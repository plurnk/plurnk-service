// run:// scheme — spawn + fork (COPY), irc (SEND), terminate (KILL). Same-session sisters
// (SPEC §machine-processes, §actor-boundary). injectRun is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the run-scheme's OWN work: the run-table effect + the
// exact inject call. The dispatch gates (#checkWritable run-copy branch, the
// #handleCopy run-copy routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, CopyStatement, KillStatement, ReadStatement, FindStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Run from "../../src/schemes/Run.ts";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { editStmt, sendStmt, readStmt } from "./_dsl.ts";

// §run-scheme — the run is the AUTHORITY: run://<name> (name in hostname), run://self for the current run.
// run://self is the self-marker; the control ops (spawn/irc/fork/kill) carry no entry path.
const runPath = (name: string): ParsedPath => ({
    kind: "url", raw: `run://${name}`, scheme: "run",
    username: null, password: null, hostname: name, port: null,
    pathname: "", params: {}, fragment: null,
});

// A run-scope STORAGE address: run://<owner>/<path> (owner "self" = the current run), entry path present.
const runEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: `run://${owner}/${path}`, scheme: "run",
    username: null, password: null, hostname: owner, port: null,
    pathname: `/${path}`, params: {}, fragment: null,
});

// Run control via COPY (grammar 0.74.41 OP×resource matrix): COPY(run://<name>):prompt spawns a
// fresh sister; COPY(run://self):prompt forks. The body is the seed prompt, not a dst path.
const copyRun = (name: string, prompt: string): CopyStatement => ({
    op: "COPY", suffix: "", signal: null, target: runPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
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

// A run-scope FIND: run://<owner>/<glob> (owner "self" = the current run).
const findEntry = (owner: string, glob: string): FindStatement => ({
    op: "FIND", suffix: "", signal: null,
    target: { kind: "url", raw: `run://${owner}/${glob}`, scheme: "run", username: null, password: null, hostname: owner, port: null, pathname: `/${glob}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// A run-scope READ: run://<owner>/<path> (owner "self" = the current run).
const readEntry = (owner: string, path: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `run://${owner}/${path}`, scheme: "run", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// A run-scope ENTRY KILL: run://<owner>/<path> — deletes the scratch entry (path present).
const killEntry = (owner: string, path: string): KillStatement => ({
    op: "KILL", suffix: "", signal: null,
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
        await run.edit(editStmt(runEntry("self", "todo.md"), "parent note"), ctxP);

        // Fork the parent — the branch must open with the parent's scratch under its OWN name.
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const ctxF = makeSchemeCtx({ db, sessionId, runId: forkId, loopId: 0, turnId: 0 });

        const inherited = await run.find(findEntry("self", "**"), ctxF);
        assert.deepEqual(inherited.results.map((r) => r.path), ["run://alpha-fork/todo.md"], "the fork's perspective holds the inherited scratch under its own name");
        const fRead = await run.read(readEntry("self", "todo.md"), ctxF);
        assert.equal(fRead.content, "parent note", "the inherited scratch content is copied");

        // Divergence: the fork edits its scratch; the parent's copy is independent + untouched.
        await run.edit(editStmt(runEntry("self", "todo.md"), "fork note"), ctxF);
        assert.equal((await run.read(readEntry("self", "todo.md"), ctxF)).content, "fork note", "the fork's edit lands on its own copy");
        assert.equal((await run.read(readEntry("self", "todo.md"), ctxP)).content, "parent note", "the parent's scratch is untouched — independent copies, diverged");
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

        // Each run writes its OWN scratch (run://self).
        await run.edit(editStmt(runEntry("self", "todo.md"), "alpha note"), ctxA);
        await run.edit(editStmt(runEntry("self", "plan.md"), "beta note"), ctxB);

        // alpha's self FIND sees ONLY alpha's scratch, addressed run://alpha/...
        const own = await run.find(findEntry("self", "**"), ctxA);
        assert.equal(own.status, 200);
        assert.deepEqual(own.results.map((r) => r.path), ["run://alpha/todo.md"], "self FIND(run://self/**) returns only the building run's own scratch");

        // beta's perspective excludes alpha's — isolation is structural (scope='run' + owner prefix).
        const betaOwn = await run.find(findEntry("self", "**"), ctxB);
        assert.deepEqual(betaOwn.results.map((r) => r.path), ["run://beta/plan.md"], "a sibling never sees another's scratch in its own perspective");

        // A sister's scratch is reachable ONLY by explicit name (cross-run READ/FIND is allowed).
        const sister = await run.find(findEntry("beta", "**"), ctxA);
        assert.deepEqual(sister.results.map((r) => r.path), ["run://beta/plan.md"], "FIND(run://beta/**) reaches the named sister's scratch");
    } finally { await db.close(); }
});

test("[§run-scheme-spawn] COPY(run://name):prompt spawns a same-session sister, seeded via injectRun", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-spawn-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: copyRun("worker", "investigate the bug"),
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

test("[§run-scheme-spawn] COPY-spawning a name a LIVE sister holds is refused 409 — legible, never a raw UNIQUE 500", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-spawn-live-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'worker' is already RUNNING (a loop at the default live status 102).
        const sister = await insertRun(db, sessionId, null, "worker");
        await insertLoop(db, sister, 1, "working");

        const result = await engine.dispatch({
            statement: copyRun("worker", "do it again"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 409, "a live name-collision is a legible 409, not a 500");
        assert.match(String((result as { error?: string }).error ?? ""), /worker.*already running|already running/, "the message names the live run");
        assert.equal(calls.length, 0, "no inject on a refused spawn");
    } finally { await db.close(); }
});

test("[§run-scheme-spawn] a TERMINATED sister's name is reclaimed — spawn succeeds, newest wins", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-spawn-reclaim-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'worker' that already TERMINATED (its loop crossed into 200) — its name is spent.
        const dead = await insertRun(db, sessionId, null, "worker");
        const deadLoop = await insertLoop(db, dead, 1, "done");
        await (db.test_set_loop_status as PrepMethod).run({ id: deadLoop, status: 200 });

        const result = await engine.dispatch({
            statement: copyRun("worker", "fresh work"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "a terminated name is free to reclaim");
        assert.equal(calls.length, 1, "the reclaimed spawn injects its fresh prompt");
        // The frozen-name/permanent-history invariant: the dead run keeps its name (a new row holds it
        // too) and resolution picks the NEWEST — the reclaimed run, not the corpse.
        const resolved = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "worker" });
        assert.notEqual(resolved?.id, dead, "run_resolve_by_name resolves the fresh run, never the terminated one");
        assert.equal(calls[0]?.runId, resolved?.id, "inject targets the reclaimed run");
    } finally { await db.close(); }
});

test("[§run-scheme-collect] READ(run://name) collects the deliverable — message done, 425 running, 404 absent", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `run-collect-${crypto.randomUUID()}`);
        const reader = await insertRun(db, sessionId); // the sister doing the collection
        const ctx = makeSchemeCtx({ db, sessionId, runId: reader });
        const run = new Run();

        // No such run → 404 (not a bare 400 the model can't read).
        const missing = await run.read(readStmt(runPath("ghost")), ctx);
        assert.equal(missing.status, 404, "a name with no run is 404");

        // A worker still running (its loop at the default live status 102) hasn't delivered → 425, steer to 202.
        const worker = await insertRun(db, sessionId, null, "worker-db");
        const wLoop = await insertLoop(db, worker, 1, "find db");
        const running = await run.read(readStmt(runPath("worker-db")), ctx);
        assert.equal(running.status, 425, "a still-running worker hasn't delivered — 425, not its result");
        assert.match(String(running.content), /still running|SEND\[202\]/, "the 425 steers the model to hibernate and await");

        // It concludes 200 with a deliverable → READing the run yields the deliverable (the pull side of collect).
        await (db.engine_loop_set_status as PrepMethod).run({ status: 200, message: "postgres", loop_id: wLoop });
        const done = await run.read(readStmt(runPath("worker-db")), ctx);
        assert.equal(done.status, 200, "a concluded worker's READ succeeds");
        assert.equal(done.content, "postgres", "the deliverable (terminal message) is collected by READing the run itself — no scratch-path guessing");
    } finally { await db.close(); }
});

