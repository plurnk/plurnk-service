// Proposal lifecycle (task #42, AGENTS.md §Phase E). When a scheme returns
// status 202, the engine writes a state='proposed' log entry and pauses
// dispatch until Engine.resolveProposal feeds back a decision. These tests
// exercise the pause/resume machinery + the log-render visibility filter
// against a tiny test scheme that always proposes.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import type { ProposalResolution } from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

// Minimal proposing scheme. `edit` returns 202 with attrs the test asserts on.
class ProposingTest {
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };
    async edit(): Promise<{ status: number; attrs: object; body: string }> {
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { path: "/proposed-test", patch: "@@ +x @@" },
        };
    }
}

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    path: { kind: "url", raw: `proposing-test://${pathname}`, scheme: "proposing-test",
        username: null, password: null, hostname: null, port: null,
        pathname, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const setupEngine = async (db: Db): Promise<{
    engine: Engine; sessionId: number; runId: number; loopId: number; turnId: number;
}> => {
    const schemes = new SchemeRegistry();
    schemes.register("proposing-test", new ProposingTest());
    const engine = new Engine({ db, schemes });
    const sessionId = await insertSession(db, `prop-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "proposal test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { engine, sessionId, runId, loopId, turnId };
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
    sessionId: number; runId: number; loopId: number; turnId: number;
}, resolution: ProposalResolution): Promise<{ status: number; logEntryId: number }> => {
    const idDeferred = deferred<number>();
    const dispatchPromise = engine.dispatch({
        statement: editStmt("/x", "y"),
        sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
        actionIndex: 0, origin: "model",
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

        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
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
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
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
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
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
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.outcome, "policy_veto");
    } finally { await db.close(); }
});

test("proposal: attrs from scheme persist into log_entries.attrs JSON", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string }>({ id: logEntryId });
        const parsed = JSON.parse(row?.attrs ?? "{}") as { path?: string; patch?: string };
        assert.equal(parsed.path, "/proposed-test");
        assert.equal(parsed.patch, "@@ +x @@");
    } finally { await db.close(); }
});

test("proposal: status=202 + state='proposed' rows hidden from packet.system.log render", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        // Dispatch but DON'T resolve — entry stays in proposed state.
        const idDeferred = deferred<number>();
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
            actionIndex: 0, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        // Render the log — proposed entry should be invisible.
        const rendered = await (db.engine_render_log as PrepMethod).all<{ status_rx: number; state: string }>({ loop_id: ctx.loopId });
        const proposedVisible = rendered.find((r) => r.status_rx === 202 && r.state === "proposed");
        assert.equal(proposedVisible, undefined, "proposed entries must be invisible to log render");

        // Now resolve and re-render — entry should surface.
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await pending;
        const rerendered = await (db.engine_render_log as PrepMethod).all<{ status_rx: number; state: string }>({ loop_id: ctx.loopId });
        const resolvedVisible = rerendered.find((r) => r.state === "resolved");
        assert.notEqual(resolvedVisible, undefined, "resolved entries must surface in log render");
        assert.equal(resolvedVisible?.status_rx, 200);
    } finally { await db.close(); }
});

test("proposal: resolveProposal for unknown id throws", () => {
    return openMigrated().then(async (db) => {
        try {
            const ctx = await setupEngine(db);
            assert.throws(
                () => ctx.engine.resolveProposal(99999, { decision: "accept" }),
                /no pending proposal for log_entry 99999/,
            );
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
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
            actionIndex: 0, origin: "model",
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

test("proposal: timeout fires after PLURNK_PROPOSAL_TIMEOUT_MS", async (t) => {
    const original = process.env.PLURNK_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_PROPOSAL_TIMEOUT_MS = "50";  // 50ms — fast for tests
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        // No resolveProposal call — wait for the timeout to fire and route
        // through the same applyResolution path as a manual cancel.
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
            actionIndex: 0, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(result.status, 499, "timeout produces a cancelled resolution → status 499");
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.outcome, "timeout");
    } finally { await db.close(); }
});
