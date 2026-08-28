// worker:// scheme — spawn + fork (COPY), irc (SEND), terminate (KILL). Same-workspace sisters
// (SPEC {§machine-processes}, {§actor-boundary}). injectWorker is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the worker scheme's own work: the worker-table effect + the
// exact inject call. The dispatch gates (#checkWritable worker-control branch and
// #handleWorkerControl routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { InvalidLoopFlagsError, parsePath } from "@plurnk/plurnk-contracts";
import type {
    ParsedPath,
    PlurnkStatement,
    WorkStatement,
    ForkStatement,
    KillStatement,
    ReadStatement,
    FindStatement,
} from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import Fork from "../../src/core/fork.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, insertOperationTurn, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
import { resourcePaths } from "./_find.ts";
import { copyStmt, editStmt, sendStmt, readStmt, fullReplace, urlPath } from "./_dsl.ts";

// {§worker-scheme} — the authority is a worker name or the current-worker sigil `~`.
// Control operations carry no entry path; storage operations do.
const workerPath = (name: string): ParsedPath => ({
    kind: "url", raw: `worker://${name}`, scheme: "worker",
    username: null, password: null, hostname: name, port: null,
    pathname: "", query: null, fragment: null,
});

const authoredWorkerPath = (raw: string): ParsedPath => {
    const target = parsePath(raw);
    if (target?.kind !== "url" || target.scheme !== "worker") throw new Error(`Expected a worker URL: ${raw}`);
    return target;
};

// An owner-addressed private entry: worker://<owner>/<path>, entry path present.
const workerEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker",
    username: null, password: null, hostname: owner, port: null,
    pathname: `/${path}`, query: null, fragment: null,
});

// Worker control (grammar 0.74.55): WORK(worker://<name>):task spawns a fresh worker; FORK(worker://<name>):task
// branches the current worker into a named sister. The body is the seed task, not a destination path.
const spawnedWorker = (name: string, prompt: string): WorkStatement => ({
    metadata: null,
    op: "WORK", annotation: null, delimiter: "", signal: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});
const forkWorker = (name: string, prompt: string): ForkStatement => ({
    metadata: null,
    op: "FORK", annotation: null, delimiter: "", signal: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});

// The Daemon.inject seam as a recording stub — its drain/enqueue behavior is
// covered by the Daemon/inject suites; here we assert exactly what the worker
// scheme hands it.
const recordingInjectWorker = () => {
    const calls: Array<{ workspaceId: number; workerId: number; sourceWorkerId: number; prompt: string }> = [];
    const injectWorker = async (args: { workspaceId: number; workerId: number; sourceWorkerId: number; prompt: string }) => {
        calls.push(args);
        return { action: "enqueued_new_loop" as const, loopId: -1 };
    };
    return { calls, injectWorker };
};

const weigh = (text: string): number => Math.ceil(text.length / 4);

// FIND in one owner's space: worker://<owner>/<glob>.
const findEntry = (owner: string, glob: string): FindStatement => ({
    metadata: null,
    op: "FIND", annotation: null, delimiter: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${glob}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${glob}`, query: null, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// READ from one owner's space: worker://<owner>/<path>.
const readEntry = (owner: string, path: string): ReadStatement => ({
    metadata: null,
    op: "READ", annotation: null, delimiter: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// KILL in one owner's space: worker://<owner>/<path> — deletes the private entry (path present).
const killEntry = (owner: string, path: string): KillStatement => ({
    metadata: null,
    op: "KILL", annotation: null, delimiter: "", signal: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("a fork inherits the parent's private entries under its own owner, then diverges", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-scratch-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "alpha");
        const ctxP = makeSchemeCtx({ db, workspaceId, workerId: parent, loopId: 0, turnId: 0 });
        const workerScheme = new Worker();
        await workerScheme.edit(editStmt(workerEntry("~", "todo.md"), "parent note"), ctxP);

        // Fork the parent — the branch must open with the parent's scratch as its OWN ({§entry-owner}).
        const forkId = await Fork.fork(
            db,
            parent,
            "alpha-fork",
            (scheme) => scheme === "worker" ? "snapshot" : "none",
        );
        const ctxF = makeSchemeCtx({ db, workspaceId, workerId: forkId, loopId: 0, turnId: 0 });

        const inherited = await workerScheme.find(findEntry("~", "**"), ctxF);
        assert.deepEqual(resourcePaths(inherited), ["worker://~/todo.md"], "the fork's own-space FIND holds the inherited scratch, addressed as its own");
        const fRead = await lookThroughScheme("worker", null, readEntry("~", "todo.md"), ctxF);
        assert.equal(fRead.content, "parent note", "the inherited scratch content is copied");

        // Divergence: the fork edits its scratch; the parent's copy is independent + untouched.
        await workerScheme.edit(editStmt(workerEntry("~", "todo.md"), "fork note", null, fullReplace), ctxF);
        assert.equal((await lookThroughScheme("worker", null, readEntry("~", "todo.md"), ctxF)).content, "fork note", "the fork's edit lands on its own copy");
        assert.equal((await lookThroughScheme("worker", null, readEntry("~", "todo.md"), ctxP)).content, "parent note", "the parent's scratch is untouched — independent copies, diverged");
    } finally { await db.close(); }
});

test("FIND draws from the resolved principal alone — ~ is own space, a name is any worker's space, perspectives never bleed", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-find-${crypto.randomUUID()}`);
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, alpha, "beta"); // beta is alpha's CHILD (ancestry gates the named read)
        const ctxA = makeSchemeCtx({ db, workspaceId, workerId: alpha, loopId: 0, turnId: 0 });
        const ctxB = makeSchemeCtx({ db, workspaceId, workerId: beta, loopId: 0, turnId: 0 });
        const workerScheme = new Worker();

        // Each worker writes its OWN space (worker://~).
        await workerScheme.edit(editStmt(workerEntry("~", "todo.md"), "alpha note"), ctxA);
        await workerScheme.edit(editStmt(workerEntry("~", "plan.md"), "beta note"), ctxB);

        // alpha's own-space FIND sees ONLY alpha's entries, addressed as its own.
        const own = await workerScheme.find(findEntry("~", "**"), ctxA);
        assert.equal(own.status, 200);
        assert.deepEqual(resourcePaths(own), ["worker://~/todo.md"], "FIND(worker://~/**) returns only the caller's own space ({§entry-owner})");

        // beta's perspective excludes alpha's — isolation is structural (the owner column).
        const betaOwn = await workerScheme.find(findEntry("~", "**"), ctxB);
        assert.deepEqual(resourcePaths(betaOwn), ["worker://~/plan.md"], "a sibling never sees another's space in its own perspective");

        // {§worker-read-scope} — the PARENT reads its child's space by name (oversight flows down)…
        const child = await workerScheme.find(findEntry("beta", "**"), ctxA);
        assert.deepEqual(resourcePaths(child), ["worker://beta/plan.md"], "FIND(worker://beta/**) reaches the named child's space");
        // …and a child names its parent's space just the same — topology is the parent's design (#394).
        const upward = await workerScheme.find(findEntry("alpha", "**"), ctxB);
        assert.equal(upward.status, 200, "a child naming its parent's space reads it");
        assert.deepEqual(resourcePaths(upward), ["worker://alpha/todo.md"], "FIND(worker://alpha/**) from the child reaches the parent's space by name");
    } finally { await db.close(); }
});

