// Process-KILL (plurnk-service#203). A backgrounded (host-effect) exec is
// addressable by its stamped coordinate and killable via the same controller
// abort loop.cancel rides. This proves the 200 case end-to-end: a real `sleep`
// spawned, killed mid-flight, and the spawn drained — not just the routing.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, KillStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, seedEntryWithChannel, testExecutors } from "./_helpers.ts";

const execStmt = (command: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: null, target: null,
    lineMarker: null, body: command, position: { line: 1, column: 1 },
});

const killExec = (pathname: string): KillStatement => ({
    op: "KILL", suffix: "", signal: null,
    target: {
        kind: "url", raw: `exec://${pathname}`, scheme: "exec",
        username: null, password: null, hostname: null, port: null,
        pathname, params: {}, fragment: null,
    },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

test("Engine.dispatch: KILL aborts a running (backgrounded) exec — 200, spawn drained", async () => {
    const db = await openMigrated();
    try {
        const registry = new SchemeRegistry();
        const engine = new Engine({ db, schemes: registry });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-kill-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "exec kill test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // Background a long sleep (host effect → proposes 202; accept → spawns).
        const idD = deferred<number>();
        const execPromise = engine.dispatch({
            statement: execStmt("sleep 30"), workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model", onDispatch: (id) => idD.resolve(id),
        });
        const execLogId = await idD.promise;
        engine.resolveProposal(execLogId, { decision: "accept" });
        const started = await execPromise;
        assert.equal(started.status, 200, "host exec should background (200 started)");

        // Recover the stamped exec:/// coordinate from the log row.
        const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: execLogId });
        const pathname = (JSON.parse(row?.attrs ?? "{}") as { pathname?: string }).pathname ?? "";
        assert.notEqual(pathname, "", "exec entry must carry a stamped pathname");

        // The spawn is registered + in-flight.
        const exec = registry.get("exec") as unknown as Exec;
        assert.equal(exec.hasActiveSpawns(workerId), true, "the sleep must be in-flight before KILL");

        // KILL it by coordinate.
        const kill = await engine.dispatch({
            statement: killExec(pathname), workspaceId, workerId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "KILL on a running exec returns 200");

        // The abort tears the child down; idle() drains the killed spawn.
        await exec.idle();
        assert.equal(exec.hasActiveSpawns(workerId), false, "the killed spawn must be drained");
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL on an unknown exec coordinate → 404 (#203 matrix)", async () => {
    const db = await openMigrated();
    try {
        const registry = new SchemeRegistry();
        const engine = new Engine({ db, schemes: registry });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-kill-404-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "kill 404 test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // No spawn was ever stamped at this coordinate — exec is model-writable
        // (no 403 confound), so kill() resolves the closed-subscription lookup to 404.
        const r = await engine.dispatch({
            statement: killExec("/sh/9/9/9"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 404, "KILL on a coordinate that was never spawned is 404");
    } finally { await db.close(); }
});

test("a stream KILL error answers in the model's runtime-tag scheme, never the internal exec:// (#553)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `exec-kill-canon-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = { db, workspaceId, workerId, loopId: 0, turnId: 0, writer: "model" as const, signal: undefined, mimetypes: undefined, tokenize: (t: string) => t.length };
        const exec = new Exec();
        // The model addresses a stream by its RUNTIME TAG; kill() must render the error in the
        // scheme it was CALLED with (the dispatcher passes the model's schemeName), never the
        // retired-internal exec (#527). run11: the model KILLed sh:/// and got exec:// back.
        const notRunning = await exec.kill("/3/1/4", null, ctx as never, "sh");
        assert.equal(notRunning.status, 404);
        assert.match(notRunning.problem?.detail ?? "", /sh:\/\/\/3\/1\/4/, "error names the model's own sh:/// address");
        assert.doesNotMatch(notRunning.problem?.detail ?? "", /exec:\/\//, "never leaks the internal exec:// scheme");
        // The default (other internal callers) stays exec — no behavior change off the model path.
        const bare = await exec.kill("/3/1/4", null, ctx as never);
        assert.match(bare.problem?.detail ?? "", /exec:\/\//, "the default scheme is unchanged for non-model callers");
    } finally { await db.close(); }
});

test("KILL rejects streams whose terminal state is already durable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `exec-kill-terminal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = { db, workspaceId, workerId, loopId: 0, turnId: 0, writer: "model" as const, signal: undefined, mimetypes: undefined, tokenize: (t: string) => t.length };
        const exec = new Exec();
        const close = async (pathname: string, result: { status: number; problem?: never } | ReturnType<typeof Results.failure>): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                workerId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                workerId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };

        await close("/3/1/1", { status: 200 });
        const closed = await exec.kill("/3/1/1", null, ctx as never, "sh");
        assert.equal(closed.status, 409);
        assert.equal(closed.problem?.type, "https://problems.plurnk.dev/scheme/exec/stream-already-terminal");
        assert.equal(closed.problem?.terminalStatus, 200);
        assert.match(closed.problem?.detail ?? "", /already concluded with status 200/);

        await close("/3/1/2", Results.failure("executor:sh", "killed", 499, "killed"));
        const killed = await exec.kill("/3/1/2", null, ctx as never, "sh");
        assert.equal(killed.status, 410);
        assert.equal(killed.problem?.type, "https://problems.plurnk.dev/scheme/exec/stream-already-killed");
    } finally { await db.close(); }
});
