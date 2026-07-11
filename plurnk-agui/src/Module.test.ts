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
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const seam: DaemonSeam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        resolveProposal: (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 2, contextSize: 1000, meta: {} } })));
        },
        runLoop: async () => ({ action: "injected_next_turn", loopId: 9, turnSeq: 2 }),
        cancelDrain: () => true,
        dispatchAsClient: async () => ({ status: 200 }),
        readLog: async () => [{ id: 1, op: "SEND", origin: "model" }],
        listProviders: () => ({ aliases: [{ alias: "opus", provider: "anthropic", model: "claude", active: true, contextSize: 200000 }] }),
        createSession: async () => ({ sessionId: 3, sessionName: "agui-t", projectRoot: null, runId: 10, runName: "client-1", modelRunId: null, clientLoopId: null }),
        attachSession: async () => { throw new Error("unexpected attach"); },
        listSessions: async () => [],
        listRuns: async () => [{ id: 10, name: "client-1" }],
        ensureModelRun: async () => 20,
        listPrompts: async () => ["hi"],
        renameSession: async (_id, name) => ({ id: 3, name }),
        constrain: async (_id, effect, glob) => ({ effect, glob }),
        unconstrain: async (_id, effect, glob) => ({ effect, glob }),
        listConstraints: async () => [{ effect: "pick", glob: "src/**" }],
        readEntry: async () => ({ status: 200, entry: { body: "x" } }),
        forkRun: async () => ({ runId: 11, runName: "fork-1", parentRunId: 10 }),
        createConversationRun: async (a) => ({ runId: 77, runName: a.name ?? "model-fresh" }),
        listMembers: async () => ({ members: [{ path: "a.ts", effect: "member" }], hidden: [] }),
        look: async () => ({ status: 200, content: "looked" }),
    };
    const finish = (sessionId: number | null) => setImmediate(() => handlers.forEach((h) => h(sessionId, "loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 2, contextSize: 1000, meta: {} } })));
    return { seam, resolves, finish };
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
        const events = await post(mod.address().port, { threadId: "t1", runId: "r1", forwardedProps: { plurnk: { session: "t1", action: { kind: "providers.list" } } } });
        const result = events.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { kind: string; ok: boolean; result: { aliases: Array<{ alias: string }> } } };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.aliases[0].alias, "opus");
        assert.equal(events[events.length - 1].type, "RUN_FINISHED", "action run finishes clean");
        // inject rides the same surface
        const inj = await post(mod.address().port, { threadId: "t1", runId: "r2", forwardedProps: { plurnk: { session: "t1", action: { kind: "loop.inject", prompt: "steer" } } } });
        const ack = inj.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { action: string } } };
        assert.equal(ack.value.result.action, "injected_next_turn", "inject folds into the active drain via the unified runLoop");
        // an unknown kind errors honestly
        const bad = await post(mod.address().port, { threadId: "t1", runId: "r3", forwardedProps: { plurnk: { session: "t1", action: { kind: "nope.nothing" } } } });
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
            threadId: "t2", runId: "r1", forwardedProps: { plurnk: { session: "t2" } },
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
    const base = seam.createSession.bind(seam);
    seam.createSession = async (args) => { created.push(args); return { ...(await base(args)), sessionName: args.name ?? "session-1" }; };
    seam.attachSession = async (args) => { attached.push(args.sessionId); return { sessionId: args.sessionId, sessionName: "alpha", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null }; };
    seam.listSessions = async () => [{ id: 4, name: "alpha" }];
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // 1) A session named like an existing world attaches to IT — the exact name.
        // (A world-scoped action binds the session; a control-plane one would not.)
        const run = await post(mod.address().port, { threadId: "alpha", runId: "r1", forwardedProps: { plurnk: { session: "alpha", action: { kind: "session.members" } } } });
        assert.equal(run[run.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(attached, [4], "session 'alpha' attached the world 'alpha' — no agui- prefix lookup");
        // 2) A new session name creates a world with EXACTLY that name.
        await post(mod.address().port, { threadId: "beta", runId: "r2", forwardedProps: { plurnk: { session: "beta", action: { kind: "session.members" } } } });
        assert.deepEqual(created.map((c) => c.name), ["beta"], "created verbatim — never 'agui-beta', never a uuid");
        // 3) session.attach is a REAL action kind returning the envelope.
        const att = await post(mod.address().port, { threadId: "alpha", runId: "r3", forwardedProps: { plurnk: { session: "alpha", action: { kind: "session.attach", id: 4 } } } });
        const result = att.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { id: number; name: string } } };
        assert.equal(result.value.ok, true, "session.attach is wired, not unknown-kind");
        assert.equal(result.value.result.name, "alpha");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] SESSION=WORKSPACE, THREAD=CONVERSATION: the session prop selects the world; the thread is a run over it (svc#366 landed — the interim bind-the-model-run behavior is retired)", async () => {
    const attaches: number[] = [];
    const created: Array<{ name?: string; projectRoot?: string | null }> = [];
    const ensured: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listSessions = async () => [{ id: 7, name: "workspace-a" }];
    seam.attachSession = async (a) => { attaches.push(a.sessionId); return { sessionId: a.sessionId, sessionName: "workspace-a", projectRoot: "/w", runId: 100, runName: "client-1", modelRunId: 200, clientLoopId: null }; };
    seam.createSession = async (a) => { created.push(a); return { sessionId: 8, sessionName: a.name ?? "session-1", projectRoot: a.projectRoot ?? null, runId: 101, runName: "client-1", modelRunId: 201, clientLoopId: null }; };
    seam.ensureModelRun = async (sid) => { ensured.push(sid); return sid === 7 ? 200 : 201; };
    seam.createConversationRun = async (a) => ({ runId: 300, runName: a.name ?? "x" });
    const drivenRuns: number[] = [];
    seam.runLoop = async (a) => { drivenRuns.push(a.runId); finish(a.sessionId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // The `session` workspace prop selects the WORLD — not the threadId. Two
        // distinct threads naming the SAME workspace share the one session.
        await post(mod.address().port, { threadId: "chat-1", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { session: "workspace-a" } } });
        assert.deepEqual(attaches, [7], "the workspace 'workspace-a' was attached (not a session named 'chat-1')");
        assert.deepEqual(ensured, [], "a DISTINCT thread never binds the model run (that's the default thread's door)");
        assert.deepEqual(drivenRuns, [300], "the loop drove in the thread's own conversation run");
    } finally { await mod.close(); }
});