test("WORK(worker://name):task spawns a same-workspace sister, seeded via injectWorker", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-spawn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "investigate the bug"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "spawn returns 200");

        const worker = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        if (worker === undefined) throw new Error("spawn must create a worker named 'worker' in the workspace");
        const meta = await db.fork_get_worker.get<{ workspace_id: number; origin: string }>({ id: worker.id });
        assert.equal(meta?.origin, "model", "spawned worker's origin is the spawning writer");
        assert.equal(meta?.workspace_id, workspaceId, "spawned worker shares the workspace (sisters)");

        assert.equal(calls.length, 1, "exactly one injectWorker call");
        const { flags: spawnFlags, ...spawnRest } = calls[0] as { flags?: object; workspaceId: number; workerId: number; sourceWorkerId: number; prompt: string; parentLoopId: number };
        assert.deepEqual(spawnRest, { workspaceId, workerId: worker.id, sourceWorkerId: workerId, prompt: "investigate the bug", parentLoopId: loopId }, "the new worker is started with its delegator's causal identity");
        assert.equal((spawnFlags as { auto?: boolean } | undefined)?.auto, false, "the delegating loop's flags ride the injection ({§worker-delegation-inherits-flags})");
    } finally { await db.close(); }
});

// {§worker-control-addressing} Parser tolerance does not grant semantics to
// components outside the exact authority-only worker control address.
test("worker control rejects every non-authority URI component before spawning (#160)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-control-shape-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const malformed = [
            "worker:///",
            "worker://user@userinfo",
            "worker://user:secret@password",
            "worker://port:42",
            "worker://slash/",
            "worker://path/ignored",
            "worker://empty-query?",
            "worker://query?mode=x",
            "worker://empty-fragment#",
            "worker://fragment#body",
        ];

        for (const [index, raw] of malformed.entries()) {
            const result = await engine.dispatch({
                statement: { ...spawnedWorker("unused", "investigate"), target: authoredWorkerPath(raw) },
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            });
            assert.equal(result.status, 400, raw);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/control-address-invalid", raw);
            assert.equal(result.problem?.operation, "WORK", raw);
            assert.equal(result.problem?.retryable, false, raw);
        }
        assert.equal(calls.length, 0, "invalid address components never reach child startup");
        for (const raw of malformed) {
            const target = authoredWorkerPath(raw);
            if (target.kind !== "url" || target.hostname === null) continue;
            assert.equal(
                await db.worker_resolve_by_name.get({ workspace_id: workspaceId, name: target.hostname }),
                undefined,
                `${raw} never mints a worker`,
            );
        }
    } finally { await db.close(); }
});

