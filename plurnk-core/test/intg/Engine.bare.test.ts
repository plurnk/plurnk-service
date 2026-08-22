import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Mock, ProviderError, validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { Provider, ProviderRequestAccounting, ProviderResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, testProviderCapacity } from "./_helpers.ts";

const mainResponse = (operations: string): ConstructorParameters<typeof Mock>[0]["responses"][number] => ({
    assistant: {
        content: `# PLAN0\nUse isolated inference where it is sufficient.\n\n${operations}`,
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

    async countPromptTokens(messages: readonly { role: string; content: string }[]) {
        return {
            kind: "exact" as const,
            tokens: messages.reduce((total, { content }) => total + content.length, 0),
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
        const prompt = args.messages[0]?.content ?? "";
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
        const prompt = args.messages[0]?.content ?? "";
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

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bare-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "ask isolated questions");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, workspaceId, workerId, loopId, engine };
};

// {§bare-inference}
test("BARE calls receive only their body prompts, run in parallel, and commit in authored order", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const parent = new Mock({
            contextWindow: 32_768,
            responses: [mainResponse([
                "## BARE0 [+fact]\nslow",
                "## BARE0 [+fact,+quick]\nfast",
                "## SEND0 [102]\nObserve both responses next turn.",
            ].join("\n\n"))],
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
        const tags = await db.test_log_tags_by_turn.all<{ tag: string }>({ turn_id: result.turnId });
        assert.deepEqual(tags.map(({ tag }) => tag), ["fact", "fact", "quick"]);

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
            responses: [mainResponse([
                "## BARE0\nfirst",
                "## BARE0\nsecond",
                "## SEND0 [102]\ncontinue",
            ].join("\n\n"))],
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
            responses: [mainResponse([
                "## BARE0\nfail",
                "## BARE0\nok",
                "## SEND0 [102]\nInspect the isolated failure and success.",
            ].join("\n\n"))],
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
            { op: "BARE", status: 503 },
            { op: "BARE", status: 200 },
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
            responses: [mainResponse("## BARE0\nquestion\n\n## SEND0 [200]\ndone")],
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
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "SEND"), [{ op: "SEND", status: 409 }]);
    } finally {
        await db.close();
    }
});
