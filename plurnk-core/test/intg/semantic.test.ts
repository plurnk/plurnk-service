// {§find-semantic-default-top-k} semantic search end-to-end with the real embedding model
// (all-MiniLM-L6-v2 via @plurnk/plurnk-mimetypes-embeddings). Runs in test:intg —
// semantics is NORMAL integration coverage, not a special live-only track; the
// model load is an accepted cost. The test builds its OWN embeddings-enabled
// Mimetypes, so DEFAULT_MIMETYPES's decline only affects tests that don't need
// the embedder.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

// This suite asserts REAL vector ranking, so it re-enables the embedder the Mock bootstrap turns off.
// --test-isolation=process scopes this to this file's process.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});
const semanticStmt = (target: UrlPath, query: string, k: number): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { marks: [1, k] }, body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});
const thresholdStmt = (
    target: UrlPath,
    query: string,
    threshold: number,
    first: number | null = null,
    last: number | null = null,
): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: {
        marks: first === null
            ? [threshold]
            : last === null
                ? [threshold, first]
                : [threshold, first, last],
    },
    body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});

test("~query ranks by real semantic similarity through the full pipeline", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `e2e-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const bodies = new Map([
            ["worker:///db.md", "the database connection failed with a timeout error"],
            ["worker:///sql.md", "sql server connection could not be established"],
            ["worker:///cake.md", "preheat the oven and frost the birthday cake"],
        ]);
        for (const [path, body] of bodies) {
            await new Worker().edit(editStmt(url(path.slice("worker:///".length)), body), ctx);
        }
        await SearchIndex.maintain(ctx);  // real embeddings stored via mimetypes-embeddings

        const r = await new Worker().find(semanticStmt(url(""), "database connection error", 2), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        // FIND <1,2> returns the two closest vectors. Cake is eligible for cosine
        // ranking too; it simply falls below both connection entries.
        assert.deepEqual(r.results.map((f) => f.path).sort(), ["worker:///db.md", "worker:///sql.md"]);
        assert.ok(!r.results.some((f) => f.path === "worker:///cake.md"), "the unrelated recipe never enters the ranking");
        assert.ok(r.results.every((row) => typeof row.channels === "object" && !("extent" in (row as object))), "~semantic FIND returns one catalog row per selected resource");
        for (const row of r.results) {
            const body = bodies.get(row.path);
            assert.ok(body !== undefined);
            assert.deepEqual(row.matches, [{
                region: {
                    startLine: 1,
                    startColumn: 1,
                    endLine: 1,
                    endColumn: [...body].length + 1,
                },
            }], "one-chunk semantic evidence is the exact indexed text region");
        }
    } finally { db.close(); }
});

test("{§derivation-dedup-parallel} multi-resource warming reports aggregate progress while a single resource stays silent", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `progress-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const seed = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        for (const name of ["a.md", "b.md", "c.md"]) await new Worker().edit(editStmt(url(name), `content for ${name} with words to embed`), seed);

        type Tel = { source?: string; kind?: string; message?: string; pathname?: string; completed?: number; total?: number };
        const events: Tel[] = [];
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, pushNotice: (e) => events.push(e as Tel) }));

        const progress = events.filter((e) => e.source === "engine:derivation" && e.kind === "embed_progress");
        assert.ok(progress.length > 0, "a 3-entry corpus pass emits progress notices (the ingest is visible, not frozen)");
        assert.ok(progress.every((e) => e.total === 3), "total reflects the corpus size (3 changed entries)");
        assert.ok(progress.every((e) => e.pathname === undefined && !e.message?.includes(".md")), "client progress is aggregate state, never a pathname ledger");
        assert.equal(progress.at(-1)?.completed, 3, "the final progress event reports completion");

        // A normal turn re-derives a single changed entry (total=1) → below the multi-entry
        // threshold → silent, so steady-state turns carry no per-turn progress noise.
        const events2: Tel[] = [];
        await new Worker().edit(editStmt(url("d.md"), "a single new entry changed this turn"), seed);
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes, pushNotice: (e) => events2.push(e as Tel) }));
        assert.equal(events2.filter((e) => e.kind === "embed_progress").length, 0, "a single-entry pass stays silent");
    } finally { db.close(); }
});

