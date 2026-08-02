// {§find-count-not-contents} #418 — a FIND whose match set exceeds the render budget returns a
// COUNT + narrow-your-query steer instead of enumerating every match (a repo-scale FIND(**) over
// a huge workspace grinds clean, not crash-and-recover). The meta line still self-describes the
// full count.
import test from "node:test";
import assert from "node:assert/strict";
import EntryFind from "../../src/schemes/_entry-find.ts";
import Worker from "../../src/schemes/Worker.ts";
import type { FindStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, seedEntryWithChannel, makeSchemeCtx } from "./_helpers.ts";

const findAll = (): FindStatement => ({
    op: "FIND", suffix: "", signal: null,
    target: { kind: "url", raw: "worker:///**", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/**", params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("over the budget, FIND returns a count + narrow steer, not the enumerated rows (#418)", async () => {
    const prev = process.env.PLURNK_SERVICE_FIND_MAX_MATCHES;
    process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = "3";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `findcap-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        for (let i = 0; i < 6; i++) await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: `/e${i}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const r = await EntryFind.findWorkspaceEntries(findAll(), ctx, Worker.manifest);
        assert.equal(r.status, 200);
        assert.equal(r.omittedItems, 6, "the full omitted-item count is reported");
        assert.equal(r.mimetype, "text/markdown", "the content is a steer, not the JSON catalog");
        assert.match(String(r.content), /6 entries match.*render budget/i, "the model is told the fact: how many matched, over budget, not enumerated");
        assert.doesNotMatch(String(r.content), /\{"path"/, "no catalog rows were materialized into the body");
        assert.deepEqual(r.results, [], "count-forward retains no hidden enumerated result objects");
        assert.deepEqual(r.matches, [], "count-forward cannot be fanned out by a caller");
        assert.deepEqual(r.pathnames, [], "count-forward retains no hidden pathname list");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FIND_MAX_MATCHES; else process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = prev;
        await db.close();
    }
});

test("under the budget, FIND enumerates the catalog rows as before (#418)", async () => {
    const prev = process.env.PLURNK_SERVICE_FIND_MAX_MATCHES;
    process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = "500";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `findsmall-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/one", channel: "body", content: "just one", mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const r = await EntryFind.findWorkspaceEntries(findAll(), ctx, Worker.manifest);
        assert.equal(r.omittedItems, undefined, "no items are omitted under budget");
        assert.equal(r.mimetype, "application/json", "the catalog rows are enumerated");
        assert.ok(Array.isArray(JSON.parse(String(r.content))), "content is the JSON catalog array");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FIND_MAX_MATCHES; else process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = prev;
        await db.close();
    }
});