test("the exact worker control address is enforced before every operation path (#160)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const killed: number[] = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            injectWorker,
            cancelWorker: async (workerId: number): Promise<void> => { killed.push(workerId); },
            weigh,
        });
        const workspaceId = await insertWorkspace(db, `worker-control-ops-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertWorker(db, workspaceId, null, "worker");
        await insertLoop(db, sisterId, 1, "working");
        const target = authoredWorkerPath("worker://worker?ignored=true");
        const statements: PlurnkStatement[] = [
            { ...spawnedWorker("worker", "spawn"), target },
            { ...forkWorker("worker", "fork"), target },
            sendStmt(null, target, "message"),
            readStmt(target),
            { metadata: null, op: "KILL", annotation: null, delimiter: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } },
        ];

        const results = [];
        for (const [index, statement] of statements.entries()) {
            results.push(await engine.dispatch({
                statement,
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            }));
        }
        assert.deepEqual(results.map(({ status }) => status), [400, 400, 400, 400, 400]);
        assert.deepEqual(
            results.map(({ problem }) => problem?.type),
            Array.from({ length: 5 }, () => "https://problems.plurnk.xyz/scheme/worker/control-address-invalid"),
        );
        assert.deepEqual(results.map(({ problem }) => problem?.operation), ["WORK", "FORK", "SEND", "READ", "KILL"]);
        assert.equal(calls.length, 0, "invalid controls never inject a worker message or task");
        assert.equal(killed.length, 0, "invalid controls never cancel a worker");
    } finally { await db.close(); }
});

test("~ is the sole current-worker sigil; self is an ordinary worker name", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const killed: number[] = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            injectWorker,
            cancelWorker: async (workerId: number): Promise<void> => { killed.push(workerId); },
            weigh,
        });
        const workspaceId = await insertWorkspace(db, `worker-self-address-${crypto.randomUUID()}`);
        const actorId = await insertWorker(db, workspaceId, null, "actor");
        const loopId = await insertLoop(db, actorId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spawn = await engine.dispatch({
            statement: spawnedWorker("self", "be the literally named worker"),
            workspaceId, workerId: actorId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 200, "self is mintable as an ordinary worker name");
        const named = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "self" });
        if (named === undefined) throw new Error("WORK(worker://self) must create the literally named worker");

        assert.equal((await engine.dispatch({
            statement: sendStmt(null, workerPath("~"), "message the caller"),
            workspaceId, workerId: actorId, loopId, turnId, sequence: 2, origin: "model",
        })).status, 200);
        assert.equal((await engine.dispatch({
            statement: sendStmt(null, workerPath("self"), "message the named worker"),
            workspaceId, workerId: actorId, loopId, turnId, sequence: 3, origin: "model",
        })).status, 200);
        assert.deepEqual(
            calls.slice(1).map(({ workerId }) => workerId),
            [actorId, named.id],
            "~ routes to the caller while self resolves through the ordinary named-worker namespace",
        );

        assert.equal((await engine.dispatch({
            statement: editStmt(workerEntry("~", "notes.md"), "private"),
            workspaceId, workerId: actorId, loopId, turnId, sequence: 4, origin: "model",
        })).status, 201, "worker://~/path is writable own-space storage");
        assert.equal((await engine.dispatch({
            statement: editStmt(workerEntry("self", "notes.md"), "not mine"),
            workspaceId, workerId: actorId, loopId, turnId, sequence: 5, origin: "model",
        })).status, 403, "worker://self/path is the named worker's space, not an own-space alias");

        const killCurrent: KillStatement = { metadata: null, op: "KILL", annotation: null, delimiter: "", signal: null, target: workerPath("~"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const killNamed: KillStatement = { ...killCurrent, target: workerPath("self") };
        assert.equal((await engine.dispatch({ statement: killCurrent, workspaceId, workerId: actorId, loopId, turnId, sequence: 6, origin: "model" })).status, 200);
        assert.equal((await engine.dispatch({ statement: killNamed, workspaceId, workerId: actorId, loopId, turnId, sequence: 7, origin: "model" })).status, 200);
        assert.deepEqual(killed, [actorId, named.id], "KILL distinguishes the current-worker sigil from the literal name");
    } finally { await db.close(); }
});

test("WORK-spawning a name a LIVE sister holds is refused 409 — legible, never a raw UNIQUE 500", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-spawn-live-${crypto.randomUUID()}`);
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
        assert.match(result.problem?.detail ?? "", /worker.*already running|already running/, "the message names the live worker");
        assert.equal(calls.length, 0, "no inject on a refused spawn");
    } finally { await db.close(); }
});

test("WORK-spawning a name held by a PARKED sister is refused 409", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-spawn-parked-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sister = await insertWorker(db, workspaceId, null, "worker");
        const parkedLoop = await insertLoop(db, sister, 1, "waiting");
        await db.test_set_loop_status.run({
            id: parkedLoop,
            status: 202,
            terminal_result: null,
        });

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "do it again"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 409, "a parked worker remains live and keeps its name");
        assert.match(result.problem?.detail ?? "", /worker.*already running|already running/);
        assert.equal(calls.length, 0, "a parked name collision never reaches injection");
    } finally { await db.close(); }
});

test("WORK and FORK reject non-mintable worker authorities before creating or starting a child", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-name-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        for (const [sequence, statement] of [
            [1, spawnedWorker("bad_name", "spawn")],
            [2, forkWorker("bad_name", "fork")],
        ] as const) {
            const result = await engine.dispatch({
                statement,
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/worker-name-invalid");
            assert.equal(result.problem?.worker, "bad_name");
            assert.equal(result.problem?.retryable, false);
        }

        assert.equal(calls.length, 0, "invalid names never reach the child-start seam");
        assert.equal(
            await db.worker_resolve_by_name.get({ workspace_id: workspaceId, name: "bad_name" }),
            undefined,
            "invalid names never reach the worker registry",
        );
    } finally { await db.close(); }
});

