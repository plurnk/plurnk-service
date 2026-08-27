// The module's HTTP surface against a mock seam (no daemon): §3 management-action AG-UI Runs execute
// via the seam and finish clean; unknown kinds error honestly; a resume tool-result
// resolves without driving a loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Module from "./Module.ts";
import type {
    ApplicationActionContext,
    ApplicationPort,
    PlurnkStatement,
    ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { AguiEvent } from "./types.ts";
import { DEFAULT_LOOP_FLAGS, PlurnkParser, Problems, Validator } from "@plurnk/plurnk-contracts";
import { loopUsage } from "../test/accounting-fixture.ts";
import { streamConclusion, streamEvent, termination } from "../test/notification-fixture.ts";

const MODULE_INPUT_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: true,
});
const MODULE_OUTPUT_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: true,
});
const workspaceRow = (id: number, name: string) => ({
    id,
    name,
    project_root: null,
    created_at: "2026-01-01T00:00:00.000Z",
});
const workerRow = (id: number, name: string, origin: "model" | "client" | "_plurnk" = "model") => ({
    id,
    name,
    created_at: "2026-01-01T00:00:00.000Z",
    origin,
    parentWorkerId: null,
});

const mockSeam = () => {
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const loopRuns: Array<{ selector?: string; childSelector?: string | null; prompt: string }> = [];
    const modelSets: Array<{ selector?: string; childSelector?: string | null }> = [];
    const modelQueries: unknown[] = [];
    const reasoningSets: unknown[] = [];
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const seam: ApplicationPort = {
        listClientDisplayCapabilities: async () => [],
        listModuleActions: () => [],
        invokeModuleAction: async (name) => { throw new Error(`unexpected module action '${name}'`); },
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        pendingClientInteractions: async () => [],
        resolveProposal: (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", termination({
                workerId: 77,
                loopId: 1,
                usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
            }))));
        },
        resolveClientInteraction: async () => {},
        runLoop: async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.childSelector !== undefined ? { childSelector: a.childSelector } : {}) }); return { status: 100, action: "injected_next_turn" as const, loopId: 9, turnSeq: 2 }; },
        cancelDrain: () => true,
        cancelWorker: async () => {},
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        readLog: async () => [{ id: 1, op: "SEND", origin: "model" }],
        listProviders: () => ({ aliases: [{ alias: "opus", provider: "anthropic", model: "claude", active: true, inputCapacity: 200000 }] }),
        listModels: (query) => {
            modelQueries.push(query);
            return {
                items: [{
                    selector: "google/gemini-3-flash",
                    provider: "google",
                    providerName: "Google",
                    model: "gemini-3-flash",
                    modelName: "Gemini 3 Flash",
                    limits: { contextTokens: 1_000_000 },
                    capabilities: {
                        attachment: true,
                        reasoning: true,
                        toolCall: true,
                        inputModalities: ["text", "image"],
                        outputModalities: ["text"],
                    },
                    readiness: { ready: true, causes: [] },
                }],
                offset: query.offset ?? 0,
                total: 1,
            };
        },
        createWorkspace: async () => ({ workspaceId: 3, workspaceName: "agui-t", projectRoot: null, workerId: 10, workerName: "client-1" }),
        attachWorkspace: async () => { throw new Error("unexpected attach"); },
        listWorkspaces: async () => [],
        listWorkers: async () => [workerRow(10, "client-1", "client")],
        readWorker: async () => null,
        listWorkerLoops: async () => [],
        ensureModelWorker: async () => 20,
        listPrompts: async () => ["hi"],
        renameWorkspace: async (_id, name) => ({ id: 3, name }),
        constrain: async (_id, effect, glob) => ({ effect, glob, source: "explicit" as const }),
        unconstrain: async (_id, effect, glob) => ({ effect, glob }),
        listConstraints: async () => [{ effect: "pick", glob: "src/**", source: "explicit" }],
        workspaceDerivationStatus: () => null,
        readEntry: async () => ({
            status: 200,
            entry: {
                entryId: 1,
                target: "worker:///x",
                channels: {},
            },
        }),
        forkWorker: async () => ({ workerId: 11, workerName: "fork-1", parentWorkerId: 10 }),
        createConversationWorker: async (a) => ({ workerId: 77, workerName: a.name ?? "model-fresh" }),
        listMembers: async () => ({ members: [{ path: "a.ts", effect: "member" }], hidden: [] }),
        look: async () => ({ status: 200, content: "looked" }),
        readWorkerModel: async () => ({ model: null, spawnModel: null }),
        readWorkerReasoning: async () => ({ policy: null, supportedPolicies: [] }),
        readWorkerSettings: async () => ({ requestUserInput: false }),
        setWorkerSettings: async ({ settings }) => ({ requestUserInput: settings?.requestUserInput === true }),
        setWorkerModel: async ({ selector }) => {
            modelSets.push({ selector });
            return selector.includes("/")
                ? { provider: selector.slice(0, selector.indexOf("/")), model: selector.slice(selector.indexOf("/") + 1) }
                : { alias: selector, provider: "openai", model: "mocktest" };
        },
        setWorkerSpawnModel: async ({ selector }) => {
            modelSets.push({ childSelector: selector });
            return selector === null
                ? null
                : selector.includes("/")
                    ? { provider: selector.slice(0, selector.indexOf("/")), model: selector.slice(selector.indexOf("/") + 1) }
                    : { alias: selector, provider: "openai", model: "mocktest" };
        },
        setWorkerReasoning: async ({ policy }) => {
            reasoningSets.push(policy);
            return { policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] };
        },
    };
    const finish = (workspaceId: number | null, workerId: number) => setImmediate(() => handlers.forEach((h) => h(workspaceId, "loop/terminated", termination({
        workerId,
        loopId: 9,
        usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
    }))));
    const emit = (workspaceId: number | null, method: string, params: unknown) => handlers.forEach((h) => h(workspaceId, method, params));
    return { seam, resolves, loopRuns, modelSets, modelQueries, reasoningSets, finish, emit };
};

const standardInput = (body: Record<string, unknown>): Record<string, unknown> => ({
    runId: typeof body.runId === "string" ? body.runId : typeof body.workerId === "string" ? body.workerId : crypto.randomUUID(),
    state: {},
    tools: [],
    context: [],
    ...body,
    messages: Array.isArray(body.messages)
        ? body.messages.map((message, index) => ({ id: `message-${index}`, ...(message as Record<string, unknown>) }))
        : [],
});

const post = async (port: number, body: Record<string, unknown>): Promise<AguiEvent[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(body)) });
    assert.equal(res.status, 200);
    const text = await res.text();
    return text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
};

// A streaming reader that stays OPEN, collecting events until the connection ends —
// lets a test hold concurrent AG-UI Runs on one workspace and observe routing live.
const openStream = (port: number, body: Record<string, unknown>): Promise<AguiEvent[]> =>
    fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(body)) })
        .then((res) => res.text())
        .then((text) => text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent));

const waitForFixture = async (barrier: Promise<void>, detail: () => string): Promise<void> => {
    let timeout: NodeJS.Timeout | null = null;
    try {
        await Promise.race([
            barrier,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(detail())), 10_000);
            }),
        ]);
    } finally {
        if (timeout !== null) clearTimeout(timeout);
    }
};

test("{§agui-listener-admission}: a bound listener refuses work until daemon activation", async () => {
    const { seam } = mockSeam();
    const mod = await Module.bind({ host: "127.0.0.1", port: 0 });
    try {
        const port = mod.address().port;
        const unavailable = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), Problems.create(
            "agui:http",
            "service-starting",
            503,
            "The PLURNK service owns this listener but has not completed durable recovery.",
            { stage: "startup", retryable: true },
        ));

        await mod.start(seam);
        const events = await post(port, {
            threadId: "startup-admission",
            forwardedProps: { plurnk: { action: { kind: "providers.list" } } },
        });
        assert.ok(events.some((event) => event.type === "RUN_FINISHED"), "activation makes the pre-bound listener ready");
    } finally { await mod.close(); }
});

test("{§agui-listener-admission}: a lost bind race rejects with the socket error", async () => {
    const holder = createServer();
    try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
            holder.once("error", rejectPromise);
            holder.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = holder.address();
        if (address === null || typeof address === "string") throw new Error("test listener did not bind TCP");
        await assert.rejects(
            () => Module.bind({ host: "127.0.0.1", port: address.port }),
            { code: "EADDRINUSE" },
        );
    } finally {
        await new Promise<void>((resolvePromise) => holder.close(() => resolvePromise()));
    }
});

