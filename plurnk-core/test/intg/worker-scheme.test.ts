// worker:// scheme — spawn + fork (COPY), irc (SEND), terminate (KILL). Same-workspace sisters
// (SPEC {§machine-processes}, {§actor-boundary}). injectWorker is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the worker scheme's own work: the worker-table effect + the
// exact inject call. The dispatch gates (#checkWritable worker-control branch and
// #handleWorkerControl routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { InvalidLoopPolicyError, PlurnkParser, parsePath } from "@plurnk/plurnk-contracts";
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
import type { InjectWorkerNotify } from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import Fork from "../../src/core/fork.ts";
import WorkerName from "../../src/core/WorkerName.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, insertOperationTurn, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
import { resourcePaths } from "./_find.ts";
import { copyStmt, editStmt, sendStmt, dispositionStmt, readStmt, fullReplace } from "./_dsl.ts";

// {§worker-scheme} — the authority is a literal Worker name.
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

// A named scratch entry; the authority is a coordinate, not an access policy.
const workerEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker",
    username: null, password: null, hostname: owner, port: null,
    pathname: `/${path}`, query: null, fragment: null,
});

// Worker control (grammar 0.74.55): WORK(worker://<name>):task spawns a fresh worker; FORK(worker://<name>):task
// branches the current worker into a named sister. The body is the seed task, not a destination path.
const spawnedWorker = (name: string, prompt: string): WorkStatement => ({
    metadata: null,
    op: "WORK", aside: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});
const forkWorker = (name: string, prompt: string): ForkStatement => ({
    metadata: null,
    op: "FORK", aside: null, target: workerPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});

// The Daemon.inject seam as a recording stub — its drain/enqueue behavior is
// covered by the Daemon/inject suites; here we assert exactly what the worker
// scheme hands it.
const recordingInjectWorker = () => {
    const calls: Array<Parameters<InjectWorkerNotify>[0]> = [];
    const injectWorker = async (args: typeof calls[number]) => {
        calls.push(args);
        return { action: "enqueued_new_loop" as const, loopId: -1 };
    };
    return { calls, injectWorker };
};

const weigh = (text: string): number => Math.ceil(text.length / 4);

// FIND in one named namespace: worker://<owner>/<glob>.
const findEntry = (owner: string, glob: string): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: { kind: "url", raw: `worker://${owner}/${glob}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${glob}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// READ from one named namespace: worker://<owner>/<path>.
const readEntry = (owner: string, path: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// KILL in one named namespace: worker://<owner>/<path> — deletes the scratch entry (path present).
const killEntry = (owner: string, path: string): KillStatement => ({
    metadata: null,
    op: "KILL", aside: null,
    target: { kind: "url", raw: `worker://${owner}/${path}`, scheme: "worker", username: null, password: null, hostname: owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§machine-processes-entry-inheritance}: a fork copies named scratch without changing literal references", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const parent = await insertWorker(db, workspaceId, null, "alpha");
        const ctxP = makeSchemeCtx({ db, workspaceId, workerId: parent });
        const scheme = new Worker();
        const body = "parent note: worker://alpha/original.md";
        assert.equal((await scheme.edit(editStmt(workerEntry("alpha", "todo.md"), body), ctxP)).status, 201);
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const ctxF = makeSchemeCtx({ db, workspaceId, workerId: forkId });
        assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha-fork", "**"), ctxF)), ["worker://alpha-fork/todo.md"]);
        assert.equal((await lookThroughScheme("worker", null, readEntry("alpha-fork", "todo.md"), ctxF)).content, body);
        assert.equal((await scheme.edit(editStmt(workerEntry("alpha-fork", "todo.md"), "fork note", fullReplace), ctxP)).status, 200);
        for (const ctx of [ctxP, ctxF]) {
            assert.equal((await lookThroughScheme("worker", null, readEntry("alpha", "todo.md"), ctx)).content, body);
            assert.equal((await lookThroughScheme("worker", null, readEntry("alpha-fork", "todo.md"), ctx)).content, "fork note");
        }
    } finally { await db.close(); }
});

