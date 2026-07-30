// The module's HTTP surface against a mock seam (no daemon): §3 action runs execute
// via the seam and finish clean; unknown kinds error honestly; a resume tool-result
// resolves without driving a loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "./Module.ts";
import type { DaemonSeam, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";
import { Problems } from "@plurnk/plurnk-contracts";

const mockSeam = () => {
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const loopRuns: Array<{ alias?: string; model?: string; prompt: string }> = [];
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const seam: DaemonSeam = {
        listModuleActions: () => [],
        invokeModuleAction: async (name) => { throw new Error(`unexpected module action '${name}'`); },
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        resolveProposal: (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", { loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0, contextTokens: 2, promptBudget: 1000, meta: {} } })));
        },
        runLoop: async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.alias !== undefined ? { alias: a.alias } : {}), ...(a.model !== undefined ? { model: a.model } : {}) }); return { status: 100, action: "injected_next_turn" as const, loopId: 9, turnSeq: 2 }; },
        cancelDrain: () => true,
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        readLog: async () => [{ id: 1, op: "SEND", origin: "model" }],
        listProviders: () => ({ aliases: [{ alias: "opus", provider: "anthropic", model: "claude", active: true, promptBudget: 200000 }] }),
        createWorkspace: async () => ({ workspaceId: 3, workspaceName: "agui-t", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: null, clientLoopId: null }),
        attachWorkspace: async () => { throw new Error("unexpected attach"); },
        listWorkspaces: async () => [],
        listWorkers: async () => [{ id: 10, name: "client-1" }],
        ensureModelWorker: async () => 20,
        listPrompts: async () => ["hi"],
        renameWorkspace: async (_id, name) => ({ id: 3, name }),
        constrain: async (_id, effect, glob) => ({ effect, glob }),
        unconstrain: async (_id, effect, glob) => ({ effect, glob }),
        listConstraints: async () => [{ effect: "pick", glob: "src/**" }],
        workspaceDerivationStatus: () => null,
        readEntry: async () => ({ status: 200, entry: { body: "x" } }),
        forkWorker: async () => ({ workerId: 11, workerName: "fork-1", parentWorkerId: 10 }),
        createConversationWorker: async (a) => ({ workerId: 77, workerName: a.name ?? "model-fresh" }),
        listMembers: async () => ({ members: [{ path: "a.ts", effect: "member" }], hidden: [] }),
        look: async () => ({ status: 200, content: "looked" }),
    };
    const finish = (workspaceId: number | null) => setImmediate(() => handlers.forEach((h) => h(workspaceId, "loop/terminated", { loopId: 9, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0, contextTokens: 2, promptBudget: 1000, meta: {} } })));
    const emit = (workspaceId: number | null, method: string, params: unknown) => handlers.forEach((h) => h(workspaceId, method, params));
    return { seam, resolves, loopRuns, finish, emit };
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
// lets a test hold two concurrent runs on one workspace and observe fan-out live.
const openStream = (port: number, body: Record<string, unknown>): Promise<AguiEvent[]> =>
    fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(body)) })
        .then((res) => res.text())
        .then((text) => text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent));

test("a workspace's stream events FAN to every open run (never last-binder-wins) — svc#504", async () => {
    const { seam, emit } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 20, name: "model-1" }];
    seam.createConversationWorker = async (a) => ({ workerId: a.name === "chat-a" ? 77 : 78, workerName: a.name ?? "x" });
    // runLoop does NOT finish here: both streams stay open so the injected stream event
    // races them exactly as concurrent nvim action runs do against a resumed exec.
    seam.runLoop = async () => ({ status: 100, action: "enqueued_new_loop" as const, loopId: 9 });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const port = mod.address().port;
        const a = openStream(port, { threadId: "chat-a", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        const b = openStream(port, { threadId: "chat-b", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        // Let both runs bind their threads to workspace 3 before the event races them.
        await new Promise((r) => setTimeout(r, 60));
        emit(3, "stream/event", { entryId: 5, scheme: "exec", content: "alpha" });
        emit(3, "stream/concluded", { entryId: 5, result: { status: 200 } });
        emit(3, "loop/terminated", { loopId: 9, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0, contextTokens: 2, promptBudget: 1000, meta: {} } });
        const [ea, eb] = await Promise.all([a, b]);
        const hasExecActivity = (evs: AguiEvent[]) => evs.some((e) => e.type === "ACTIVITY_SNAPSHOT" && (e as { messageId?: string }).messageId === "stream-5");
        assert.ok(hasExecActivity(ea), "run A received the exec stream activity");
        assert.ok(hasExecActivity(eb), "run B received it TOO — the fan is a broadcast, not a single binding");
    } finally { await mod.close(); }
});

