// {§find-result-projection}: FIND bounds materialization through its ordinary
// result pagination, with one compact extent over the selected result unit.
import test from "node:test";
import assert from "node:assert/strict";
import EntryFind from "../../src/schemes/_entry-find.ts";
import Worker from "../../src/schemes/Worker.ts";
import Owner from "../../src/core/Owner.ts";
import type { FindStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, seedEntryWithChannel, makeSchemeCtx } from "./_helpers.ts";

const findAll = (marks: [number, ...number[]] | null = null): FindStatement => ({
    op: "FIND", annotation: null, delimiter: "", signal: null,
    target: { kind: "url", raw: "worker:///**", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/**", query: null, fragment: null },
    lineMarker: marks === null ? null : { marks }, body: null, position: { line: 1, column: 1 },
});

test("{§find-result-projection}: markerless FIND returns the first 16 resources with complete counts", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-page-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        for (let i = 0; i < 20; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/e${i.toString().padStart(2, "0")}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const ownerId = await Owner.commonsId(db, workspaceId);
        const r = await EntryFind.findWorkspaceEntries(findAll(), ctx, Worker.manifest, { ownerId });
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 16);
        assert.equal(r.matchingPathCount, 20);
        assert.equal(r.matchLocationCount, 0);
        assert.equal(r.mimetype, "application/json");
        assert.deepEqual(r.range, {
            unit: "resource",
            total: 20,
            requested: [1, 16],
            returned: [1, 16],
        });
    } finally {
        await db.close();
    }
});

test("{§find-result-projection}: explicit later and all-results pages use the same resource unit", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `find-explicit-page-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        for (let i = 0; i < 20; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/e${i.toString().padStart(2, "0")}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const ownerId = await Owner.commonsId(db, workspaceId);
        const continued = await EntryFind.findWorkspaceEntries(findAll([17, -1]), ctx, Worker.manifest, { ownerId });
        assert.equal(continued.results.length, 4);
        assert.equal(continued.range?.unit, "resource");
        assert.equal(continued.matchingPathCount, 20);

        const all = await EntryFind.findWorkspaceEntries(findAll([1, -1]), ctx, Worker.manifest, { ownerId });
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.matchingPathCount, 20);
    } finally {
        await db.close();
    }
});