test("workspace notifications route to their owning worker's AG-UI Run", async () => {
    const { seam, emit } = mockSeam();
    const firstRun = Promise.withResolvers<void>();
    const bothRuns = Promise.withResolvers<void>();
    const releaseSecondWorker = Promise.withResolvers<void>();
    let runCalls = 0;
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.listWorkers = async () => [workerRow(20, "model-1")];
    seam.createConversationWorker = async (a) => {
        if (a.name === "chat-b") await releaseSecondWorker.promise;
        return { workerId: a.name === "chat-a" ? 77 : 78, workerName: a.name ?? "x" };
    };
    // runLoop does NOT finish here: both streams stay open so the injected stream event
    // races them exactly as concurrent nvim management-action AG-UI Runs do against a resumed exec.
    seam.runLoop = async ({ workerId }) => {
        runCalls++;
        if (runCalls === 1) firstRun.resolve();
        if (runCalls === 2) bothRuns.resolve();
        return { status: 100, action: "enqueued_new_loop" as const, loopId: workerId === 77 ? 9 : 10 };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const a = openStream(port, { threadId: "chat-a", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        const b = openStream(port, { threadId: "chat-b", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        await waitForFixture(firstRun.promise, () => `first AG-UI Run did not bind through runLoop; observed ${runCalls}/2`);
        releaseSecondWorker.resolve();
        await waitForFixture(bothRuns.promise, () => `both AG-UI Runs did not bind through runLoop; observed ${runCalls}/2`);
        emit(3, "stream/event", streamEvent({ entryId: 5, workerId: 77, target: "exec:///1/1/5", scheme: "exec", contentLength: 5 }));
        emit(3, "stream/concluded", streamConclusion({ entryId: 5, workerId: 77, target: "exec:///1/1/5", scheme: "exec" }));
        emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        emit(3, "loop/terminated", termination({ workerId: 78, loopId: 10, usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        const [ea, eb] = await Promise.all([a, b]);
        const hasExecActivity = (evs: AguiEvent[]) => evs.some((e) => e.type === "ACTIVITY_SNAPSHOT" && (e as { messageId?: string }).messageId === "stream-5");
        assert.ok(hasExecActivity(ea), "AG-UI Run A received the exec stream activity");
        assert.equal(hasExecActivity(eb), false, "AG-UI Run B did not receive another worker's stream activity");
    } finally { await mod.close(); }
});

test("a read-only management Run does not duplicate its conversation's model settlement", async () => {
    const { seam, emit } = mockSeam();
    const loopStarted = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    seam.runLoop = async () => {
        loopStarted.resolve();
        return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 };
    };
    seam.readEntry = async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return { status: 200, entry: { entryId: 1, target: "worker:///x", channels: {} } };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const conversation = openStream(port, {
            threadId: "agui-t",
            runId: "conversation-run",
            messages: [{ role: "user", content: "hi" }],
            forwardedProps: { plurnk: { workspace: "agui-t" } },
        });
        await waitForFixture(loopStarted.promise, () => "conversation AG-UI Run did not enter runLoop");

        const management = openStream(port, {
            threadId: "agui-t",
            runId: "management-run",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: { kind: "entry.read", target: "worker:///x" },
                },
            },
        });
        await waitForFixture(readStarted.promise, () => "management AG-UI Run did not enter entry.read");

        emit(3, "log/entry", {
            entry: {
                id: 21,
                worker_id: 20,
                loop_id: 9,
                origin: "model",
                op: "SEND",
                coordinate: "1/1/1/SEND",
                tx: { body: "one answer" },
                turn_id: 1,
            },
        });
        releaseRead.resolve();
        emit(3, "loop/terminated", termination({
            workerId: 20,
            loopId: 9,
            usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
        }));

        const [conversationEvents, managementEvents] = await Promise.all([conversation, management]);
        const answerRows = (events: AguiEvent[]) => events.filter((event) =>
            event.type === "CUSTOM"
            && (event as { name?: string; value?: { id?: number } }).name === "plurnk.row"
            && (event as { value?: { id?: number } }).value?.id === 21);
        assert.equal(answerRows(conversationEvents).length, 1, "the conversation receives its SEND exactly once");
        assert.equal(answerRows(managementEvents).length, 0, "the management Run receives no conversation rows");
    } finally { await mod.close(); }
});

test("a management-action AG-UI Run executes via the seam: result custom + RUN_FINISHED, no loop", async () => {
    const { seam, modelQueries } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "providers.list" } } } });
        const result = events.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { kind: string; ok: boolean; result: { aliases: Array<{ alias: string }> } } };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.aliases[0].alias, "opus");
        assert.equal(events[events.length - 1].type, "RUN_FINISHED", "management-action AG-UI Run finishes clean");
        const models = await post(mod.address().port, { threadId: "t1", workerId: "models", forwardedProps: { plurnk: { action: { kind: "models.list", provider: "google", search: "flash", limit: 10 } } } });
        const modelResult = models.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { items: Array<{ selector: string }> } } };
        assert.equal(modelResult.value.ok, true);
        assert.equal(modelResult.value.result.items[0]?.selector, "google/gemini-3-flash");
        assert.deepEqual(modelQueries, [{ provider: "google", search: "flash", limit: 10 }]);

        const invalidModels = await post(mod.address().port, { threadId: "t1", workerId: "models-invalid", forwardedProps: { plurnk: { action: { kind: "models.list", limit: 101 } } } });
        const invalidModelResult = invalidModels.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; problem: { status: number; type: string } } };
        assert.equal(invalidModelResult.value.ok, false);
        assert.equal(invalidModelResult.value.problem.status, 400);
        // inject rides the same surface
        const inj = await post(mod.address().port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "loop.inject", prompt: "steer" } } } });
        const ack = inj.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { action: string } } };
        assert.equal(ack.value.result.action, "injected_next_turn", "inject folds into the active drain via the unified runLoop");
        // an unknown kind errors honestly
        const bad = await post(mod.address().port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "nope.nothing" } } } });
        const err = bad.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: {
                ok: boolean;
                problem: {
                    type: string;
                    detail: string;
                    requestedAction: string;
                    recovery: string;
                    retryable: boolean;
                };
            };
        };
        assert.equal(err.value.ok, false);
        assert.equal(err.value.problem.type, "https://problems.plurnk.xyz/agui/action/unknown-action");
        assert.equal(err.value.problem.detail, "Action 'nope.nothing' is not registered.");
        assert.equal(err.value.problem.requestedAction, "nope.nothing");
        assert.equal(err.value.problem.recovery, "Use an action advertised by discover.");
        assert.equal(err.value.problem.retryable, false);
        assert.doesNotMatch(err.value.problem.detail, /seam surface/, "no internal jargon leaks to the client");
    } finally { await mod.close(); }
});

test("the initial AG-UI snapshot carries durable model, exact packet count, and current derivation activity", async () => {
    const { seam } = mockSeam();
    seam.readWorkerModel = async () => ({
        model: { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" },
        spawnModel: null,
    });
    seam.listWorkerLoops = async () => [{
        id: 9,
        workerId: 20,
        sequence: 2,
        status: 100,
        prompt: "work",
        promptSource: null,
        terminatedAt: null,
        terminalResult: null,
        packetCount: 3,
    }];
    seam.workspaceDerivationStatus = () => ({
        phase: "indexing",
        completed: 4,
        total: 10,
        percent: 40,
        message: "Indexing repository semantics: 40% (4/10)",
        level: "info",
    });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "status",
            forwardedProps: { plurnk: { workspace: "status", action: { kind: "worker.model.get" } } },
        });
        const event = events.find((candidate) => candidate.type === "STATE_SNAPSHOT") as {
            snapshot: { plurnk: { status: Record<string, unknown> } };
        };
        assert.deepEqual(event.snapshot.plurnk.status, {
            lifecycle: "running",
            model: { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" },
            loopId: 9,
            packetCount: 3,
            activity: {
                kind: "derivation",
                phase: "indexing",
                completed: 4,
                total: 10,
                percent: 40,
                message: "Indexing repository semantics: 40% (4/10)",
            },
        });
    } finally { await mod.close(); }
});

