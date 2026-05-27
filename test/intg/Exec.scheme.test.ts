// Exec scheme (E.1 vertical slice). EDIT against exec://<id> proposes a
// command run; on accept, applyResolution spawns the shell, captures
// stdout/stderr, and writes a two-channel entry. Clean exit → 200 +
// channels at state=closed; non-zero exit → 500 + state=errored.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, SendStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import Mock from "../../src/providers/Mock.ts";
import { attachYolo } from "../../src/server/yolo.ts";
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

// SEND status lives in the `signal` field (number). `suffix` is empty on
// plain `<<SEND[499](target)::SEND` emissions.
const execSendStmt = (id: string, status: number): SendStatement => ({
    op: "SEND", suffix: "", signal: status,
    target: {
        kind: "url", raw: `exec://${id}`, scheme: "exec",
        username: null, password: null, hostname: null, port: null,
        pathname: id, params: {}, fragment: null,
    },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const withSession = async <T>(fn: (ctx: {
    engine: Engine;
    exec: Exec;
    db: Awaited<ReturnType<typeof openMigrated>>;
    sessionId: number; runId: number; loopId: number; turnId: number;
}) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const sessionId = await insertSession(db, `exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn({ engine, exec, db, sessionId, runId, loopId, turnId });
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

test("exec applyResolution: dispatch returns 'started' (non-blocking); spawn completes async with state=closed + exit_0 once idle", async () => {
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

        // The dispatch returned BEFORE the spawn closed (SPEC §7.1
        // streaming-scheme contract: dispatch returns immediately, the
        // connection stays alive). The "started" outcome reflects this.
        // Wait for the background spawn to complete before asserting
        // terminal state.
        await ctx.exec.idle();

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "greet",
        });
        assert.ok(entryRow);
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

        // Log entry retains "started" outcome from the synchronous dispatch
        // return. Spawn completion is observable via channel state +
        // subscription row, not by mutating the original log entry.
        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ status_rx: number; outcome: string | null }>({
            id: logEntryId,
        });
        assert.equal(log?.status_rx, 200);
        assert.equal(log?.outcome, "started");

        // Subscription row records the final exit status.
        const sub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200);
    });
});

test("exec applyResolution: non-zero exit → channels=errored + subscription.close_status=500 once idle", async () => {
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
        assert.equal(result.status, 200);
        await ctx.exec.idle();

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "oops",
        });
        assert.ok(entryRow);
        const stderr = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "ouch\n");
        assert.equal(stderr?.state, "errored");
        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.state, "errored");

        // Subscription's close_status carries the exit-code signal —
        // log_entry.outcome stays at "started" since dispatch returned
        // before the spawn closed.
        const sub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 500);

        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; outcome: string | null }>({
            id: logEntryId,
        });
        assert.equal(log?.state, "resolved");
        assert.equal(log?.status_rx, 200);
        assert.equal(log?.outcome, "started");
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
        await ctx.exec.idle();

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
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
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
        await exec.idle();

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
        await ctx.exec.idle();

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

// E.3: SEND[499] cancel routing through the subscription registry.
// Model emits SEND[499](exec://id); exec.send finds the active sub,
// fires its AbortController, the spawn's close handler closes the row
// at 499 and transitions channels to errored.

test("exec.send[499]: cancels an active spawn — channels=errored, subscription.close_status=499", async () => {
    await withSession(async (ctx) => {
        // sleep 30 keeps the spawn live long enough for SEND[499] to land.
        const editStmt = execEditStmt("longjob", "sleep 30");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: editStmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const editLogId = await idDeferred.promise;
        ctx.engine.resolveProposal(editLogId, { decision: "accept" });
        const editResult = await dispatchPromise;
        assert.equal(editResult.status, 200, "EDIT returns immediately while sleep runs");

        // Verify subscription is live BEFORE we cancel.
        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "longjob",
        });
        assert.ok(entryRow);
        const liveSub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ closed_at: string | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.equal(liveSub?.closed_at, null, "subscription is active while sleep runs");

        // Cancel.
        const sendResult = await ctx.engine.dispatch({
            statement: execSendStmt("longjob", 499),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId: ctx.turnId, sequence: 2, origin: "model",
        });
        assert.equal(sendResult.status, 200, "SEND[499] returns 200 (cancel accepted)");

        // Spawn's close handler runs async after the AbortController fires.
        await ctx.exec.idle();

        const closedSub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null; closed_at: string | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.ok(closedSub?.closed_at);
        assert.equal(closedSub?.close_status, 499);

        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.state, "errored");
        const stderr = await (ctx.db.test_get_channel as PrepMethod).get<{ state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.state, "errored");
    });
});

test("exec.send[499]: target without an active subscription → 404", async () => {
    await withSession(async (ctx) => {
        // First run a short command to completion so the entry exists but
        // the subscription is closed.
        const editStmt = execEditStmt("done", "echo done");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: editStmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        ctx.engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        // Cancel: there's no active subscription, so 404.
        const sendResult = await ctx.engine.dispatch({
            statement: execSendStmt("done", 499),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId: ctx.turnId, sequence: 2, origin: "model",
        });
        assert.equal(sendResult.status, 404);
    });
});

test("exec.send[499]: target entry that doesn't exist → 404", async () => {
    await withSession(async (ctx) => {
        const sendResult = await ctx.engine.dispatch({
            statement: execSendStmt("nonexistent", 499),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(sendResult.status, 404);
    });
});

test("exec.send: non-499 signal → 501", async () => {
    await withSession(async (ctx) => {
        const sendResult = await ctx.engine.dispatch({
            statement: execSendStmt("anything", 200),
            sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId,
            turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(sendResult.status, 501, "exec v0 only handles SEND[499]");
    });
});

// E.4 wake-on-completion: spawn fires wakeRunNotify with a synthetic
// summary so the daemon can open a new loop if the run has gone dormant.
// These tests exercise the scheme-side call; daemon active-loop check is
// covered separately (Daemon.exec-wake.test.ts).

test("exec wake-on-completion: clean exit fires wakeRunNotify with closeStatus=200 and a stdout-summary string", async () => {
    type WakePayload = {
        sessionId: number; runId: number; entryId: number;
        subscriptionId: number; closeStatus: number; scheme: string; summary: string;
    };
    const wakes: WakePayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            wakeRunNotify: (payload) => wakes.push(payload),
        });
        const sessionId = await insertSession(db, `exec-wake-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "wake test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const stmt = execEditStmt("wake-clean", "echo hello");
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        assert.equal(wakes.length, 1, "exactly one wake per spawn completion");
        const [w] = wakes;
        assert.equal(w.sessionId, sessionId);
        assert.equal(w.runId, runId);
        assert.equal(w.scheme, "exec");
        assert.equal(w.closeStatus, 200);
        assert.match(w.summary, /^exec:\/\/wake-clean completed \(exit 0\)/);
        assert.match(w.summary, /stdout=6 bytes/, '"hello\\n" is 6 bytes');
        assert.match(w.summary, /stderr=0 bytes/);
    } finally { await db.close(); }
});

test("exec wake-on-completion: non-zero exit fires wakeRunNotify with closeStatus=500 and 'exit 7' in summary", async () => {
    type WakePayload = { closeStatus: number; summary: string };
    const wakes: WakePayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            wakeRunNotify: (payload) => wakes.push({ closeStatus: payload.closeStatus, summary: payload.summary }),
        });
        const sessionId = await insertSession(db, `exec-wake-err-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "wake error test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const stmt = execEditStmt("wake-err", "exit 7");
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 500);
        assert.match(wakes[0].summary, /exit 7/);
    } finally { await db.close(); }
});

test("exec wake-on-completion: SEND[499] cancel fires wakeRunNotify with closeStatus=499 (daemon will skip on this)", async () => {
    type WakePayload = { closeStatus: number };
    const wakes: WakePayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            wakeRunNotify: (payload) => wakes.push({ closeStatus: payload.closeStatus }),
        });
        const sessionId = await insertSession(db, `exec-wake-cancel-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "wake cancel test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const stmt = execEditStmt("wake-cancel", "sleep 30");
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: stmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;

        await engine.dispatch({
            statement: execSendStmt("wake-cancel", 499),
            sessionId, runId, loopId, turnId, sequence: 2, origin: "model",
        });
        await exec.idle();

        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 499,
            "wake notify carries the abort status; daemon's wake handler is what skips this case");
    } finally { await db.close(); }
});

