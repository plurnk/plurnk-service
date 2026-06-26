// run:// scheme — spawn (EDIT), irc (SEND), fork (COPY). Same-session sisters
// (SPEC §machine-processes, §actor-boundary). injectRun is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the run-scheme's OWN work: the run-table effect + the
// exact inject call. The dispatch gates (#checkWritable run-fork branch, the
// #handleCopy run-fork routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, CopyStatement, KillStatement, ReadStatement, FindStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Run from "../../src/schemes/Run.ts";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { editStmt, sendStmt } from "./_dsl.ts";

// §run-scheme — the run is the AUTHORITY: run://<name> (name in hostname), not run:///<name>.
// "." stays the self-marker; the control ops (spawn/irc/fork/kill) carry no entry path.
const runPath = (name: string): ParsedPath => ({
    kind: "url", raw: `run://${name}`, scheme: "run",
    username: null, password: null, hostname: name, port: null,
    pathname: "", params: {}, fragment: null,
});

// A run-scope STORAGE address: run://<owner>/<path> ("" owner = self), entry path present.
const runEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: `run://${owner}/${path}`, scheme: "run",
    username: null, password: null, hostname: owner, port: null,
    pathname: `/${path}`, params: {}, fragment: null,
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

// A run-scope FIND: run://<owner>/<glob> ("" owner = self).
const findEntry = (owner: string, glob: string): FindStatement => ({
    op: "FIND", suffix: "", signal: null,
    target: { kind: "url", raw: `run://${owner}/${glob}`, scheme: "run", username: null, password: null, hostname: owner, port: null, pathname: `/${glob}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// A run-scope READ: run://<owner>/<path> ("" owner = self).
const readEntry = (owner: string, path: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `run://${owner}/${path}`, scheme: "run", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("[§run-scheme-fork-scratch] a fork inherits the parent's run-scope scratch (owner-remapped), then diverges", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `fork-scratch-${crypto.randomUUID()}`);
        const parent = await insertRun(db, sessionId, null, "alpha");
        const ctxP = makeSchemeCtx({ db, sessionId, runId: parent, loopId: 0, turnId: 0 });
        const run = new Run();
        await run.edit(editStmt(runEntry("", "todo.md"), "parent note"), ctxP);

        // Fork the parent — the branch must open with the parent's scratch under its OWN name.
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const ctxF = makeSchemeCtx({ db, sessionId, runId: forkId, loopId: 0, turnId: 0 });

        const inherited = await run.find(findEntry("", "**"), ctxF);
        assert.deepEqual(inherited.results.map((r) => r.path), ["run://alpha-fork/todo.md"], "the fork's perspective holds the inherited scratch under its own name");
        const fRead = await run.read(readEntry("", "todo.md"), ctxF);
        assert.equal(fRead.content, "parent note", "the inherited scratch content is copied");

        // Divergence: the fork edits its scratch; the parent's copy is independent + untouched.
        await run.edit(editStmt(runEntry("", "todo.md"), "fork note"), ctxF);
        assert.equal((await run.read(readEntry("", "todo.md"), ctxF)).content, "fork note", "the fork's edit lands on its own copy");
        assert.equal((await run.read(readEntry("", "todo.md"), ctxP)).content, "parent note", "the parent's scratch is untouched — independent copies, diverged");
    } finally { await db.close(); }
});

test("[§run-scheme-find-perspective] a run FINDs its OWN run-scope scratch; a sister's only by name — the run's perspective", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `run-find-${crypto.randomUUID()}`);
        const alpha = await insertRun(db, sessionId, null, "alpha");
        const beta = await insertRun(db, sessionId, null, "beta");
        const ctxA = makeSchemeCtx({ db, sessionId, runId: alpha, loopId: 0, turnId: 0 });
        const ctxB = makeSchemeCtx({ db, sessionId, runId: beta, loopId: 0, turnId: 0 });
        const run = new Run();

        // Each run writes its OWN scratch (empty authority = self).
        await run.edit(editStmt(runEntry("", "todo.md"), "alpha note"), ctxA);
        await run.edit(editStmt(runEntry("", "plan.md"), "beta note"), ctxB);

        // alpha's self FIND sees ONLY alpha's scratch, addressed run://alpha/...
        const own = await run.find(findEntry("", "**"), ctxA);
        assert.equal(own.status, 200);
        assert.deepEqual(own.results.map((r) => r.path), ["run://alpha/todo.md"], "self FIND(run:///**) returns only the building run's own scratch");

        // beta's perspective excludes alpha's — isolation is structural (scope='run' + owner prefix).
        const betaOwn = await run.find(findEntry("", "**"), ctxB);
        assert.deepEqual(betaOwn.results.map((r) => r.path), ["run://beta/plan.md"], "a sibling never sees another's scratch in its own perspective");

        // A sister's scratch is reachable ONLY by explicit name (cross-run READ/FIND is allowed).
        const sister = await run.find(findEntry("beta", "**"), ctxA);
        assert.deepEqual(sister.results.map((r) => r.path), ["run://beta/plan.md"], "FIND(run://beta/**) reaches the named sister's scratch");
    } finally { await db.close(); }
});

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

test("run-scope scratch: self EDIT writes the run partition; cross-run READ reaches it; cross-run WRITE is 403", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), tokenize });
        const sessionId = await insertSession(db, `run-store-${crypto.randomUUID()}`);
        const meId = await insertRun(db, sessionId, null, "me");
        const otherId = await insertRun(db, sessionId, null, "other");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ op: "READ", suffix: "", signal: null, lineMarker: null, target, body: null, position: { line: 1, column: 1 } });

        // self EDIT(run:///note.md) — a self-owned run-scope entry; the empty authority folds to "me".
        const write = await engine.dispatch({ statement: editStmt(runEntry("", "note.md"), "scratch"), sessionId, runId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "self scratch write creates the entry");
        const stored = await (db.crud_find_run_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "run", pathname: "/me/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed (scope='run', /me/note.md) — owner folded from the empty authority");

        // cross-run READ(run://me/note.md) from 'other' — reaches the sister's scratch (perspective-private, not ACL).
        const otherLoop = await insertLoop(db, otherId, 1, "go");
        const otherTurn = await insertTurn(db, otherLoop, 1, 102);
        const readCross = await engine.dispatch({ statement: readOf(runEntry("me", "note.md")), sessionId, runId: otherId, loopId: otherLoop, turnId: otherTurn, sequence: 1, origin: "model" });
        assert.equal(readCross.status, 200, "cross-run READ reaches a sister's scratch by address");

        // cross-run EDIT(run://me/note.md) from 'other' — denied (write is self-only).
        const writeCross = await engine.dispatch({ statement: editStmt(runEntry("me", "note.md"), "tamper"), sessionId, runId: otherId, loopId: otherLoop, turnId: otherTurn, sequence: 2, origin: "model" });
        assert.equal(writeCross.status, 403, "cross-run WRITE is denied — read a sister's notes, never write them");
    } finally { await db.close(); }
});
