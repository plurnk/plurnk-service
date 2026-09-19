import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Results from "../../src/core/results.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import { readStmt, findStmt, editStmt, copyStmt, moveStmt, killStmt } from "./_dsl.ts";

test("{§worker-loop-result}: exact outcomes compose with READ, FIND, COPY and immutable source boundaries", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "loop-resources");
    const workerId = await insertWorker(db, workspaceId, null, "reader");
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "model" });
    const child = await insertWorker(db, workspaceId, null, "child");
    const first = await insertLoop(db, child, 1);
    const source = parsePath("ops://child/1")!;
    const unfinished = await dispatch(readStmt(source));
    assert.equal(unfinished.status, 425);
    assert.equal(unfinished.resource, source.raw);
    assert.equal(unfinished.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");
    const body = Array.from({ length: 30 }, (_, i) => `Result line ${i + 1}`).join("\n");
    const lifecycle = new LoopLifecycle(db);
    await lifecycle.finish(first, { status: 200, content: body, mimetype: "text/plain" });
    const page = await dispatch(readStmt(source));
    assert.equal(page.status, 200);
    assert.equal(page.content, body.split("\n").slice(0, 16).join("\n"));
    assert.equal(page.lineAnchors, undefined);
    assert.deepEqual(page.range, { unit: "line", total: 30, requested: [1, 16], returned: [1, 16] });
    assert.equal((await dispatch(readStmt(source, { marks: [17, -1] }))).content, body.split("\n").slice(16).join("\n"));

    const live = await insertLoop(db, child, 2);
    const latest = await dispatch(readStmt(parsePath("worker://child")));
    assert.equal(latest.status, 425);
    assert.equal(latest.resource, "ops://child/2");
    assert.equal((await dispatch(readStmt(source, { marks: [1, -1] }))).content, body);
    for (const target of ["ops://child/*", "ops://*/1", "ops://child/1"]) {
        const found = await dispatch(findStmt(parsePath(target)));
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.match(JSON.stringify(found.results), /ops:\/\/child\/1/);
    }
    const destination = parsePath("worker:///copied.txt")!;
    assert.equal((await dispatch(copyStmt(source, destination, { marks: [20, 21] }))).status, 201);
    assert.equal((await dispatch(readStmt(destination))).content, "Result line 20\nResult line 21\n");
    for (const statement of [editStmt(source, "changed"), killStmt(source), moveStmt(source, parsePath("worker:///moved.txt")!), copyStmt(destination, source)]) {
        const denied = await dispatch(statement);
        assert.equal(denied.status, 403, JSON.stringify(denied));
        assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
        assert.equal((await lifecycle.result(first))?.content, body, "no mutation changes the outcome");
    }
    assert.equal((await dispatch(readStmt(parsePath("ops://child/99")))).status, 404);
    for (const target of ["ops:///1", "ops://child/0", "ops://child/1?latest=1", "ops://child/9007199254740992"]) {
        const invalid = await dispatch(readStmt(parsePath(target)));
        assert.equal(invalid.status, 400, target);
        assert.equal(invalid.problem?.type, "https://problems.plurnk.xyz/scheme/ops/coordinate-malformed");
    }
    const otherWorkspace = await insertWorkspace(db, "separate-loop-resources");
    const otherChild = await insertWorker(db, otherWorkspace, null, "child");
    const otherLoop = await insertLoop(db, otherChild, 1);
    await lifecycle.finish(otherLoop, { status: 200, content: "Different workspace." });
    assert.equal((await dispatch(readStmt(source, { marks: [1, -1] }))).content, body, "workspace scope is not worker privacy");
    await lifecycle.finish(live, { status: 200 });
    const collected = await dispatch(readStmt(parsePath("worker://child")));
    assert.equal(collected.status, 200);
    assert.equal(collected.content, "");
    assert.equal(collected.resource, "ops://child/2");

    const third = await insertLoop(db, child, 3);
    const exact = Results.failure("test:source", "failed", 502, "Provider failed.");
    await lifecycle.finish(third, exact);
    const fourth = await insertLoop(db, child, 4);
    const external = Results.failure("test:source", "external", 502, "Remote request failed.");
    Results.attachInstance(external, "https://example.test/errors/abc123");
    await lifecycle.finish(fourth, external);
    await Fork.fork(db, child, "branch");
    const inherited = await dispatch(readStmt(parsePath("ops://branch/3")));
    assert.equal(inherited.status, 502);
    assert.equal(inherited.problem?.instance, "ops://branch/3");
    assert.equal(inherited.content, "Provider failed.");
    assert.equal((await dispatch(readStmt(parsePath("ops://branch/1"), { marks: [1, -1] }))).content, body);
    assert.equal((await dispatch(readStmt(parsePath("ops://branch/4")))).problem?.instance, external.problem?.instance);
});

test("{§worker-loop-result}: source identity and exact outcome survive reopening the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-loop-resource-"));
    let db = await openMigrated(join(directory, "plurnk.db"));
    try {
        const workspaceId = await insertWorkspace(db, "loop-resource-restart");
        const workerId = await insertWorker(db, workspaceId, null, "producer");
        const loopId = await insertLoop(db, workerId, 1);
        const exact = await new LoopLifecycle(db).finish(loopId, Results.failure("test:source", "failed", 502, "Retained failure."));
        assert.ok(exact);
        await db.close();
        db = await openMigrated(join(directory, "plurnk.db"));
        const reader = await insertWorker(db, workspaceId, null, "reader");
        const readingLoop = await insertLoop(db, reader, 1);
        const turnId = await insertTurn(db, readingLoop, 1);
        const read = await new Engine({ db, schemes: new SchemeRegistry() }).dispatch({
            workspaceId, workerId: reader, loopId: readingLoop, turnId, sequence: 1, origin: "model",
            statement: readStmt(parsePath("ops://producer/1")),
        });
        assert.equal(read.status, 502);
        assert.equal(read.resource, "ops://producer/1");
        assert.equal(read.content, "Retained failure.");
        assert.deepEqual(read.problem, exact.problem);
    } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
    }
});