test("{§agui-worker-model-actions}: worker model get/set reach the seam and child null means inherit", async () => {
    const { seam, modelSets } = mockSeam();
    seam.readWorkerModel = async () => ({ model: { alias: "opus", provider: "anthropic", model: "claude" }, spawnModel: { alias: "tiny", provider: "openai", model: "mini" } });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const get = await post(port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.get" } } } });
        const got = get.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; result: { model: { alias: string } | null; spawnModel: { alias: string } | null } };
        };
        assert.equal(got.value.ok, true);
        assert.equal(got.value.result.model?.alias, "opus");
        assert.equal(got.value.result.spawnModel?.alias, "tiny");

        const set = await post(port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.set", selector: "fresh" } } } });
        assert.equal(set[set.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(modelSets, [{ selector: "fresh" }]);

        const child = await post(port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.child.set", selector: null } } } });
        assert.equal(child[child.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(modelSets, [{ selector: "fresh" }, { childSelector: null }], "child selector null forwards as inherit");

        const noSelector = await post(port, { threadId: "t1", workerId: "r4", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.set" } } } });
        const refused = noSelector.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; problem: { type: string; status: number } };
        };
        assert.equal(refused.value.ok, false);
        assert.equal(refused.value.problem.status, 400, "a selectorless set is an invalid action, not a silent no-op");
    } finally { await mod.close(); }
});

test("{§agui-worker-reasoning-actions}: worker reasoning get/set reach the seam as a separate durable policy", async () => {
    const { seam, reasoningSets } = mockSeam();
    seam.readWorkerReasoning = async () => ({ policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const get = await post(port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.reasoning.get" } } } });
        const got = get.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; result: { policy: string | null; supportedPolicies: string[] } };
        };
        assert.equal(got.value.ok, true);
        assert.equal(got.value.result.policy, "adaptive");
        assert.deepEqual(got.value.result.supportedPolicies, ["off", "adaptive", "high"]);

        const set = await post(port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.reasoning.set", policy: "adaptive" } } } });
        assert.equal(set[set.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(reasoningSets, ["adaptive"]);

        const missing = await post(port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.reasoning.set" } } } });
        const refused = missing.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; problem: { type: string; status: number } };
        };
        assert.equal(refused.value.ok, false);
        assert.equal(refused.value.problem.status, 400);
    } finally { await mod.close(); }
});

test("entry.read defaults to the thread worker, honors an explicit owner, and preserves the contracts-owned wire", async () => {
    const { seam } = mockSeam();
    const calls: Array<Parameters<ApplicationPort["readEntry"]>[0]> = [];
    const entry = {
        entryId: 42,
        target: "worker://~/notes.md",
        channels: {
            body: {
                content: "hello",
                contentOffset: 0,
                contentLength: 5,
                mimetype: "text/markdown",
                weight: 3,
                state: "static" as const,
            },
        },
    };
    seam.readEntry = async (args) => {
        calls.push(args);
        return Validator.assertEntryReadResult({ status: 200, entry });
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "entry-wire-thread",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: {
                        kind: "entry.read",
                        target: "worker://~/notes.md",
                        channel: "body",
                        offset: 0,
                    },
                },
            },
        });
        assert.deepEqual(calls, [{
            workspaceId: 3,
            workerId: 77,
            target: "worker://~/notes.md",
            channel: "body",
            offset: 0,
        }]);
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: unknown };
        } | undefined;
        assert.equal(event?.value?.ok, true);
        assert.deepEqual(event?.value?.result, { status: 200, entry });

        await post(mod.address().port, {
            threadId: "entry-wire-thread",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: {
                        kind: "entry.read",
                        workerId: 91,
                        target: "worker://~/notes.md",
                    },
                },
            },
        });
        assert.deepEqual(calls[1], {
            workspaceId: 3,
            workerId: 91,
            target: "worker://~/notes.md",
        });
    } finally {
        await mod.close();
    }
});

test("#131: structured op.exec dispatches one valid statement with unknown source position", async () => {
    const { seam } = mockSeam();
    const dispatched: Parameters<ApplicationPort["dispatchClientAction"]>[0]["statements"][] = [];
    seam.dispatchClientAction = async ({ statements }) => {
        dispatched.push(statements);
        return [{ status: 200 }];
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, {
            threadId: "structured-exec-position",
            forwardedProps: {
                plurnk: {
                    workspace: "structured-exec-position",
                    action: { kind: "op.exec", command: "printf done" },
                },
            },
        });
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].length, 1);
        assert.equal(dispatched[0][0].op, "EXEC");
        assert.equal(Validator.validatePlurnkStatement(dispatched[0][0]).valid, true);
        assert.deepEqual(dispatched[0][0].position, { line: 0, column: 0 });
    } finally { await mod.close(); }
});

test("#58: op.parse projects the parser-owned diagnostic and structured position", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const text = "## EXEC0 (😀) [-1,300]\nx";
        const events = await post(mod.address().port, {
            threadId: "parse-diagnostic",
            runId: "parse-diagnostic-run",
            forwardedProps: {
                plurnk: {
                    workspace: "parse-diagnostic",
                    action: { kind: "op.parse", text },
                },
            },
        });
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: {
                result?: {
                    results?: Array<{
                        status?: number;
                        problem?: {
                            detail?: string;
                            line?: number;
                            column?: number;
                            source?: string;
                            severity?: string;
                            recovery?: string;
                        };
                    }>;
                };
            };
        } | undefined;
        const failure = event?.value?.result?.results?.find(({ status }) => status === 400)?.problem;
        assert.ok(failure !== undefined, "the malformed statement surfaces as a child operation failure");
        assert.match(failure.detail ?? "", /timeout\/poll ride the `<scope>` slot/);
        assert.doesNotMatch(failure.detail ?? "", /Plurnk lexer error at line/);
        assert.deepEqual(
            { line: failure.line, column: failure.column, source: failure.source, severity: failure.severity },
            { line: 1, column: 14, source: "lexer", severity: "error" },
        );
        assert.equal(text.indexOf("-1"), 15, "the UTF-16 index differs from the parser's code-point column");
        assert.equal(failure.recovery, undefined, "AG-UI does not author generic parser recovery");
    } finally { await mod.close(); }
});

// {§agui-op-look} {§parse-diagnostics} {§unparsed-tail-boundary}
test("#136: op.look admits one clean LOOK and rejects every other parser fact before observation", async () => {
    const { seam } = mockSeam();
    const calls: Parameters<ApplicationPort["look"]>[0][] = [];
    seam.look = async (args) => {
        calls.push(args);
        return { status: 200, content: "looked" };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const invoke = async (text: string): Promise<{
            ok: boolean;
            result?: Record<string, unknown>;
            problem?: Record<string, unknown>;
        }> => {
            const events = await post(mod.address().port, {
                threadId: "look-admission",
                forwardedProps: {
                    plurnk: {
                        workspace: "look-admission",
                        action: { kind: "op.look", text },
                    },
                },
            });
            const event = events.find((candidate) => candidate.type === "CUSTOM"
                && (candidate as { name?: string }).name === "plurnk.action.result") as {
                value?: {
                    ok: boolean;
                    result?: Record<string, unknown>;
                    problem?: Record<string, unknown>;
                };
            } | undefined;
            assert.ok(event?.value !== undefined, "op.look returns one management-action outcome");
            return event.value;
        };

        const source = " \n## LOOK0 [draft] (worker:///x) <1-2>\n~needle\n";
        const admitted = await invoke(source);
        assert.equal(admitted.ok, true);
        assert.equal(admitted.result?.content, "looked");
        assert.equal(calls.length, 1);
        const expected = PlurnkParser.parseClient(source).items.find((item) => item.kind === "statement")?.statement;
        assert.ok(expected !== undefined);
        const { op: _look, ...expectedReadShape } = expected;
        const { op, ...actualReadShape } = calls[0].statement as PlurnkStatement;
        assert.equal(op, "READ");
        assert.deepEqual(actualReadShape, expectedReadShape, "the projection changes only LOOK to READ");

        const missing = await invoke(" \n\t");
        assert.equal(missing.ok, false);
        assert.equal(missing.problem?.type, "https://problems.plurnk.xyz/agui/action/invalid-action-parameters");
        assert.equal(missing.problem?.detail, "op.look parsed 0 statements; exactly one LOOK statement is required.");

        const extra = await invoke("## LOOK0 (worker:///x)\n\n## LOOK0 (worker:///y)");
        assert.equal(extra.ok, false);
        assert.equal(extra.problem?.type, "https://problems.plurnk.xyz/agui/action/invalid-action-parameters");
        assert.equal(extra.problem?.detail, "op.look parsed 2 statements; exactly one LOOK statement is required.");
        assert.equal(extra.problem?.stage, "action-validation");

        for (const operation of ["READ", "EDIT"] as const) {
            const body = operation === "EDIT" ? "\nbad" : "";
            const wrongOperation = await invoke(`## ${operation}0 (worker:///x)${body}`);
            assert.equal(wrongOperation.ok, false);
            assert.equal(wrongOperation.problem?.type, "https://problems.plurnk.xyz/agui/action/invalid-action-parameters");
            assert.equal(wrongOperation.problem?.detail, `op.look parsed ${operation}; the single statement must be LOOK.`);
        }

        const bounded = await invoke("text ## LOOK0 (worker:///x)");
        assert.equal(bounded.ok, false);
        assert.deepEqual(bounded.problem, {
            type: "https://problems.plurnk.xyz/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "unexpected text before PLAN; expected PLAN heading `# PLANdelimiter`, H2 operation heading `## OPdelimiter`, or H2 client heading `## OPdelimiter`",
            line: 1,
            column: 0,
            source: "parser",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });

        const tailed = await invoke("## LOOK0 (worker:///x)\n\n## EDIT0 (worker:///y");
        assert.equal(tailed.ok, false);
        assert.deepEqual(tailed.problem, {
            type: "https://problems.plurnk.xyz/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "target slot of `## EDIT0` opened at line 3 but never closed - add `)`",
            line: 3,
            column: 0,
            source: "grammar",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });
        assert.equal(calls.length, 1, "no rejected parse reaches ApplicationPort.look");
    } finally { await mod.close(); }
});