test("{§worker-read-scope}: FIND addresses literal namespaces identically from unrelated Workers", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, null, "beta");
        const contexts = [alpha, beta].map((workerId) => makeSchemeCtx({ db, workspaceId, workerId }));
        const scheme = new Worker();
        assert.equal((await scheme.edit(editStmt(workerEntry("alpha", "todo.md"), "alpha note"), contexts[1]!)).status, 201);
        assert.equal((await scheme.edit(editStmt(workerEntry("beta", "plan.md"), "beta note"), contexts[0]!)).status, 201);
        for (const ctx of contexts) {
            assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha", "**"), ctx)), ["worker://alpha/todo.md"]);
            assert.deepEqual(resourcePaths(await scheme.find(findEntry("beta", "**"), ctx)), ["worker://beta/plan.md"]);
        }
    } finally { await db.close(); }
});

test("WORK(worker://name):task spawns a same-workspace sister, seeded via injectWorker", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-spawn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "parent", "model");
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: spawnedWorker("worker", "investigate the bug"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "spawn returns 200");

        const worker = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" });
        if (worker === undefined) throw new Error("spawn must create a worker named 'worker' in the workspace");
        const meta = await db.worker_get.get<{ workspace_id: number; origin: string }>({ id: worker.id });
        assert.equal(meta?.origin, "model", "spawned worker's actor class follows its parent");
        assert.equal(meta?.workspace_id, workspaceId, "spawned worker shares the workspace (sisters)");

        assert.equal(calls.length, 1, "exactly one injectWorker call");
        const { freshLoopPolicy: spawnPolicy, ...spawnRest } = calls[0];
        assert.deepEqual(spawnRest, { workspaceId, workerId: worker.id, sourceLoopId: loopId, prompt: "investigate the bug", spawn: true }, "the new worker is started with its delegator's causal identity");
        assert.deepEqual(spawnPolicy, { proposals: "review" }, "the delegating loop's policy rides the injection ({§worker-delegation-inherits-policy})");
    } finally { await db.close(); }
});

test("{§worker-scheme-spawn}: concurrent WORK and FORK cannot claim the same literal address", async () => {
    await using db = await openMigrated();
    const { calls, injectWorker } = recordingInjectWorker();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
    const workspaceId = await insertWorkspace(db, "named-claim-race");
    const workerId = await insertWorker(db, workspaceId, null, "parent");
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const results = await Promise.all([spawnedWorker("child", "fresh"), forkWorker("child", "branch")].map((statement, index) =>
        engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: index + 1, origin: "model" })));
    assert.deepEqual(results.map(({ status }) => status).toSorted(), [200, 409]);
    const failure = results.find(({ status }) => status === 409)!;
    assert.match(failure.problem!.type, /worker-name-conflict$/);
    assert.equal(failure.problem!.worker, "child");
    assert.equal(calls.length, 1, "only the successful claim starts a child");
    const child = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
    assert.equal(child?.id, calls[0].workerId);
});

for (const origin of ["model", "client", "plugin", "_plurnk"] as const) {
    test(`{§machine-processes-worker-origin}: a ${origin} turn delegates within its actor's lineage`, async () => {
        await using db = await openMigrated();
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `delegating-${origin}`);
        const workerId = await insertWorker(db, workspaceId, null, "parent", "model");
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = origin === "model" ? await insertTurn(db, loopId, 1) : await insertOperationTurn(db, loopId, 1, origin);
        for (const [index, statement] of [spawnedWorker("fresh", "go"), forkWorker("branch", "go")].entries()) {
            const result = await engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: index + 1, origin });
            assert.equal(result.status, 200, JSON.stringify(result));
            const child = await db.worker_get.get<{ origin: string }>({ id: calls[index].workerId });
            assert.equal(child?.origin, "model", "operation producer is not the child actor class");
            const lineage = await db.test_worker_lineage.get<{ parent_worker_id: number }>({ id: calls[index].workerId });
            assert.equal(lineage?.parent_worker_id, workerId);
        }
    });
}

