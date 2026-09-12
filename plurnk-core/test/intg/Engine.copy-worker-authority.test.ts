import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertOperationTurn, fixtureExecutors } from "./_helpers.ts";

for (const operation of ["COPY", "MOVE"]) for (const destination of ["", "caller", "peer"]) for (const scoped of [false, true]) {
    test(`{§worker-write-scoping}: ${operation} to '${destination}' preserves ${scoped ? "scoped" : "whole"} transfer semantics`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const workerId = await insertWorker(db, workspaceId, null, "caller");
        await insertWorker(db, workspaceId, null, "peer");
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertOperationTurn(db, loopId, 1, "client");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        let sequence = 0;
        const run = (header: string, body: string | null = null) => {
            const item = PlurnkParser.parseClient(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) }).items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return engine.dispatch({ workspaceId, workerId, loopId, turnId, sequence: ++sequence, origin: "client",
                statement: item.statement as PlurnkStatement });
        };
        const source = "worker://peer/source.md";
        const target = `worker://${destination}/copy.md`;
        assert.equal((await run(`EDIT (${source})`, "first\nsecond\nthird")).status, 201);
        assert.equal((await run(`${operation} (${source}) ${scoped ? "<1,2>" : ""} (${target})`)).status, 201);
        const copied = await run(`READ (${target}) <1,-1>`);
        assert.equal(String(copied.content).trimEnd(), scoped ? "first\nsecond" : "first\nsecond\nthird");
        const original = await run(`READ (${source}) <1,-1>`);
        if (operation === "COPY") assert.equal(original.content, "first\nsecond\nthird");
        else if (scoped) assert.equal(String(original.content).trimEnd(), "third");
        else assert.equal(original.status, 404);
    });
}
