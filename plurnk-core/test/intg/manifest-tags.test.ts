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

test("the manifest catalog does not project operation signals as resource metadata", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mtags-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(taggedEdit(url("plan.md"), "the plan", ["+wip", "+draft"]), ctx);
        await new Worker().edit(taggedEdit(url("done.md"), "shipped", []), ctx);

        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const plan = catalog.find(([channel]) => channel.path.endsWith("plan.md"));
        assert.ok(plan !== undefined);
        assert.equal("tags" in plan[0], false, "log classification does not become resource metadata");
        const done = catalog.find(([channel]) => channel.path.endsWith("done.md"));
        assert.ok(done !== undefined);
        assert.equal("tags" in done[0], false);
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
        await EntryCrud.writeEntry("notes.md", { channels: { body: { content: "hi", mimetype: "text/markdown" } } }, ctx, "file");
        const stored = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string }>({ pathname: "notes.md", scheme: "file" });
        assert.equal(stored?.scheme, "file", "the durable entry identity is non-null and explicit");
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const note = catalog.find(([channel]) => channel.path.endsWith("notes.md"));
        assert.equal(note?.[0].path, "notes.md", "the /notes.md member renders as bare notes.md — what the model writes back");
    } finally { await db.close(); }
});