for (const op of ["WORK", "FORK"] as const) {
    test(`{§worker-auto-name}: addressless ${op} allocates and reports a distinct short child address`, async (t) => {
        const db = await openMigrated();
        try {
            const { calls, injectWorker } = recordingInjectWorker();
            const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
            const workspaceId = await insertWorkspace(db, `anonymous-${op}-${crypto.randomUUID()}`);
            const parentId = await insertWorker(db, workspaceId, null, "parent");
            const occupiedId = await insertWorker(db, workspaceId, null, "ab3d5678");
            const loopId = await insertLoop(db, parentId, 1, "delegate");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const source = PlurnkParser.frame(op, "Inspect the project.");
            const parsed = PlurnkParser.parseStatements(source);
            assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.ok(item?.kind === "statement");
            const statement = item.statement;
            assert.equal(statement.op, op);
            assert.equal(statement.target, null, "authored program contains no invented address");
            const names = ["e6a78901", "ab3d5678", "c4e56789", "d5f67890"];
            t.mock.method(WorkerName, "short", () => {
                const name = names.shift();
                assert.ok(name !== undefined, "allocator must settle after the collision retry");
                return name;
            });
            const first = await engine.dispatch({
                statement, workspaceId, workerId: parentId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(first.status, 200, "an omitted address allocates a worker rather than refusing the operation");
            assert.deepEqual(first.attrs, { worker: "worker://e6a78901" });

            const results = await Promise.all([2, 3].map((sequence) => engine.dispatch({
                statement, workspaceId, workerId: parentId, loopId, turnId, sequence, origin: "model",
            })));
            assert.deepEqual(results.map(({ status }) => status), [200, 200]);
            assert.deepEqual(results.map(({ body }) => body).toSorted(), ["c4e56789", "d5f67890"]);
            for (const result of results) assert.deepEqual(result.attrs, { worker: `worker://${result.body}` });
            assert.equal(calls.length, 3);
            for (const call of calls) {
                const child = await db.worker_get.get<{ name: string }>({ id: call.workerId });
                assert.ok(child !== undefined);
                assert.match(child.name, /^[a-f0-9]{8}$/);
                const lineage = await db.test_worker_lineage.get<{ parent_worker_id: number }>({ id: call.workerId });
                assert.equal(lineage?.parent_worker_id, parentId);
                assert.equal(call.workspaceId, workspaceId);
                assert.equal(call.prompt, "Inspect the project.");
                assert.deepEqual(call.freshLoopPolicy, { proposals: "review" });
                const inherited = await db.test_fork_loops.all({ worker_id: call.workerId });
                assert.equal(inherited.length, op === "FORK" ? 1 : 0, "FORK copies history; WORK starts fresh");
                const addressed = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: child.name });
                assert.equal(addressed?.id, call.workerId, "the reported name addresses the child that actually received the prompt");
            }
            assert.equal((await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "ab3d5678" }))?.id, occupiedId);
            assert.equal(statement.target, null, "allocation must not rewrite submitted operation evidence");
        } finally { await db.close(); }
    });
}

