import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Mock, ProviderError, chatMessageText, validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { ChatMessage, InputModality, Provider, ProviderRequestAccounting, ProviderResponse } from "@plurnk/plurnk-providers";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, testProviderCapacity } from "./_helpers.ts";

const mainResponse = (operations: string): ConstructorParameters<typeof Mock>[0]["responses"][number] => ({
    assistant: {
        content: `${operations}
`,
        reasoning: null,
    },
});

type GenerateArgs = Parameters<Provider["generate"]>[0];

class BareWitness implements Provider {
    readonly contextWindow = 16_384;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedReasoningPolicies = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly model = "bare-witness";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly calls: GenerateArgs[] = [];
    readonly completions: string[] = [];
    maxActive = 0;
    #active = 0;
    #started = 0;
    #release!: () => void;
    readonly #allStarted: Promise<void>;
    readonly #expectedCalls: number;
    readonly #failedPrompt: string | null;

    constructor(expectedCalls: number, failedPrompt: string | null = null) {
        this.#expectedCalls = expectedCalls;
        this.#failedPrompt = failedPrompt;
        this.#allStarted = new Promise((resolve) => { this.#release = resolve; });
    }

    async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "exact" as const,
            tokens: messages.reduce((total, message) => total + chatMessageText(message).length, 0),
            source: "bare-witness",
        };
    }

    async assessRequestCapacity(messages: Parameters<Provider["assessRequestCapacity"]>[0]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    attributions() {
        return ["provider:bare-witness"];
    }

    async generate(args: GenerateArgs): Promise<ProviderResponse> {
        this.calls.push(args);
        const prompt = chatMessageText(args.messages[0] ?? { content: "" });
        const capacity = await this.assessRequestCapacity(args.messages);
        const settle = await args.observeRequest?.({ provider: "provider:bare-witness", model: this.model });
        this.#active++;
        this.maxActive = Math.max(this.maxActive, this.#active);
        this.#started++;
        if (this.#started === this.#expectedCalls) this.#release();
        await this.#allStarted;
        if (prompt === "slow") await delay(20, undefined, { signal: args.signal });

        const failed = prompt === this.#failedPrompt;
        const accounting: ProviderRequestAccounting = validateProviderRequestAccounting({
            provider: "provider:bare-witness",
            model: this.model,
            outcome: failed ? "error" : "response",
            usage: failed ? undefined : { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: failed
                ? { kind: "unknown", reason: "deliberate BARE provider failure" }
                : { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "BARE fixture" },
        });
        await settle?.(accounting);
        this.#active--;
        this.completions.push(prompt);
        if (failed) {
            throw new ProviderError("bare-witness", "network_failure", `could not answer ${prompt}`, {
                status: 503,
                accounting: [accounting],
                capacity,
            });
        }
        return {
            assistant: {
                content: `answer:${prompt}`,
                reasoning: "private child reasoning",
                finishReason: "stop",
                model: this.model,
            },
            assistantRaw: null,
            accounting: [accounting],
            capacity,
        };
    }
}

class CancellingBareWitness implements Provider {
    readonly contextWindow = 16_384;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedReasoningPolicies = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly model = "cancelling-bare-witness";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly aborted: string[] = [];
    readonly started: Promise<void>;
    readonly expectedCalls: number;
    #startedCount = 0;
    #allStarted!: () => void;

    constructor(expectedCalls: number) {
        this.expectedCalls = expectedCalls;
        this.started = new Promise((resolve) => { this.#allStarted = resolve; });
    }

    async countPromptTokens() {
        return { kind: "exact" as const, tokens: 1, source: "cancelling-bare-witness" };
    }

    async assessRequestCapacity(messages: Parameters<Provider["assessRequestCapacity"]>[0]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    async generate(args: GenerateArgs): Promise<ProviderResponse> {
        const prompt = chatMessageText(args.messages[0] ?? { content: "" });
        const capacity = await this.assessRequestCapacity(args.messages);
        const settle = await args.observeRequest?.({ provider: "provider:cancelling-bare-witness", model: this.model });
        this.#startedCount++;
        if (this.#startedCount === this.expectedCalls) this.#allStarted();
        try {
            await new Promise<void>((_resolve, reject) => {
                if (args.signal?.aborted === true) reject(args.signal.reason);
                else args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
            });
        } catch (cause) {
            this.aborted.push(prompt);
            const accounting = validateProviderRequestAccounting({
                provider: "provider:cancelling-bare-witness",
                model: this.model,
                outcome: "error",
                status: 499,
                cost: { kind: "unknown", reason: "cancelled fixture request" },
            });
            await settle?.(accounting);
            throw new ProviderError("cancelling-bare-witness", "resource_interrupted", "cancelled", {
                status: 499,
                accounting: [accounting],
                capacity,
                cause,
            });
        }
        throw new Error("unreachable");
    }
}

const setup = async (schemes = new SchemeRegistry()) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bare-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "ask isolated questions");
    const engine = new Engine({ db, schemes });
    return { db, workspaceId, workerId, loopId, engine };
};

test("{§bare-inference}: resource prompts bypass line and size preview caps after preceding edits, with an optional inline tail", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const prompt = [...Array.from({ length: 24 }, (_, i) => `Finding ${i + 1}`), `Long finding: ${"α".repeat(8_000)} end`].join("\n");
        const child = new BareWitness(2);
        const result = await engine.runTurn({
            workspaceId, workerId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "```EDIT (worker:///prompt.md)",
                "" + (prompt) + "",
                "```",
                "```BARE (worker:///prompt.md)```",
                "```BARE (worker:///prompt.md)",
                "Compare these findings.",
                "```",
                "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
            ].join("\n"))] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(child.calls.map(({ messages }) => messages), [
            [{ role: "user", content: prompt }],
            [{ role: "user", content: `${prompt}\n\nCompare these findings.` }],
        ]);
        assert.equal(child.maxActive, 2);
        assert.deepEqual(result.outcomes.map(({ op }) => op), ["EDIT", "BARE", "BARE", "TASK"], "source reads do not mint extra log receipts");
    } finally { await db.close(); }
});

test("{§bare-inference}: missing resources preserve the source error without calling the provider or discarding a successful sibling", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const child = new BareWitness(1);
        const result = await engine.runTurn({
            workspaceId, workerId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "```BARE (worker:///missing.md)",
                "Do not infer from this tail alone.",
                "```",
                "```BARE",
                "survivor",
                "```",
                "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
            ].join("\n"))] }),
        });
        assert.deepEqual(child.completions, ["survivor"]);
        const rows = (await db.test_log_entries_by_turn.all<{ op: string; rx: string; model_call_id: number | null }>({ turn_id: result.turnId })).filter(({ op }) => op === "BARE");
        assert.equal(rows.length, 2);
        const failure = JSON.parse(rows[0]!.rx);
        assert.equal(failure.status, 404);
        assert.match(failure.problem.type, /\/entry-not-found$/);
        assert.equal(rows[0]!.model_call_id, null);
        assert.notEqual(rows[1]!.model_call_id, null);
        const calls = await db.test_model_calls.all<{ kind: string }>({ turn_id: result.turnId });
        assert.equal(calls.filter(({ kind }) => kind === "bare").length, 1);
    } finally { await db.close(); }
});