test("a TERMINATED sister's name is reclaimed — spawn succeeds, newest wins", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-spawn-reclaim-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'worker' that already TERMINATED (its loop crossed into 200) — its name is spent.
        const dead = await insertWorker(db, workspaceId, null, "worker");
        const deadLoop = await insertLoop(db, dead, 1, "done");
        await db.test_set_loop_status.run({
            id: deadLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "fresh work"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "a terminated name is free to reclaim");
        assert.equal(calls.length, 1, "the reclaimed spawn injects its fresh prompt");
        // The frozen-name/permanent-history invariant: the dead worker keeps its name (a new row holds it
        // too) and resolution picks the newest — the reclaimed worker, not the corpse.
        const resolved = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.notEqual(resolved?.id, dead, "worker_resolve_by_name resolves the fresh worker, never the terminated one");
        assert.equal(calls[0]?.workerId, resolved?.id, "inject targets the reclaimed worker");
    } finally { await db.close(); }
});

test("READ(worker://name) collects the exact terminal result — 425 running, 404 absent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `worker-collect-${crypto.randomUUID()}`);
        const reader = await insertWorker(db, workspaceId); // the sister doing the collection
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: reader });
        // No such worker → 404 (not a bare 400 the model can't read).
        const missing = await lookThroughScheme("worker", null, readStmt(workerPath("ghost")), ctx);
        assert.equal(missing.status, 404, "a name with no worker is 404");

        // A worker still running (its loop at the default live status 102) hasn't delivered → 425, steer to 202.
        const worker = await insertWorker(db, workspaceId, null, "worker-db");
        const wLoop = await insertLoop(db, worker, 1, "find db");
        const running = await lookThroughScheme("worker", null, readStmt(workerPath("worker-db")), ctx);
        assert.equal(running.status, 425, "a still-running worker hasn't delivered — 425, not its result");
        assert.match(running.problem?.detail ?? "", /still running/, "the exact 425 explains the unresolved deliverable");
        assert.equal(running.awaitWorker, "worker-db", "the 425 arms the blocking join");

        // It concludes 200 with a deliverable → READing the worker yields one
        // canonical body channel, projected by the same READ rules as entries.
        const lines = Array.from({ length: 20 }, (_, index) => `finding ${index + 1}`);
        const deliverable = { status: 200, content: lines.join("\n"), mimetype: "text/markdown" };
        assert.deepEqual(
            await new LoopLifecycle(db).finish(wLoop, deliverable),
            deliverable,
        );
        const done = await lookThroughScheme("worker", null, readStmt(workerPath("worker-db")), ctx);
        assert.equal(done.status, 200, "a concluded worker's READ succeeds");
        assert.equal(done.content, lines.slice(0, 16).join("\n"));
        assert.deepEqual(done.range, {
            unit: "line",
            total: 20,
            requested: [1, 16],
            returned: [1, 16],
        });

        const tail = await lookThroughScheme("worker", null, {
            ...readStmt(workerPath("worker-db")),
            lineMarker: { marks: [18, -1] },
        }, ctx);
        assert.equal(tail.content, lines.slice(17).join("\n"));
        assert.equal(tail.mimetype, "text/markdown");

        const bodyTarget = workerPath("worker-db");
        if (bodyTarget.kind !== "url") throw new Error("worker test target must be a URL");
        const body = await lookThroughScheme("worker", null, readStmt({
            ...bodyTarget,
            raw: `${bodyTarget.raw}#body`,
            fragment: "body",
        }), ctx);
        assert.equal(body.content, lines.slice(0, 16).join("\n"));
        assert.equal(body.channel, "body");

        const failedWorker = await insertWorker(db, workspaceId, null, "worker-failed");
        const failedLoop = await insertLoop(db, failedWorker, 1, "call provider");
        const failure = Results.failure(
            "test:worker",
            "provider-failed",
            502,
            "The child provider failed.",
        );
        await new LoopLifecycle(db).finish(failedLoop, failure);
        const failed = await lookThroughScheme("worker", null, readStmt(workerPath("worker-failed")), ctx);
        assert.equal(failed.status, 502, "READ preserves the child's exact failure status");
        assert.equal(failed.problem?.detail, "The child provider failed.", "READ preserves the child's exact Problem");
        assert.equal(failed.content, "The child provider failed.", "READ derives a readable body from the exact Problem");
    } finally { await db.close(); }
});

test("EDIT on the bare worker entity is rejected — WORK spawns, not EDIT (400, no inject)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-edit-entity-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const namedWorkerId = await insertWorker(db, workspaceId, null, "worker");

        // grammar 0.74.41 OP×resource matrix: EDIT is file/entry only — the worker ENTITY (path-absent
        // worker://<name>) is not editable. The old EDIT-spawn form is gone; WORK(worker://<name>) spawns.
        const result = await engine.dispatch({
            statement: editStmt(workerPath("worker"), "loop forever"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "EDIT on the worker entity is rejected");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-entity-not-editable");
        assert.equal(result.problem?.detail, "A worker entity is not an editable entry.");
        assert.equal(result.problem?.recovery, "Use WORK or FORK to create a worker.");
        assert.equal(result.problem?.retryable, false);
        assert.equal(calls.length, 0, "no inject on a rejected EDIT");
        const worker = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(worker?.id, namedWorkerId, "the rejected EDIT neither creates nor replaces the addressed worker");
    } finally { await db.close(); }
});