for (const op of ["WORK", "FORK"] as const) test(`{§workspace-capability-policy}: ${op} shares live workspace policy and inherits only proposal disposition`, async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `delegation-policy-${op}`);
        const parentId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, parentId, 1, "delegate");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await db.test_set_loop_policy.run({ loop_id: loopId, policy: JSON.stringify({ proposals: "accept" }) });
        const seed = await engine.dispatch({
            statement: editStmt(workerEntry("", "note.md"), "shared source"),
            workspaceId, workerId: parentId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(seed.status, 201);
        await db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "READ" }] } }),
        });
        const spawned = await engine.dispatch({
            statement: { ...spawnedWorker("child", "work independently"), op },
            workspaceId, workerId: parentId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(spawned.status, 200);
        assert.deepEqual(calls[0]?.freshLoopPolicy, { proposals: "accept" });
        const childId = calls[0]!.workerId;
        const childLoop = await insertLoop(db, childId, op === "FORK" ? 2 : 1, "continue");
        const childTurn = await insertTurn(db, childLoop, 1, 102);
        const read = (sequence: number) => engine.dispatch({
            statement: readEntry("", "note.md"), workspaceId, workerId: childId,
            loopId: childLoop, turnId: childTurn, sequence, origin: "model",
        });
        assert.equal((await read(1)).problem?.policyScope, "workspace");
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: {} }) });
        const admitted = await read(2);
        assert.equal(admitted.status, 200);
        assert.equal(admitted.content, "shared source");
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
            sendStmt(target, "message"),
            readStmt(target),
            { metadata: null, op: "KILL", aside: null, target, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } },
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

