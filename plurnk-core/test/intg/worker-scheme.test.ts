// worker:// scheme — spawn + fork (COPY), irc (SEND), terminate (KILL). Same-workspace sisters
// (SPEC §machine-processes, §actor-boundary). injectWorker is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the run-scheme's OWN work: the run-table effect + the
// exact inject call. The dispatch gates (#checkWritable run-copy branch, the
// #handleCopy run-copy routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath, CopyStatement, WorkStatement, ForkStatement, KillStatement, ReadStatement, FindStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";
import { editStmt, sendStmt, readStmt } from "./_dsl.ts";

// §worker-scheme — the worker is the AUTHORITY: worker://<name> (name in hostname), worker://self for the current run.
// worker://self is the self-marker; the control ops (spawn/irc/fork/kill) carry no entry path.
const workerPath = (name: string): ParsedPath => ({
    kind: "url", raw: `worker://${name}`, scheme: "worker",
    username: null, password: null, hostname: name, port: null,
    pathname: "", params: {}, fragment: null,
});

// A worker-scope STORAGE address: worker://<owner>/<path> (owner "self" = the current run), entry path present.
const workerEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker",
    username: null, password: null, hostname: owner, port: null,
    pathname: `/${path}`, params: {}, fragment: null,
});

// Run control (grammar 0.74.55): WORK(worker://<name>):task spawns a fresh worker; FORK(worker://<name>):task
// branches the current run into a named sister. The body is the seed task, not a dst path.
const spawnedWorker = (name: string, prompt: string): WorkStatement => ({
    op: "WORK", suffix: "", signal: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});
const forkWorker = (name: string, prompt: string): ForkStatement => ({
    op: "FORK", suffix: "", signal: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});

// The Daemon.inject seam as a recording stub — its drain/enqueue behavior is
// covered by the Daemon/inject suites; here we assert exactly what the worker
// scheme hands it.
const recordingInjectWorker = () => {
    const calls: Array<{ workspaceId: number; workerId: number; prompt: string }> = [];
    const injectWorker = async (args: { workspaceId: number; workerId: number; prompt: string }) => {
        calls.push(args);
        return { action: "enqueued_new_loop" as const, loopId: -1 };
    };
    return { calls, injectWorker };
};

const tokenize = (text: string): number => Math.ceil(text.length / 4);