test("an action run executes via the seam: result custom + RUN_FINISHED, no loop", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const events = await post(mod.address().port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "providers.list" } } } });
        const result = events.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { kind: string; ok: boolean; result: { aliases: Array<{ alias: string }> } } };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.aliases[0].alias, "opus");
        assert.equal(events[events.length - 1].type, "RUN_FINISHED", "action run finishes clean");
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
        assert.equal(err.value.problem.type, "https://problems.plurnk.dev/agui/action/unknown-action");
        assert.equal(err.value.problem.detail, "Action 'nope.nothing' is not registered.");
        assert.equal(err.value.problem.requestedAction, "nope.nothing");
        assert.equal(err.value.problem.recovery, "Use an action advertised by discover.");
        assert.equal(err.value.problem.retryable, false);
        assert.doesNotMatch(err.value.problem.detail, /seam surface/, "no internal jargon leaks to the client");
    } finally { await mod.close(); }
});

test("module actions are advertised and invoked without AG-UI importing their owner", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        name: string;
        params: Readonly<Record<string, unknown>>;
    }> = [];
    seam.listModuleActions = () => ["mcp.prompt.get"];
    seam.invokeModuleAction = async (name, params) => {
        calls.push({
            name,
            params,
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
                    methods: Record<string, true>;
                };
            };
        };
        assert.equal(discovery.value.result.methods["mcp.prompt.get"], true);

        const invoked = await post(mod.address().port, {
            threadId: "module-action",
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "mcp.prompt.get",
                        server: "github",
                        name: "review",
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
            name: "mcp.prompt.get",
            params: {
                server: "github",
                name: "review",
            },
        }]);
    } finally {
        await mod.close();
    }
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
        assert.equal(result?.value?.problem?.type, "https://problems.plurnk.dev/agui/action/action-failed");
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
        emit(3, "stream/event", { entryId: 81, scheme: "sh", channel: "stdout", state: "active", contentLength: 4 });
        release();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "the action result cannot terminate its AG-UI run while its spawned stream is active");

        emit(3, "stream/concluded", { entryId: 81, scheme: "sh", result: { status: 200 }, summary: "done" });
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
        emit(3, "stream/event", { entryId: 82, scheme: "sh", channel: "stdout", state: "active", contentLength: 1 });
        release();
        await new Promise((resolve) => setImmediate(resolve));
        ac.abort();
        await assert.rejects(body, { name: "AbortError" });
        assert.deepEqual(await cancellation, { workerId: 10, reason: "client_disconnected" });
    } finally { await mod.close(); }
});

test("a standard resume resolves the paused proposal without driving a new loop", async () => {
    const { seam, resolves } = mockSeam();
    seam.pendingProposals = async () => [{ logEntryId: 42, workerId: 77, loopId: 1, turnId: 1, op: "EDIT", suffix: "", scheme: "file", pathname: "a", tx: "", attrs: null }];
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

test("PLURNK PARADIGM: the name IS the identity — no prefix, no forging, attach is real", async () => {
    const created: Array<{ name?: string }> = [];
    const attached: number[] = [];
    const { seam } = mockSeam();
    const base = seam.createWorkspace.bind(seam);
    seam.createWorkspace = async (args) => { created.push(args); return { ...(await base(args)), workspaceName: args.name ?? "workspace-1" }; };
    seam.attachWorkspace = async (args) => { attached.push(args.workspaceId); return { workspaceId: args.workspaceId, workspaceName: "alpha", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null }; };
    seam.listWorkspaces = async () => [{ id: 4, name: "alpha" }];
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
        const result = att.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { id: number; name: string } } };
        assert.equal(result.value.ok, true, "workspace.attach is wired, not unknown-kind");
        assert.equal(result.value.result.name, "alpha");
    } finally { await mod.close(); }
});

