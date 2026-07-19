// note 13 — the manifest catalog surfaces each entry's tags (entry_tags), so the model
// sees its own categorization in the directory it READs (and can FIND by tag) without a
// separate read. Untagged entries omit the field — no empty-array clutter.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const taggedEdit = (target: UrlPath, body: string, tags: string[]): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("[§packet-catalog] the manifest catalog surfaces each entry's tags (note 13)", async () => {
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

test("manifest catalog: a file member (scheme=null) renders slash-free — matches what the model types (note 1)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mslash-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        // A file member is stored namespace-absolute (`/notes.md`, scheme=null) but the model
        // types the relative path it reads — the catalog must render it slash-free so the two match.
        await EntryCrud.writeEntry("/notes.md", { channels: { body: { content: "hi", mimetype: "text/markdown" } }, tags: [] }, ctx, null);
        const catalog = await EntryManifest.catalogRowsFor(ctx) as Array<{ path: string }>;
        const note = catalog.find((e) => e.path.endsWith("notes.md"));
        assert.equal(note?.path, "notes.md", "the /notes.md member renders as bare notes.md — what the model writes back");
    } finally { await db.close(); }
});
