import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { insertLoop, insertOperationTurn, insertTurn, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";

for (const origin of ["model", "client", "_plurnk"] as const) {
    test(`{§session-write-scoping}: ${origin} composes operations across explicit Session namespaces`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `addresses-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        await insertSession(db, workspaceId, null, "bob");
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = origin === "model" ? await insertTurn(db, loopId, 1) : await insertOperationTurn(db, loopId, 1, origin);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        let sequence = 0;
        const run = (header: string, body: string | null = null) => {
            const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) });
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected one operation");
            return engine.dispatch({ workspaceId, sessionId, loopId, turnId, origin,
                sequence: ++sequence, statement: item.statement });
        };
        for (const name of ["alice", "bob", "unallocated", ""]) {
            const path = name === "" ? "workspace:///notes.md" : `session://${name}/notes.md`;
            const glob = name === "" ? "workspace:///*.md" : `session://${name}/*.md`;
            assert.equal((await run(`EDIT (${path})`, "first\nsecond")).status, 201);
            assert.equal((await run(`READ (${path}) <1,-1>`)).content, "first\nsecond");
            assert.equal((await run(`FIND (${glob})`)).status, 200);
            assert.equal((await run(`EDIT (${path}) <2>`, "updated")).status, 200);
        }
        assert.equal((await run("COPY (session://alice/notes.md) (session://bob/copy.md)")).status, 201);
        assert.equal((await run("MOVE (session://bob/copy.md) (workspace:///moved.md)")).status, 201);
        assert.equal((await run("READ (workspace:///moved.md) <1,-1>")).content, "first\nupdated");
        assert.equal((await run("READ (session://bob/copy.md)")).status, 404);
        assert.equal((await run("KILL (session://bob/notes.md)")).status, 200);
        assert.equal((await run("READ (session://bob/notes.md)")).status, 404);
        assert.equal((await run("EDIT (session://bob/_plurnk/example.md)", "ordinary generated area")).status, 201);
        assert.equal((await run("READ (session://bob/_plurnk/example.md) <1,-1>")).content, "ordinary generated area");
        assert.equal((await run("READ (session://missing/notes.md)")).status, 404, "an absent namespace does not resolve through the calling session");
    });
}

test("{§actor-boundary-doc-injection}: shared reference maintenance does not broadcast into model histories", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "shared-doc-maintenance");
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    await LoopDocs.materialize(engine, db, workspaceId);
    const observations = await db.engine_pull_ambient_events.all<{ event_id: number | null }>({ workspace_id: workspaceId, session_id: sessionId });
    assert.deepEqual(observations.filter(({ event_id }) => event_id !== null), [], "background document maintenance is not model activity");
    const entries = await db.loop_docs_materialized.all({ workspace_id: workspaceId });
    assert.ok(entries.length > 0, "the actual reference tree was materialized");
});

test("{§entry-owner}: scratch survives its namesake actor and remains workspace-local", async () => {
    await using db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const spaces = await Promise.all(["one", "two"].map(async (name) => {
        const workspaceId = await insertWorkspace(db, name);
        const sessionId = await insertSession(db, workspaceId, null, "reader");
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertOperationTurn(db, loopId, 1, "client");
        let sequence = 0;
        return { workspaceId, run: (header: string, body: string | null = null) => {
            const item = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) }).items[0];
            assert.ok(item?.kind === "statement");
            return engine.dispatch({ workspaceId, sessionId, loopId, turnId, origin: "client", sequence: ++sequence,
                statement: item.statement });
        } };
    }));
    const author = await insertSession(db, spaces[0].workspaceId, null, "author");
    assert.equal((await spaces[0].run("EDIT (session://author/note.md)", "first workspace")).status, 201);
    await db.test_delete_session.run({ id: author });
    assert.equal((await spaces[0].run("READ (session://author/note.md)")).content, "first workspace");
    const catalog = await spaces[0].run("FIND (session://author/*.md)");
    assert.match(JSON.stringify(catalog.results), /session:\/\/author\/note\.md/);
    assert.equal((await spaces[1].run("READ (session://author/note.md)")).status, 404);
    assert.equal((await spaces[1].run("COPY (session://author/note.md) (workspace:///copy.md)")).status, 404);
    assert.equal((await spaces[1].run("READ (workspace:///copy.md)")).status, 404);
    assert.equal((await spaces[1].run("EDIT (session://author/note.md)", "second workspace")).status, 201);
    assert.equal((await spaces[1].run("MOVE (session://author/note.md) (workspace:///copy.md)")).status, 201);
    assert.equal((await spaces[1].run("READ (workspace:///copy.md)")).content, "second workspace");
    assert.equal((await spaces[0].run("READ (session://author/note.md)")).content, "first workspace");
});