test("SESSION=WORKSPACE, THREAD=CONVERSATION: the workspace prop selects the world; the thread is a worker over it (svc#366 landed — the interim bind-the-model-run behavior is retired)", async () => {
    const attaches: number[] = [];
    const created: Array<{ name?: string; projectRoot?: string | null }> = [];
    const ensured: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 7, name: "workspace-a" }];
    seam.attachWorkspace = async (a) => { attaches.push(a.workspaceId); return { workspaceId: a.workspaceId, workspaceName: "workspace-a", projectRoot: "/w", workerId: 100, workerName: "client-1", modelWorkerId: 200, clientLoopId: null }; };
    seam.createWorkspace = async (a) => { created.push(a); return { workspaceId: 8, workspaceName: a.name ?? "workspace-1", projectRoot: a.projectRoot ?? null, workerId: 101, workerName: "client-1", modelWorkerId: 201, clientLoopId: null }; };
    seam.ensureModelWorker = async (sid) => { ensured.push(sid); return sid === 7 ? 200 : 201; };
    seam.createConversationWorker = async (a) => ({ workerId: 300, workerName: a.name ?? "x" });
    const drivenRuns: number[] = [];
    seam.runLoop = async (a) => { drivenRuns.push(a.workerId); finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
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
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c", modelWorkerId: 2, clientLoopId: null }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "solo", runId: "r1", messages: [{ role: "user", content: "hi" }] })) });
        assert.equal(res.status, 400, "the missing workspace is a request defect, not an internal failure");
        assert.equal(res.headers.get("content-type"), "application/problem+json");
        const body = await res.json() as { type: string; status: number; detail: string; stage: string; recovery: string; retryable: boolean };
        assert.equal(body.type, "https://problems.plurnk.dev/agui/http/workspace-required");
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
    const mod = await Module.init({ host: "127.0.0.1", port: 0, token: "expected" }).start(seam);
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
        assert.equal(unauthorized.type, "https://problems.plurnk.dev/agui/http/bearer-token-required");
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.stage, "authorization");

        const invalidJson = await problem("/", {
            method: "POST",
            headers: { authorization: "Bearer expected", "content-type": "application/json" },
            body: "{",
        });
        assert.equal(invalidJson.type, "https://problems.plurnk.dev/agui/http/invalid-json");
        assert.equal(invalidJson.status, 400);
        assert.equal(invalidJson.stage, "request-validation");

        const invalidInput = await problem("/", {
            method: "POST",
            headers: { authorization: "Bearer expected", "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(invalidInput.type, "https://problems.plurnk.dev/agui/http/invalid-run-input");
        assert.ok(Array.isArray(invalidInput.issues));

        const missingRoute = await problem("/missing", {
            method: "GET",
            headers: { authorization: "Bearer expected" },
        });
        assert.equal(missingRoute.type, "https://problems.plurnk.dev/agui/http/route-not-found");
        assert.equal(missingRoute.path, "/missing");
    } finally { await mod.close(); }
});

test("CONTROL PLANE: a worldless action needs NO workspace and FORGES none (operator ruling: not everything is a worker)", async () => {
    let created = 0, ensured = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c", modelWorkerId: 2, clientLoopId: null }; };
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

test("discover: returns the real capability manifest (methods + notifications) — the stale-daemon probe", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "discover" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { methods: Record<string, true>; notifications: Record<string, true> } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.methods["op.exec"], true, "op.exec is in the surface");
        assert.equal(r.value.result.methods["workspace.list"], true);
        assert.equal(r.value.result.notifications["stream/concluded"], true, "the concluded notification the client depends on");
    } finally { await mod.close(); }
});

test("workspace.create WITH a name is worldless and does NOT demand a pre-bound workspace (regression)", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => ({ workspaceId: 12, workspaceName: a.name ?? "auto", projectRoot: null, workerId: 3, workerName: "client-1", modelWorkerId: null, clientLoopId: null });
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
    const cancelled: number[] = [];
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    seam.cancelDrain = (workerId) => { cancelled.push(workerId); return true; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "w", workerId: "r1", forwardedProps: { plurnk: { workspace: "w", action: { kind: "loop.cancel", reason: "user_stop" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { cancelled: boolean } } };
        assert.equal(r.value.ok, true, "loop.cancel must be a known kind");
        assert.equal(r.value.result.cancelled, true);
        assert.deepEqual(cancelled, [20], "the MODEL worker's drain was cancelled");
    } finally { await mod.close(); }
});

// ── THREAD ↔ RUN (svc#366 landed): the threadId is the CONVERSATION ──────────
// threadId == workspace name → the model worker (the default conversation, unchanged).
// A DISTINCT threadId names its own conversation worker within the world: found by
// name if it exists, minted via createConversationWorker if it doesn't — the name is
// the identity at BOTH levels. Forks (named workers) are addressable as threads.