// {§agui-op-parse} {§unparsed-tail-boundary}
test("#127: op.parse dispatches only the trusted prefix and appends one parser-owned tail failure", async () => {
    const { seam } = mockSeam();
    const dispatched: Parameters<ApplicationPort["dispatchClientAction"]>[0]["statements"][] = [];
    seam.dispatchClientAction = async ({ statements }) => {
        dispatched.push(statements);
        return statements.map(() => ({ status: 201 }));
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const text = "## EDIT0 (worker:///ok)\nyes\n\n## EDIT0 (worker:///bad";
        const events = await post(mod.address().port, {
            threadId: "parse-tail",
            runId: "parse-tail-run",
            forwardedProps: {
                plurnk: {
                    workspace: "parse-tail",
                    action: { kind: "op.parse", text },
                },
            },
        });
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: {
                result?: {
                    results?: Array<{
                        status?: number;
                        problem?: Record<string, unknown>;
                    }>;
                };
            };
        } | undefined;

        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].length, 1, "the recovered tail statement is not dispatched");
        assert.equal(dispatched[0][0].op, "EDIT");
        assert.equal(dispatched[0][0].target?.raw, "worker:///ok");

        const results = event?.value?.result?.results;
        assert.deepEqual(results?.map(({ status }) => status), [201, 400]);
        assert.deepEqual(results?.[1]?.problem, {
            type: "https://problems.plurnk.xyz/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "target slot of `## EDIT0` opened at line 4 but never closed - add `)`",
            line: 4,
            column: 0,
            source: "grammar",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });
    } finally { await mod.close(); }
});

test("a module action colliding with an AG-UI built-in fails module startup", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "ping",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    await assert.rejects(
        () => Module.init({ host: "127.0.0.1", port: 0 }).start(seam),
        /AG-UI action 'ping' is registered more than once/,
    );
});

test("module actions are advertised and invoked without AG-UI importing their owner", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        name: string;
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (name, params, context) => {
        calls.push({
            name,
            params,
            context,
        });
        return {
            prompt: "review",
        };
    };
    const mod = await Module.init({
        host: "127.0.0.1",
        port: 0,
    }).start(seam);
    try {
        const discovered = await post(mod.address().port, {
            threadId: "module-discover",
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "discover",
                    },
                },
            },
        });
        const discovery = discovered.find(
            (event) => event.type === "CUSTOM"
                && (event as { name: string }).name === "plurnk.action.result",
        ) as {
            value: {
                result: {
                    actions: Record<string, { scope: string; inputSchema: unknown; outputSchema: unknown }>;
                };
            };
        };
        assert.deepEqual(discovery.value.result.actions["example.inspect"], {
            scope: "worldless",
            inputSchema: MODULE_INPUT_SCHEMA,
            outputSchema: MODULE_OUTPUT_SCHEMA,
        });

        const invoked = await post(mod.address().port, {
            threadId: "module-action",
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "example.inspect",
                        target: "sample",
                    },
                },
            },
        });
        const result = invoked.find(
            (event) => event.type === "CUSTOM"
                && (event as { name: string }).name === "plurnk.action.result",
        ) as {
            value: {
                ok: boolean;
                result: {
                    prompt: string;
                };
            };
        };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.prompt, "review");
        assert.deepEqual(calls, [{
            name: "example.inspect",
            params: {
                target: "sample",
            },
            context: { scope: "worldless" },
        }]);
    } finally {
        await mod.close();
    }
});

// {§agui-action-schema-enforcement}
test("advertised action schemas admit inputs and reject undeclared parameters before dispatch", async () => {
    const { seam } = mockSeam();
    let calls = 0;
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: {
            type: "object",
            required: ["target"],
            additionalProperties: false,
            properties: { target: { type: "string", minLength: 1 } },
        },
        outputSchema: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: { prompt: { type: "string" } },
        },
    }];
    seam.invokeModuleAction = async () => {
        calls++;
        return { prompt: "review" };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const rejected = await post(mod.address().port, {
            threadId: "module-schema-reject",
            forwardedProps: { plurnk: { action: { kind: "example.inspect", target: "x", surprise: true } } },
        });
        const failure = rejected.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { status?: number; type?: string } };
        } | undefined;
        assert.equal(failure?.value?.ok, false);
        assert.equal(failure?.value?.problem?.status, 400);
        assert.equal(failure?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/invalid-action-parameters");
        assert.equal(calls, 0, "the owner never receives schema-invalid parameters");

        const accepted = await post(mod.address().port, {
            threadId: "module-schema-admit",
            forwardedProps: { plurnk: { action: { kind: "example.inspect", target: "x" } } },
        });
        const success = accepted.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { prompt?: string } };
        } | undefined;
        assert.equal(success?.value?.ok, true);
        assert.equal(success?.value?.result?.prompt, "review");
        assert.equal(calls, 1);
    } finally { await mod.close(); }
});

// {§agui-action-schema-enforcement}
test("an owner output violating its advertised schema fails at the AG-UI boundary", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: { prompt: { type: "string" } },
        },
    }];
    seam.invokeModuleAction = async () => ({ prompt: 42 });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-output-schema",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const failure = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { status?: number; type?: string } };
        } | undefined;
        assert.equal(failure?.value?.ok, false);
        assert.equal(failure?.value?.problem?.status, 500);
        assert.equal(failure?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
    } finally { await mod.close(); }
});

test("workspace module actions receive authority from the bound AG-UI envelope", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.configure",
        scope: "workspace",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (_name, params, context) => {
        calls.push({ params, context });
        return { configured: true };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-workspace",
            forwardedProps: {
                plurnk: {
                    workspace: "trusted-world",
                    action: {
                        kind: "example.configure",
                        workspaceId: 999,
                    },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { configured?: boolean } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.configured, true);
        assert.deepEqual(calls, [{
            params: { workspaceId: 999 },
            context: { scope: "workspace", workspaceId: 3 },
        }]);
    } finally { await mod.close(); }
});

test("worker module actions receive authority from the bound AG-UI conversation", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.worker.configure",
        scope: "worker",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (_name, params, context) => {
        calls.push({ params, context });
        return { configured: true };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-worker",
            forwardedProps: {
                plurnk: {
                    workspace: "trusted-world",
                    action: {
                        kind: "example.worker.configure",
                        workspaceId: 999,
                        workerId: 999,
                    },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { configured?: boolean } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.configured, true);
        assert.deepEqual(calls, [{
            params: { workspaceId: 999, workerId: 999 },
            context: { scope: "worker", workspaceId: 3, workerId: 77 },
        }]);
    } finally { await mod.close(); }
});

