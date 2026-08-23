// Conformance: the ChannelCaps namespace in plurnk-schemes
// {§capability-ctx}, driven against real SQLite through the public capability
// surface. Entries are seeded through that same surface.

import test from "node:test";
import assert from "node:assert/strict";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import { openMigrated, insertWorkspace, makeSchemeCtx, schemeManifest } from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";

test("DbChannelCaps: append grows, replace swaps + re-tokenizes, setState transitions; absent → 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-channels-${crypto.randomUUID()}`);
        const ownerId = await Owner.commonsId(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId });
        const entries = new DbEntryCaps(ctx, "notes", schemeManifest("notes"), "", ownerId);
        const channels = new DbChannelCaps(ctx, "notes", "", ownerId);

        const w = await entries.write("/doc.md", { channels: { body: { content: "abc", mimetype: "text/markdown" } } });
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
        assert.equal(missingEntry.problem?.type, "https://problems.plurnk.dev/scheme/notes/entry-not-found");
        const missingReplace = await channels.replace("/doc.md", "nope", "x");
        assert.equal(missingReplace.problem?.type, "https://problems.plurnk.dev/scheme/notes/channel-not-found");
        const missingState = await channels.setState("/doc.md", "nope", "closed");
        assert.equal(missingState.problem?.type, "https://problems.plurnk.dev/scheme/notes/channel-not-found");
    } finally { await db.close(); }
});