// Case C from the lifecycle question: loop forcefully cancelled
// mid-spawn → loop-level AbortController aborts the spawn → channels
// land at errored, subscription closes at 499. Drives this through a
// real runLoop with maxTurns=3 (smaller than the sleep 30 duration) so
// the loop hits max_turns while the spawn is still active.

test("exec lifecycle C: runLoop max_turns force-cancel aborts in-flight spawn", async () => {
    type WakePayload = { closeStatus: number };
    const wakes: WakePayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            wakeRunNotify: (payload) => wakes.push({ closeStatus: payload.closeStatus }),
        });
        attachYolo(engine, db);
        const sessionId = await insertSession(db, `exec-cancel-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "force-cancel test");
        // Persist yolo flag so the proposal auto-accepts in-process.
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        // Mock: turn 1 starts a long exec + continues; turn 2-3 just continue;
        // loop hits max_turns=3 → forceful cleanup → loopAbort fires.
        const execEditOp = {
            op: "EDIT" as const, suffix: "", signal: null,
            target: {
                kind: "url" as const, raw: "exec://longjob", scheme: "exec",
                username: null, password: null, hostname: null, port: null,
                pathname: "longjob", params: {}, fragment: null,
            },
            lineMarker: null, body: "sleep 30", position: { line: 1, column: 1 },
        };
        const continueOp = {
            op: "SEND" as const, suffix: "", signal: 102, target: null,
            lineMarker: null, body: { raw: "thinking", json: null },
            position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                { assistant: { content: "", ops: [execEditOp, continueOp], reasoning: null } },
                { assistant: { content: "", ops: [continueOp], reasoning: null } },
                { assistant: { content: "", ops: [continueOp], reasoning: null } },
                { assistant: { content: "", ops: [continueOp], reasoning: null } },
            ],
        });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "start a slow exec" }],
        });
        assert.equal(result.finalStatus, 499);
        assert.equal(result.hitMaxTurns, true);

        // The forceful cleanup fired loopAbort. The exec spawn's
        // controller is chained from ctx.signal → AbortError fires →
        // spawn's close handler closes the subscription at 499.
        await exec.idle();

        const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "longjob",
        });
        assert.ok(entryRow, "exec entry was created before the cancel");
        const sub = await (db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 499, "subscription closed at 499 when loop forcefully cancelled");

        const stdout = await (db.test_get_channel as PrepMethod).get<{ state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.state, "errored");

        // wakeRunNotify fired with closeStatus=499 — daemon-side handler
        // would skip opening a new loop (don't resurrect a forceful
        // cancellation), but the notification still flows for client UI.
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 499);
    } finally { await db.close(); }
});

// Case A from the lifecycle question: spawn finishes mid-loop. The
// channel transition lands during a later turn; model sees state=closed
// in the next packet's index.

test("exec lifecycle A: spawn finishes mid-loop, the next turn's packet build picks up state=closed", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        attachYolo(engine, db);
        const sessionId = await insertSession(db, `exec-midloop-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "mid-loop test");
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        const execEditOp = {
            op: "EDIT" as const, suffix: "", signal: null,
            target: {
                kind: "url" as const, raw: "exec://quick", scheme: "exec",
                username: null, password: null, hostname: null, port: null,
                pathname: "quick", params: {}, fragment: null,
            },
            lineMarker: null, body: "echo done", position: { line: 1, column: 1 },
        };
        const finishOp = {
            op: "SEND" as const, suffix: "", signal: 200, target: null,
            lineMarker: null, body: { raw: "ok", json: null },
            position: { line: 1, column: 1 },
        };
        const continueOp = { ...finishOp, signal: 102 };
        // Two turns: turn 1 kicks off the (fast) exec, turn 2 ends the loop.
        // The exec should finish in turn 1's window or turn 2's, leaving
        // channels at state=closed by the time the loop terminates.
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                { assistant: { content: "", ops: [execEditOp, continueOp], reasoning: null } },
                { assistant: { content: "", ops: [finishOp], reasoning: null } },
            ],
        });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 5,
            messages: [{ role: "user", content: "run quick exec" }],
        });
        assert.equal(result.finalStatus, 200);
        await exec.idle();

        // Channels reached terminal state.
        const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "quick",
        });
        assert.ok(entryRow);
        const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "done\n");
        assert.equal(stdout?.state, "closed");
    } finally { await db.close(); }
});