test("NO session prop is a HARD ERROR (500) — a run has no world to forge from the threadId", async () => {
    let created = 0;
    const { seam } = mockSeam();
    seam.listSessions = async () => [];
    seam.createSession = async (a) => { created++; return { sessionId: 9, sessionName: a.name ?? "x", projectRoot: null, runId: 1, runName: "c", modelRunId: 2, clientLoopId: null }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: "solo", runId: "r1", messages: [{ role: "user", content: "hi" }] }) });
        assert.equal(res.status, 500, "the missing session surfaces as an honest 500, not a fabricated 200");
        const body = await res.json() as { error: string };
        assert.match(body.error, /forwardedProps\.plurnk\.session \(a session name\) is required/);
        assert.doesNotMatch(body.error, /world|existence/, "the error states the contract, never the machine-model philosophy");
        assert.equal(created, 0, "NO session was forged from the threadId");
    } finally { await mod.close(); }
});

test("CONTROL PLANE: a worldless action needs NO session and FORGES none (operator ruling: not everything is a run)", async () => {
    let created = 0, ensured = 0;
    const { seam } = mockSeam();
    seam.listSessions = async () => [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    seam.createSession = async (a) => { created++; return { sessionId: 9, sessionName: a.name ?? "x", projectRoot: null, runId: 1, runName: "c", modelRunId: 2, clientLoopId: null }; };
    seam.ensureModelRun = async () => { ensured++; return 2; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // session.list with NO session prop — control plane, so no world required, none forged.
        const ev = await post(mod.address().port, { threadId: "probe", runId: "r1", forwardedProps: { plurnk: { action: { kind: "session.list" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { sessions: unknown[] } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.sessions.length, 2, "listed the real sessions");
        assert.equal(ev[ev.length - 1].type, "RUN_FINISHED");
        assert.equal(created, 0, "no ephemeral session was created");
        assert.equal(ensured, 0, "no model run was spun for a control-plane action");
    } finally { await mod.close(); }
});

test("discover: returns the real capability manifest (methods + notifications) — the stale-daemon probe", async () => {
    const { seam } = mockSeam();
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "probe", runId: "r1", forwardedProps: { plurnk: { action: { kind: "discover" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { methods: Record<string, true>; notifications: Record<string, true> } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.methods["op.exec"], true, "op.exec is in the surface");
        assert.equal(r.value.result.methods["session.list"], true);
        assert.equal(r.value.result.notifications["stream/concluded"], true, "the concluded notification the client depends on");
    } finally { await mod.close(); }
});

test("session.create WITH a name is worldless and does NOT demand a pre-bound session (regression)", async () => {
    const { seam } = mockSeam();
    seam.listSessions = async () => [];
    seam.createSession = async (a) => ({ sessionId: 12, sessionName: a.name ?? "auto", projectRoot: null, runId: 3, runName: "client-1", modelRunId: null, clientLoopId: null });
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        // No forwardedProps.plurnk.session on the run itself — session.create supplies its own world.
        const ev = await post(mod.address().port, { threadId: "probe", runId: "r1", forwardedProps: { plurnk: { action: { kind: "session.create", name: "fresh-world" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { name: string }; error?: string } };
        assert.equal(r.value.ok, true, r.value.error ?? "");
        assert.equal(r.value.result.name, "fresh-world", "created the named world, no session-required throw");
    } finally { await mod.close(); }
});

test("loop.cancel is a REAL action kind — cancels the model run's drain (both clients' stop buttons ride it)", async () => {
    const cancelled: number[] = [];
    const { seam } = mockSeam();
    seam.listSessions = async () => [{ id: 3, name: "w" }];
    seam.attachSession = async () => ({ sessionId: 3, sessionName: "w", projectRoot: null, runId: 10, runName: "c", modelRunId: 20, clientLoopId: null });
    seam.ensureModelRun = async () => 20;
    seam.cancelDrain = (runId) => { cancelled.push(runId); return true; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "w", runId: "r1", forwardedProps: { plurnk: { session: "w", action: { kind: "loop.cancel", reason: "user_stop" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { cancelled: boolean }; error?: string } };
        assert.equal(r.value.ok, true, r.value.error ?? "loop.cancel must be a known kind");
        assert.equal(r.value.result.cancelled, true);
        assert.deepEqual(cancelled, [20], "the MODEL run's drain was cancelled");
    } finally { await mod.close(); }
});

// ── THREAD ↔ RUN (svc#366 landed): the threadId is the CONVERSATION ──────────
// threadId == session name → the model run (the default conversation, unchanged).
// A DISTINCT threadId names its own conversation run within the world: found by
// name if it exists, minted via createConversationRun if it doesn't — the name is
// the identity at BOTH levels. Forks (named runs) are addressable as threads.

test("[§agui-thread-is-run] a distinct threadId MINTS a conversation run named for it, and the loop drives there", async () => {
    const created: Array<{ sessionId: number; name?: string }> = [];
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listSessions = async () => [{ id: 3, name: "workspace" }];
    seam.attachSession = async () => ({ sessionId: 3, sessionName: "workspace", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null });
    seam.listRuns = async () => [{ id: 20, name: "model-1" }];
    seam.createConversationRun = async (a) => { created.push(a); return { runId: 77, runName: a.name ?? "x" }; };
    seam.runLoop = async (a) => { driven.push(a.runId); finish(a.sessionId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "chat-2", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { session: "workspace" } } });
        assert.deepEqual(created, [{ sessionId: 3, name: "chat-2" }], "the conversation run is named for the thread, verbatim");
        assert.deepEqual(driven, [77], "the loop drove in the NEW conversation run, not the model run");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] a threadId naming an EXISTING run (a fork, a prior conversation) binds it — no mint", async () => {
    let created = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listSessions = async () => [{ id: 3, name: "workspace" }];
    seam.attachSession = async () => ({ sessionId: 3, sessionName: "workspace", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null });
    seam.listRuns = async () => [{ id: 20, name: "model-1" }, { id: 44, name: "spike" }];
    seam.createConversationRun = async () => { created++; return { runId: 99, runName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.runId); finish(a.sessionId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "spike", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { session: "workspace" } } });
        assert.deepEqual(driven, [44], "the existing run 'spike' is the conversation");
        assert.equal(created, 0, "no duplicate conversation minted");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] threadId == session name stays the MODEL run (the default conversation)", async () => {
    let minted = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listSessions = async () => [{ id: 3, name: "workspace" }];
    seam.attachSession = async () => ({ sessionId: 3, sessionName: "workspace", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null });
    seam.ensureModelRun = async () => 20;
    seam.createConversationRun = async () => { minted++; return { runId: 99, runName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.runId); finish(a.sessionId); return { action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "workspace", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { session: "workspace" } } });
        assert.deepEqual(driven, [20], "the default conversation is the model run");
        assert.equal(minted, 0, "no fresh run for the default thread");
    } finally { await mod.close(); }
});

test("[§agui-thread-is-run] loop.inject on a distinct thread folds into THAT conversation, never the model run", async () => {
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listSessions = async () => [{ id: 3, name: "workspace" }];
    seam.attachSession = async () => ({ sessionId: 3, sessionName: "workspace", projectRoot: null, runId: 10, runName: "client-1", modelRunId: 20, clientLoopId: null });
    seam.listRuns = async () => [{ id: 44, name: "spike" }];
    seam.runLoop = async (a) => { driven.push(a.runId); finish(a.sessionId); return { action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
    const mod = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    try {
        await post(mod.address().port, { threadId: "spike", runId: "r1", forwardedProps: { plurnk: { session: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.deepEqual(driven, [44], "the steer reached the thread's own run");
    } finally { await mod.close(); }
});