test("{§find-semantic-default-top-k}: a decimal threshold composes with FIND result positions", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `thresh-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await new Worker().edit(editStmt(url("db.md"), "the database connection failed with a timeout error"), ctx);
        await new Worker().edit(editStmt(url("sql.md"), "sql server connection could not be established"), ctx);
        await new Worker().edit(editStmt(url("cake.md"), "preheat the oven and frost the birthday cake"), ctx);
        await SearchIndex.maintain(ctx);
        const findCtx = (): ReturnType<typeof makeSchemeCtx> => makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0, mimetypes });

        // A low floor admits every positively related vector. Exhaustive cosine
        // recall may include a weakly positive document; lexical overlap is not
        // an eligibility gate.
        const low = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.05), findCtx());
        assert.equal(low.status, 200);
        const lowPaths = new Set(low.results.map((f) => f.path));
        assert.ok(lowPaths.has("worker:///db.md"));
        assert.ok(lowPaths.has("worker:///sql.md"));

        // A near-1 floor admits nothing - the threshold actually filters.
        const high = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.999), findCtx());
        assert.equal(high.status, 200);
        assert.deepEqual([...new Set(high.results.map((f) => f.path))], [], "a 0.999 floor filters everything out");

        const first = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.05, 1), findCtx());
        assert.deepEqual(
            first.results.map(({ path }) => path),
            low.results.slice(0, 1).map(({ path }) => path),
            "<threshold,1> selects result position 1 rather than defining a cap dialect",
        );

        const second = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.05, 2), findCtx());
        assert.deepEqual(
            second.results.map(({ path }) => path),
            low.results.slice(1, 2).map(({ path }) => path),
            "<threshold,2> selects result position 2",
        );

        const firstTwo = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.05, 1, 2), findCtx());
        assert.deepEqual(
            firstTwo.results.map(({ path }) => path),
            low.results.slice(0, 2).map(({ path }) => path),
            "<threshold,1,2> selects the inclusive result range",
        );

        const textShapedFind = await new Worker().find({
            ...thresholdStmt(url(""), "database connection error", 0.05),
            lineMarker: { marks: [0.05, 1, 1, 1, 1] },
        }, findCtx());
        assert.equal(
            textShapedFind.status,
            416,
            "semantic FIND rejects READ's four-coordinate text scope instead of reinterpreting it",
        );

        // A fractional value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const bad = await new Worker().find(thresholdStmt(url(""), "database connection error", 1.5), findCtx());
        assert.equal(bad.status, 416, "a fractional marker outside (0,1) is 416");
    } finally { db.close(); }
});


test("[#91] PLURNK_SERVICE_SEARCH_EXCLUDE applies only to file-scheme entries", async () => {
    const prev = process.env.PLURNK_SERVICE_SEARCH_EXCLUDE;
    process.env.PLURNK_SERVICE_SEARCH_EXCLUDE = "*/dist/*";
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `noembed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const identical = '{"name":"x","version":"24.18.0","packages":{"":{"deps":{"y":"1.0.0"}}}}';
        const pathname = "/repo/dist/index.json";
        await EntryCrud.writeEntry(pathname, {
            channels: { body: { content: identical, mimetype: "application/json" } },
            tags: [],
        }, ctx, "file");
        await EntryCrud.writeEntry(pathname, {
            channels: { body: { content: identical, mimetype: "application/json" } },
            tags: [],
        }, ctx, "https");
        await new Worker().edit(editStmt(url("notes.md"), "the database connection failed with a timeout"), ctx);
        await SearchIndex.maintain(ctx);
        const fileEntry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "file", pathname });
        const httpsEntry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "https", pathname });
        const notes = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/notes.md" });
        const fileVecs = await db.test_count_embeddings.get<{ n: number }>({ entry_id: fileEntry?.id ?? -1 });
        const httpsVecs = await db.test_count_embeddings.get<{ n: number }>({ entry_id: httpsEntry?.id ?? -1 });
        const noteVecs = await db.test_count_embeddings.get<{ n: number }>({ entry_id: notes?.id ?? -1 });
        assert.equal(fileVecs?.n, 0, "the file pathname matched the pattern — zero vectors");
        assert.ok((httpsVecs?.n ?? 0) > 0, "the identical pathname under HTTPS remains vector-searchable");
        assert.ok((noteVecs?.n ?? 0) > 0, "the unmatched entry embeds fully");
        const fts = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query: "version" });
        assert.equal(fts.filter((row) => row.pathname === pathname).length, 1, "only the HTTPS entry contributes the shared pathname to lexical search");
        const fileDisposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string }>({ entry_id: fileEntry?.id ?? -1 });
        const httpsDisposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string | null; deep_hash: string }>({ entry_id: httpsEntry?.id ?? -1 });
        assert.equal(fileDisposition?.disposition, "excluded");
        assert.equal(fileDisposition?.reason, "*/dist/*");
        assert.equal(httpsDisposition?.disposition, "vector", "identical bytes at a non-file pathname remain searchable");
        const readable = await EntryCrud.readEntry(pathname, ctx, "file");
        assert.equal(readable.entry?.channels.body?.content, identical, "search exclusion does not alter direct readability");
        // stamped: a second pass derives nothing (no eternal re-attempt of the suppressed entry)
        await SearchIndex.maintain(ctx);
        const fileVecs2 = await db.test_count_embeddings.get<{ n: number }>({ entry_id: fileEntry?.id ?? -1 });
        assert.equal(fileVecs2?.n, 0, "still zero after a second pump pass — classified once, skipped");
    } finally {
        db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEARCH_EXCLUDE; else process.env.PLURNK_SERVICE_SEARCH_EXCLUDE = prev;
    }
});

test("{§derivation-dedup-parallel}: the pump admits smallest-first without skipping a large outlier", async () => {
    // Pure scheduling: nothing skipped, nothing capped — the whale derives to full depth, LAST.
    // Proven by insertion order: embedding rowids are monotonic, so the small entries' vectors
    // must land before the big entry's despite the big entry being written first.
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
        const order = await db.test_embedding_insertion_order.all<{ pathname: string; first_rowid: number }>({});
        const byPath = new Map(order.map((o) => [o.pathname, o.first_rowid]));
        const whaleFirst = byPath.get("/whale.md") ?? -1;
        assert.ok((byPath.get("/minnow-a.md") ?? Infinity) < whaleFirst, "minnow-a embedded before the whale");
        assert.ok((byPath.get("/minnow-b.md") ?? Infinity) < whaleFirst, "minnow-b embedded before the whale");
    } finally { db.close(); }
});
