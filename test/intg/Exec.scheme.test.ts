// Exec scheme — the EXEC op handler per plurnk.md.
//   <<EXEC[runtime](cwd):command:EXEC
// Auto-generates an `exec://r-<uuid>` entry; spawns the subprocess;
// streams stdout/stderr into channels; closes subscription + transitions
// channel state at exit.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

const execStmt = (runtime: string | null, cwd: string | null, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime,
    target: cwd === null ? null : { kind: "local", raw: cwd },
    lineMarker: null, body, position: { line: 1, column: 1 },
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
        engine.setExecutors(await testExecutors());
        const sessionId = await insertSession(db, `exec-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn({ engine, exec, db, sessionId, runId, loopId, turnId });
    } finally {
        await db.close();
    }
};

test("EXEC: empty body → 400 (no command)", async () => {
    await withSession(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt("sh", null, ""),
            sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    });
});

test("EXEC: proposes 202 with {runtime, cwd, command, pathname}", async () => {
    await withSession(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("sh", null, "echo hello"),
            sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { runtime: string; cwd: string | null; command: string; pathname: string };
        assert.equal(attrs.runtime, "sh");
        assert.equal(attrs.cwd, null);
        assert.equal(attrs.command, "echo hello");
        // Coordinate-based pathname mirrors the log row's URI: the stream
        // entry at exec://<loop_seq>/<turn_seq>/<sequence>/EXEC parallels
        // the log row at log://<...>/EXEC.
        assert.match(attrs.pathname, /^\d+\/\d+\/\d+\/EXEC$/, "pathname is the log coordinate");

        ctx.engine.resolveProposal(logEntryId, { decision: "reject" });
        await dispatchPromise;
    });
});

// applyResolution returns 200/"started" immediately; the spawn runs async.
// The dispatch outcome on the log entry is "started" — the SPAWN's exit
// info (exit code, abort) lives on the subscription row's close_status
// and on the channel state transitions.

test("EXEC[sh]: clean exit → channels at state=closed, stdout captured, subscription closed at 200", async () => {
    await withSession(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("sh", null, "echo marker"),
            sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        await ctx.exec.idle();

        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string; outcome: string | null }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        assert.equal(log?.outcome, "started", "dispatch outcome reflects when applyResolution returned");

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname,
        });
        assert.ok(entryRow, `exec://${pathname} entry exists`);
        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "marker\n");
        assert.equal(stdout?.state, "closed");

        const sub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200, "spawn's actual exit-0 lands on subscription.close_status");
    });
});

test("EXEC[sh]: non-zero exit → channels=errored, stderr captured, subscription closed at 500", async () => {
    await withSession(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("sh", null, "echo oops >&2; exit 7"),
            sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };

        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname,
        });
        assert.ok(entryRow);
        const stderr = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "oops\n");
        assert.equal(stderr?.state, "errored");

        const sub = await (ctx.db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: ctx.runId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 500, "non-zero exit → subscription closed at 500");
    });
});

test("EXEC: cwd defaults to session.project_root when statement target is null", async () => {
    // Writes a file via shell into "$PWD/<marker>", then asserts the file
    // exists at <project_root>/<marker> — proves cwd really was project_root.
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-cwd-default-"));
    const marker = `cwd-default-${crypto.randomUUID().slice(0, 6)}.txt`;
    try {
        await withSession(async (ctx) => {
            await (ctx.db.test_set_session_project_root as PrepMethod).run({
                id: ctx.sessionId, project_root: workspace,
            });
            const idDeferred = deferred<number>();
            const dispatchPromise = ctx.engine.dispatch({
                statement: execStmt("sh", null, `echo here > ${marker}`),
                sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            ctx.engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
            await dispatchPromise;
            await ctx.exec.idle();

            // The file landed in the project_root, not in plurnk-service's cwd.
            const written = await readFile(join(workspace, marker), "utf8").catch(() => null);
            assert.equal(written, "here\n",
                `EXEC's cwd should have defaulted to session.project_root (${workspace}); file ${marker} should exist there`);
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("EXEC[node]: runs node code via -e and captures stdout", async () => {
    await withSession(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("node", null, "console.log(2 + 3)"),
            sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname,
        });
        assert.ok(entryRow);
        const stdout = await (ctx.db.test_get_channel as PrepMethod).get<{ content: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "5\n");
    });
});

test("EXEC: subscription row opens then closes; stream/event fires per chunk + transition", async () => {
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
        engine.setExecutors(await testExecutors());
        const sessionId = await insertSession(db, `exec-notify-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec notify test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", null, "echo one"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        const sessionEvents = events.filter((e) => e.sessionId === sessionId);
        const chunkEvents = sessionEvents.filter((e) => e.state === "active");
        const closedEvents = sessionEvents.filter((e) => e.state === "closed");
        assert.ok(chunkEvents.length >= 1, "at least one chunk event for stdout");
        assert.equal(closedEvents.length, 2, "both stdout and stderr transition to closed");

        // Subscription row exists and is closed at 200.
        const entryRow = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
            scheme: "exec", pathname: chunkEvents.length > 0
                ? (await (db.test_get_entry_by_id as PrepMethod).get<{ pathname: string }>({ id: chunkEvents[0].entryId }))!.pathname
                : "",
        });
        const sub = await (db.test_get_subscription_by_entry as PrepMethod).get<{ close_status: number | null }>({
            run_id: runId, entry_id: entryRow!.id,
        });
        assert.equal(sub?.close_status, 200);
    } finally { await db.close(); }
});