test("{§bare-inference}: cancellation during source preparation leaves no unstarted inference calls open", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel prompt acquisition");
    const schemes = new SchemeRegistry();
    schemes.register("interrupted-prompt", {
        manifest: {
            name: "interrupted-prompt", channels: { body: "text/plain" }, defaultChannel: "body",
            category: "data", writableBy: ["model"],
            volatile: false, modelVisible: true,
        },
        async prepareRepresentation() {
            controller.abort(cancellation);
            throw cancellation;
        },
    } satisfies SchemeHandler);
    const { db, workspaceId, workerId, loopId, engine } = await setup(schemes);
    try {
        const child = new BareWitness(2);
        await assert.rejects(engine.runTurn({
            workspaceId, workerId, loopId, messages: [], childProvider: child, signal: controller.signal,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "```BARE",
                "first prompt",
                "```",
                "```BARE (interrupted-prompt:///question.md)```",
                "```BARE",
                "last prompt",
                "```",
                "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
            ].join("\n"))] }),
        }), (error: unknown) => error === cancellation);
        assert.equal(child.calls.length, 0);
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        assert.ok(turn);
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: turn.id });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare"), [], "unstarted inference must not remain active after cancellation");
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const [denied, target] of [
    [{ operation: "BARE" }, ""],
    [{ operation: "BARE" }, " (worker:///prompt.md)"],
    [{ scheme: "worker", access: "observe" }, " (worker:///prompt.md)"],
] as const) {
    test(`{§capability-admission}: BARE${target} respects ${JSON.stringify(denied)} before inference`, async () => {
        const { db, workspaceId, workerId, loopId, engine } = await setup();
        try {
            await db.workspace_capability_policy_update.run({ workspace_id: workspaceId, policy: JSON.stringify({ deny: [denied] }) });
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                workspaceId, workerId, loopId, messages: [], childProvider: child,
                provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                    "```EDIT (worker:///prompt.md)",
                    "secret prompt",
                    "```",
                    "```BARE" + target,
                    "inline prompt",
                    "```",
                    "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
                ].join("\n"))] }),
            });
            assert.equal(child.calls.length, 0);
            assert.deepEqual(result.outcomes.filter(({ op }) => op === "BARE"), [{ op: "BARE", status: 403, problemType: "https://problems.plurnk.xyz/engine/dispatcher/capability-denied" }]);
            const calls = await db.test_model_calls.all<{ kind: string }>({ turn_id: result.turnId });
            assert.equal(calls.filter(({ kind }) => kind === "bare").length, 0);
        } finally { await db.close(); }
    });
}