test("{§worker-control-addressing}: all Worker names are literal; tilde is not an alias", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const killed: number[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, cancelWorker: async (id) => { killed.push(id); }, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const workerId = await insertWorker(db, workspaceId, null, "actor");
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        let sequence = 0;
        const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "model" });
        assert.equal((await dispatch(spawnedWorker("self", "be the literally named worker"))).status, 200);
        const named = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "self" });
        assert.ok(named);
        assert.equal((await dispatch(sendStmt(workerPath("actor"), "message the caller"))).status, 200);
        assert.equal((await dispatch(sendStmt(workerPath("self"), "message the named worker"))).status, 200);
        assert.deepEqual(calls.slice(1).map(({ workerId: id }) => id), [workerId, named.id]);
        assert.equal((await dispatch(sendStmt(workerPath("~"), "no alias"))).status, 404);
        assert.equal((await dispatch(editStmt(workerEntry("~", "notes.md"), "literal namespace"))).status, 201);
        assert.equal((await dispatch(readStmt(workerEntry("actor", "notes.md")))).status, 404,
            "a literal tilde never aliases the caller's named scratch");
        for (const name of ["actor", "self"]) {
            assert.equal((await dispatch(editStmt(workerEntry(name, "notes.md"), "scratch"))).status, 201);
            const kill: KillStatement = { metadata: null, op: "KILL", aside: null, target: workerPath(name), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
            assert.equal((await dispatch(kill)).status, 200);
        }
        assert.deepEqual(killed, [workerId, named.id]);
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
        assert.match(result.problem?.detail ?? "", /already exists in this workspace/, "the message names the live worker");
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
        assert.match(result.problem?.detail ?? "", /already exists in this workspace/);
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

test("{§worker-scheme-spawn}: a completed Worker retains its name and scratch identity", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const retained = await insertWorker(db, workspaceId, null, "worker");
        const completed = await insertLoop(db, retained, 1, "done");
        await db.test_set_loop_status.run({ id: completed, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        for (const [index, statement] of [spawnedWorker("worker", "fresh work"), forkWorker("worker", "branch")].entries()) {
            const result = await engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: index + 1, origin: "model" });
            assert.equal(result.status, 409);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/worker-name-conflict");
        }
        assert.equal(calls.length, 0);
        assert.equal((await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "worker" }))?.id, retained);
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

        // {§join-blocking-collect}
        const worker = await insertWorker(db, workspaceId, null, "worker-db");
        const wLoop = await insertLoop(db, worker, 1, "find db");
        const running = await lookThroughScheme("worker", null, readStmt(workerPath("worker-db")), ctx);
        assert.equal(running.status, 425, "a still-running worker hasn't delivered — 425, not its result");
        assert.equal(running.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-unfinished");
        assert.equal(running.problem?.detail, "Worker 'worker-db' has unfinished work (status 102).", "425 states the unresolved task and its actual state");
        assert.equal("awaitWorker" in running, false, "a READ result does not carry hidden scheduling intent");

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
        assert.equal(Object.hasOwn(done, "lineAnchors"), false, "an actor's deliverable is not an editable entry");
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
        assert.equal(Object.hasOwn(tail, "lineAnchors"), false, "scoping an actor READ does not grant entry-edit authority");

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
        assert.equal(result.problem?.recovery, "EDIT requires an entry path, such as worker:///notes.md.");
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
            statement: sendStmt(workerPath("worker"), "what's your status?"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(ok.status, 200, "irc to an existing sister returns 200");
        const { freshLoopPolicy: ircPolicy, ...ircRest } = calls.at(-1)!;
        assert.deepEqual(ircRest, { workspaceId, workerId: sisterId, sourceLoopId: loopId, prompt: "what's your status?" }, "the message is delivered with the sender's causal identity");
        assert.deepEqual(ircPolicy, { proposals: "review" }, "the sender's policy rides the irc ({§worker-delegation-inherits-policy})");

        const missing = await engine.dispatch({
            statement: sendStmt(workerPath("ghost"), "anyone there?"),
            workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(missing.status, 404, "irc to a non-existent sister is 404");
        assert.equal(calls.length, 1, "no inject for a missing sister");
    } finally { await db.close(); }
});

test("{§worker-delegation-inherits-policy}: a fresh IRC loop receives the sender's proposal disposition", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectWorker, weigh });
        const workspaceId = await insertWorkspace(db, `worker-irc-bound-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await db.test_set_workspace_settings.run({
            id: workspaceId,
            settings: JSON.stringify({ capabilities: { deny: [{ operation: "EXEC" }] } }),
        });
        const loopId = await insertLoop(db, workerId, 1, "delegate");
        await db.test_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({
                proposals: "accept",
            }),
        });
        const turnId = await insertTurn(db, loopId, 1, 102);
        await insertWorker(db, workspaceId, null, "sister");

        const result = await engine.dispatch({
            statement: sendStmt(workerPath("sister"), "continue this work"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.deepEqual(calls[0]?.freshLoopPolicy, {
            proposals: "accept",
        });
    } finally { await db.close(); }
});

test("worker IRC rejects contract-invalid delegator policy before inheritance (#169)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectWorker } = recordingInjectWorker();
        const workspaceId = await insertWorkspace(db, `worker-irc-policy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await insertWorker(db, workspaceId, null, "worker");
        await db.test_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({ proposals: "sometimes" }),
        });

        await assert.rejects(
            new Worker().send(
                sendStmt(workerPath("worker"), "what's your status?"),
                makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, injectWorker }),
            ),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Loop ${loopId} has invalid persisted policy.`);
                assert.ok(error.cause instanceof InvalidLoopPolicyError);
                return true;
            },
        );
        assert.equal(calls.length, 0);
    } finally { await db.close(); }
});

test("{§worker-write-scoping}: entry KILL works upward, downward and on self without cancelling actors", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker: async (id) => { killed.push(id); }, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const alpha = await insertWorker(db, workspaceId, null, "alpha");
        const beta = await insertWorker(db, workspaceId, alpha, "beta");
        for (const [index, [writer, target]] of [[beta, "alpha"], [alpha, "beta"], [alpha, "alpha"]].entries()) {
            const workerId = writer as number;
            const name = target as string;
            const loopId = await insertLoop(db, workerId, index + 1, "go");
            const turnId = await insertTurn(db, loopId, 1, 102);
            let sequence = 0;
            const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "model" });
            assert.equal((await dispatch(editStmt(workerEntry(name, "note.md"), "scratch"))).status, 201);
            assert.equal((await dispatch(killEntry(name, "note.md"))).status, 200);
            assert.equal((await dispatch(readEntry(name, "note.md"))).status, 404);
            assert.ok(await db.worker_resolve_by_name.get({ workspace_id: workspaceId, name }));
        }
        assert.deepEqual(killed, []);
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
        const { freshLoopPolicy: forkPolicy, ...forkRest } = calls.at(-1)!;
        assert.deepEqual(forkRest, { workspaceId, workerId: branch.id, sourceLoopId: loopId, prompt: "take the other branch", spawn: true }, "the branch is continued with its delegator's causal identity");
        assert.deepEqual(forkPolicy, { proposals: "review" }, "the forking loop's policy rides the injection ({§worker-delegation-inherits-policy})");
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

        const killWorker: KillStatement = { metadata: null, op: "KILL", aside: null, target: workerPath("worker"), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
        const ok = await engine.dispatch({ statement: killWorker, workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(ok.status, 200, "KILL of an existing sister returns 200");
        assert.deepEqual(killed, [sisterId], "the named sister worker is aborted by id");

        const killGhost: KillStatement = { metadata: null, op: "KILL", aside: null, target: workerPath("ghost"), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
        const missing = await engine.dispatch({ statement: killGhost, workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(missing.status, 404, "KILL of a non-existent sister is 404");
        assert.equal(killed.length, 1, "no abort for a missing sister");
    } finally { await db.close(); }
});

for (const related of [true, false]) test(`{§worker-read-scope}: ${related ? "parent" : "unrelated worker"} reads and writes a named entry`, async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, `worker-store-${crypto.randomUUID()}`);
        const meId = await insertWorker(db, workspaceId, null, "me");
        const childId = await insertWorker(db, workspaceId, related ? meId : null, "author");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ metadata: null, op: "READ", aside: null, lineMarker: null, target, matcher: null, body: null, position: { line: 1, column: 1 } });

        // {§entry-owner}: the authority is part of the workspace entry key.
        const childLoop = await insertLoop(db, childId, 1, "go");
        const childTurn = await insertTurn(db, childLoop, 1, 102);
        const write = await engine.dispatch({ statement: editStmt(workerEntry("author", "note.md"), "scratch"), workspaceId, workerId: childId, loopId: childLoop, turnId: childTurn, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "own-space write creates the entry");
        const stored = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "worker", authority: "author", pathname: "/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed by workspace and literal authority");

        const readCross = await engine.dispatch({ statement: readOf(workerEntry("author", "note.md")), workspaceId, workerId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(readCross.status, 200, "a named READ reaches another worker's entry without ancestry");
        assert.equal(readCross.content, "scratch");

        // {§worker-write-scoping} applies independently to the destination.
        const writeCross = await engine.dispatch({ statement: editStmt(workerEntry("author", "note.md"), "updated", fullReplace), workspaceId, workerId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(writeCross.status, 200);
        assert.equal((await engine.dispatch({ statement: readOf(workerEntry("author", "note.md")), workspaceId, workerId: meId, loopId, turnId, sequence: 3, origin: "model" })).content, "updated");
    } finally { await db.close(); }
});

test("the reserved runtime worker is an ordinary named space: readable and writable by everyone", async () => {
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
            statement: editStmt(workerEntry("plurnk", "runtime.md"), "private runtime evidence"),
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
        const write = await engine.dispatch({ statement: editStmt(workerEntry("plurnk", "runtime.md"), "updated", fullReplace), workspaceId, workerId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(write.status, 200, "the runtime actor has no privileged scratch access");
        const leaked = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "worker", authority: "", pathname: "/runtime.md" });
        assert.equal(leaked, undefined, "named writes do not create a second copy in shared scratch");
    } finally { await db.close(); }
});

test("{§join-blocking-collect} READ of a running child does not override an actionable TASK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-collect-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 200);
        const worker = await insertWorker(db, workspaceId, parent, "worker"); // a worker still running (live loop 102),
        await insertLoop(db, worker, 1, "count");                     // nothing delivered yet
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const read = await engine.dispatch({ statement: readStmt(workerPath("worker")), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(read.status, 425, "the worker hasn't delivered — 425 still-running");
        const send = await engine.dispatch({ statement: dispositionStmt("in_progress", null), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 2, origin: "model" });
        assert.equal(send.status, 102);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status, 102, "actionable work remains runnable");
        const nextTurn = await insertTurn(db, parentLoop, 2, 102);
        const waiting = await engine.dispatch({ statement: dispositionStmt("waiting", "Await the child"), workspaceId, workerId: parent, loopId: parentLoop, turnId: nextTurn, sequence: 1, origin: "model" });
        assert.equal(waiting.status, 202);
        const parked = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.equal(parked?.status, 202, "the explicit waiting inventory parks on the live child");
    } finally { await db.close(); }
});

test("{§join-blocking-collect} an actionable TASK without live work continues normally", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-none-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, worker, 1, "go");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const send = await engine.dispatch({ statement: dispositionStmt("in_progress", null), workspaceId, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(send.status, 102);
        const status = await db.test_get_loop_status.get<{ status: number }>({ id: loop });
        assert.equal(status?.status, 102, "the loop stays live");
    } finally { await db.close(); }
});

test("{§op-synchronous} KILL(worker) settles before same-turn completion", async () => {
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

        // Killing the worker settles immediately and does not itself block completion.
        const killWorker: KillStatement = { metadata: null, op: "KILL", aside: null, target: workerPath("leftover-worker"), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
        const kill = await engine.dispatch({ statement: killWorker, workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(kill.status, 200, "KILL succeeds");
        // The DECISIVE claim: the worker's loop is terminal (499) SYNCHRONOUSLY — the same-turn gate reads it dead.
        const wstatus = await db.test_get_loop_status.get<{ status: number }>({ id: workerLoop });
        assert.equal(wstatus?.status, 499, "the killed worker's loop is 499 NOW, not next turn — KILL landed before the turn moved on");
        const send = await engine.dispatch({ statement: dispositionStmt("completed", "done, worker killed"), workspaceId, workerId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 2, origin: "model" });
        assert.equal(send.status, 200, "the stopped worker is no longer live pending work and KILL permits completion");
    } finally { await db.close(); }
});

test("TASK waiting: a live obligation parks; an empty join continues without inventing completion", async () => {
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
        const blocked = await eng1.dispatch({ statement: dispositionStmt("waiting", "awaiting worker"), workspaceId: s1, workerId: parent, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        assert.equal(blocked.status, 202, "202 with a live child blocks on the join");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: pLoop }))?.status, 202, "the loop is blocked at 202");

        // {§wait-obligation-matrix}
        const s2 = await insertWorkspace(db, `wait-void-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, s2);
        const loop = await insertLoop(db, worker, 1, "solo");
        const turn = await insertTurn(db, loop, 1, 200);
        const eng2 = new Engine({ db, schemes: new SchemeRegistry() });
        const satisfied = await eng2.dispatch({ statement: dispositionStmt("waiting", "standing by"), workspaceId: s2, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(satisfied.status, 102);
        assert.equal(satisfied.detail, "Nothing is in flight and no timed or polled wait is set. Continuing.");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 102, "the empty join is not terminal");

        // 202<-1> + ∅ — the marker cannot turn an empty join into a hang.
        const s3 = await insertWorkspace(db, `wait-hang-${crypto.randomUUID()}`);
        const run3 = await insertWorker(db, s3);
        const loop3 = await insertLoop(db, run3, 1, "solo");
        const turn3 = await insertTurn(db, loop3, 1, 200);
        const eng3 = new Engine({ db, schemes: new SchemeRegistry() });
        const indef = { ...dispositionStmt("waiting", "standing by"), lineMarker: { marks: [-1] as [number, ...number[]] } };
        const noHang = await eng3.dispatch({ statement: indef, workspaceId: s3, workerId: run3, loopId: loop3, turnId: turn3, sequence: 1, origin: "model" });
        assert.equal(noHang.status, 102, "an indefinite wait without work continues");
        assert.equal(noHang.detail, satisfied.detail);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop3 }))?.status, 102, "no held-open 202");
    } finally { await db.close(); }
});

