// Exec scheme — the EXEC op handler per plurnk.md.
//   <<EXEC[runtime](cwd):command:EXEC
// Auto-generates a `<runtime>:///<loop>/<turn>/<seq>` entry (the runtime tag IS the
// authority); spawns the subprocess; streams stdout/stderr into channels; closes
// subscription + transitions channel state at exit.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, seedEntryWithChannel, rootWorkspace, makeSchemeCtx } from "./_helpers.ts";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";

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

const withWorkspace = async <T>(fn: (ctx: {
    engine: Engine;
    exec: Exec;
    db: Awaited<ReturnType<typeof openMigrated>>;
    workspaceId: number; workerId: number; loopId: number; turnId: number;
}) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "exec test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn({ engine, exec, db, workspaceId, workerId, loopId, turnId });
    } finally {
        await db.close();
    }
};

test("EXEC: empty body → 400 (no command)", async () => {
    await withWorkspace(async (ctx) => {
        const result = await ctx.engine.dispatch({
            statement: execStmt("sh", null, ""),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    });
});

test("Exec.applyResolution: malformed accepted proposal state remains an internal invariant", async () => {
    await withWorkspace(async (ctx) => {
        await assert.rejects(
            ctx.exec.applyResolution(
                { attrs: {} },
                makeSchemeCtx({
                    db: ctx.db,
                    workspaceId: ctx.workspaceId,
                    workerId: ctx.workerId,
                    loopId: ctx.loopId,
                    turnId: ctx.turnId,
                    executors: await testExecutors(),
                }),
            ),
            InvalidOperationResultError,
        );
    });
});

test("{§exec-target-routing} an empty-body scheme target resolves as the command", async () => {
    await withWorkspace(async (ctx) => {
        // A stored script lives at worker:///script; running it runs its content.
        await seedEntryWithChannel(ctx.db, { workspaceId: ctx.workspaceId, scheme: "worker", pathname: "/script", channel: "body", content: "echo resolved-from-scheme", state: "static" });

        const statement: ExecStatement = {
            op: "EXEC", suffix: "", signal: "sh",
            target: { kind: "url", raw: "worker:///script", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/script", query: null, fragment: null },
            lineMarker: null, body: "", position: { line: 1, column: 1 },
        };

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "empty body + scheme target is accepted, not 400");
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
        assert.ok(entryRow, "sh entry exists");
        const stdout = await ctx.db.test_get_channel.get<{ content: string }>({ entry_id: entryRow.id, name: "stdout" });
        assert.equal(stdout?.content, "resolved-from-scheme\n", "the stored script's content was resolved into the command and run");
    });
});

test("bare EXEC defaults to sh and proposes with {runtime, cwd, command, pathname}", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt(null, null, "echo hello"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { runtime: string; cwd: string | null; command: string; pathname: string };
        assert.equal(attrs.runtime, "sh");
        assert.equal(attrs.cwd, null);
        assert.equal(attrs.command, "echo hello");
        // Coordinate-only pathname: the runtime lives in the entry's SCHEME (tag authority),
        // so the stream entry at <runtime>:///<loop_seq>/<turn_seq>/<sequence> carries just the
        // coordinate it shares with the log row.
        assert.match(attrs.pathname, /^\/\d+\/\d+\/\d+$/, "pathname is the log coordinate");

        ctx.engine.resolveProposal(logEntryId, { decision: "reject" });
        await dispatchPromise;
    });
});

test("{§exec-target-routing} the target slot remains distinct from cwd", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        // A data-source runtime with a target — EXEC[jq](data/users.json):length. The target is the
        // input file; cwd is the workspace it resolves against. The old contract crammed the target into
        // cwd (so a relative data path resolved against the daemon's cwd → not found). Now they're distinct.
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("jq", "data/users.json", "length"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const attrs = JSON.parse(row?.attrs ?? "{}") as { runtime: string; cwd: string | null; target: string | null; command: string };
        assert.equal(attrs.target, "data/users.json", "the (target) slot is the data source, in attrs.target");
        assert.equal(attrs.cwd, null, "cwd is the workspace (null headless here), never the target");
        assert.equal(attrs.command, "length", "the body is the jq program");
        await dispatchPromise; // jq(read) auto-runs inline (no proposal); let it settle
        await ctx.exec.idle();
    });
});