test("{§bare-inference}: a log prompt uses only retained source lines", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const first = await engine.runTurn({
            workspaceId, workerId, loopId, messages: [],
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "```EDIT (worker:///source.md)",
                "first",
                "superseded",
                "last",
                "```",
                "```READ (worker:///source.md) <1,-1>```",
                "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
            ].join("\n"))] }),
        });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; sequence: number }>({ turn_id: first.turnId });
        const source = rows.find(({ op }) => op === "READ");
        assert.ok(source);
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.ok(turn);
        const address = `log:///1/${turn.sequence}/${source.sequence}/READ`;
        const child = new BareWitness(1);
        const second = await engine.runTurn({
            workspaceId, workerId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                "```KILL (" + (address) + ") <2>```",
                "```BARE (" + (address) + ")```",
                "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
            ].join("\n"))] }),
        });
        assert.deepEqual(second.outcomes.filter(({ op }) => op === "BARE"), [{ op: "BARE", status: 200, problemType: null }]);
        assert.deepEqual(child.calls.map(({ messages }) => messages), [[{ role: "user", content: "first\nlast" }]]);
    } finally { await db.close(); }
});

for (const [target, status, problem] of [
    ["worker:///prompt.md#missing", 404, "channel-not-found"],
    ["unregistered://prompt", 501, "scheme-not-found"],
    [null, 422, "bare-prompt-empty"],
] as const) {
    test(`{§bare-inference}: ${target ?? "empty input"} produces ${problem} without inference`, async () => {
        const { db, workspaceId, workerId, loopId, engine } = await setup();
        try {
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                workspaceId, workerId, loopId, messages: [], childProvider: child,
                provider: new Mock({ contextWindow: 32_768, responses: [mainResponse([
                    "```EDIT (worker:///prompt.md)",
                    "source prompt",
                    "```",
                    "```BARE" + (target === null ? "" : ` (${target})`),
                    "```",
                    "```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```",
                ].join("\n"))] }),
            });
            const [bare] = result.outcomes.filter(({ op }) => op === "BARE");
            assert.equal(bare?.status, status);
            assert.ok(bare?.problemType?.endsWith(`/${problem}`));
            assert.equal(child.calls.length, 0);
        } finally { await db.close(); }
    });
}