test("a module action preserves its owner-defined validation Problem", async () => {
    const { seam } = mockSeam();
    const problem = Problems.create(
        "example:inspect",
        "target-required",
        400,
        "A target is required.",
        { field: "target", stage: "validation", retryable: false },
    );
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async () => {
        throw Object.assign(new Error(problem.detail), { problem });
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-action-validation",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: typeof problem };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.deepEqual(result?.value?.problem, problem);
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    } finally { await mod.close(); }
});

test("a throwing module action becomes one generic action Problem and a completed AG-UI Run", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async () => { throw new Error("private extension detail"); };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-action-failure",
            runId: "module-action-failure-run",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { type?: string; detail?: string } };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.equal(result?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
        assert.doesNotMatch(result?.value?.problem?.detail ?? "", /private extension detail/);
        assert.equal(events.at(-1)?.type, "RUN_FINISHED", "a management failure is the action result, not a failed AG-UI transport Run");
    } finally { await mod.close(); }
});

test("an action failure preserves its originating Problem instead of rebuilding it at the client boundary", async () => {
    const { seam } = mockSeam();
    const problem = Problems.create(
        "file:read",
        "target-not-found",
        404,
        "No entry exists at the requested target.",
        {
            stage: "read",
            target: "file:///missing.txt",
            recovery: "Use FIND to select an available target.",
            retryable: false,
        },
    );
    seam.readEntry = async () => ({ status: problem.status, problem, entry: null });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "action-problem",
            runId: "action-problem-run",
            forwardedProps: {
                plurnk: {
                    workspace: "action-problem",
                    action: { kind: "entry.read", target: "file:///missing.txt" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: typeof problem };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.deepEqual(result?.value?.problem, problem);
    } finally { await mod.close(); }
});

test("a loop-owned proposal cannot terminate a concurrent loop.inject action Run", async () => {
    const { seam, emit } = mockSeam();
    const conversationStarted = Promise.withResolvers<void>();
    const injectionStarted = Promise.withResolvers<void>();
    const releaseInjection = Promise.withResolvers<void>();
    let runs = 0;
    seam.createWorkspace = async () => ({
        workspaceId: 3,
        workspaceName: "interrupt-ownership",
        projectRoot: null,
        workerId: 10,
        workerName: "client-1",
    });
    seam.runLoop = async () => {
        runs += 1;
        if (runs === 1) {
            conversationStarted.resolve();
            return { status: 100, action: "enqueued_new_loop", loopId: 9 };
        }
        injectionStarted.resolve();
        await releaseInjection.promise;
        return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const conversation = openStream(port, {
            threadId: "interrupt-ownership",
            runId: "conversation-run",
            messages: [{ role: "user", content: "research the project" }],
            forwardedProps: { plurnk: { workspace: "interrupt-ownership" } },
        });
        await waitForFixture(
            conversationStarted.promise,
            () => "the conversation Run never reached runLoop",
        );
        await new Promise((resolve) => setImmediate(resolve));

        const injection = openStream(port, {
            threadId: "interrupt-ownership",
            runId: "injection-run",
            forwardedProps: {
                plurnk: {
                    workspace: "interrupt-ownership",
                    action: { kind: "loop.inject", prompt: "I am plurnk_pk" },
                },
            },
        });
        await waitForFixture(
            injectionStarted.promise,
            () => "the injection action never reached runLoop",
        );

        emit(3, "loop/proposal", {
            logEntryId: 42,
            workerId: 20,
            loopId: 9,
            turnId: 1,
            op: "EXEC",
            target: { scheme: "gitea", authority: null, pathname: "search_repos" },
            body: "{}",
            attrs: {},
            flags: DEFAULT_LOOP_FLAGS,
            disposition: { owner: "client" },
        });
        releaseInjection.resolve();

        const [conversationEvents, injectionEvents] = await Promise.all([
            conversation,
            injection,
        ]);
        assert.equal(
            (conversationEvents.at(-1) as { outcome?: { type?: string } }).outcome?.type,
            "interrupt",
            "the proposal still interrupts its owning conversation Run",
        );
        assert.equal(
            injectionEvents.some((event) => event.type.startsWith("TOOL_CALL")),
            false,
            "the loop-owned proposal does not leak into the concurrent action Run",
        );
        const result = injectionEvents.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { kind?: string; ok?: boolean; result?: { action?: string } };
        } | undefined;
        assert.deepEqual(result?.value, {
            kind: "loop.inject",
            ok: true,
            result: {
                status: 100,
                action: "injected_next_turn",
                loopId: 9,
                turnSeq: 2,
            },
        });
        assert.equal(injectionEvents.at(-1)?.type, "RUN_FINISHED");
    } finally {
        releaseInjection.resolve();
        await mod.close();
    }
});

test("an unexpected action exception becomes one generic Problem without leaking its message", async () => {
    const { seam } = mockSeam();
    seam.readEntry = async () => { throw new Error("private adapter detail"); };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "action-failure",
            runId: "action-failure-run",
            forwardedProps: {
                plurnk: {
                    workspace: "action-failure",
                    action: { kind: "entry.read", target: "file:///missing.txt" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { type?: string; detail?: string; stage?: string } };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.equal(result?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
        assert.equal(result?.value?.problem?.detail, "The action failed unexpectedly.");
        assert.equal(result?.value?.problem?.stage, "action-execution");
        assert.doesNotMatch(JSON.stringify(events), /private adapter detail/);
    } finally { await mod.close(); }
});

test("a streaming action remains open until its stream concludes", async () => {
    const { seam, emit } = mockSeam();
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { dispatched = resolve; });
    let release!: () => void;
    const dispatchReleased = new Promise<void>((resolve) => { release = resolve; });
    seam.dispatchClientAction = async () => {
        dispatched();
        await dispatchReleased;
        return [{ status: 200 }];
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        let settled = false;
        const run = openStream(mod.address().port, {
            threadId: "streaming-action",
            runId: "streaming-action-run",
            forwardedProps: { plurnk: { workspace: "streaming-action", action: { kind: "op.exec", command: "printf done" } } },
        }).then((events) => {
            settled = true;
            return events;
        });

        await dispatchStarted;
        emit(3, "stream/event", streamEvent({ entryId: 81, target: "sh:///1/1/81", scheme: "sh", channel: "stdout", contentLength: 4 }));
        release();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "the action result cannot terminate its AG-UI Run while its spawned stream is active");

        emit(3, "stream/concluded", streamConclusion({ entryId: 81, target: "sh:///1/1/81", scheme: "sh", summary: "done" }));
        const events = await run;
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
        assert.ok(events.some((event) => event.type === "CUSTOM" && (event as { name?: string }).name === "plurnk.action.result"));
        assert.ok(events.some((event) => event.type === "ACTIVITY_SNAPSHOT" && (event as { messageId?: string }).messageId === "stream-81"));
    } finally { await mod.close(); }
});

