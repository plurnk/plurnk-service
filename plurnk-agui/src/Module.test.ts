// The module's HTTP surface against a mock seam (no daemon): §3 action runs execute
// via the seam and finish clean; unknown kinds error honestly; a resume tool-result
// resolves without driving a loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "./Module.ts";
import type { DaemonSeam, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";

const mockSeam = () => {
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const loopRuns: Array<{ alias?: string; model?: string; prompt: string }> = [];
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const seam: DaemonSeam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        resolveProposal: (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 2, promptBudget: 1000, meta: {} } })));
        },
        runLoop: async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.alias !== undefined ? { alias: a.alias } : {}), ...(a.model !== undefined ? { model: a.model } : {}) }); return { action: "injected_next_turn" as const, loopId: 9, turnSeq: 2 }; },
        cancelDrain: () => true,
        dispatchAsClient: async () => ({ status: 200 }),
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
        readEntry: async () => ({ status: 200, entry: { body: "x" } }),
        forkWorker: async () => ({ workerId: 11, workerName: "fork-1", parentWorkerId: 10 }),
        createConversationWorker: async (a) => ({ workerId: 77, workerName: a.name ?? "model-fresh" }),
        listMembers: async () => ({ members: [{ path: "a.ts", effect: "member" }], hidden: [] }),
        look: async () => ({ status: 200, content: "looked" }),
    };
    const finish = (workspaceId: number | null) => setImmediate(() => handlers.forEach((h) => h(workspaceId, "loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 2, promptBudget: 1000, meta: {} } })));
    return { seam, resolves, loopRuns, finish };
};

const post = async (port: number, body: object): Promise<AguiEvent[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    const text = await res.text();
    return text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
};

test("[§agui-management-plane] an action run executes via the seam: result custom + RUN_FINISHED, no loop", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
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
        const err = bad.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; error: string } };
        assert.equal(err.value.ok, false);
        assert.match(err.value.error, /unknown action 'nope\.nothing'/);
        assert.doesNotMatch(err.value.error, /seam surface/, "no internal jargon leaks to the client");
    } finally { await mod.close(); }
});

test("[§agui-proposal-resolve] a resume tool-result resolves the paused proposal without driving a loop", async () => {
    const { seam, resolves } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "t2", workerId: "r1", forwardedProps: { plurnk: { workspace: "t2" } },
            messages: [
                { role: "assistant", content: "" },
                { role: "tool", toolCallId: "prop:42", content: JSON.stringify({ decision: "accept", body: "edited" }) },
            ],
        });
        assert.equal(events[0].type, "RUN_STARTED");
        assert.deepEqual(resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited" } }, "the tool-result reached resolveProposal");
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
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
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

test("[§agui-thread-is-run] SESSION=WORKSPACE, THREAD=CONVERSATION: the workspace prop selects the world; the thread is a worker over it (svc#366 landed — the interim bind-the-model-run behavior is retired)", async () => {
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
    seam.runLoop = async (a) => { drivenRuns.push(a.workerId); finish(a.workspaceId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // The `workspace` workspace prop selects the WORLD — not the threadId. Two
        // distinct threads naming the SAME workspace share the one workspace.
        await post(mod.address().port, { threadId: "chat-1", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace-a" } } });
        assert.deepEqual(attaches, [7], "the workspace 'workspace-a' was attached (not a workspace named 'chat-1')");
        assert.deepEqual(ensured, [], "a DISTINCT thread never binds the model worker (that's the default thread's door)");
        assert.deepEqual(drivenRuns, [300], "the loop drove in the thread's own conversation worker");
    } finally { await mod.close(); }
});

test("NO workspace prop is a HARD ERROR (500) — a worker has no world to forge from the threadId", async () => {
    let created = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c", modelWorkerId: 2, clientLoopId: null }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "solo", workerId: "r1", messages: [{ role: "user", content: "hi" }] }) });
        assert.equal(res.status, 500, "the missing workspace surfaces as an honest 500, not a fabricated 200");
        const body = await res.json() as { error: string };
        assert.match(body.error, /forwardedProps\.plurnk\.workspace \(a workspace name\) is required/);
        assert.doesNotMatch(body.error, /world|existence/, "the error states the contract, never the machine-model philosophy");
        assert.equal(created, 0, "NO workspace was forged from the threadId");
    } finally { await mod.close(); }
});

test("CONTROL PLANE: a worldless action needs NO workspace and FORGES none (operator ruling: not everything is a worker)", async () => {
    let created = 0, ensured = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, workerId: 1, workerName: "c", modelWorkerId: 2, clientLoopId: null }; };
    seam.ensureModelWorker = async () => { ensured++; return 2; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
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
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
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
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // No forwardedProps.plurnk.workspace on the worker itself — workspace.create supplies its own world.
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "workspace.create", name: "fresh-world" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { name: string }; error?: string } };
        assert.equal(r.value.ok, true, r.value.error ?? "");
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
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "w", workerId: "r1", forwardedProps: { plurnk: { workspace: "w", action: { kind: "loop.cancel", reason: "user_stop" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { cancelled: boolean }; error?: string } };
        assert.equal(r.value.ok, true, r.value.error ?? "loop.cancel must be a known kind");
        assert.equal(r.value.result.cancelled, true);
        assert.deepEqual(cancelled, [20], "the MODEL worker's drain was cancelled");
    } finally { await mod.close(); }
});