test("{§bare-inference}: an intervening operation separates concurrent BARE groups", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const child = new BareWitness(1);
        const generate = child.generate.bind(child);
        const observed: Array<string | undefined> = [];
        child.generate = async (args) => {
            const row = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/between", name: "body" });
            observed.push(row?.content);
            return generate(args);
        };
        const result = await engine.runTurn({
            workspaceId, workerId, loopId, messages: [], childProvider: child,
            provider: new Mock({ contextWindow: 32_768, responses: [mainResponse("```BARE\nbefore\n```\n```EDIT (worker:///between)\nwritten\n```\n```BARE\nafter\n```\n```TASK\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```")] }),
        });
        assert.equal(result.status, 102);
        assert.deepEqual(observed, [undefined, "written"]);
        assert.deepEqual(child.completions, ["before", "after"]);
        assert.deepEqual(result.outcomes.map(({ op }) => op), ["BARE", "EDIT", "BARE", "TASK"]);
    } finally { await db.close(); }
});

// {§bare-inference}
test("BARE calls receive only their body prompts, run in parallel, and commit in authored order", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("```BARE\nslow\n```\n\n```BARE\nfast\n```\n\n```TASK\n[{\"content\":\"Observe both responses next turn.\",\"status\":\"in_progress\"}]\n```")],
        });
        const child = new BareWitness(2);

        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });

        assert.equal(result.status, 102);
        assert.equal(child.maxActive, 2, "the child calls overlap");
        assert.deepEqual(child.completions, ["fast", "slow"], "the fixture proves completion order differs");
        assert.deepEqual(child.calls.map(({ messages }) => messages), [
            [{ role: "user", content: "slow" }],
            [{ role: "user", content: "fast" }],
        ]);
        assert.ok(child.calls.every(({ grammar }) => grammar === undefined), "BARE has no output rail");
        assert.ok(child.calls.every(({ observeReasoning }) => observeReasoning === undefined), "BARE reasoning remains private to its operation result");
        assert.ok(child.calls.every(({ callKind }) => callKind === "bare"), "BARE declares its provider output contract");
        const parentIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: workerId });
        const bareIdentities = child.calls.map(({ workerId: callWorker }) => callWorker);
        assert.ok(bareIdentities.every((identity) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity)), "each BARE call receives an opaque UUID identity");
        assert.equal(new Set(bareIdentities).size, 2, "parallel BARE calls cannot acquire affinity with one another");
        assert.ok(bareIdentities.every((identity) => identity !== parentIdentity?.provider_identity), "BARE does not reuse the parent worker's affinity identity");
        assert.ok(child.calls.every(({ primaryWorkerId, client, strikes }) =>
            primaryWorkerId === parentIdentity?.provider_identity && client === undefined && strikes === undefined));
        assert.ok(child.calls.every(({ attributions }) =>
            JSON.stringify(attributions) === JSON.stringify(["provider:bare-witness"])));

        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            op: string | null;
            signal: string | null;
            rx: string;
            model_call_id: number | null;
        }>({ turn_id: result.turnId });
        const bareRows = rows.filter(({ op }) => op === "BARE");
        assert.deepEqual(bareRows.map(({ sequence, rx }) => ({
            sequence,
            content: (JSON.parse(rx) as { content: string }).content,
        })), [
            { sequence: bareRows[0]?.sequence, content: "answer:slow" },
            { sequence: bareRows[1]?.sequence, content: "answer:fast" },
        ]);
        assert.ok(bareRows.every(({ model_call_id }) => model_call_id !== null));

        const calls = await db.test_model_calls.all<{
            sequence: number;
            kind: string;
            state: string;
            attributions: string;
            log_entry_id: number | null;
        }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ sequence, kind, state }) => ({ sequence, kind, state })), [
            { sequence: 1, kind: "emission", state: "response" },
            { sequence: 2, kind: "bare", state: "response" },
            { sequence: 3, kind: "bare", state: "response" },
        ]);
        assert.ok(calls.slice(1).every(({ log_entry_id }) => log_entry_id !== null));
        assert.ok(calls.slice(1).every(({ attributions }) =>
            JSON.stringify(JSON.parse(attributions)) === JSON.stringify(["provider:bare-witness"])));

        const usage = await engine.loopUsage(loopId);
        assert.equal(usage.accounting.requests.length, 3, "parent and both BARE calls remain cardinal accounting");
        assert.equal(usage.contextTokens, 0, "the context gauge remains the parent emission packet, not a tiny BARE prompt");
    } finally {
        await db.close();
    }
});

