import test from "node:test";
import assert from "node:assert/strict";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

test("manifest catalog: a file member stores scheme=file and renders slash-free (note 1)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mslash-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        // {§entry-identity-no-null} — storage uses the reserved file identity, while
        // the catalog projects the relative bare path the model reads and writes.
        await EntryCrud.writeEntry({ authority: "", pathname: "notes.md" }, { channels: { body: { content: "hi", mimetype: "text/markdown" } } }, ctx, "file", await Owner.commonsId(db, workspaceId));
        const stored = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "notes.md", scheme: "file" });
        assert.equal(stored?.scheme, "file", "the durable entry identity is non-null and explicit");
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const note = catalog.find(([channel]) => channel.path.endsWith("notes.md"));
        assert.equal(note?.[0].path, "notes.md", "the /notes.md member renders as bare notes.md — what the model writes back");
    } finally { await db.close(); }
});