// ── THREAD ↔ RUN (svc#366 landed): the threadId is the CONVERSATION ──────────
// threadId == workspace name → the model worker (the default conversation, unchanged).
// A DISTINCT threadId names its own conversation worker within the world: found by
// name if it exists, minted via createConversationWorker if it doesn't — the name is
// the identity at BOTH levels. Forks (named workers) are addressable as threads.

test("[§agui-thread-is-run] a distinct threadId MINTS a conversation worker named for it, and the loop drives there", async () => {
    const created: Array<{ workspaceId: number; name?: string }> = [];
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 20, name: "model-1" }];
    seam.createConversationWorker = async (a) => { created.push(a); return { workerId: 77, workerName: a.name ?? "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "chat-2", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(created, [{ workspaceId: 3, name: "chat-2" }], "the conversation worker is named for the thread, verbatim");
        assert.deepEqual(driven, [77], "the loop drove in the NEW conversation worker, not the model worker");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] a threadId naming an EXISTING run (a fork, a prior conversation) binds it — no mint", async () => {
    let created = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 20, name: "model-1" }, { id: 44, name: "spike" }];
    seam.createConversationWorker = async () => { created++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [44], "the existing run 'spike' is the conversation");
        assert.equal(created, 0, "no duplicate conversation minted");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] threadId == workspace name stays the MODEL run (the default conversation)", async () => {
    let minted = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    seam.createConversationWorker = async () => { minted++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "workspace", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [20], "the default conversation is the model worker");
        assert.equal(minted, 0, "no fresh run for the default thread");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] loop.inject on a distinct thread folds into THAT conversation, never the model worker", async () => {
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "workspace" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, workerId: 10, workerName: "client-1", modelWorkerId: 20, clientLoopId: null });
    seam.listWorkers = async () => [{ id: 44, name: "spike" }];
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId); return { action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", forwardedProps: { plurnk: { workspace: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.deepEqual(driven, [44], "the steer reached the thread's own worker");
    } finally { await mod.close(); }
});

test("[§agui-run-endpoint] SSE heartbeat: a silent run stays alive — comment frames flow between events (agui#3: undici bodyTimeout kills silent streams)", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "w" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, workerId: 10, workerName: "c", modelWorkerId: 20, clientLoopId: null });
    seam.ensureModelWorker = async () => 20;
    // A SLOW loop: no events for ~200ms (a long model generation), then terminated.
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId), 200); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0, heartbeatMs: 40 })(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "w", workerId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } }) });
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
    seam.runLoop = async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.alias !== undefined ? { alias: a.alias } : {}), ...(a.model !== undefined ? { model: a.model } : {}) }); finish(a.workspaceId); return { action: "enqueued_new_loop" as const, loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
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
