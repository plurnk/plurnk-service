// Exec scheme (E.1 vertical slice). EDIT against exec://<id> proposes a
// command run; on accept, applyResolution spawns the shell, captures
// stdout/stderr, and writes a two-channel entry. Clean exit → 200 +
// channels at state=closed; non-zero exit → 500 + state=errored.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

const execEditStmt = (id: string, command: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: {
        kind: "url", raw: `exec://${id}`, scheme: "exec",
        username: null, password: null, hostname: null, port: null,
        pathname: id, params: {}, fragment: null,
    },
    lineMarker: null, body: command, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const withSession = async <T>(fn: (ctx: {
    engine: Engine;
    db: Awaited<ReturnType<typeof openMigrated>>;
    sessionId: number; runId: number; loopId: number; turnId: number;
}) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const sessionId = await insertSession(db, `exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn({ engine, db, sessionId, runId, loopId, turnId });
    } finally {
        await db.close();
    }
};

test("exec.edit: proposes (202) with the command echoed in body + attrs.command", async () => {
    await withSession(async (ctx) => {
        const stmt = execEditStmt("greet", "echo hello");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { command: string; pathname: string };
        assert.equal(attrs.command, "echo hello");
        assert.equal(attrs.pathname, "greet");

        // Reject so the dispatch resolves and the test cleans up.
        ctx.engine.resolveProposal(logEntryId, { decision: "reject" });
        await dispatchPromise;
    });
});

test("exec applyResolution: clean exit → 200, stdout channel captured, state=closed, outcome=exit_0", async () => {
    await withSession(async (ctx) => {
        const stmt = execEditStmt("greet", "echo hello");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "greet",
        });
        assert.ok(entryRow, "entry exists after applyResolution");
        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string; mimetype: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "hello\n");
        assert.equal(stdout?.state, "closed");
        assert.equal(stdout?.mimetype, "text/plain");
        const stderr = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "");
        assert.equal(stderr?.state, "closed");

        // Forensics: outcome encodes the exit code; status_rx stays 200.
        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ status_rx: number; outcome: string | null }>({
            id: logEntryId,
        });
        assert.equal(log?.status_rx, 200);
        assert.equal(log?.outcome, "exit_0");
    });
});

test("exec applyResolution: non-zero exit → 200 + outcome=exit_N + channels at state=errored", async () => {
    await withSession(async (ctx) => {
        const stmt = execEditStmt("oops", "echo ouch >&2; exit 7");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        // Engine status: the proposal completed (operation ran). Failure
        // mode is encoded in channel state + outcome, not in the dispatch
        // status — the engine's proposal contract maps applyResolution
        // >=400 to "apply_failed reject" which isn't what "exit 7" means.
        assert.equal(result.status, 200);

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "oops",
        });
        assert.ok(entryRow, "entry exists even on non-zero exit");
        const stderr = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "ouch\n");
        assert.equal(stderr?.state, "errored");
        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.state, "errored", "stdout channel also at errored on non-zero exit");

        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; outcome: string | null }>({
            id: logEntryId,
        });
        assert.equal(log?.state, "resolved");
        assert.equal(log?.status_rx, 200);
        assert.equal(log?.outcome, "exit_7");
    });
});

test("exec.edit: empty body → 400", async () => {
    await withSession(async (ctx) => {
        const stmt = execEditStmt("noop", "");
        const result = await ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    });
});

test("exec applyResolution: subscription row opens before spawn and closes with terminal status", async () => {
    await withSession(async (ctx) => {
        const stmt = execEditStmt("sub", "echo hi");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "sub",
        });
        assert.ok(entryRow);
        const sub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{
            scheme: string; handle: string; closed_at: string | null; close_status: number | null;
        }>({ run_id: ctx.runId, entry_id: entryRow.id });
        assert.equal(sub?.scheme, "exec");
        assert.equal(sub?.handle, "echo hi", "handle records the command for forensics");
        assert.ok(sub?.closed_at, "subscription closed after spawn exit");
        assert.equal(sub?.close_status, 200, "clean exit closes the subscription at 200");
    });
});

test("exec applyResolution: streamEventNotify fires on chunks AND on terminal state transition", async () => {
    type Event = { sessionId: number; entryId: number; channel: string; state: string; contentLength: number };
    const events: Event[] = [];
    const db = await openMigrated();
    try {
        const engine = new Engine({
            db, schemes: new SchemeRegistry(),
            streamEventNotify: (sessionId, event) => events.push({ sessionId, ...event }),
        });
        const sessionId = await insertSession(db, `exec-notify-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec notify test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const stmt = execEditStmt("notif", "echo one");
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const sessionEvents = events.filter((e) => e.sessionId === sessionId);
        // At least one chunk event (stdout), then two state transitions
        // (stdout → closed, stderr → closed).
        const chunkEvents = sessionEvents.filter((e) => e.state === "active");
        const closedEvents = sessionEvents.filter((e) => e.state === "closed");
        assert.ok(chunkEvents.length >= 1, `expected >=1 chunk event, got ${chunkEvents.length}`);
        assert.ok(chunkEvents.some((e) => e.channel === "stdout" && e.contentLength === 4),
            `stdout chunk event reports contentLength=4 (for "one\\n"); got ${JSON.stringify(chunkEvents)}`);
        assert.equal(closedEvents.length, 2, "both stdout and stderr transition to closed");
        assert.ok(closedEvents.some((e) => e.channel === "stdout"));
        assert.ok(closedEvents.some((e) => e.channel === "stderr"));
    } finally { await db.close(); }
});

test("exec.read: after applyResolution, READ returns the stdout channel content", async () => {
    await withSession(async (ctx) => {
        const editStmt = execEditStmt("greet2", "echo world");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: editStmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const readResult = await ctx.engine.dispatch({
            statement: {
                op: "READ", suffix: "", signal: null,
                target: {
                    kind: "url", raw: "exec://greet2", scheme: "exec",
                    username: null, password: null, hostname: null, port: null,
                    pathname: "greet2", params: {}, fragment: null,
                },
                lineMarker: null, body: null, position: { line: 1, column: 1 },
            },
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId: ctx.turnId, sequence: 2, origin: "model",
        });
        assert.equal(readResult.status, 200);
        // The standard read helper returns content under the default channel
        // (stdout for exec).
        type ReadDispatch = { content?: string | null; mimetype?: string | null };
        const r = readResult as ReadDispatch;
        assert.equal(r.content, "world\n");
        assert.equal(r.mimetype, "text/plain");
    });
});