// A worker-scope FIND: worker://<owner>/<glob> (owner "self" = the current run).
const findEntry = (owner: string, glob: string): FindStatement => ({
    op: "FIND", suffix: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${glob}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${glob}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// A worker-scope READ: worker://<owner>/<path> (owner "self" = the current run).
const readEntry = (owner: string, path: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// A worker-scope ENTRY KILL: worker://<owner>/<path> — deletes the scratch entry (path present).
const killEntry = (owner: string, path: string): KillStatement => ({
    op: "KILL", suffix: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("[§worker-scheme-fork-scratch] a fork inherits the parent's worker-scope scratch (owner-remapped), then diverges", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-scratch-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "alpha");
        const ctxP = makeSchemeCtx({ db, workspaceId, workerId: parent, loopId: 0, turnId: 0 });
        const run = new Worker();
        await run.edit(editStmt(workerEntry("self", "todo.md"), "parent note"), ctxP);

        // Fork the parent — the branch must open with the parent's scratch under its OWN name.
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const ctxF = makeSchemeCtx({ db, workspaceId, workerId: forkId, loopId: 0, turnId: 0 });

        const inherited = await run.find(findEntry("self", "**"), ctxF);
        assert.deepEqual(inherited.results.map((r) => r.path), ["worker://alpha-fork/todo.md"], "the fork's perspective holds the inherited scratch under its own name");
        const fRead = await run.read(readEntry("self", "todo.md"), ctxF);
        assert.equal(fRead.content, "parent note", "the inherited scratch content is copied");

        // Divergence: the fork edits its scratch; the parent's copy is independent + untouched.
        await run.edit(editStmt(workerEntry("self", "todo.md"), "fork note"), ctxF);
        assert.equal((await run.read(readEntry("self", "todo.md"), ctxF)).content, "fork note", "the fork's edit lands on its own copy");
        assert.equal((await run.read(readEntry("self", "todo.md"), ctxP)).content, "parent note", "the parent's scratch is untouched — independent copies, diverged");
    } finally { await db.close(); }
});

test("[§worker-scheme-find-perspective] a worker FINDs its OWN worker-scope scratch; a sister's only by name — the worker's perspective", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `run-find-${crypto.randomUUID()}`);
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, null, "beta");
        const ctxA = makeSchemeCtx({ db, workspaceId, workerId: alpha, loopId: 0, turnId: 0 });
        const ctxB = makeSchemeCtx({ db, workspaceId, workerId: beta, loopId: 0, turnId: 0 });
        const run = new Worker();

        // Each worker writes its OWN scratch (worker://self).
        await run.edit(editStmt(workerEntry("self", "todo.md"), "alpha note"), ctxA);
        await run.edit(editStmt(workerEntry("self", "plan.md"), "beta note"), ctxB);

        // alpha's self FIND sees ONLY alpha's scratch, addressed worker://alpha/...
        const own = await run.find(findEntry("self", "**"), ctxA);
        assert.equal(own.status, 200);
        assert.deepEqual(own.results.map((r) => r.path), ["worker://alpha/todo.md"], "self FIND(worker://self/**) returns only the building worker's own scratch");

        // beta's perspective excludes alpha's — isolation is structural (scope='worker' + owner prefix).
        const betaOwn = await run.find(findEntry("self", "**"), ctxB);
        assert.deepEqual(betaOwn.results.map((r) => r.path), ["worker://beta/plan.md"], "a sibling never sees another's scratch in its own perspective");

        // A sister's scratch is reachable ONLY by explicit name (cross-worker READ/FIND is allowed).
        const sister = await run.find(findEntry("beta", "**"), ctxA);
        assert.deepEqual(sister.results.map((r) => r.path), ["worker://beta/plan.md"], "FIND(worker://beta/**) reaches the named sister's scratch");
    } finally { await db.close(); }
});

test("[§worker-scheme-spawn] WORK(worker://name):task spawns a same-workspace sister, seeded via injectWorker", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-spawn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "investigate the bug"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "spawn returns 200");

        const worker = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        if (worker === undefined) throw new Error("spawn must create a worker named 'worker' in the workspace");
        const meta = await (db.fork_get_worker as PrepMethod).get<{ workspace_id: number; origin: string }>({ id: worker.id });
        assert.equal(meta?.origin, "model", "spawned worker's origin is the spawning writer");
        assert.equal(meta?.workspace_id, workspaceId, "spawned run shares the workspace (sisters)");

        assert.equal(calls.length, 1, "exactly one injectWorker call");
        const { flags: spawnFlags, ...spawnRest } = calls[0] as { flags?: object; workspaceId: number; workerId: number; prompt: string };
        assert.deepEqual(spawnRest, { workspaceId, workerId: worker.id, prompt: "investigate the bug" }, "the new run is started with the prompt");
        assert.equal((spawnFlags as { yolo?: boolean } | undefined)?.yolo, false, "the delegating loop's flags ride the injection (§worker-delegation-inherits-flags)");
    } finally { await db.close(); }
});

test("[§worker-scheme-spawn] WORK-spawning a name a LIVE sister holds is refused 409 — legible, never a raw UNIQUE 500", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-spawn-live-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'worker' is already RUNNING (a loop at the default live status 102).
        const sister = await insertWorker(db, workspaceId, null, "worker");
        await insertLoop(db, sister, 1, "working");

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "do it again"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 409, "a live name-collision is a legible 409, not a 500");
        assert.match(String((result as { error?: string }).error ?? ""), /worker.*already running|already running/, "the message names the live run");
        assert.equal(calls.length, 0, "no inject on a refused spawn");
    } finally { await db.close(); }
});

