// Conformance: the db-backed ChannelCaps + TagCaps (keystone PR-2, #180)
// against real SQLite, as a third-party sibling would drive them through the
// capability surface. Entries are seeded via DbEntryCaps (the same seam).

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import DbTagCaps from "../../src/core/caps/DbTagCaps.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx } from "./_helpers.ts";

test("DbChannelCaps: append grows, replace swaps + re-tokenizes, setState transitions; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-channels-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "known");
        const channels = new DbChannelCaps(ctx, "known");

        const w = await entries.write("/doc.md", { channels: { body: { content: "abc", mimetype: "text/markdown" } }, tags: [] });
        const entryId = w.entryId as number;

        // append → content grows
        assert.equal((await channels.append("/doc.md", "body", "def")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "abcdef");

        // replace → content swapped, tokens re-counted at write
        assert.equal((await channels.replace("/doc.md", "body", "xyz")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "xyz");
        const after = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "body" });
        assert.equal(after?.contentLength, 3);

        // setState → state transitions (verified through channel_meta)
        assert.equal((await channels.setState("/doc.md", "body", "closed")).status, 200);
        const meta = await (db.channel_meta as PrepMethod).get<{ state: string }>({ entry_id: entryId, channel: "body" });
        assert.equal(meta?.state, "closed");

        // absent entry / channel → 404
        assert.equal((await channels.append("/missing.md", "body", "x")).status, 404);
        assert.equal((await channels.replace("/doc.md", "nope", "x")).status, 404);
        assert.equal((await channels.setState("/doc.md", "nope", "closed")).status, 404);
    } finally { await db.close(); }
});

test("DbTagCaps: add dedupes (INSERT OR IGNORE), list is sorted, remove drops named; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-tags-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "known");
        const tags = new DbTagCaps(ctx, "known");

        await entries.write("/x.md", { channels: { body: { content: "_", mimetype: "text/markdown" } }, tags: ["keep"] });

        // add — incl. a duplicate of the seeded "keep" → INSERT OR IGNORE dedupes
        assert.equal((await tags.add("/x.md", ["alpha", "beta", "keep"])).status, 200);
        const listed = await tags.list("/x.md");
        assert.equal(listed.status, 200);
        assert.deepEqual([...listed.tags], ["alpha", "beta", "keep"]); // ORDER BY tag

        // remove a single tag
        assert.equal((await tags.remove("/x.md", ["beta"])).status, 200);
        assert.deepEqual([...(await tags.list("/x.md")).tags], ["alpha", "keep"]);

        // absent entry → 404
        assert.equal((await tags.add("/missing.md", ["z"])).status, 404);
        assert.equal((await tags.list("/missing.md")).status, 404);
        assert.equal((await tags.remove("/missing.md", ["z"])).status, 404);
    } finally { await db.close(); }
});