test("SEND(worker://name):msg delivers to a sister; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-irc-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertWorker(db, workspaceId, null, "worker");

        const ok = await engine.dispatch({
            statement: sendStmt(null, workerPath("worker"), "what's your status?"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(ok.status, 200, "irc to an existing sister returns 200");
        const { flags: ircFlags, ...ircRest } = calls.at(-1) as { flags?: { auto?: boolean }; workspaceId: number; workerId: number; sourceWorkerId: number; prompt: string };
        assert.deepEqual(ircRest, { workspaceId, workerId: sisterId, sourceWorkerId: workerId, prompt: "what's your status?" }, "the message is delivered with the sender's causal identity");
        assert.equal(ircFlags?.auto, false, "the sender's flags ride the irc ({§worker-delegation-inherits-flags})");

        const missing = await engine.dispatch({
            statement: sendStmt(null, workerPath("ghost"), "anyone there?"),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(missing.status, 404, "irc to a non-existent sister is 404");
        assert.equal(calls.length, 1, "no inject for a missing sister");
    } finally { await db.close(); }
});

test("worker IRC rejects contract-invalid delegator flags before inheritance (#169)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const workspaceId = await insertWorkspace(db, `worker-irc-flags-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await insertWorker(db, workspaceId, null, "worker");
        await db.engine_set_loop_flags.run({ loop_id: loopId, flags: JSON.stringify({ auto: "yes" }) });

        await assert.rejects(
            new Worker().send(
                sendStmt(null, workerPath("worker"), "what's your status?"),
                makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, injectWorker }),
            ),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Loop ${loopId} has invalid persisted flags.`);
                assert.ok(error.cause instanceof InvalidLoopFlagsError);
                return true;
            },
        );
        assert.equal(calls.length, 0);
    } finally { await db.close(); }
});

// {§worker-control-addressing} {§worker-read-scope} {§worker-write-scoping}: KILL of an
// owner-addressed entry deletes the entry rather than cancelling the worker and obeys the same
// ancestry gates as other entry mutations. Drive the real dispatch route that distinguishes an
// authority-only control address from an entry path.
test("entry KILL: a named space is read-only from below and from above (403); the worker survives", async () => {
    const db = await openMigrated();
    try {
        const { injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-kill-entry-${crypto.randomUUID()}`);
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, alpha, "beta"); // beta is alpha's child
        const loopA = await insertLoop(db, alpha, 1, "go");
        const turnA = await insertTurn(db, loopA, 1, 102);
        const loopB = await insertLoop(db, beta, 1, "go");
        const turnB = await insertTurn(db, loopB, 1, 102);

        await engine.dispatch({ statement: editStmt(workerEntry("~", "note.md"), "scratch"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(workerEntry("~", "child-note.md"), "beta scratch"), workspaceId, workerId: beta, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });

        // {§worker-read-scope} {§worker-write-scoping} — a child KILLing UPWARD sees the parent's space (#394) and cannot write into it: 403.
        const upward = await engine.dispatch({ statement: killEntry("alpha", "note.md"), workspaceId, workerId: beta, loopId: loopB, turnId: turnB, sequence: 10, origin: "model" });
        assert.equal(upward.status, 403, "a child's named KILL is read-only — a named space takes no model writes");
        // {§worker-write-scoping} — the PARENT sees the child's space (ancestor read) but cannot write into it: 403.
        const downward = await engine.dispatch({ statement: killEntry("beta", "child-note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 10, origin: "model" });
        assert.equal(downward.status, 403, "an ancestor's named KILL is read-only — a named space takes no model writes");
        assert.equal((await engine.dispatch({ statement: readEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 20, origin: "model" })).status, 200, "the denied KILLs left the entries intact");

        // Only `~` is writable, even when a literal name denotes the caller.
        const namedSelf = await engine.dispatch({ statement: killEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 3, origin: "model" });
        assert.equal(namedSelf.status, 403, "a literal self-name remains a read-only owner selector");
        const killed = await engine.dispatch({ statement: killEntry("~", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 4, origin: "model" });
        assert.equal(killed.status, 200, "KILL(worker://~/note.md) deletes the caller's scratch entry");
        const gone = await engine.dispatch({ statement: readEntry("alpha", "note.md"), workspaceId, workerId: alpha, loopId: loopA, turnId: turnA, sequence: 5, origin: "model" });
        assert.equal(gone.status, 404, "the killed scratch entry is gone");
        const workerStillExists = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "alpha" });
        assert.notEqual(workerStillExists, undefined, "the worker alpha survives — KILL of an entry path is entry-delete, not worker cancellation");
    } finally { await db.close(); }
});

test("FORK(worker://name):task forks a NAMED branch — started via injectWorker", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-fork-${crypto.randomUUID()}`);
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

        const branch = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: branchName });
        if (branch === undefined) throw new Error("fork must create the branch worker in the workspace");
        assert.notEqual(branch.id, workerId, "the branch is a distinct worker");
        const { flags: forkFlags, ...forkRest } = calls.at(-1) as { flags?: { auto?: boolean }; workspaceId: number; workerId: number; sourceWorkerId: number; prompt: string; parentLoopId: number };
        assert.deepEqual(forkRest, { workspaceId, workerId: branch.id, sourceWorkerId: workerId, prompt: "take the other branch", parentLoopId: loopId }, "the branch is continued with its delegator's causal identity");
        assert.equal(forkFlags?.auto, false, "the forking loop's flags ride the injection ({§worker-delegation-inherits-flags})");
    } finally { await db.close(); }
});

test("spawn AND fork past PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE fail hard (508), create nothing", async () => {
    const db = await openMigrated();
    const prior = process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE;
    process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE = "2";
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-cap-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);        // the acting worker, its loop 102 = 1 active = the ceiling
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const parkedWorkerId = await insertWorker(db, workspaceId, null, "parked");
        const parkedLoopId = await insertLoop(db, parkedWorkerId, 1, "waiting");
        await db.test_set_loop_status.run({
            id: parkedLoopId,
            status: 202,
            terminal_result: null,
        });

        const spawn = await engine.dispatch({
            statement: spawnedWorker("worker", "go"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 508, "spawn at the ceiling is refused, hard");

        const fork = await engine.dispatch({
            statement: forkWorker("branch", "go"), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(fork.status, 508, "fork at the ceiling is refused, hard");

        const worker = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        assert.equal(worker, undefined, "no worker is created past the ceiling");
        assert.equal(calls.length, 0, "no inject on a refused spawn/fork");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE;
        else process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE = prior;
        await db.close();
    }
});

test("KILL(worker://name) aborts a sister by address; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const cancelWorker = async (workerId: number): Promise<void> => { killed.push(workerId); };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-kill-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertWorker(db, workspaceId, null, "worker");

        const killWorker: KillStatement = { metadata: null, op: "KILL", annotation: null, delimiter: "", signal: null, target: workerPath("worker"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const ok = await engine.dispatch({ statement: killWorker, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(ok.status, 200, "KILL of an existing sister returns 200");
        assert.deepEqual(killed, [sisterId], "the named sister worker is aborted by id");

        const killGhost: KillStatement = { metadata: null, op: "KILL", annotation: null, delimiter: "", signal: null, target: workerPath("ghost"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const missing = await engine.dispatch({ statement: killGhost, workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(missing.status, 404, "KILL of a non-existent sister is 404");
        assert.equal(killed.length, 1, "no abort for a missing sister");
    } finally { await db.close(); }
});

test("own-space EDIT lands owner-keyed; an ancestor READs the child's space; every named authority refuses model writes (403)", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, `worker-store-${crypto.randomUUID()}`);
        const meId = await insertWorker(db, workspaceId, null, "me");
        const childId = await insertWorker(db, workspaceId, meId, "child"); // me's child: me may read down into it
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ metadata: null, op: "READ", annotation: null, delimiter: "", signal: null, lineMarker: null, target, body: null, position: { line: 1, column: 1 } });

        // own-space EDIT(worker://~/note.md) — owner-keyed storage, BARE pathname ({§entry-owner}).
        const childLoop = await insertLoop(db, childId, 1, "go");
        const childTurn = await insertTurn(db, childLoop, 1, 102);
        const write = await engine.dispatch({ statement: editStmt(workerEntry("~", "note.md"), "scratch"), workspaceId, workerId: childId, loopId: childLoop, turnId: childTurn, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "own-space write creates the entry");
        const stored = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: childId, scheme: "worker", authority: "", pathname: "/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed (owner=child, /note.md) — the owner is the column, never the pathname");

        // {§worker-read-scope} — the PARENT reads its child's space by name (oversight flows down).
        const readCross = await engine.dispatch({ statement: readOf(workerEntry("child", "note.md")), workspaceId, workerId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(readCross.status, 200, "an ancestor's named READ reaches the child's space");

        // {§worker-write-scoping} — the ancestor still can't WRITE into it: named spaces are read-only.
        const writeCross = await engine.dispatch({ statement: editStmt(workerEntry("child", "note.md"), "tamper"), workspaceId, workerId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(writeCross.status, 403, "a named space takes no model writes — write to the commons or your own ~");
    } finally { await db.close(); }
});

test("the reserved runtime worker is an ordinary named space: readable by name, writable only by itself", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, `plurnk-ro-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId, null, "plurnk"); // the kernel principal must resolve by name
        const meId = await insertWorker(db, workspaceId, null, "me");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const kernelId = (await db.worker_resolve_by_name.get<{ id: number }>({
            workspace_id: workspaceId,
            name: "plurnk",
        }))?.id;
        assert.ok(kernelId);
        const kernelLoop = await insertLoop(db, kernelId!, 1, "runtime evidence");
        const kernelTurn = await insertTurn(db, kernelLoop, 1, 102);
        const runtimeWrite = await engine.dispatch({
            statement: editStmt(workerEntry("~", "runtime.md"), "private runtime evidence"),
            workspaceId,
            workerId: kernelId!,
            loopId: kernelLoop,
            turnId: kernelTurn,
            sequence: 1,
            origin: "_plurnk",
        });
        assert.equal(runtimeWrite.status, 201);

        const read = await engine.dispatch({
            statement: readStmt(workerEntry("plurnk", "runtime.md")),
            workspaceId,
            workerId: meId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(read.status, 200, "an independent root reads the runtime actor's named space (#394)");
        const write = await engine.dispatch({ statement: editStmt(workerEntry("plurnk", "runtime.md"), "tamper"), workspaceId, workerId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(write.status, 403, "a named space takes no model writes ({§worker-write-scoping})");
        const leaked = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: meId, scheme: "worker", authority: "", pathname: "/runtime.md" });
        assert.equal(leaked, undefined, "the refused write left nothing behind under any owner");
    } finally { await db.close(); }
});