test("[§worker-scheme-spawn] a TERMINATED sister's name is reclaimed — spawn succeeds, newest wins", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-spawn-reclaim-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'worker' that already TERMINATED (its loop crossed into 200) — its name is spent.
        const dead = await insertWorker(db, workspaceId, null, "worker");
        const deadLoop = await insertLoop(db, dead, 1, "done");
        await (db.test_set_loop_status as PrepMethod).run({ id: deadLoop, status: 200 });

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "fresh work"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "a terminated name is free to reclaim");
        assert.equal(calls.length, 1, "the reclaimed spawn injects its fresh prompt");
        // The frozen-name/permanent-history invariant: the dead run keeps its name (a new row holds it
        // too) and resolution picks the NEWEST — the reclaimed run, not the corpse.
        const resolved = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.notEqual(resolved?.id, dead, "worker_resolve_by_name resolves the fresh run, never the terminated one");
        assert.equal(calls[0]?.workerId, resolved?.id, "inject targets the reclaimed run");
    } finally { await db.close(); }
});

test("[§worker-scheme-collect] READ(worker://name) collects the deliverable — message done, 425 running, 404 absent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `run-collect-${crypto.randomUUID()}`);
        const reader = await insertWorker(db, workspaceId); // the sister doing the collection
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: reader });
        const run = new Worker();

        // No such run → 404 (not a bare 400 the model can't read).
        const missing = await run.read(readStmt(workerPath("ghost")), ctx);
        assert.equal(missing.status, 404, "a name with no worker is 404");

        // A worker still running (its loop at the default live status 102) hasn't delivered → 425, steer to 202.
        const worker = await insertWorker(db, workspaceId, null, "worker-db");
        const wLoop = await insertLoop(db, worker, 1, "find db");
        const running = await run.read(readStmt(workerPath("worker-db")), ctx);
        assert.equal(running.status, 425, "a still-running worker hasn't delivered — 425, not its result");
        assert.match(String(running.content), /still running|SEND\[202\]/, "the 425 steers the model to hibernate and await");

        // It concludes 200 with a deliverable → READing the worker yields the deliverable (the pull side of collect).
        await (db.engine_loop_set_status as PrepMethod).run({ status: 200, message: "postgres", loop_id: wLoop });
        const done = await run.read(readStmt(workerPath("worker-db")), ctx);
        assert.equal(done.status, 200, "a concluded worker's READ succeeds");
        assert.equal(done.content, "postgres", "the deliverable (terminal message) is collected by READing the worker itself — no scratch-path guessing");
    } finally { await db.close(); }
});

