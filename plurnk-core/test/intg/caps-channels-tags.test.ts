// Conformance: the db-backed ChannelCaps + TagCaps (keystone PR-2, #180)
// against real SQLite, as a third-party sibling would drive them through the
// capability surface. Entries are seeded via DbEntryCaps (the same seam).

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import DbTagCaps from "../../src/core/caps/DbTagCaps.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";

test("DbChannelCaps: append grows, replace swaps + re-tokenizes, setState transitions; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-channels-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "known", schemeManifest("known"));
        const channels = new DbChannelCaps(ctx, "known");

        const w = await entries.write("/doc.md", { channels: { body: { content: "abc", mimetype: "text/markdown" } }, tags: [] });
        const entryId = w.entryId as number;

        // append → content grows
        assert.equal((await channels.append("/doc.md", "body", "def")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "abcdef");

        // replace → content swapped, tokens re-counted at write
        assert.equal((await channels.replace("/doc.md", "body", "xyz")).status, 200);
        assert.equal((await entries.read("/doc.md")).entry?.channels.body.content, "xyz");
        const after = await db.channel_meta.get<{ contentLength: number }>({ entry_id: entryId, channel: "body" });
        assert.equal(after?.contentLength, 3);

        // setState → state transitions (verified through channel_meta)
        assert.equal((await channels.setState("/doc.md", "body", "closed")).status, 200);
        const meta = await db.channel_meta.get<{ state: string }>({ entry_id: entryId, channel: "body" });
        assert.equal(meta?.state, "closed");

        // absent entry / channel → 404
        const missingEntry = await channels.append("/missing.md", "body", "x");
        assert.equal(missingEntry.status, 404);
        assert.equal(missingEntry.problem?.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
        const missingReplace = await channels.replace("/doc.md", "nope", "x");
        assert.equal(missingReplace.problem?.type, "https://problems.plurnk.dev/scheme/known/channel-not-found");
        const missingState = await channels.setState("/doc.md", "nope", "closed");
        assert.equal(missingState.problem?.type, "https://problems.plurnk.dev/scheme/known/channel-not-found");
    } finally { await db.close(); }
});

test("DbTagCaps: add dedupes (INSERT OR IGNORE), list is sorted, remove drops named; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-tags-${crypto.randomUUID()}`);
        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "known", schemeManifest("known"));
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
        const missingAdd = await tags.add("/missing.md", ["z"]);
        assert.equal(missingAdd.problem?.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
        const missingList = await tags.list("/missing.md");
        assert.equal(missingList.problem?.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
        assert.deepEqual(missingList.tags, []);
        const missingRemove = await tags.remove("/missing.md", ["z"]);
        assert.equal(missingRemove.problem?.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
    } finally { await db.close(); }
});