test("{§join-blocking-collect} READ(worker://running-child) makes the turn's bare SEND[102] park", async () => {
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
        const parked = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.equal(parked?.status, 202, "the parent PARKED (202) awaiting the worker — the model never had to know SEND[202]<-1>");
    } finally { await db.close(); }
});

test("{§join-blocking-collect} a bare SEND[102] without an armed join continues normally", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-none-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, worker, 1, "go");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const send = await engine.dispatch({ statement: sendStmt(102, null, null), workspaceId, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.notEqual((send.attrs as { join?: boolean } | undefined)?.join, true, "no READ armed a join — a plain continue");
        const status = await db.test_get_loop_status.get<{ status: number }>({ id: loop });
        assert.notEqual(status?.status, 202, "the loop did not park — a bare continue without a join stays live");
    } finally { await db.close(); }
});

test("{§op-synchronous} KILL(worker) is decisive before same-turn SEND[200]", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `kill-sync-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 200);
        const worker = await insertWorker(db, workspaceId, null, "leftover-worker");
        const workerLoop = await insertLoop(db, worker, 1, "work");          // a LIVE child (status 102)
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            cancelWorker: async (workerId: number, reason: string) => {
                await lifecycle.cancelTree(workerId, reason, true);
            },
        });

        // Before: the live child would make a SEND[200] a premature-terminate. KILL must fix it IN this turn.
        const killWorker: KillStatement = { metadata: null, op: "KILL", annotation: null, delimiter: "", signal: null, target: workerPath("leftover-worker"), lineMarker: null, body: null, position: { line: 1, column: 1 } };
        const kill = await engine.dispatch({ statement: killWorker, workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(kill.status, 200, "KILL succeeds");
        // The DECISIVE claim: the worker's loop is terminal (499) SYNCHRONOUSLY — the same-turn gate reads it dead.
        const wstatus = await db.test_get_loop_status.get<{ status: number }>({ id: workerLoop });
        assert.equal(wstatus?.status, 499, "the killed worker's loop is 499 NOW, not next turn — KILL landed before the turn moved on");
        const send = await engine.dispatch({ statement: sendStmt(200, null, "done, worker killed"), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 2, origin: "model" });
        assert.notEqual(send.status, 409, `no premature-terminate 409 — the killed child is not live pending work; got ${send.status}`);
    } finally { await db.close(); }
});

test("SEND[202]: a live obligation blocks; an empty join completes immediately", async () => {
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
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: pLoop }))?.status, 202, "the loop is blocked at 202");

        // 202 + ∅ (no live work) → successful completion.
        const s2 = await insertWorkspace(db, `wait-void-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, s2);
        const loop = await insertLoop(db, worker, 1, "solo");
        const turn = await insertTurn(db, loop, 1, 200);
        const eng2 = new Engine({ db, schemes: new SchemeRegistry() });
        const satisfied = await eng2.dispatch({ statement: sendStmt(202, null, "standing by"), workspaceId: s2, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(satisfied.status, 200, "202 on an empty task group completes");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 200, "the empty join is terminal");

        // 202<-1> + ∅ — the marker cannot turn an empty join into a hang.
        const s3 = await insertWorkspace(db, `wait-hang-${crypto.randomUUID()}`);
        const run3 = await insertWorker(db, s3);
        const loop3 = await insertLoop(db, run3, 1, "solo");
        const turn3 = await insertTurn(db, loop3, 1, 200);
        const eng3 = new Engine({ db, schemes: new SchemeRegistry() });
        const indef = { ...sendStmt(202, null, "standing by"), lineMarker: { marks: [-1] as [number, ...number[]] } };
        const noHang = await eng3.dispatch({ statement: indef, workspaceId: s3, workerId: run3, loopId: loop3, turnId: turn3, sequence: 1, origin: "model" });
        assert.equal(noHang.status, 200, "202<-1> on nothing completes immediately");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop3 }))?.status, 200, "no held-open 202");
    } finally { await db.close(); }
});