test("[§worker-scheme-spawn] EDIT on the bare worker entity is rejected — WORK spawns, not EDIT (400, no inject)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-edit-entity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        // grammar 0.74.41 OP×resource matrix: EDIT is file/entry only — the worker ENTITY (path-absent
        // worker://<name>) is not editable. The old EDIT-spawn form is gone; WORK(worker://<name>) spawns.
        const result = await engine.dispatch({
            statement: editStmt(workerPath("worker"), "loop forever"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "EDIT on the worker entity is rejected");
        assert.match(String((result as { error?: string }).error ?? ""), /COPY\(worker:\/\/|not editable/, "the rejection steers to COPY");
        assert.equal(calls.length, 0, "no inject on a rejected EDIT");
        const worker = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(worker, undefined, "no worker is created by a rejected EDIT");
    } finally { await db.close(); }
});

test("[§worker-scheme-irc] SEND(worker://name):msg delivers to a sister; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-irc-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertWorker(db, workspaceId, null, "worker");

        const ok = await engine.dispatch({
            statement: sendStmt(null, workerPath("worker"), "what's your status?"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(ok.status, 200, "irc to an existing sister returns 200");
        const { flags: ircFlags, ...ircRest } = calls.at(-1) as { flags?: { yolo?: boolean }; workspaceId: number; workerId: number; prompt: string };
        assert.deepEqual(ircRest, { workspaceId, workerId: sisterId, prompt: "what's your status?" }, "the message is delivered to the named sister");
        assert.equal(ircFlags?.yolo, false, "the sender's flags ride the irc (§worker-delegation-inherits-flags)");

        const missing = await engine.dispatch({
            statement: sendStmt(null, workerPath("ghost"), "anyone there?"),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(missing.status, 404, "irc to a non-existent sister is 404");
        assert.equal(calls.length, 1, "no inject for a missing sister");
    } finally { await db.close(); }
});

// Dispatch-path coverage (#282): KILL of a worker-scope ENTRY must DELETE the entry, NOT
// cancel the worker — and stay self-only. Driven through engine.dispatch (the real routing),
// not a bare Run instance, because the bug lived in Engine.#handleKill's run branch.
test("[§worker-scheme-scratch-kill] KILL(worker://owner/entry) deletes the scratch entry (self-only); the worker survives — #282", async () => {
    const db = await openMigrated();
    try {
        const { injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-kill-entry-${crypto.randomUUID()}`);
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, null, "beta");
        const loopA = await insertLoop(db, alpha, 1, "go");
        const turnA = await insertTurn(db, loopA, 1, 102);
        const loopB = await insertLoop(db, beta, 1, "go");
        const turnB = await insertTurn(db, loopB, 1, 102);

        await engine.dispatch({ statement: editStmt(workerEntry("alpha", "note.md"), "scratch"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 1, origin: "model" });

        // A sister cannot delete alpha's scratch — cross-worker write is denied (403); the entry survives.
        const cross = await engine.dispatch({ statement: killEntry("alpha", "note.md"), workspaceId, workerId: beta, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.equal(cross.status, 403, "cross-worker KILL of a sister's scratch is denied (self-only)");
        assert.equal((await engine.dispatch({ statement: readEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 2, origin: "model" })).status, 200, "the denied cross-worker KILL left the entry intact");

        // alpha kills its OWN scratch entry → 200; it's gone; the worker alpha still exists.
        const killed = await engine.dispatch({ statement: killEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 3, origin: "model" });
        assert.equal(killed.status, 200, "KILL(worker://alpha/note.md) deletes the scratch entry");
        const gone = await engine.dispatch({ statement: readEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 4, origin: "model" });
        assert.equal(gone.status, 404, "the killed scratch entry is gone");
        const runStill = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "alpha" });
        assert.notEqual(runStill, undefined, "the worker alpha survives — KILL of an entry PATH is entry-delete, not run cancellation");
    } finally { await db.close(); }
});

test("[§worker-scheme-fork] FORK(worker://name):task forks a NAMED branch — started via injectWorker", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-fork-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "explorer");
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const forkStmt = forkWorker("recheck", "take the other branch");
        const result = await engine.dispatch({
            statement: forkStmt, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "fork returns 200");
        const branchName = (result as { body?: string }).body ?? "";
        assert.equal(branchName, "recheck", "the branch carries the explicit name FORK gave it");

        const branch = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: branchName });
        if (branch === undefined) throw new Error("fork must create the branch run in the workspace");
        assert.notEqual(branch.id, workerId, "the branch is a distinct run");
        const { flags: forkFlags, ...forkRest } = calls.at(-1) as { flags?: { yolo?: boolean }; workspaceId: number; workerId: number; prompt: string };
        assert.deepEqual(forkRest, { workspaceId, workerId: branch.id, prompt: "take the other branch" }, "the branch is continued with the fork prompt");
        assert.equal(forkFlags?.yolo, false, "the forking loop's flags ride the injection (§worker-delegation-inherits-flags)");
    } finally { await db.close(); }
});

test("[§worker-scheme-cap] spawn AND fork past PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE fail hard (508), create nothing", async () => {
    const db = await openMigrated();
    const prior = process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE;
    process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE = "1"; // ceiling of 1 active run
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-cap-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);        // the acting run, its loop 102 = 1 active = the ceiling
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spawn = await engine.dispatch({
            statement: spawnedWorker("worker", "go"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 508, "spawn at the ceiling is refused, hard");

        const fork = await engine.dispatch({
            statement: forkWorker("branch", "go"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(fork.status, 508, "fork at the ceiling is refused, hard");

        const worker = await (db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(worker, undefined, "no worker is created past the ceiling");
        assert.equal(calls.length, 0, "no inject on a refused spawn/fork");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE;
        else process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE = prior;
        await db.close();
    }
});

test("[§worker-scheme-terminate] KILL(worker://name) aborts a sister by address; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const cancelWorker = (workerId: number): boolean => { killed.push(workerId); return true; };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker, tokenize });
        const workspaceId = await insertWorkspace(db, `run-kill-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertWorker(db, workspaceId, null, "worker");

        const killWorker: KillStatement = { op: "KILL", suffix: "", signal: null, target: workerPath("worker"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const ok = await engine.dispatch({ statement: killWorker, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(ok.status, 200, "KILL of an existing sister returns 200");
        assert.deepEqual(killed, [sisterId], "the named sister's run is aborted by id");

        const killGhost: KillStatement = { op: "KILL", suffix: "", signal: null, target: workerPath("ghost"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const missing = await engine.dispatch({ statement: killGhost, workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(missing.status, 404, "KILL of a non-existent sister is 404");
        assert.equal(killed.length, 1, "no abort for a missing sister");
    } finally { await db.close(); }
});

test("[§worker-scheme-scratch] self EDIT writes the worker partition; cross-worker READ reaches it; cross-worker WRITE is 403", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), tokenize });
        const workspaceId = await insertWorkspace(db, `run-store-${crypto.randomUUID()}`);
        const meId = await insertWorker(db, workspaceId, null, "me");
        const otherId = await insertWorker(db, workspaceId, null, "other");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ op: "READ", suffix: "", signal: null, lineMarker: null, target, body: null, position: { line: 1, column: 1 } });

        // self EDIT(worker://self/note.md) — a self-owned worker-scope entry; self folds to "me".
        const write = await engine.dispatch({ statement: editStmt(workerEntry("self", "note.md"), "scratch"), workspaceId, workerId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "self scratch write creates the entry");
        const stored = await (db.crud_find_worker_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme: "worker", pathname: "/me/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed (scope='worker', /me/note.md) — owner folded from self");

        // cross-worker READ(worker://me/note.md) from 'other' — reaches the sister's scratch (perspective-private, not ACL).
        const otherLoop = await insertLoop(db, otherId, 1, "go");
        const otherTurn = await insertTurn(db, otherLoop, 1, 102);
        const readCross = await engine.dispatch({ statement: readOf(workerEntry("me", "note.md")), workspaceId, workerId: otherId, loopId: otherLoop, turnId: otherTurn, sequence: 1, origin: "model" });
        assert.equal(readCross.status, 200, "cross-worker READ reaches a sister's scratch by address");

        // cross-worker EDIT(worker://me/note.md) from 'other' — denied (write is self-only).
        const writeCross = await engine.dispatch({ statement: editStmt(workerEntry("me", "note.md"), "tamper"), workspaceId, workerId: otherId, loopId: otherLoop, turnId: otherTurn, sequence: 2, origin: "model" });
        assert.equal(writeCross.status, 403, "cross-worker WRITE is denied — read a sister's notes, never write them");
    } finally { await db.close(); }
});

test("[§join-blocking-collect] READ(worker://running-child) arms a join — the turn's bare SEND[102] PARKS, never spins (#354)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-collect-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 200);
        const worker = await insertWorker(db, workspaceId, null, "worker"); // a worker still running (live loop 102),
        await insertLoop(db, worker, 1, "count");                     // nothing delivered yet
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // 1. READ the running worker → 425 (still running) AND arms the join on this loop.
        const read = await engine.dispatch({ statement: readStmt(workerPath("worker")), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(read.status, 425, "the worker hasn't delivered — 425 still-running");
        // 2. the turn's bare SEND[102] (continue) becomes a PARK — the blocking join, not a spin.
        const send = await engine.dispatch({ statement: sendStmt(102, null, null), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 2, origin: "model" });
        assert.equal((send.attrs as { join?: boolean } | undefined)?.join, true, "the bare continue was converted to a join-park");
        const parked = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: parentLoop });
        assert.equal(parked?.status, 202, "the parent PARKED (202) awaiting the worker — the model never had to know SEND[102]<-1>");
    } finally { await db.close(); }
});

test("[§join-blocking-collect] a bare SEND[102] with NO armed join continues normally — the park is join-driven, not blanket (#354)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-none-${crypto.randomUUID()}`);
        const run = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, run, 1, "go");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const send = await engine.dispatch({ statement: sendStmt(102, null, null), workspaceId, workerId: run, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.notEqual((send.attrs as { join?: boolean } | undefined)?.join, true, "no READ armed a join — a plain continue");
        const status = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loop });
        assert.notEqual(status?.status, 202, "the loop did not park — a bare continue without a join stays live");
    } finally { await db.close(); }
});

test("[§op-synchronous] KILL(run) is decisive — a same-turn KILL then SEND[200] concludes, no premature-terminate 409 (#354)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `kill-sync-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 200);
        const worker = await insertWorker(db, workspaceId, null, "leftover-worker");
        const workerLoop = await insertLoop(db, worker, 1, "work");          // a LIVE child (status 102)
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker: (_workerId: number) => true }); // stub reap — the sync terminal-flip is under test

        // Before: the live child would make a SEND[200] a premature-terminate. KILL must fix it IN this turn.
        const killWorker: KillStatement = { op: "KILL", suffix: "", signal: null, target: workerPath("leftover-worker"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const kill = await engine.dispatch({ statement: killWorker, workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(kill.status, 200, "KILL succeeds");
        // The DECISIVE claim: the worker's loop is terminal (499) SYNCHRONOUSLY — the same-turn gate reads it dead.
        const wstatus = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: workerLoop });
        assert.equal(wstatus?.status, 499, "the killed worker's loop is 499 NOW, not next turn — KILL landed before the turn moved on");
        const send = await engine.dispatch({ statement: sendStmt(200, null, "done, worker killed"), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 2, origin: "model" });
        assert.notEqual(send.status, 409, `no premature-terminate 409 — the killed child is not live pending work; got ${send.status}`);
    } finally { await db.close(); }
});