test("an empty join cannot manufacture a terminal deliverable from its inventory", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `drained-join-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId, null, "req-test");
        const wLoop = await insertLoop(db, worker, 1, "test the module");
        const wTurn = await insertTurn(db, wLoop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const waited = await engine.dispatch({ statement: dispositionStmt("waiting", "Standing by for user input"), workspaceId, workerId: worker, loopId: wLoop, turnId: wTurn, sequence: 1, origin: "model" });
        assert.equal(waited.status, 102, "the empty join continues");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: wLoop }))?.status, 102, "the loop remains active");
        const reader = await insertWorker(db, workspaceId);
        const collected = await lookThroughScheme("worker", null, readStmt(workerPath("req-test")), makeSchemeCtx({ db, workspaceId, workerId: reader }));
        assert.equal(collected.status, 425);
        const nextTurn = await insertTurn(db, wLoop, 2, 102);
        const completed = await engine.dispatch({ statement: dispositionStmt("completed", "Finished"), workspaceId, workerId: worker, loopId: wLoop, turnId: nextTurn, sequence: 1, origin: "model" });
        assert.equal(completed.status, 200);
        const done = await lookThroughScheme("worker", null, readStmt(workerPath("req-test")), makeSchemeCtx({ db, workspaceId, workerId: reader }));
        assert.equal(done.status, 200);
        assert.equal(done.content, "[ worker 'req-test' concluded with no deliverable (status 200) ]", "the READ reports absence instead of inventing an answer from the inventory");
        assert.equal((await new LoopLifecycle(db).result(wLoop))?.content ?? null, null);
    } finally { await db.close(); }
});

test("an empty waiting inventory stays runnable in the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-concludes-${crypto.randomUUID()}`);
        const worker = await insertWorker(db, workspaceId);
        const loop = await insertLoop(db, worker, 1, "nothing to do");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const r = await engine.dispatch({ statement: dispositionStmt("waiting", "idle"), workspaceId, workerId: worker, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 102, "no completion and no held-open 202");
    } finally { await db.close(); }
});

