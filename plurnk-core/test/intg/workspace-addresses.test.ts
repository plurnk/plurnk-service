import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { insertLoop, insertOperationTurn, insertTurn, insertWorker, insertWorkspace, openMigrated, fixtureExecutors } from "./_helpers.ts";

for (const origin of ["model", "client", "plugin", "_plurnk"] as const) {
    test(`{§worker-write-scoping}: ${origin} composes operations across explicit Worker namespaces`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `addresses-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        await insertWorker(db, workspaceId, null, "bob");
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = origin === "model" ? await insertTurn(db, loopId, 1) : await insertOperationTurn(db, loopId, 1, origin);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        let sequence = 0;
        const run = (header: string, body: string | null = null) => {
            const parsed = PlurnkParser.parseClient(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) });
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected one operation");
            return engine.dispatch({ workspaceId, workerId, loopId, turnId, origin,
                sequence: ++sequence, statement: item.statement as PlurnkStatement });
        };
        for (const name of ["alice", "bob", "unallocated", ""]) {
            const path = `worker://${name}/notes.md`;
            assert.equal((await run(`EDIT (${path})`, "first\nsecond")).status, 201);
            assert.equal((await run(`READ (${path}) <1,-1>`)).content, "first\nsecond");
            assert.equal((await run(`FIND (worker://${name}/*.md)`)).status, 200);
            assert.equal((await run(`EDIT (${path}) <2>`, "updated")).status, 200);
        }
        assert.equal((await run("COPY (worker://alice/notes.md) (worker://bob/copy.md)")).status, 201);
        assert.equal((await run("MOVE (worker://bob/copy.md) (worker:///moved.md)")).status, 201);
        assert.equal((await run("READ (worker:///moved.md) <1,-1>")).content, "first\nupdated");
        assert.equal((await run("READ (worker://bob/copy.md)")).status, 404);
        assert.equal((await run("KILL (worker://bob/notes.md)")).status, 200);
        assert.equal((await run("READ (worker://bob/notes.md)")).status, 404);
        assert.equal((await run("EDIT (worker://bob/_plurnk/example.md)", "ordinary generated area")).status, 201);
        assert.equal((await run("READ (worker://bob/_plurnk/example.md) <1,-1>")).content, "ordinary generated area");
        assert.equal((await run("READ (worker://~/notes.md)")).status, 404, "tilde is not a caller-relative alias");
    });
}

test("{§actor-boundary-doc-injection}: shared reference maintenance does not broadcast into model histories", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "shared-doc-maintenance");
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    await LoopDocs.materialize(engine, db, workspaceId);
    const observations = await db.engine_pull_ambient_events.all<{ event_id: number | null }>({ workspace_id: workspaceId, worker_id: workerId });
    assert.deepEqual(observations.filter(({ event_id }) => event_id !== null), [], "background document maintenance is not model activity");
    const entries = await db.loop_docs_materialized.all({ workspace_id: workspaceId });
    assert.ok(entries.length > 0, "the actual reference tree was materialized");
});

test("{§entry-owner}: scratch survives its namesake actor and remains workspace-local", async () => {
    await using db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const spaces = await Promise.all(["one", "two"].map(async (name) => {
        const workspaceId = await insertWorkspace(db, name);
        const workerId = await insertWorker(db, workspaceId, null, "reader");
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertOperationTurn(db, loopId, 1, "client");
        let sequence = 0;
        return { workspaceId, run: (header: string, body: string | null = null) => {
            const item = PlurnkParser.parseClient(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) }).items[0];
            assert.ok(item?.kind === "statement");
            return engine.dispatch({ workspaceId, workerId, loopId, turnId, origin: "client", sequence: ++sequence,
                statement: item.statement as PlurnkStatement });
        } };
    }));
    const author = await insertWorker(db, spaces[0].workspaceId, null, "author");
    assert.equal((await spaces[0].run("EDIT (worker://author/note.md)", "first workspace")).status, 201);
    await db.test_delete_worker.run({ id: author });
    assert.equal((await spaces[0].run("READ (worker://author/note.md)")).content, "first workspace");
    const catalog = await spaces[0].run("FIND (worker://author/*.md)");
    assert.match(JSON.stringify(catalog.results), /worker:\/\/author\/note\.md/);
    assert.equal((await spaces[1].run("READ (worker://author/note.md)")).status, 404);
    assert.equal((await spaces[1].run("COPY (worker://author/note.md) (worker:///copy.md)")).status, 404);
    assert.equal((await spaces[1].run("READ (worker:///copy.md)")).status, 404);
    assert.equal((await spaces[1].run("EDIT (worker://author/note.md)", "second workspace")).status, 201);
    assert.equal((await spaces[1].run("MOVE (worker://author/note.md) (worker:///copy.md)")).status, 201);
    assert.equal((await spaces[1].run("READ (worker:///copy.md)")).content, "second workspace");
    assert.equal((await spaces[0].run("READ (worker://author/note.md)")).content, "first workspace");
});