test("[§wait-obligation-matrix] SEND[202]: a live obligation BLOCKS; ∅ (bare or <-1>) is the 409 contradiction — never a hang, never a silent conclude", async () => {
    const db = await openMigrated();
    try {
        // 202 + J (a live child) → the loop BLOCKS at 202, to be reawakened when the child concludes.
        const s1 = await insertWorkspace(db, `wait-J-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, s1);
        const pLoop = await insertLoop(db, parent, 1, "orchestrate");
        const pTurn = await insertTurn(db, pLoop, 1, 200);
        const child = await insertWorker(db, s1, parent, "worker");
        await insertLoop(db, child, 1, "work"); // a live child (latest loop 102)
        const eng1 = new Engine({ db, schemes: new SchemeRegistry() });
        const blocked = await eng1.dispatch({ statement: sendStmt(202, null, "awaiting worker"), workspaceId: s1, workerId: parent, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        assert.equal(blocked.status, 202, "202 with a live child blocks on the join");
        assert.equal((await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: pLoop }))?.status, 202, "the loop is blocked at 202");

        // 202 + ∅ (no live work) → 409: the wait-side contradiction (owner ruling, #502 run113).
        const s2 = await insertWorkspace(db, `wait-void-${crypto.randomUUID()}`);
        const run = await insertWorker(db, s2);
        const loop = await insertLoop(db, run, 1, "solo");
        const turn = await insertTurn(db, loop, 1, 200);
        const eng2 = new Engine({ db, schemes: new SchemeRegistry() });
        const satisfied = await eng2.dispatch({ statement: sendStmt(202, null, "standing by"), workspaceId: s2, workerId: run, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(satisfied.status, 409, "202 on nothing is the contradiction, returned to the model");
        assert.notEqual((await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loop }))?.status, 202, "no held-open 202 — the turn is back with the model");

        // 202<-1> + ∅ — the degenerate indefinite wait on nothing: the same 409, never a hang.
        const s3 = await insertWorkspace(db, `wait-hang-${crypto.randomUUID()}`);
        const run3 = await insertWorker(db, s3);
        const loop3 = await insertLoop(db, run3, 1, "solo");
        const turn3 = await insertTurn(db, loop3, 1, 200);
        const eng3 = new Engine({ db, schemes: new SchemeRegistry() });
        const indef = { ...sendStmt(202, null, "standing by"), lineMarker: { marks: [-1] as [number, ...number[]] } };
        const noHang = await eng3.dispatch({ statement: indef, workspaceId: s3, workerId: run3, loopId: loop3, turnId: turn3, sequence: 1, origin: "model" });
        assert.equal(noHang.status, 409, "202<-1> on nothing is the same contradiction — refused with the fact, never hung");
        assert.notEqual((await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loop3 }))?.status, 202, "no held-open 202");
    } finally { await db.close(); }
});

test("[§wait-collapse-marked] a ∅ wait is 409 — the contradiction returns to the model; a historical collapse row still renders both truth layers (#379, #502)", async () => {
    // run113: a worker waited on an EXEC that never dispatched; the old ∅-collapse concluded it
    // CLEAN and the confusion vanished. The flip: dispatch 409s the ∅ wait (the recovery rail);
    // the collapse MARKER render survives for rows history already carries (run42's class).
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `collapse-mark-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId, null, "req-test");
        const wLoop = await insertLoop(db, worker, 1, "test the module");
        const wTurn = await insertTurn(db, wLoop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const waited = await engine.dispatch({ statement: sendStmt(202, null, "Standing by for user input"), workspaceId, workerId: worker, loopId: wLoop, turnId: wTurn, sequence: 1, origin: "model" });
        assert.equal(waited.status, 409, "∅ — a wait on nothing is the contradiction, returned to the model");
        assert.match(String(waited.error), /Attempted \[202\] wait with nothing pending: no surviving streams, no worker runs, no unretrieved results\./, "the canon text states the fact");
        assert.notEqual((await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: wLoop }))?.status, 200, "the loop did NOT conclude — the turn returns to the model");

        // The RENDER contract survives for history: a row already carrying terminated_by='collapse'
        // (real DBs hold them) still names the act before the model's unrewritten words.
        await (db.engine_loop_set_status as PrepMethod).run({ status: 200, loop_id: wLoop, message: "Standing by for user input" });
        await (db.engine_loop_mark_terminated_by as PrepMethod).run({ terminated_by: "collapse", loop_id: wLoop });
        const reader = await insertWorker(db, workspaceId);
        const collected = await new Worker().read(readStmt(workerPath("req-test")), makeSchemeCtx({ db, workspaceId, workerId: reader }));
        assert.equal(collected.status, 200);
        assert.match(String(collected.content), /^\[ concluded on ∅-collapse — waited on nothing; no result was produced \] Standing by for user input$/,
            "the deliverable names the engine's act and carries the park text — never the park text alone as a result");
    } finally { await db.close(); }
});

