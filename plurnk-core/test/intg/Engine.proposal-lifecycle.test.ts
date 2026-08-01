// Proposal lifecycle (SPEC.md §engine-rails + §methods). When a scheme returns
// status 202, the engine writes a state='proposed' log entry and pauses
// dispatch until Engine.resolveProposal feeds back a decision. These tests
// exercise the pause/resume machinery + the log-render visibility filter
// against a tiny test scheme that always proposes.

import test from "node:test";
import assert from "node:assert/strict";
import { OperationFailureError } from "../../src/core/results.ts";
import type { EditStatement } from "@plurnk/plurnk-contracts/grammar";
import Engine from "../../src/core/Engine.ts";
import type { ProposalResolution } from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import { parseDsl } from "./_rpc.ts";

// Minimal proposing scheme. `edit` returns 202 with attrs the test asserts on.
class ProposingTest {
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };
    async editBatch(): Promise<{ status: number; attrs: object; body: string }> {
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { path: "/proposed-test", patch: "@@ +x @@" },
        };
    }
}

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `proposing-test://${pathname}`, scheme: "proposing-test",
        username: null, password: null, hostname: null, port: null,
        pathname, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const setupEngine = async (db: Db): Promise<{
    engine: Engine; workspaceId: number; workerId: number; loopId: number; turnId: number;
}> => {
    const schemes = new SchemeRegistry();
    schemes.register("proposing-test", new ProposingTest());
    const engine = new Engine({ db, schemes });
    const workspaceId = await insertWorkspace(db, `prop-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "proposal test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { engine, workspaceId, workerId, loopId, turnId };
};

// Deferred promise: resolves when onDispatch fires with the log entry id.
// This is deterministic — no setImmediate race with the DB roundtrip inside
// dispatch's write-log step.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const dispatchAndResolve = async (engine: Engine, ctx: {
    workspaceId: number; workerId: number; loopId: number; turnId: number;
}, resolution: ProposalResolution): Promise<{ status: number; logEntryId: number }> => {
    const idDeferred = deferred<number>();
    const dispatchPromise = engine.dispatch({
        statement: editStmt("/x", "y"),
        workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model",
        onDispatch: (id) => idDeferred.resolve(id),
    });
    const logEntryId = await idDeferred.promise;
    engine.resolveProposal(logEntryId, resolution);
    const result = await dispatchPromise;
    return { status: result.status, logEntryId };
};

test("proposal: 202 scheme result pauses; accept resolves to 200", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        assert.equal(status, 200, "post-resolution status should be 200 (accepted)");

        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 200);
        assert.equal(row?.outcome, null);
    } finally { await db.close(); }
});

test("proposal: reject transitions to state='failed', status=400, outcome='rejected'", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "reject" });
        assert.equal(status, 400);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "failed");
        assert.equal(row?.status_rx, 400);
        assert.equal(row?.outcome, "rejected");
    } finally { await db.close(); }
});

test("proposal: cancel transitions to state='cancelled', status=499, outcome='loop_aborted'", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "cancel" });
        assert.equal(status, 499);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.status_rx, 499);
        assert.equal(row?.outcome, "loop_aborted");
    } finally { await db.close(); }
});

test("proposal: caller-supplied outcome overrides the default", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, {
            decision: "reject", outcome: "policy_veto",
        });
        const row = await db.test_get_log_entry_by_id.get<{ outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.outcome, "policy_veto");
    } finally { await db.close(); }
});

test("proposal: attrs from scheme persist into log_entries.attrs JSON", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const parsed = JSON.parse(row?.attrs ?? "{}") as { path?: string; patch?: string };
        assert.equal(parsed.path, "/proposed-test");
        assert.equal(parsed.patch, "@@ +x @@");
    } finally { await db.close(); }
});

test("proposal: status=202 + state='proposed' rows hidden from the log section render", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        // Dispatch but DON'T resolve — entry stays in proposed state.
        const idDeferred = deferred<number>();
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        // Render the log — proposed entry should be invisible.
        // engine_render_log is worker-scoped per SPEC §packet-terms (runs own log entries).
        const rendered = await db.engine_render_log.all<{ status_rx: number; state: string }>({ worker_id: ctx.workerId });
        const proposedVisible = rendered.find((r) => r.status_rx === 202 && r.state === "proposed");
        assert.equal(proposedVisible, undefined, "proposed entries must be invisible to log render");

        // Now resolve and re-render — entry should surface.
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await pending;
        const rerendered = await db.engine_render_log.all<{ status_rx: number; state: string }>({ worker_id: ctx.workerId });
        const resolvedVisible = rerendered.find((r) => r.state === "resolved");
        assert.notEqual(resolvedVisible, undefined, "resolved entries must surface in log render");
        assert.equal(resolvedVisible?.status_rx, 200);
    } finally { await db.close(); }
});

test("proposal: resolveProposal for unknown id throws", () => {
    return openMigrated().then(async (db) => {
        try {
            const ctx = await setupEngine(db);
            assert.throws(() => ctx.engine.resolveProposal(99999, { decision: "accept" }), (error) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.dev/proposal/resolution/proposal-not-pending");
                assert.equal(error.result.problem.logEntryId, 99999);
                assert.equal(error.result.problem.recovery, "Refresh pending proposals before resolving one.");
                return true;
            });
        } finally { await db.close(); }
    });
});

test("proposal: pendingProposalIds reports waiting entries", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.deepEqual(ctx.engine.pendingProposalIds(), [logEntryId]);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await pending;
        assert.deepEqual(ctx.engine.pendingProposalIds(), []);
    } finally { await db.close(); }
});

test("proposal: onProposalPending listener fires with the right payload", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const seen: { logEntryId: number; op: string; attrs: object; target: { scheme: string | null; pathname: string | null } }[] = [];
        ctx.engine.onProposalPending((event) => {
            seen.push({ logEntryId: event.logEntryId, op: event.op, attrs: event.attrs, target: event.target });
        });
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.logEntryId, logEntryId);
        assert.equal(seen[0]?.op, "EDIT");
        assert.equal(seen[0]?.target.scheme, "proposing-test");
        assert.equal(seen[0]?.target.pathname, "/x");
        const attrs = seen[0]?.attrs as { path: string; patch: string };
        assert.equal(attrs.path, "/proposed-test");
        assert.equal(attrs.patch, "@@ +x @@");
    } finally { await db.close(); }
});

test("#255 — a broadcast SEND[202] (parked terminal) is NOT dispatched as a proposal", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const proposed: number[] = [];
        ctx.engine.onProposalPending((event) => { proposed.push(event.logEntryId); });

        // A broadcast SEND[202] — the model PARKING the loop (no target). It returns
        // status 202, but it is model speech, not a reviewable side-effect, so it must
        // NOT enter the propose/await path (the #255 collision that froze clients).
        // A bare statement without a PLAN lead is a parse error (grammar 0.70 PLAN-first),
        // and parseDsl drops kind:"error" items — so build from a PLAN-led turn and pluck
        // the broadcast SEND[202] (target:null) the model would actually emit.
        const sendParked = parseDsl("<<PLAN::PLAN\n<<SEND[202]<-1>:awaiting your reply:SEND").find((s) => s.op === "SEND");
        assert.ok(sendParked, "fixture: the broadcast park parsed as a statement");
        const parkDeferred = deferred<number>();
        const parkResult = await ctx.engine.dispatch({
            statement: sendParked,
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => parkDeferred.resolve(id),
        });
        const parkId = await parkDeferred.promise;

        // Dispatch handled the already-drained join inline — it never paused.
        assert.equal(parkResult.status, 200, "the broadcast join ([202]<-1> on nothing) completes inline");
        // ...the entry is a resolved row, not a proposed one...
        const parkRow = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({ id: parkId });
        assert.equal(parkRow?.state, "resolved", "the wait SEND is a resolved row, not a proposed entry");
        assert.equal(parkRow?.status_rx, 200);
        // ...and no loop/proposal was announced for it.
        assert.ok(!proposed.includes(parkId), "no proposal announced for the broadcast SEND[202] wait");

        // Negative control: a genuine side-effecting EDIT[202] DOES propose — proving the
        // listener is live and the SEND is exempt by op, not by a dead listener. Assert
        // only after the dispatch fully resolves, so onProposalPending has already run.
        const editDeferred = deferred<number>();
        const editPending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 2, origin: "model",
            onDispatch: (id) => editDeferred.resolve(id),
        });
        const editId = await editDeferred.promise;
        ctx.engine.resolveProposal(editId, { decision: "accept" });
        await editPending;
        assert.ok(proposed.includes(editId), "the side-effecting EDIT[202] IS announced as a proposal");
    } finally { await db.close(); }
});

test("proposal: loop auto-approval engages when loops.flags.auto === true", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        // Persist canonical loop auto-approval, then attach its listener.
        await db.engine_set_loop_flags.run({
            loop_id: ctx.loopId, flags: JSON.stringify({ auto: true }),
        });
        const Auto = (await import("../../src/server/auto.ts")).default;
        Auto.attach(ctx.engine, db);

        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(result.status, 200, "loop auto-approval produces status 200");
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.outcome, null);
    } finally { await db.close(); }
});

test("proposal: loop auto-approval does NOT engage when flags.auto is absent / false", async (t) => {
    // Tight timeout so the test doesn't wait the full 5m default.
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "100";
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const Auto = (await import("../../src/server/auto.ts")).default;
        Auto.attach(ctx.engine, db);

        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Auto doesn't engage → timeout fires → 499/cancelled/timeout.
        assert.equal(result.status, 499);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.outcome, "timeout");
    } finally { await db.close(); }
});

test("proposal: timeout fires after PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", async (t) => {
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "50";  // 50ms — fast for tests
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        // No resolveProposal call — wait for the timeout to fire and route
        // through the same applyResolution path as a manual cancel.
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(result.status, 499, "timeout produces a cancelled resolution → status 499");
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.outcome, "timeout");
    } finally { await db.close(); }
});

test("the SHIPPED default is INDEFINITE — a stopped world waits for its human (owner ruling)", async (t) => {
    // The AG-UI migration's first surfaced decision: absence is not an answer. With the knob
    // unset, a pending proposal outlives any would-be window and resolves only when the human
    // does — the [202]<-1> doctrine's sibling. The operator-bounded lane above keeps its test.
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Far past the old 300s-scaled window at test speed: the world stays stopped.
        await new Promise((r) => setTimeout(r, 250));
        const pending = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
        assert.equal(pending?.state, "proposed", "still stopped — no synthetic cancel, however long the human takes");
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "the human's answer, whenever it arrives, is the only resolution");
    } finally { await db.close(); }
});
