// {§derivation-exhaustive} {§derivation-dedup-parallel}
import test from "node:test";
import assert from "node:assert/strict";
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Owner from "../../src/core/Owner.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});
test("{§derivation-dedup-parallel} changed resources report one aggregate derivation lifecycle", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `progress-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const seed = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        for (const name of ["a.md", "b.md", "c.md"]) await new Worker().edit(editStmt(url(name), `content for ${name} with words to index`), seed);

        type Tel = { source?: string; kind?: string; message?: string; pathname?: string; completed?: number; total?: number };
        const events: Tel[] = [];
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, pushNotice: (e) => events.push(e as Tel) }));

        const progress = events.filter((e) => e.source === "engine:derivation" && e.kind === "search_progress");
        assert.ok(progress.length > 0, "a 3-entry corpus pass emits a visible lifecycle");
        assert.ok(progress.every((e) => e.total === 3), "total reflects the corpus size (3 changed entries)");
        assert.ok(progress.every((e) => e.pathname === undefined && !e.message?.includes(".md")), "client progress is aggregate state, never a pathname ledger");
        assert.equal(progress.at(-1)?.completed, 3, "the final progress event reports completion");

        // A single changed entry is still real work and therefore has one coherent
        // lifecycle. Replaceable buffering keeps this from becoming packet history.
        const events2: Tel[] = [];
        await new Worker().edit(editStmt(url("d.md"), "a single new entry changed this turn"), seed);
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, pushNotice: (e) => events2.push(e as Tel) }));
        assert.deepEqual(
            events2.filter((e) => e.kind === "search_progress").map((e) => (e as { phase?: string }).phase),
            ["preparing", "complete"],
            "a single-entry pass reports one real lifecycle",
        );
    } finally { db.close(); }
});

test("[#91] PLURNK_SERVICE_SEARCH_EXCLUDE applies only to file-scheme entries", async () => {
    const prev = process.env.PLURNK_SERVICE_SEARCH_EXCLUDE;
    process.env.PLURNK_SERVICE_SEARCH_EXCLUDE = "*/dist/*";
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `excluded-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const commonsId = await Owner.commonsId(db, workspaceId);
        const identical = '{"name":"x","version":"24.18.0","packages":{"":{"deps":{"y":"1.0.0"}}}}';
        const pathname = "/repo/dist/index.json";
        await EntryCrud.writeEntry({ authority: "", pathname }, {
            channels: { body: { content: identical, mimetype: "application/json" } },
        }, ctx, "file", commonsId);
        await EntryCrud.writeEntry({ authority: "", pathname }, {
            channels: { body: { content: identical, mimetype: "application/json" } },
        }, ctx, "https", workerId);
        await new Worker().edit(editStmt(url("notes.md"), "the database connection failed with a timeout"), ctx);
        await SearchIndex.maintain(ctx);
        const fileEntry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "file", pathname });
        const httpsEntry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "https", pathname });
        const fts = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query: "version" });
        assert.equal(fts.filter((row) => row.pathname === pathname).length, 1, "only the HTTPS entry contributes the shared pathname to lexical search");
        const fileDisposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string }>({ entry_id: fileEntry?.id ?? -1 });
        const httpsDisposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string | null; deep_hash: string }>({ entry_id: httpsEntry?.id ?? -1 });
        assert.equal(fileDisposition?.disposition, "excluded");
        assert.equal(fileDisposition?.reason, "*/dist/*");
        assert.equal(httpsDisposition?.disposition, "indexed", "identical bytes at a non-file pathname remain searchable");
        const readable = await EntryCrud.readEntry({ authority: "", pathname }, ctx, "file", commonsId);
        assert.equal(readable.entry?.channels.body?.content, identical, "search exclusion does not alter direct readability");
        // stamped: a second pass derives nothing (no eternal re-attempt of the suppressed entry)
        assert.equal(await SearchIndex.maintain(ctx), 0, "a second pass reuses the terminal exclusion and indexed artifacts");
    } finally {
        db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEARCH_EXCLUDE; else process.env.PLURNK_SERVICE_SEARCH_EXCLUDE = prev;
    }
});

test("{§derivation-dedup-parallel}: the pump admits smallest-first without skipping a large outlier", async () => {
    // Artifact identities prove scheduling order; every resource must still finish.
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sort-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const whale = Array.from({ length: 120 }, (_, i) => `whale line ${i}: substantial prose about topic ${i} with enough words to chunk`).join("\n");
        await new Worker().edit(editStmt(url("whale.md"), whale), ctx);       // written FIRST, biggest
        await new Worker().edit(editStmt(url("minnow-a.md"), "a tiny note about apples"), ctx);
        await new Worker().edit(editStmt(url("minnow-b.md"), "a tiny note about lemons"), ctx);
        await SearchIndex.maintain(ctx);
        const order = await db.test_artifact_insertion_order.all<{ pathname: string; first_rowid: number }>({});
        const byPath = new Map(order.map((o) => [o.pathname, o.first_rowid]));
        const whaleFirst = byPath.get("/whale.md") ?? -1;
        assert.ok((byPath.get("/minnow-a.md") ?? Infinity) < whaleFirst, "minnow-a scheduled before the whale");
        assert.ok((byPath.get("/minnow-b.md") ?? Infinity) < whaleFirst, "minnow-b scheduled before the whale");
    } finally { db.close(); }
});