test("[§worker-lifecycle-idle-is-concluded] an idle wait is 409; the worker concludes by SAYING so next turn — never a held-open 202, never a silent conclude", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-concludes-${crypto.randomUUID()}`);
        const run = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, run, 1, "nothing to do");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const r = await engine.dispatch({ statement: sendStmt(202, null, "idle"), workspaceId, workerId: run, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(r.status, 409, "an idle wait is the ∅ contradiction — returned, never silently concluded");
        const done = await engine.dispatch({ statement: sendStmt(200, null, "done — nothing to do"), workspaceId, workerId: run, loopId: loop, turnId: turn, sequence: 2, origin: "model" });
        assert.equal(done.status, 409, "same-turn conclude after the 409 is held — the error lands NEXT turn (errors are weighed before concluding)");
        // the real recovery shape: next turn, the model has SEEN the 409 and concludes deliberately
        const turn2 = await insertTurn(db, loop, 2, 102);
        const concluded = await engine.dispatch({ statement: sendStmt(200, null, "done — nothing to do"), workspaceId, workerId: run, loopId: loop, turnId: turn2, sequence: 1, origin: "model" });
        assert.equal(concluded.status, 200, "the idle worker concludes by SAYING so — SEND[200], one turn later");
        assert.notEqual((await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loop }))?.status, 202, "no held-open 202 — the loop reached a real terminal");
    } finally { await db.close(); }
});
