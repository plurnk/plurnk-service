// note 13 — the manifest catalog surfaces each entry's tags (entry_tags), so the model
// sees its own categorization in the directory it READs (and can FIND by tag) without a
// separate read. Untagged entries omit the field — no empty-array clutter.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const taggedEdit = (target: UrlPath, body: string, tags: string[]): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("the manifest catalog surfaces each entry's tags (note 13)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mtags-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(taggedEdit(url("plan.md"), "the plan", ["wip", "draft"]), ctx);
        await new Worker().edit(taggedEdit(url("done.md"), "shipped", []), ctx);

        const catalog = await EntryManifest.catalogRowsFor(ctx) as Array<{ path: string; tags?: string[] }>;
        const plan = catalog.find((e) => e.path.endsWith("plan.md"));
        assert.deepEqual(plan?.tags, ["draft", "wip"], "the tagged entry carries its entry_tags in the catalog, sorted");
        const done = catalog.find((e) => e.path.endsWith("done.md"));
        assert.equal(done?.tags, undefined, "an untagged entry omits the tags field (no empty-array clutter)");
    } finally { await db.close(); }
});

test("manifest catalog: a file member stores scheme=file and renders slash-free (note 1)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mslash-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        // {§entry-identity-no-null} — storage uses the reserved file identity, while
        // the catalog projects the relative bare path the model reads and writes.
        await EntryCrud.writeEntry("notes.md", { channels: { body: { content: "hi", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");
        const stored = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "notes.md", scheme: "file" });
        assert.equal(stored?.scheme, "file", "the durable entry identity is non-null and explicit");
        const catalog = await EntryManifest.catalogRowsFor(ctx) as Array<{ path: string }>;
        const note = catalog.find((e) => e.path.endsWith("notes.md"));
        assert.equal(note?.path, "notes.md", "the /notes.md member renders as bare notes.md — what the model writes back");
    } finally { await db.close(); }
});