test("{§worker-generated-subtree}: generated documents are ordinary editable workspace scratch", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const workerId = await insertWorker(db, workspaceId, null, "alpha");
        const loopId = await insertLoop(db, workerId, 1, "go");
        for (const [index, origin] of ["_plurnk", "model", "client"].entries()) {
            const writer = origin as "model" | "client" | "_plurnk";
            const turnId = writer === "model"
                ? await insertTurn(db, loopId, index + 1, 102)
                : await insertOperationTurn(db, loopId, index + 1, writer);
            let sequence = 0;
            const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: writer });
            const target = workerEntry("", "_plurnk/plurnk/example.md");
            assert.equal((await dispatch(editStmt(target, "# Example"))).status, 201);
            assert.equal((await dispatch(editStmt(target, "# Updated", fullReplace))).status, 200);
            assert.equal((await dispatch(readStmt(target))).content, "# Updated");
            assert.equal((await dispatch(copyStmt(target, workerEntry("", "_plurnk/copied.md")))).status, 201);
            assert.equal((await dispatch(killEntry("", "_plurnk/plurnk/example.md"))).status, 200);
            assert.equal((await dispatch(killEntry("", "_plurnk/copied.md"))).status, 200);
        }
    } finally { await db.close(); }
});

test("{§worker-generated-subtree}: shared docs are not forked; every named scratch path is copied", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const parent = await insertWorker(db, workspaceId, null, "alpha");
        const ctx = makeSchemeCtx({ db, workspaceId, workerId: parent });
        const scheme = new Worker();
        assert.equal((await scheme.edit(editStmt(workerEntry("", "_plurnk/example.md"), "# Shared"), ctx)).status, 201);
        assert.equal((await scheme.edit(editStmt(workerEntry("alpha", "_plurnk/note.md"), "ordinary scratch"), ctx)).status, 201);
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const forkCtx = makeSchemeCtx({ db, workspaceId, workerId: forkId });
        assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha-fork", "**"), forkCtx)), ["worker://alpha-fork/_plurnk/note.md"]);
        assert.equal((await lookThroughScheme("worker", null, readEntry("", "_plurnk/example.md"), forkCtx)).content, "# Shared");
    } finally { await db.close(); }
});