test("client hangup cancels an unfinished streaming action instead of detaching it", async () => {
    const { seam, emit } = mockSeam();
    let dispatched!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { dispatched = resolve; });
    let release!: () => void;
    const dispatchReleased = new Promise<void>((resolve) => { release = resolve; });
    let cancelled!: (value: { workerId: number; reason?: string }) => void;
    const cancellation = new Promise<{ workerId: number; reason?: string }>((resolve) => { cancelled = resolve; });
    seam.dispatchClientAction = async () => {
        dispatched();
        await dispatchReleased;
        return [{ status: 200 }];
    };
    seam.cancelDrain = (workerId, reason) => {
        cancelled({ workerId, ...(reason !== undefined ? { reason } : {}) });
        return true;
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const ac = new AbortController();
        const response = await fetch(`http://127.0.0.1:${mod.address().port}/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: ac.signal,
            body: JSON.stringify(standardInput({
                threadId: "abandoned-action",
                runId: "abandoned-action-run",
                forwardedProps: { plurnk: { workspace: "abandoned-action", action: { kind: "op.exec", command: "sleep 60" } } },
            })),
        });
        assert.equal(response.status, 200);
        const body = response.text();
        await dispatchStarted;
        emit(3, "stream/event", streamEvent({ entryId: 82, target: "sh:///1/1/82", scheme: "sh", channel: "stdout", contentLength: 1 }));
        release();
        await new Promise((resolve) => setImmediate(resolve));
        ac.abort();
        await assert.rejects(body, { name: "AbortError" });
        assert.deepEqual(await cancellation, { workerId: 10, reason: "client_disconnected" });
    } finally { await mod.close(); }
});

test("a standard resume resolves the paused proposal without driving a new loop", async () => {
    const { seam, resolves } = mockSeam();
    seam.pendingProposals = async () => [{
        logEntryId: 42,
        workerId: 77,
        loopId: 1,
        turnId: 1,
        op: "EDIT",
        target: { scheme: "file", authority: null, pathname: "a" },
        body: "diff",
        attrs: {},
        flags: DEFAULT_LOOP_FLAGS,
        disposition: { owner: "client" },
    }];
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "t2", runId: "r1", forwardedProps: { plurnk: { workspace: "t2" } },
            resume: [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept", body: "edited" } }],
        });
        assert.equal(events[0].type, "RUN_STARTED");
        assert.deepEqual(resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } }, `the resume reached resolveProposal: ${JSON.stringify(events)}`);
    } finally { await mod.close(); }
});

test("a generic client interaction round-trips through standard AG-UI interrupt and resume", async () => {
    const { seam, emit, loopRuns } = mockSeam();
    let pending = [{
        interactionId: 88,
        workerId: 77,
        loopId: 6,
        turnId: 9,
        request: {
            toolName: "choose_color",
            arguments: { palette: "warm" },
            message: "Choose one color.",
            responseSchema: {
                type: "object",
                properties: { color: { type: "string" } },
                required: ["color"],
            },
        },
    }];
    const resolutions: unknown[] = [];
    seam.pendingClientInteractions = async () => pending;
    seam.resolveClientInteraction = async (interactionId, resolution) => {
        resolutions.push({ interactionId, resolution });
        pending = [];
        setImmediate(() => emit(3, "loop/terminated", termination({
            workerId: 77,
            loopId: 6,
            turnIds: [9],
            usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
        })));
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const interrupted = await post(mod.address().port, {
            threadId: "interaction-thread",
            runId: "interaction-a",
            messages: [{ role: "user", content: "continue" }],
            forwardedProps: { plurnk: { workspace: "interaction-thread" } },
        });
        assert.deepEqual(
            interrupted.filter((event) => event.type.startsWith("TOOL_CALL")),
            [
                { type: "TOOL_CALL_START", toolCallId: "int:88", toolCallName: "choose_color" },
                { type: "TOOL_CALL_ARGS", toolCallId: "int:88", delta: JSON.stringify({ palette: "warm" }) },
                { type: "TOOL_CALL_END", toolCallId: "int:88" },
            ],
        );
        const terminal = interrupted.at(-1) as {
            type?: string;
            outcome?: { type?: string; interrupts?: unknown[] };
        };
        assert.equal(terminal.type, "RUN_FINISHED");
        assert.deepEqual(terminal.outcome, {
            type: "interrupt",
            interrupts: [{
                id: "int:88",
                reason: "tool_call",
                toolCallId: "int:88",
                message: "Choose one color.",
                responseSchema: pending[0].request.responseSchema,
            }],
        });
        assert.equal(loopRuns.length, 0, "re-surfacing pending input does not start new model work");

        const resumed = await post(mod.address().port, {
            threadId: "interaction-thread",
            runId: "interaction-b",
            forwardedProps: { plurnk: { workspace: "interaction-thread" } },
            resume: [{
                interruptId: "int:88",
                status: "resolved",
                payload: { color: "orange" },
            }],
        });
        assert.deepEqual(resolutions, [{
            interactionId: 88,
            resolution: { status: "resolved", payload: { color: "orange" } },
        }]);
        assert.equal(resumed.at(-1)?.type, "RUN_FINISHED");
    } finally {
        await mod.close();
    }
});

test("PLURNK PARADIGM: the name IS the identity — no prefix, no forging, attach is real", async () => {
    const created: Array<{ name?: string }> = [];
    const attached: number[] = [];
    const { seam } = mockSeam();
    const base = seam.createWorkspace.bind(seam);
    seam.createWorkspace = async (args) => { created.push(args); return { ...(await base(args)), workspaceName: args.name ?? "workspace-1" }; };
    seam.attachWorkspace = async (args) => { attached.push(args.workspaceId); return { workspaceId: args.workspaceId, workspaceName: "alpha", projectRoot: null, workerId: 10, workerName: "client-1" }; };
    seam.listWorkspaces = async () => [workspaceRow(4, "alpha")];
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        // 1) A workspace named like an existing world attaches to IT — the exact name.
        // (A world-scoped action binds the workspace; a control-plane one would not.)
        const run = await post(mod.address().port, { threadId: "alpha", workerId: "r1", forwardedProps: { plurnk: { workspace: "alpha", action: { kind: "workspace.members" } } } });
        assert.equal(run[run.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(attached, [4], "workspace 'alpha' attached the world 'alpha' — no agui- prefix lookup");
        // 2) A new workspace name creates a world with EXACTLY that name.
        await post(mod.address().port, { threadId: "beta", workerId: "r2", forwardedProps: { plurnk: { workspace: "beta", action: { kind: "workspace.members" } } } });
        assert.deepEqual(created.map((c) => c.name), ["beta"], "created verbatim — never 'agui-beta', never a uuid");
        // 3) workspace.attach is a REAL action kind returning the envelope.
        const att = await post(mod.address().port, { threadId: "alpha", workerId: "r3", forwardedProps: { plurnk: { workspace: "alpha", action: { kind: "workspace.attach", id: 4 } } } });
        const result = att.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { id: number; name: string; workerId: number } } };
        assert.equal(result.value.ok, true, "workspace.attach is wired, not unknown-kind");
        assert.deepEqual(
            result.value.result,
            { id: 4, name: "alpha", workerId: 10 },
            "{§agui-thread-binding} #64: attach returns the selected client worker, never a fabricated conversation binding",
        );
    } finally { await mod.close(); }
});

test("reattach replays PLAN as activity and SEND as speech through the thread router", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1" });
    seam.readLog = async () => [
        { id: 1, coordinate: "1/1/1/PLAN", op: "PLAN", origin: "model", turn_id: 1, sequence: 1, tx: { body: [
            { content: "Inspect, repair, and verify.", status: "in_progress" },
        ] } },
        { id: 2, coordinate: "1/1/2/SEND", op: "SEND", origin: "model", turn_id: 1, sequence: 2, tx: { body: "checkpoint complete" } },
        { id: 3, coordinate: "1/1/3", op: null, origin: "model", turn_id: 1, sequence: 3, attrs: { kind: "turnOps", reasoning: [
            { id: "provider-detail", subtype: "message", encrypted: [{ data: "OPAQUE", format: "openai-responses-v1" }] },
        ] } },
    ];
    seam.runLoop = async (args) => {
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "workspace",
            runId: "reattach-1",
            messages: [{ role: "user", content: "continue" }],
            forwardedProps: { plurnk: { workspace: "workspace" } },
        });
        const snapshot = events.find((event) => event.type === "MESSAGES_SNAPSHOT") as { messages?: unknown[] } | undefined;
        assert.deepEqual(snapshot?.messages, [
            { id: "workspace/plan", role: "activity", activityType: "PLAN", content: {
                entries: [{ content: "Inspect, repair, and verify.", priority: "medium", status: "in_progress" }],
            } },
            { id: "1/1/2/SEND", role: "assistant", content: "checkpoint complete", encryptedValue: "OPAQUE" },
        ]);
    } finally { await mod.close(); }
});

test("WORKSPACE=WORLD, AG-UI THREAD=CONVERSATION: the workspace prop selects the world; the thread resolves to a worker", async () => {
    const attaches: number[] = [];
    const created: Array<{ name?: string; projectRoot?: string | null }> = [];
    const ensured: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(7, "workspace-a")];
    seam.attachWorkspace = async (a) => { attaches.push(a.workspaceId); return { workspaceId: a.workspaceId, workspaceName: "workspace-a", projectRoot: "/w", workerId: 100, workerName: "client-1" }; };
    seam.createWorkspace = async (a) => { created.push(a); return { workspaceId: 8, workspaceName: a.name ?? "workspace-1", projectRoot: a.projectRoot ?? null, workerId: 101, workerName: "client-1" }; };
    seam.ensureModelWorker = async (sid) => { ensured.push(sid); return sid === 7 ? 200 : 201; };
    seam.createConversationWorker = async (a) => ({ workerId: 300, workerName: a.name ?? "x" });
    const drivenRuns: number[] = [];
    seam.runLoop = async (a) => { drivenRuns.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        // The `workspace` workspace prop selects the WORLD — not the threadId. Two
        // distinct threads naming the SAME workspace share the one workspace.
        await post(mod.address().port, { threadId: "chat-1", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace-a" } } });
        assert.deepEqual(attaches, [7], "the workspace 'workspace-a' was attached (not a workspace named 'chat-1')");
        assert.deepEqual(ensured, [], "a DISTINCT thread never binds the model worker (that's the default thread's door)");
        assert.deepEqual(drivenRuns, [300], "the loop drove in the thread's own conversation worker");
    } finally { await mod.close(); }
});

test("NO workspace prop is a 400 Problem - a worker has no world to forge from the threadId", async () => {
    let created = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c" }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "solo", runId: "r1", messages: [{ role: "user", content: "hi" }] })) });
        assert.equal(res.status, 400, "the missing workspace is a request defect, not an internal failure");
        assert.equal(res.headers.get("content-type"), "application/problem+json");
        const body = await res.json() as { type: string; status: number; detail: string; stage: string; recovery: string; retryable: boolean };
        assert.equal(body.type, "https://problems.plurnk.xyz/agui/http/workspace-required");
        assert.equal(body.status, 400);
        assert.match(body.detail, /forwardedProps\.plurnk\.workspace must name a workspace/);
        assert.equal(body.stage, "request-validation");
        assert.equal(body.recovery, "Provide a non-empty workspace name.");
        assert.equal(body.retryable, false);
        assert.doesNotMatch(body.detail, /world|existence/, "the error states the contract, never the machine-model philosophy");
        assert.equal(created, 0, "NO workspace was forged from the threadId");
    } finally { await mod.close(); }
});

test("PLURNK-owned HTTP failures use application/problem+json with stable Problems", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({
        host: "127.0.0.1",
        port: 0,
        env: {
            PLURNK_AGUI_TOKEN: "expected",
            PLURNK_AGUI_HEARTBEAT_MS: "0",
        },
    }).start(seam);
    const base = `http://127.0.0.1:${mod.address().port}`;
    const problem = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
        const response = await fetch(`${base}${path}`, init);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.status, response.status);
        return body;
    };
    try {
        const unauthorized = await problem("/", { method: "POST", body: "{}" });
        assert.equal(unauthorized.type, "https://problems.plurnk.xyz/agui/http/bearer-token-required");
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.stage, "authorization");

        const invalidJson = await problem("/", {
            method: "POST",
            headers: { authorization: "Bearer expected", "content-type": "application/json" },
            body: "{",
        });
        assert.equal(invalidJson.type, "https://problems.plurnk.xyz/agui/http/invalid-json");
        assert.equal(invalidJson.status, 400);
        assert.equal(invalidJson.stage, "request-validation");

        const invalidInput = await problem("/", {
            method: "POST",
            headers: { authorization: "Bearer expected", "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(invalidInput.type, "https://problems.plurnk.xyz/agui/http/invalid-run-input");
        assert.ok(Array.isArray(invalidInput.issues));

        const missingRoute = await problem("/missing", {
            method: "GET",
            headers: { authorization: "Bearer expected" },
        });
        assert.equal(missingRoute.type, "https://problems.plurnk.xyz/agui/http/route-not-found");
        assert.equal(missingRoute.path, "/missing");
    } finally { await mod.close(); }
});

test("CONTROL PLANE: a worldless action needs NO workspace and FORGES none", async () => {
    let created = 0, ensured = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(1, "a"), workspaceRow(2, "b")];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c" }; };
    seam.ensureModelWorker = async () => { ensured++; return 2; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        // workspace.list with NO workspace prop — control plane, so no world required, none forged.
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "workspace.list" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { workspaces: unknown[] } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.workspaces.length, 2, "listed the real workspaces");
        assert.equal(ev[ev.length - 1].type, "RUN_FINISHED");
        assert.equal(created, 0, "no ephemeral workspace was created");
        assert.equal(ensured, 0, "no model worker was spun for a control-plane action");
    } finally { await mod.close(); }
});

