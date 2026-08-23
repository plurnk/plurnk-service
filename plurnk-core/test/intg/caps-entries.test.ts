// Conformance: the EntryCaps namespace in plurnk-schemes {§capability-ctx}
// round-trips write → read → delete against real SQLite through the public
// capability surface rather than core's private database context.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";

test("DbEntryCaps: write creates (201) → read round-trips → re-write updates (200) → delete (200→404)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-entries-${crypto.randomUUID()}`);
        const ownerId = await Owner.commonsId(db, workspaceId);
        const caps = new DbEntryCaps(makeSchemeCtx({ db, workspaceId }), "notes", schemeManifest("notes"), "", ownerId);

        // write a new entry → 201 created, real entryId
        const w = await caps.write("/note.md", {
            channels: { body: { content: "hello", mimetype: "text/markdown", state: "active" } },
            attributes: { kind: "note", rank: 2 },
        });
        assert.equal(w.status, 201);
        assert.equal(w.created, true);
        assert.equal(typeof w.entryId, "number");

        // read round-trips content, mimetype, lifecycle state, and private attributes
        const r = await caps.read("/note.md");
        assert.equal(r.status, 200);
        assert.equal(r.entry?.channels.body.content, "hello");
        assert.equal(r.entry?.channels.body.mimetype, "text/markdown");
        assert.equal(r.entry?.channels.body.state, "active");
        assert.deepEqual(r.entry?.attributes, { kind: "note", rank: 2 });

        // re-write the same path → 200 (not created), content replaced
        const w2 = await caps.write("/note.md", {
            channels: { body: { content: "world", mimetype: "text/markdown", state: "closed" } },
        });
        assert.equal(w2.status, 200);
        assert.equal(w2.created, false);
        const updated = await caps.read("/note.md");
        assert.equal(updated.entry?.channels.body.content, "world");
        assert.equal(updated.entry?.channels.body.state, "closed");
        assert.deepEqual(updated.entry?.attributes, { kind: "note", rank: 2 }, "omitting private attributes preserves them");

        // read an absent path → 404, null entry
        const miss = await caps.read("/missing.md");
        assert.equal(miss.status, 404);
        assert.equal(miss.entry, null);

        // delete → 200, then read → 404, then delete-again → 404
        assert.equal((await caps.delete("/note.md")).status, 200);
        assert.equal((await caps.read("/note.md")).status, 404);
        assert.equal((await caps.delete("/note.md")).status, 404);
    } finally { await db.close(); }
});