// {§bare-inference} {§provider-guarantees-signal-wired}
test("loop cancellation reaches every concurrent BARE call before the batch escapes", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("```BARE\nfirst\n```\n\n```BARE\nsecond\n```\n\n```TASK\n[{\"content\":\"continue\",\"status\":\"in_progress\"}]\n```")],
        });
        const child = new CancellingBareWitness(2);
        const controller = new AbortController();
        const running = engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
            signal: controller.signal,
        });
        await child.started;
        const cancellation = new Error("cancel BARE batch");
        controller.abort(cancellation);
        await assert.rejects(running, (error: unknown) => error === cancellation);
        assert.deepEqual(child.aborted.toSorted(), ["first", "second"]);
        const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: turn!.id });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare").map(({ state }) => state), ["error", "error"]);
    } finally {
        await db.close();
    }
});

// {§bare-inference}
test("one BARE provider failure is an ordered operation result and does not cancel its siblings", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("```BARE\nfail\n```\n\n```BARE\nok\n```\n\n```TASK\n[{\"content\":\"Inspect the isolated failure and success.\",\"status\":\"in_progress\"}]\n```")],
        });
        const child = new BareWitness(2, "fail");

        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });

        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "BARE"), [
            { op: "BARE", status: 503, problemType: "https://problems.plurnk.xyz/provider/bare-witness/network-failure" },
            { op: "BARE", status: 200, problemType: null },
        ]);
        const calls = await db.test_model_calls.all<{ kind: string; state: string }>({ turn_id: result.turnId });
        assert.deepEqual(calls.filter(({ kind }) => kind === "bare").map(({ state }) => state), ["error", "response"]);
    } finally {
        await db.close();
    }
});

// {§bare-inference} {§send-premature-terminate}
test("a same-turn BARE response is unseen retrieval work and refuses SEND 200", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse("```BARE\nquestion\n```\n\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```")],
        });
        const child = new BareWitness(1);
        const result = await engine.runTurn({
            provider: parent,
            childProvider: child,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "ask isolated questions" }],
        });
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "TASK"), [{ op: "TASK", status: 409, problemType: "https://problems.plurnk.xyz/engine/dispatcher/retrieval-results-unobserved" }]);
    } finally {
        await db.close();
    }
});

for (const state of ["in_progress", "waiting", "completed"] as const) {
    test(`{§bare-inference} {§disposition-ends-turn}: BARE after TASK ${state} is dropped, never called, and diagnosed once`, async () => {
        const { db, workspaceId, workerId, loopId, engine } = await setup();
        try {
            const child = new BareWitness(1);
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 32_768,
                    responses: [mainResponse(`\`\`\`TASK
${JSON.stringify([{ content: "Observe the answer.", status: state }])}
\`\`\`
\`\`\`BARE
question
\`\`\``)],
                }),
                childProvider: child,
                workspaceId,
                workerId,
                loopId,
                messages: [],
            });
            assert.equal(result.status, 102, "the diagnostic is a same-turn failure the model sees in the next packet");
            assert.deepEqual(child.completions, [], "no isolated call was made for the dropped BARE");
            assert.deepEqual(result.outcomes.map(({ op }) => op), [null, "TASK"]);
            assert.deepEqual(result.outcomes.filter(({ op }) => op === null), [
                { op: null, status: 400, problemType: "https://problems.plurnk.xyz/grammar/parser/invalid-operation-syntax" },
            ]);
            assert.deepEqual(result.outcomes.filter(({ op }) => op === "TASK"), [
                state === "completed"
                    ? { op: "TASK", status: 409, problemType: "https://problems.plurnk.xyz/engine/dispatcher/unobserved-failures" }
                    : { op: "TASK", status: 102, problemType: null },
            ]);
        } finally {
            await db.close();
        }
    });
}
