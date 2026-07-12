// Process-KILL (plurnk-service#203). A backgrounded (host-effect) exec is
// addressable by its stamped coordinate and killable via the same controller
// abort loop.cancel rides. This proves the 200 case end-to-end: a real `sleep`
// spawned, killed mid-flight, and the spawn drained — not just the routing.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, KillStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

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
        const sessionId = await insertSession(db, `exec-kill-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "exec kill test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // Background a long sleep (host effect → proposes 202; accept → spawns).
        const idD = deferred<number>();
        const execPromise = engine.dispatch({
            statement: execStmt("sleep 30"), sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model", onDispatch: (id) => idD.resolve(id),
        });
        const execLogId = await idD.promise;
        engine.resolveProposal(execLogId, { decision: "accept" });
        const started = await execPromise;
        assert.equal(started.status, 200, "host exec should background (200 started)");

        // Recover the stamped exec:/// coordinate from the log row.
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string }>({ id: execLogId });
        const pathname = (JSON.parse(row?.attrs ?? "{}") as { pathname?: string }).pathname ?? "";
        assert.notEqual(pathname, "", "exec entry must carry a stamped pathname");

        // The spawn is registered + in-flight.
        const exec = registry.get("exec") as unknown as Exec;
        assert.equal(exec.hasActiveSpawns(runId), true, "the sleep must be in-flight before KILL");

        // KILL it by coordinate.
        const kill = await engine.dispatch({
            statement: killExec(pathname), sessionId, runId, loopId, turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "KILL on a running exec returns 200");

        // The abort tears the child down; idle() drains the killed spawn.
        await exec.idle();
        assert.equal(exec.hasActiveSpawns(runId), false, "the killed spawn must be drained");
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL on an unknown exec coordinate → 404 (#203 matrix)", async () => {
    const db = await openMigrated();
    try {
        const registry = new SchemeRegistry();
        const engine = new Engine({ db, schemes: registry });
        engine.setExecutors(await testExecutors());
        const sessionId = await insertSession(db, `exec-kill-404-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "kill 404 test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // No spawn was ever stamped at this coordinate — exec is model-writable
        // (no 403 confound), so kill() resolves the closed-subscription lookup to 404.
        const r = await engine.dispatch({
            statement: killExec("/sh/9/9/9"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 404, "KILL on a coordinate that was never spawned is 404");
    } finally { await db.close(); }
});