test("{§exec-target-routing} a file target with an empty body runs the file", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-file-"));
        try {
            await writeFile(join(root, "greet.sh"), "echo hi\n");
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idD = deferred<number>();
            const p = ctx.engine.dispatch({
                statement: execStmt("sh", "greet.sh", ""),  // EXEC[sh](greet.sh): — empty body, FILE target
                workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idD.resolve(id),
            });
            const id = await idD.promise;  // a log row minted ⇒ it dispatched (proposed), never the empty-body 400
            const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
            const attrs = JSON.parse(row?.attrs ?? "{}") as { cwd: string | null; target: string | null; command: string };
            assert.equal(attrs.target, "greet.sh", "a FILE target is the program the executor runs (body = stdin)");
            assert.equal(attrs.cwd, root, "a file target never moves cwd — it stays the workspace");
            assert.equal(attrs.command, "", "empty body is legal for a file target — run it, no stdin");
            ctx.engine.resolveProposal(id, { decision: "reject" });
            await p.catch(() => {});
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§exec-target-routing} a directory target overrides cwd", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-directory-"));
        try {
            await mkdir(join(root, "sub"));
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const idD = deferred<number>();
            const p = ctx.engine.dispatch({
                statement: execStmt("sh", "sub", "echo hi"),  // EXEC[sh](sub):echo hi — DIRECTORY target
                workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idD.resolve(id),
            });
            const id = await idD.promise;
            const row = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id });
            const attrs = JSON.parse(row?.attrs ?? "{}") as { cwd: string | null; target: string | null; command: string };
            assert.equal(attrs.cwd, join(root, "sub"), "a DIRECTORY target overrides cwd — the body runs there");
            assert.equal(attrs.target, null, "a directory is neither program nor data source — target is cleared");
            assert.equal(attrs.command, "echo hi", "the body is the command");
            ctx.engine.resolveProposal(id, { decision: "reject" });
            await p.catch(() => {});
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§exec-target-routing} an empty-body directory target is refused", async () => {
    await withWorkspace(async (ctx) => {
        const root = await mkdtemp(join(tmpdir(), "exec-target-empty-directory-"));
        try {
            await mkdir(join(root, "sub"));
            await rootWorkspace(ctx.db, ctx.workspaceId, root);
            const result = await ctx.engine.dispatch({
                statement: execStmt("sh", "sub", ""),  // EXEC[sh](sub): — DIRECTORY target, empty body
                workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            });
            assert.equal(result.status, 400, "a directory target with empty body has nothing to run");
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

// applyResolution returns 200/"started" immediately; the spawn runs async.
// The dispatch outcome on the log entry is "started" — the SPAWN's exit
// result lives intact on the subscription row's close_result; close_status is
// its constrained relational projection and channels carry lifecycle state.

test("EXEC[sh]: clean exit → channels at state=closed, stdout captured, subscription closed at 200", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("sh", null, "echo marker"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string; outcome: string | null }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        assert.equal(log?.outcome, "started", "dispatch outcome reflects when applyResolution returned");

        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow, `sh://${pathname} entry exists`);
        const stdout = await ctx.db.test_get_channel.get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        assert.equal(stdout?.content, "marker\n");
        assert.equal(stdout?.state, "closed");

        const sub = await ctx.db.test_get_subscription_by_entry.get<{ close_status: number | null; close_result: string | null }>({
            worker_id: ctx.workerId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 200, "spawn's actual exit-0 lands on subscription.close_status");
        assert.deepEqual(JSON.parse(sub?.close_result ?? "null"), { status: 200, exitCode: 0 });
    });
});