test("a distinct threadId MINTS a conversation worker named for it, and the loop drives there", async () => {
    const created: Array<{ workspaceId: number; name?: string }> = [];
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 20, name: "model-1" }];
    seam.createConversationWorker = async (a) => { created.push(a); return { workerId: 77, workerName: a.name ?? "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "chat-2", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(created, [{ workspaceId: 3, name: "chat-2" }], "the conversation worker is named for the thread, verbatim");
        assert.deepEqual(driven, [77], "the loop drove in the NEW conversation worker, not the model worker");
    } finally { await mod.close(); }
});

test("a threadId naming an EXISTING run (a fork, a prior conversation) binds it — no mint", async () => {
    let created = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 20, name: "model-1" }, { id: 44, name: "spike" }];
    seam.createConversationWorker = async () => { created++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [44], "the existing run 'spike' is the conversation");
        assert.equal(created, 0, "no duplicate conversation minted");
    } finally { await mod.close(); }
});

test("threadId == workspace name stays the MODEL run (the default conversation)", async () => {
    let minted = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    seam.createConversationWorker = async () => { minted++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "workspace", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [20], "the default conversation is the model worker");
        assert.equal(minted, 0, "no fresh run for the default thread");
    } finally { await mod.close(); }
});

test("loop.inject on a distinct thread folds into THAT conversation, never the model worker", async () => {
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 44, name: "spike" }];
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", forwardedProps: { plurnk: { workspace: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.deepEqual(driven, [44], "the steer reached the thread's own worker");
    } finally { await mod.close(); }
});

test("SSE heartbeat: a silent run stays alive — comment frames flow between events (agui#3: undici bodyTimeout kills silent streams)", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    // A SLOW loop: no events for ~200ms (a long model generation), then terminated.
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId), 200); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0, heartbeatMs: 40 }).start(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        const raw = await res.text();
        const beats = (raw.match(/^: hb$/gm) ?? []).length;
        assert.ok(beats >= 2, `the silent window carried heartbeats (got ${beats}) — no client bodyTimeout can starve mid-generate`);
        assert.match(raw, /RUN_FINISHED/, "the worker still ends clean");
    } finally { await mod.close(); }
});


test("a message run forwards forwardedProps.plurnk alias+model into runLoop (#414 per-loop model selection)", async () => {
    const { seam, loopRuns, finish } = mockSeam();
    // The worker self-completes: the runLoop override closes the stream for its workspace (the working
    // message-drive pattern above), so the POST resolves.
    seam.runLoop = async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.alias !== undefined ? { alias: a.alias } : {}), ...(a.model !== undefined ? { model: a.model } : {}) }); finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 }).start(seam);
    try {
        await post(mod.address().port, {
            threadId: "t-model", workerId: "r1",
            forwardedProps: { plurnk: { workspace: "t-model", alias: "fireslow", model: "fireworks/deepseek-v4" } },
            messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(loopRuns.length, 1, "the message drove one runLoop");
        assert.equal(loopRuns[0].alias, "fireslow", "the alias forwarded off forwardedProps.plurnk");
        assert.equal(loopRuns[0].model, "fireworks/deepseek-v4", "the client-resolved model forwarded too (daemon applies precedence)");
    } finally { await mod.close(); }
});

test("a post-headers runLoop failure preserves its exact Problem in the terminal SSE frames", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    const problem = Problems.create(
        "daemon:provider",
        "not-configured",
        501,
        "No model provider is configured for this run.",
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
        // The leak pin: the error path must release the run's handles (heartbeat
        // interval, portal binding) — a survivor here wedges `node --test` (no
        // force-exit in the drill) forever.
        const timeouts = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
        assert.equal(timeouts, before, "no timer survives the errored run");
    } finally { await mod.close(); }
});

test("an unexpected post-headers runLoop exception becomes one generic Problem without leaking its message", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
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
        assert.equal(exact?.value?.type, "https://problems.plurnk.dev/agui/http/run-failed");
        assert.equal(exact?.value?.detail, "The run failed unexpectedly.");
        assert.equal(exact?.value?.stage, "run");
        assert.doesNotMatch(JSON.stringify(events), /secret internal failure/);
    } finally { await mod.close(); }
});

test("the AG-UI STANDARD face keeps the protocol's nouns: RUN_STARTED/RUN_FINISHED echo RunAgentInput.runId (never plurnk's workerId) — ungated, so a lexicon sweep can't silently break conformance", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    seam.runLoop = async (a) => { finish(a.workspaceId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
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