test("run.fork admits the contract's anonymous-fork form", async () => {
    const { seam } = mockSeam();
    const calls: Parameters<ApplicationPort["forkWorker"]>[0][] = [];
    seam.forkWorker = async (args) => {
        calls.push(args);
        return { workerId: 11, workerName: "main-fork", parentWorkerId: args.workerId };
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "anonymous-fork",
            forwardedProps: {
                plurnk: {
                    workspace: "anonymous-fork",
                    action: { kind: "run.fork" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { workerName?: string | null } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.workerName, "main-fork");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, undefined);
    } finally { await mod.close(); }
});

test("discover returns the exact public action and notification membership", async () => {
    const { seam } = mockSeam();
    seam.listClientDisplayCapabilities = async () => [
        { kind: "scheme", scheme: "https", display: { glyph: "🌐" } },
        { kind: "mimetype", mimetype: "text/html", display: { glyph: "󰖟" } },
    ];
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "discover" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { schemaVersion: number; actions: Record<string, { scope: string; inputSchema: unknown; outputSchema: unknown }>; notifications: Record<string, { payloadSchema: unknown }>; display: unknown[] } } };
        assert.equal(r.value.ok, true);
        assert.deepEqual(Object.keys(r.value.result).toSorted(), ["actions", "display", "notifications", "schemaVersion"]);
        assert.equal(r.value.result.schemaVersion, 1);
        assert.deepEqual(r.value.result.display, [
            { kind: "scheme", scheme: "https", display: { glyph: "🌐" } },
            { kind: "mimetype", mimetype: "text/html", display: { glyph: "󰖟" } },
        ]);
        assert.deepEqual(Object.keys(r.value.result.actions).toSorted(), [
            "discover",
            "entry.read",
            "log.read",
            "loop.cancel",
            "loop.inject",
            "models.list",
            "op.exec",
            "op.look",
            "op.parse",
            "ping",
            "providers.list",
            "run.fork",
            "worker.child.set",
            "worker.model.get",
            "worker.model.set",
            "worker.reasoning.get",
            "worker.reasoning.set",
            "worker.settings.get",
            "worker.settings.set",
            "workspace.attach",
            "workspace.constrain",
            "workspace.constraints",
            "workspace.create",
            "workspace.derivation",
            "workspace.list",
            "workspace.members",
            "workspace.prompts",
            "workspace.rename",
            "workspace.unconstrain",
            "workspace.workers",
        ]);
        assert.deepEqual(Object.keys(r.value.result.notifications).toSorted(), [
            "log/entry",
            "loop/interaction",
            "loop/packet",
            "loop/proposal",
            "loop/terminated",
            "notice/event",
            "reasoning/event",
            "stream/concluded",
            "stream/event",
            "workspace/branch-batch",
        ]);
        for (const action of Object.values(r.value.result.actions)) {
            assert.ok(action.scope === "worldless" || action.scope === "workspace");
            assert.equal(typeof action.inputSchema, "object");
            assert.equal(typeof action.outputSchema, "object");
        }
        for (const notification of Object.values(r.value.result.notifications)) {
            assert.equal(typeof notification.payloadSchema, "object");
        }
    } finally { await mod.close(); }
});

test("workspace.create WITH a name is worldless and does NOT demand a pre-bound workspace (regression)", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => ({ workspaceId: 12, workspaceName: a.name ?? "auto", projectRoot: null, workerId: 3, workerName: "client-1" });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        // No forwardedProps.plurnk.workspace on the worker itself — workspace.create supplies its own world.
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "workspace.create", name: "fresh-world" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { name: string } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.name, "fresh-world", "created the named world, no workspace-required throw");
    } finally { await mod.close(); }
});

test("loop.cancel is a REAL action kind — cancels the model worker's drain (both clients' stop buttons ride it)", async () => {
    const cancelled: Array<{ workerId: number; reason?: string }> = [];
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    seam.cancelDrain = (workerId, reason) => {
        cancelled.push({ workerId, ...(reason === undefined ? {} : { reason }) });
        return true;
    };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "w", workerId: "r1", forwardedProps: { plurnk: { workspace: "w", action: { kind: "loop.cancel", reason: "user_stop" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { cancelled: boolean } } };
        assert.equal(r.value.ok, true, "loop.cancel must be a known kind");
        assert.equal(r.value.result.cancelled, true);
        assert.deepEqual(cancelled, [{ workerId: 20, reason: "user_stop" }], "the MODEL worker's drain was cancelled with the client's reason");
    } finally { await mod.close(); }
});