test("EXEC[sh]: non-zero exit → channels=errored, stderr captured, subscription closed at 500", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("sh", null, "echo oops >&2; exit 7"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };

        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow);
        const stderr = await ctx.db.test_get_channel.get<{ content: string; state: string }>({
            entry_id: entryRow.id, name: "stderr",
        });
        assert.equal(stderr?.content, "oops\n");
        assert.equal(stderr?.state, "errored");

        const sub = await ctx.db.test_get_subscription_by_entry.get<{ close_status: number | null; close_result: string | null }>({
            worker_id: ctx.workerId, entry_id: entryRow.id,
        });
        assert.equal(sub?.close_status, 500, "non-zero exit → subscription closed at 500");
        const terminal = JSON.parse(sub?.close_result ?? "null") as {
            status?: number;
            exitCode?: number;
            problem?: { type?: string; status?: number; detail?: string };
        };
        assert.equal(terminal.status, 500);
        assert.equal(terminal.exitCode, 7);
        assert.equal(terminal.problem?.status, 500);
        assert.equal(terminal.problem?.type, "https://problems.plurnk.dev/executor/subprocess/nonzero-exit");
        assert.equal(terminal.problem?.detail, "'sh' exited with code 7.");
    });
});

test("EXEC: cwd defaults to workspace.project_root when statement target is null", async () => {
    // Writes a file via shell into "$PWD/<marker>", then asserts the file
    // exists at <project_root>/<marker> — proves cwd really was project_root.
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-cwd-default-"));
    const marker = `cwd-default-${crypto.randomUUID().slice(0, 6)}.txt`;
    try {
        await withWorkspace(async (ctx) => {
            await ctx.db.test_set_workspace_project_root.run({
                id: ctx.workspaceId, project_root: workspace,
            });
            const idDeferred = deferred<number>();
            const dispatchPromise = ctx.engine.dispatch({
                statement: execStmt("sh", null, `echo here > ${marker}`),
                workspaceId: ctx.workspaceId, workerId: ctx.workerId,
                loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            ctx.engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
            await dispatchPromise;
            await ctx.exec.idle();

            // The file landed in the project_root, not in plurnk-service's cwd.
            const written = await readFile(join(workspace, marker), "utf8").catch(() => null);
            assert.equal(written, "here\n",
                `EXEC's cwd should have defaulted to workspace.project_root (${workspace}); file ${marker} should exist there`);
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("EXEC[node]: runs node code via -e and captures stdout", async () => {
    await withWorkspace(async (ctx) => {
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: execStmt("node", null, "console.log(2 + 3)"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await ctx.exec.idle();

        const log = await ctx.db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await ctx.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "node", pathname,
        });
        assert.ok(entryRow);
        const stdout = await ctx.db.test_get_channel.get<{ content: string }>({
            entry_id: entryRow.id, name: "stdout",
        });
        // stdout reflects the subprocess's INHERITED env ({§exec-env-scoped}) — a host FORCE_COLOR makes
        // node colorize the number (`\x1b[33m5\x1b[39m`). This test verifies stdout CAPTURE, not exact
        // bytes, so strip ANSI control codes before the equality (deterministic on any host).
        assert.equal((stdout?.content ?? "").replace(/\x1b\[[0-9;]*m/g, ""), "5\n");
    });
});

test("EXEC: subscription row opens then closes; stream/event fires per chunk + transition", async () => {
    type Event = { workspaceId: number; entryId: number; channel: string; state: string; contentLength: number };
    const events: Event[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            streamEventNotify: (workspaceId, event) => events.push({ workspaceId, ...event }),
        });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-notify-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "exec notify test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", null, "echo one"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();

        const workspaceEvents = events.filter((e) => e.workspaceId === workspaceId);
        const chunkEvents = workspaceEvents.filter((e) => e.state === "active");
        const closedEvents = workspaceEvents.filter((e) => e.state === "closed");
        assert.ok(chunkEvents.length >= 1, "at least one chunk event for stdout");
        assert.equal(closedEvents.length, 2, "both stdout and stderr transition to closed");

        // Subscription row exists and is closed at 200.
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname: chunkEvents.length > 0
                ? (await db.test_get_entry_by_id.get<{ pathname: string }>({ id: chunkEvents[0].entryId }))!.pathname
                : "",
        });
        const sub = await db.test_get_subscription_by_entry.get<{ close_status: number | null }>({
            worker_id: workerId, entry_id: entryRow!.id,
        });
        assert.equal(sub?.close_status, 200);
    } finally { await db.close(); }
});