test("an already-drained join is a normal deliverable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `drained-join-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId, null, "req-test");
        const wLoop = await insertLoop(db, worker, 1, "test the module");
        const wTurn = await insertTurn(db, wLoop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const waited = await engine.dispatch({ statement: sendStmt(202, null, "Standing by for user input"), workspaceId, workerId: worker, loopId: wLoop, turnId: wTurn, sequence: 1, origin: "model" });
        assert.equal(waited.status, 200, "the empty join completes");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: wLoop }))?.status, 200, "the loop concluded");
        const reader = await insertWorker(db, workspaceId);
        const collected = await lookThroughScheme("worker", null, readStmt(workerPath("req-test")), makeSchemeCtx({ db, workspaceId, workerId: reader }));
        assert.equal(collected.status, 200);
        assert.equal(String(collected.content), "Standing by for user input", "the model's terminal body is the deliverable");
    } finally { await db.close(); }
});

test("an idle join completes in the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-concludes-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, worker, 1, "nothing to do");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const r = await engine.dispatch({ statement: sendStmt(202, null, "idle"), workspaceId, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(r.status, 200, "the already-drained join completes");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 200, "no held-open 202");
    } finally { await db.close(); }
});

test("{§worker-generated-subtree} only _plurnk writes worker://~/_plurnk/ — model EDIT, KILL, SEND[410] and COPY/MOVE into it are 403 while it stays readable", async () => {
    const db = await openMigrated();
    try {
        const { injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-generated-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "alpha");
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A log row must match its turn's producer: one turn per writer tier.
        const turns = {
            model: await insertTurn(db, loopId, 1, 102),
            client: await insertOperationTurn(db, loopId, 2, "client"),
            _plurnk: await insertOperationTurn(db, loopId, 3, "_plurnk"),
        };
        const dispatch = (statement: PlurnkStatement, origin: keyof typeof turns, sequence: number) =>
            engine.dispatch({ statement, workspaceId, workerId, loopId, turnId: turns[origin], sequence, origin });
        const generated = "_plurnk/plurnk/example.md";

        // Plurnk materializes; the model reads.
        assert.equal((await dispatch(editStmt(workerEntry("~", generated), "# Example"), "_plurnk", 1)).status, 201, "the _plurnk writer materializes generated documents");
        assert.equal((await dispatch(readEntry("~", generated), "model", 2)).status, 200, "the subtree is readable like the rest of the space");

        // Every other writer tier is refused with the exact Problem, in own space and the commons alike.
        for (const [sequence, origin] of [[3, "model"], [4, "client"]] as const) {
            const edit = await dispatch(editStmt(workerEntry("~", generated), "clobbered", null, fullReplace), origin, sequence);
            assert.equal(edit.status, 403, `${origin} EDIT into the generated subtree is refused`);
            assert.equal(edit.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-generated-read-only");
        }
        assert.equal((await dispatch(killEntry("~", generated), "model", 5)).status, 403, "model KILL in the generated subtree is refused");
        assert.equal((await dispatch(sendStmt(410, workerEntry("~", generated)), "model", 6)).status, 403, "model SEND[410] in the generated subtree is refused");
        assert.equal((await dispatch(editStmt(workerEntry("", "_plurnk/notes.md"), "squat"), "model", 7)).status, 403, "the commons reserves the same subtree");
        assert.equal((await dispatch(editStmt(workerEntry("~", "_plurnk"), "root"), "model", 8)).status, 403, "the root itself is reserved");
        assert.equal((await dispatch(editStmt(workerEntry("", "free.md"), "free"), "model", 9)).status, 201);
        const copied = await dispatch(copyStmt(urlPath("worker", "/free.md"), urlPath("worker", "/_plurnk/copied.md")), "model", 13);
        assert.equal(copied.status, 403, "COPY cannot land a commons entry inside the generated subtree");
        assert.equal(copied.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-generated-read-only");

        // Ordinary own-space and commons writes are untouched.
        assert.equal((await dispatch(editStmt(workerEntry("~", "_plurnkish.md"), "mine"), "model", 10)).status, 201, "only the exact /_plurnk/ prefix is reserved");
        assert.equal((await dispatch(editStmt(workerEntry("~", "notes/plurnk.md"), "mine"), "model", 11)).status, 201);
        assert.equal((await dispatch(readEntry("~", generated), "model", 12)).content, "# Example", "every refusal left the generated document intact");
    } finally { await db.close(); }
});

test("{§worker-generated-subtree} a fork rederives the generated subtree — only ordinary own-space entries are snapshotted", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-generated-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "alpha");
        const plurnkCtx = makeSchemeCtx({ db, workspaceId, workerId: parent, loopId: 0, turnId: 0, writer: "_plurnk" });
        const modelCtx = makeSchemeCtx({ db, workspaceId, workerId: parent, loopId: 0, turnId: 0 });
        const workerScheme = new Worker();
        await workerScheme.edit(editStmt(workerEntry("~", "_plurnk/plurnk/example.md"), "# Example"), plurnkCtx);
        await workerScheme.edit(editStmt(workerEntry("~", "todo.md"), "parent note"), modelCtx);

        const forkId = await Fork.fork(db, parent, "alpha-fork", (scheme) => scheme === "worker" ? "snapshot" : "none");
        const forkCtx = makeSchemeCtx({ db, workspaceId, workerId: forkId, loopId: 0, turnId: 0 });
        const inherited = await workerScheme.find(findEntry("~", "**"), forkCtx);
        assert.deepEqual(resourcePaths(inherited), ["worker://~/todo.md"], "the branch inherits scratch but not generated bytes; LoopDocs rederives those from its own Functionality");
        assert.equal((await lookThroughScheme("worker", null, readEntry("~", "_plurnk/plurnk/example.md"), modelCtx)).content, "# Example", "the parent's generated document is untouched");
    } finally { await db.close(); }
});