// {§agui-thread-binding} AG-UI THREAD ↔ CORE WORKER: threadId is the conversation.
// threadId == workspace name → the model worker (the default conversation, unchanged).
// A DISTINCT threadId names its own conversation worker within the world: found by
// name if it exists, minted via createConversationWorker if it doesn't — the name is
// the identity at BOTH levels. Forks (named workers) are addressable as threads.

test("a distinct threadId MINTS a conversation worker named for it, and the loop drives there", async () => {
    const created: Array<{ workspaceId: number; name?: string }> = [];
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1" });
    seam.listWorkers = async () => [workerRow(20, "model-1")];
    seam.createConversationWorker = async (a) => { created.push(a); return { workerId: 77, workerName: a.name ?? "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "chat-2", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(created, [{ workspaceId: 3, name: "chat-2" }], "the conversation worker is named for the thread, verbatim");
        assert.deepEqual(driven, [77], "the loop drove in the NEW conversation worker, not the model worker");
    } finally { await mod.close(); }
});

test("a threadId naming an existing worker (a fork or prior conversation) binds it — no mint", async () => {
    let created = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1" });
    seam.listWorkers = async () => [workerRow(20, "model-1"), workerRow(44, "spike")];
    seam.createConversationWorker = async () => { created++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [44], "the existing worker 'spike' is the conversation");
        assert.equal(created, 0, "no duplicate conversation minted");
    } finally { await mod.close(); }
});

test("threadId == workspace name stays on the model worker (the default conversation)", async () => {
    let minted = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1" });
    seam.ensureModelWorker = async () => 20;
    seam.createConversationWorker = async () => { minted++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "workspace", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [20], "the default conversation is the model worker");
        assert.equal(minted, 0, "no fresh worker for the default thread");
    } finally { await mod.close(); }
});

test("loop.inject on a distinct thread folds into THAT conversation, never the model worker", async () => {
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1" });
    seam.listWorkers = async () => [workerRow(44, "spike")];
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", forwardedProps: { plurnk: { workspace: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.deepEqual(driven, [44], "the steer reached the thread's own worker");
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] the environment heartbeat cadence reaches the SSE listener", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    // A SLOW loop: no events for ~200ms (a long model generation), then terminated.
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId, a.workerId), 200); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({
        host: "127.0.0.1",
        port: 0,
        env: { PLURNK_AGUI_HEARTBEAT_MS: "40" },
    }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        const raw = await res.text();
        const beats = (raw.match(/^: hb$/gm) ?? []).length;
        assert.ok(beats >= 2, `the silent window carried heartbeats (got ${beats}) — no client bodyTimeout can starve mid-generate`);
        assert.match(raw, /RUN_FINISHED/, "the worker still ends clean");
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] heartbeat cadence 0 emits no comment frames", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId, a.workerId), 100); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({
        host: "127.0.0.1",
        port: 0,
        env: { PLURNK_AGUI_HEARTBEAT_MS: "0" },
    }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        assert.doesNotMatch(await res.text(), /^: hb$/m);
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] the environment turn default yields to the Run value", async () => {
    const observed: Array<number | undefined> = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    seam.runLoop = async (args) => {
        observed.push(args.maxTurns);
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await Module.init({
        host: "127.0.0.1",
        port: 0,
        env: {
            PLURNK_AGUI_MAX_TURNS: "7",
            PLURNK_AGUI_HEARTBEAT_MS: "0",
        },
    }).start(seam);
    try {
        const input = { threadId: "w", messages: [{ role: "user", content: "continue" }], forwardedProps: { plurnk: { workspace: "w" } } };
        await post(mod.address().port, input);
        await post(mod.address().port, {
            ...input,
            forwardedProps: { plurnk: { workspace: "w", maxTurns: 2 } },
        });
        assert.deepEqual(observed, [7, 2]);
    } finally { await mod.close(); }
});


test("a message AG-UI Run forwards parent and child provider selection into runLoop", async () => {
    const { seam, loopRuns, finish } = mockSeam();
    // The worker self-completes: the runLoop override closes the stream for its workspace (the working
    // message-drive pattern above), so the POST resolves.
    seam.runLoop = async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.childSelector !== undefined ? { childSelector: a.childSelector } : {}) }); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, {
            threadId: "t-model", workerId: "r1",
            forwardedProps: { plurnk: { workspace: "t-model", selector: "fireslow", childSelector: "firefast" } },
            messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(loopRuns.length, 1, "the message drove one runLoop");
        assert.equal(loopRuns[0].selector, "fireslow", "the parent selector forwards off forwardedProps.plurnk");
        assert.equal(loopRuns[0].childSelector, "firefast", "the child selector rides the same per-loop wire");
    } finally { await mod.close(); }
});

test("a post-headers runLoop failure preserves its exact Problem in the terminal SSE frames", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    const problem = Problems.create(
        "daemon:provider",
        "not-configured",
        501,
        "No model provider is configured for this AG-UI Run.",
        {
            stage: "provider-selection",
            recovery: "Configure or select an available model provider.",
            retryable: false,
            alias: "missing",
        },
    );
    seam.runLoop = async () => {
        throw Object.assign(new Error(problem.detail), { result: { status: problem.status, problem } });
    };
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        assert.equal(res.status, 200, "the SSE opened before the throw");
        const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { type: string; message?: string; code?: string });
        const err = frames.find((e) => e.type === "RUN_ERROR");
        assert.ok(err !== undefined, "the throw surfaced as a RUN_ERROR frame, not a silent end");
        assert.equal(err.message, problem.detail);
        assert.equal(err.code, problem.type, "RUN_ERROR code projects the exact Problem type");
        const exact = frames.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.problem") as {
            value?: typeof problem;
        } | undefined;
        assert.deepEqual(exact?.value, problem, "the lossless custom event preserves every Problem field");
        // The leak pin: the error path must release the AG-UI Run's handles (heartbeat
        // interval, portal binding) — a survivor here wedges `node --test` (no
        // force-exit in the drill) forever.
        const timeouts = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
        assert.equal(timeouts, before, "no timer survives the errored AG-UI Run");
    } finally { await mod.close(); }
});

test("an unexpected post-headers runLoop exception becomes one generic Problem without leaking its message", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    seam.runLoop = async () => { throw new Error("secret internal failure"); };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "w",
            runId: "r1",
            messages: [{ role: "user", content: "hi" }],
            forwardedProps: { plurnk: { workspace: "w" } },
        });
        const exact = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.problem") as {
            value?: { type?: string; detail?: string; stage?: string };
        } | undefined;
        assert.equal(exact?.value?.type, "https://problems.plurnk.xyz/agui/http/run-failed");
        assert.equal(exact?.value?.detail, "The AG-UI Run failed unexpectedly.");
        assert.equal(exact?.value?.stage, "run");
        assert.doesNotMatch(JSON.stringify(events), /secret internal failure/);
    } finally { await mod.close(); }
});

test("the AG-UI STANDARD face keeps the protocol's nouns: RUN_STARTED/RUN_FINISHED echo RunAgentInput.runId (never plurnk's workerId) — ungated, so a lexicon sweep can't silently break conformance", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c" });
    seam.ensureModelWorker = async () => 20;
    seam.runLoop = async (a) => { finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, { threadId: "w", runId: "agui-run-7", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        const started = events.find((e) => e.type === "RUN_STARTED") as { runId?: string; workerId?: unknown };
        const finished = events.find((e) => e.type === "RUN_FINISHED") as { runId?: string; workerId?: unknown };
        assert.equal(started?.runId, "agui-run-7", "RUN_STARTED echoes the protocol's runId");
        assert.equal(finished?.runId, "agui-run-7", "RUN_FINISHED echoes the protocol's runId");
        assert.equal(started?.workerId, undefined, "plurnk's worker noun NEVER rides the standard face");
        assert.equal(finished?.workerId, undefined, "plurnk's worker noun NEVER rides the standard face");
    } finally { await mod.close(); }
});