test("[§run-scheme-spawn] EDIT on the bare run entity is rejected — COPY spawns, not EDIT (400, no inject)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-edit-entity-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // grammar 0.74.41 OP×resource matrix: EDIT is file/entry only — the run ENTITY (path-absent
        // run://<name>) is not editable. The old EDIT-spawn form is gone; COPY(run://<name>) spawns.
        const result = await engine.dispatch({
            statement: editStmt(runPath("worker"), "loop forever"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "EDIT on the run entity is rejected");
        assert.match(String((result as { error?: string }).error ?? ""), /COPY\(run:\/\/|not editable/, "the rejection steers to COPY");
        assert.equal(calls.length, 0, "no inject on a rejected EDIT");
        const worker = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "worker" });
        assert.equal(worker, undefined, "no run is created by a rejected EDIT");
    } finally { await db.close(); }
});

test("[§run-scheme-irc] SEND(run://name):msg delivers to a sister; a missing sister is 404", async () => {
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

// Dispatch-path coverage (#282): KILL of a run-scope ENTRY must DELETE the entry, NOT
// cancel the run — and stay self-only. Driven through engine.dispatch (the real routing),
// not a bare Run instance, because the bug lived in Engine.#handleKill's run branch.
test("[§run-scheme-scratch-kill] KILL(run://owner/entry) deletes the scratch entry (self-only); the run survives — #282", async () => {
    const db = await openMigrated();
    try {
        const { injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-kill-entry-${crypto.randomUUID()}`);
        const alpha = await insertRun(db, sessionId, null, "alpha");
        const beta = await insertRun(db, sessionId, null, "beta");
        const loopA = await insertLoop(db, alpha, 1, "go");
        const turnA = await insertTurn(db, loopA, 1, 102);
        const loopB = await insertLoop(db, beta, 1, "go");
        const turnB = await insertTurn(db, loopB, 1, 102);

        await engine.dispatch({ statement: editStmt(runEntry("alpha", "note.md"), "scratch"), sessionId, runId: alpha, loopId: loopA, turnId: turnA, sequence: 1, origin: "model" });

        // A sister cannot delete alpha's scratch — cross-run write is denied (403); the entry survives.
        const cross = await engine.dispatch({ statement: killEntry("alpha", "note.md"), sessionId, runId: beta, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.equal(cross.status, 403, "cross-run KILL of a sister's scratch is denied (self-only)");
        assert.equal((await engine.dispatch({ statement: readEntry("alpha", "note.md"), sessionId, runId: alpha, loopId: loopA, turnId: turnA, sequence: 2, origin: "model" })).status, 200, "the denied cross-run KILL left the entry intact");

        // alpha kills its OWN scratch entry → 200; it's gone; the run alpha still exists.
        const killed = await engine.dispatch({ statement: killEntry("alpha", "note.md"), sessionId, runId: alpha, loopId: loopA, turnId: turnA, sequence: 3, origin: "model" });
        assert.equal(killed.status, 200, "KILL(run://alpha/note.md) deletes the scratch entry");
        const gone = await engine.dispatch({ statement: readEntry("alpha", "note.md"), sessionId, runId: alpha, loopId: loopA, turnId: turnA, sequence: 4, origin: "model" });
        assert.equal(gone.status, 404, "the killed scratch entry is gone");
        const runStill = await (db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "alpha" });
        assert.notEqual(runStill, undefined, "the run alpha survives — KILL of an entry PATH is entry-delete, not run cancellation");
    } finally { await db.close(); }
});

test("[§run-scheme-fork] COPY(run://self):prompt forks — a branch run started via injectRun", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectRun } = recordingInjectRun();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectRun, tokenize });
        const sessionId = await insertSession(db, `run-fork-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId, null, "explorer");
        const loopId = await insertLoop(db, runId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const forkStmt: CopyStatement = {
            op: "COPY", suffix: "", signal: null, target: runPath("self"),
            lineMarker: null, body: "take the other branch", position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: forkStmt, sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "fork returns 200");
        const branchName = (result as { body?: string }).body ?? "";
        assert.equal(branchName, "explorer-fork-1", "the branch is the source's name + -fork-<N> (unique per fork)");

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
            statement: copyRun("worker", "go"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 508, "spawn at the ceiling is refused, hard");

        const forkStmt: CopyStatement = {
            op: "COPY", suffix: "", signal: null, target: runPath("self"),
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

test("[§run-scheme-terminate] KILL(run://name) aborts a sister by address; a missing sister is 404", async () => {
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

test("[§run-scheme-scratch] self EDIT writes the run partition; cross-run READ reaches it; cross-run WRITE is 403", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), tokenize });
        const sessionId = await insertSession(db, `run-store-${crypto.randomUUID()}`);
        const meId = await insertRun(db, sessionId, null, "me");
        const otherId = await insertRun(db, sessionId, null, "other");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ op: "READ", suffix: "", signal: null, lineMarker: null, target, body: null, position: { line: 1, column: 1 } });

        // self EDIT(run://self/note.md) — a self-owned run-scope entry; self folds to "me".
        const write = await engine.dispatch({ statement: editStmt(runEntry("self", "note.md"), "scratch"), sessionId, runId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "self scratch write creates the entry");
        const stored = await (db.crud_find_run_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "run", pathname: "/me/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed (scope='run', /me/note.md) — owner folded from self");

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