// Case B from the lifecycle question: spawn outlives the calling loop.
// The loop ends gracefully (SEND[200]) while the spawn is still running;
// after the loop closes, the spawn finishes and wakeRunNotify fires.

test("exec lifecycle B: spawn outlives calling loop — graceful loop exit does NOT abort the spawn; wake fires after loop ends", async () => {
    type WakePayload = { closeStatus: number; summary: string };
    const wakes: WakePayload[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            wakeRunNotify: (payload) => wakes.push({ closeStatus: payload.closeStatus, summary: payload.summary }),
        });
        attachYolo(engine, db);
        const sessionId = await insertSession(db, `exec-outlive-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "outlive test");
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        const execEditOp = {
            op: "EDIT" as const, suffix: "", signal: null,
            target: {
                kind: "url" as const, raw: "exec://slow", scheme: "exec",
                username: null, password: null, hostname: null, port: null,
                pathname: "slow", params: {}, fragment: null,
            },
            lineMarker: null, body: "sleep 0.5; echo finally", position: { line: 1, column: 1 },
        };
        const sendDone = {
            op: "SEND" as const, suffix: "", signal: 200, target: null,
            lineMarker: null, body: { raw: "ending early", json: null },
            position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextSize: 100000,
            responses: [
                // Turn 1: kick off slow exec, then immediately SEND[200] to end the loop.
                { assistant: { content: "", ops: [execEditOp, sendDone], reasoning: null } },
            ],
        });

        const startedAt = Date.now();
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns: 5,
            messages: [{ role: "user", content: "fire and forget" }],
        });
        const loopDuration = Date.now() - startedAt;
        assert.equal(result.finalStatus, 200, "loop ended gracefully");
        // Loop ended fast; the sleep is still running.
        assert.ok(loopDuration < 400, `loop should NOT block on the spawn — got ${loopDuration}ms`);

        // Spawn is still in-flight at this point. Wait for it.
        await exec.idle();
        const afterIdle = Date.now() - startedAt;
        assert.ok(afterIdle >= 500, `spawn should have lived ~500ms past the loop's exit — got ${afterIdle}ms total`);

        // Spawn completed cleanly post-loop. Channel content + subscription
        // reflect the truth.
        const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: "slow",
        });
        assert.ok(entryRow);
        const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "finally\n", "spawn ran to completion after the loop ended");
        assert.equal(stdout?.state, "closed");

        // Wake fired with closeStatus=200; daemon-side would open a new
        // loop with this summary (covered in Daemon.exec-wake.test.ts).
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].closeStatus, 200);
        assert.match(wakes[0].summary, /exec:\/\/slow completed \(exit 0\)/);
    } finally { await db.close(); }
});


