// run:// scheme — spawn (EDIT), irc (SEND), fork (COPY). Same-session sisters
// (SPEC §machine-processes, §actor-boundary). injectRun is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the run-scheme's OWN work: the run-table effect + the
// exact inject call. The dispatch gates (#checkWritable run-fork branch, the
// #handleCopy run-fork routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, CopyStatement, KillStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";
import { editStmt, sendStmt } from "./_dsl.ts";

const runPath = (name: string): ParsedPath => ({
    kind: "url", raw: `run:///${name}`, scheme: "run",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${name}`, params: {}, fragment: null,
});

// The Daemon.inject seam as a recording stub — its drain/enqueue behavior is
// covered by the Daemon/inject suites; here we assert exactly what the run
// scheme hands it.
const recordingInjectRun = () => {
    const calls: Array<{ sessionId: number; runId: number; prompt: string }> = [];
    const injectRun = async (args: { sessionId: number; runId: number; prompt: string }) => {
        calls.push(args);
        return { action: "enqueued_new_loop" as const, loopId: -1 };
    };
    return { calls, injectRun };
};

const tokenize = (text: string): number => Math.ceil(text.length / 4);

test("[§run-scheme-spawn] EDIT(run:///name):prompt spawns a same-session sister, seeded via injectRun", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-spawn-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: editStmt(runPath("worker"), "investigate the bug"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "spawn returns 200");

        const worker = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "worker" });
        if (worker === undefined) throw new Error("spawn must create a run named 'worker' in the session");
        const meta = await (db.fork_get_run as PrepMethod).get<{ session_id: number; origin: string }>({ id: worker.id });
        assert.equal(meta?.origin, "model", "spawned run's origin is the spawning writer");
        assert.equal(meta?.session_id, sessionId, "spawned run shares the session (sisters)");

        assert.equal(calls.length, 1, "exactly one injectRun call");
        assert.deepEqual(calls[0], { sessionId, runId: worker.id, prompt: "investigate the bug" }, "the new run is started with the prompt");
    } finally { await db.close(); }
});

test("[§run-scheme-spawn] EDIT(run:///.) cannot spawn self — 400, no inject", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-spawn-self-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: editStmt(runPath("."), "loop forever"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "spawning self is rejected");
        assert.equal(calls.length, 0, "no inject on a rejected spawn");
    } finally { await db.close(); }
});

test("[§run-scheme-irc] SEND(run:///name):msg delivers to a sister; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-irc-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const workerId = await insertRun(db, sessionId, null, "worker");

        const ok = await engine.dispatch({
            statement: sendStmt(null, runPath("worker"), "what's your status?"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(ok.status, 200, "irc to an existing sister returns 200");
        assert.deepEqual(calls.at(-1), { sessionId, runId: workerId, prompt: "what's your status?" }, "the message is delivered to the named sister");

        const missing = await engine.dispatch({
            statement: sendStmt(null, runPath("ghost"), "anyone there?"),
            sessionId, runId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(missing.status, 404, "irc to a non-existent sister is 404");
        assert.equal(calls.length, 1, "no inject for a missing sister");
    } finally { await db.close(); }
});

test("[§run-scheme-fork] COPY(run:///.):prompt forks — a branch run started via injectRun", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-fork-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId, null, "explorer");
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const forkStmt: CopyStatement = {
            op: "COPY", suffix: "", signal: null, target: runPath("."),
            lineMarker: null, body: "take the other branch", position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: forkStmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "fork returns 200");
        const branchName = (result as { body?: string }).body ?? "";
        assert.equal(branchName, "explorer-fork", "the branch is the source's name + -fork");

        const branch = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: branchName });
        if (branch === undefined) throw new Error("fork must create the branch run in the session");
        assert.notEqual(branch.id, runId, "the branch is a distinct run");
        assert.deepEqual(calls.at(-1), { sessionId, runId: branch.id, prompt: "take the other branch" }, "the branch is continued with the fork prompt");
    } finally { await db.close(); }
});

test("[§run-scheme-cap] spawn AND fork past PLURNK_SESSION_RUNS_MAX_ACTIVE fail hard (508), create nothing", async () => {
    const db = await openMigrated();
    const prior = process.env.PLURNK_SESSION_RUNS_MAX_ACTIVE;
    process.env.PLURNK_SESSION_RUNS_MAX_ACTIVE = "1"; // ceiling of 1 active run
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-cap-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);        // the acting run, its loop 102 = 1 active = the ceiling
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spawn = await engine.dispatch({
            statement: editStmt(runPath("worker"), "go"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 508, "spawn at the ceiling is refused, hard");

        const forkStmt: CopyStatement = {
            op: "COPY", suffix: "", signal: null, target: runPath("."),
            lineMarker: null, body: "branch", position: { line: 1, column: 1 },
        };
        const fork = await engine.dispatch({
            statement: forkStmt, sessionId, runId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(fork.status, 508, "fork at the ceiling is refused, hard");

        const worker = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "worker" });
        assert.equal(worker, undefined, "no run is created past the ceiling");
        assert.equal(calls.length, 0, "no inject on a refused spawn/fork");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SESSION_RUNS_MAX_ACTIVE;
        else process.env.PLURNK_SESSION_RUNS_MAX_ACTIVE = prior;
        await db.close();
    }
});

test("[§run-scheme-terminate] KILL(run:///name) aborts a sister by address; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const cancelRun = (runId: number): boolean => { killed.push(runId); return true; };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelRun, tokenize });
        const sessionId = await insertSession(db, `run-kill-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const workerId = await insertRun(db, sessionId, null, "worker");

        const killWorker: KillStatement = { op: "KILL", suffix: "", signal: null, target: runPath("worker"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const ok = await engine.dispatch({ statement: killWorker, sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(ok.status, 200, "KILL of an existing sister returns 200");
        assert.deepEqual(killed, [workerId], "the named sister's run is aborted by id");

        const killGhost: KillStatement = { op: "KILL", suffix: "", signal: null, target: runPath("ghost"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const missing = await engine.dispatch({ statement: killGhost, sessionId, runId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(missing.status, 404, "KILL of a non-existent sister is 404");
        assert.equal(killed.length, 1, "no abort for a missing sister");
    } finally { await db.close(); }
});
