// ~query semantic search end-to-end with the REAL embedding model
// (all-MiniLM-L6-v2 via @plurnk/plurnk-mimetypes-embeddings). Runs in test:intg —
// semantics is NORMAL integration coverage, not a special live-only track; the
// model load is an accepted cost. The test builds its OWN embeddings-enabled
// Mimetypes, so DEFAULT_MIMETYPES's decline only affects tests that don't need
// the embedder.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, MatcherBody, UrlPath } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

// This suite asserts REAL vector ranking, so it re-enables the embedder the fast lane turns off
// (.env.test PLURNK_SERVICE_EMBED_DISABLE=1). --test-isolation=process scopes this to this file's process.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});
const semanticStmt = (target: UrlPath, query: string, k: number): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { marks: [k] }, body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});
// #209 — decimal <0.x> (+ optional ,N cap) = similarity threshold, not top-K.
const thresholdStmt = (target: UrlPath, query: string, threshold: number, cap: number | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: { marks: cap === null ? [threshold] : [threshold, cap] }, body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});

test("[#186-semantic-e2e] ~query ranks by REAL semantic similarity (full pipeline, real model)", async () => {
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
        // Top-2 returns the two closest vectors. Cake is eligible for cosine
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

test("[#272] the derivation pump emits throttled embed_progress notices for a multi-entry corpus pass, silent for a single entry", async () => {
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

test("[#209-semantic-threshold] ~query <0.x> form-dispatches to a similarity threshold, not top-K", async () => {
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

        // A near-1 floor admits nothing — the threshold actually filters; it isn't a top-K in disguise.
        const high = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.999), findCtx());
        assert.equal(high.status, 200);
        assert.deepEqual([...new Set(high.results.map((f) => f.path))], [], "a 0.999 floor filters everything out");

        // <0.05,1> — threshold + result cap → at most one, the closest.
        const capped = await new Worker().find(thresholdStmt(url(""), "database connection error", 0.05, 1), findCtx());
        assert.equal(capped.results.length, 1, "the ,N cap bounds the threshold set");

        // A fractional value outside (0,1) is a nonsense result-marker → 416, never coerced.
        const bad = await new Worker().find(thresholdStmt(url(""), "database connection error", 1.5), findCtx());
        assert.equal(bad.status, 416, "a fractional marker outside (0,1) is 416");
    } finally { db.close(); }
});


test("[#47] PLURNK_MIMETYPES_SEARCH_EXCLUDE applies to project files, not arbitrary scheme paths", async () => {
    // The operator's decision table (mimetypes 0.18.1 §21) consumed in the pump: the knob IS the
    // classification — a lockfile-class entry remains directly readable but
    // contributes no graph, FTS, or vectors. No caps, no heuristics in code.
    const prev = process.env.PLURNK_MIMETYPES_SEARCH_EXCLUDE;
    process.env.PLURNK_MIMETYPES_SEARCH_EXCLUDE = "*/dist/*";
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `noembed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const identical = '{"name":"x","version":"24.18.0","packages":{"":{"deps":{"y":"1.0.0"}}}}';
        await EntryCrud.writeEntry("/repo/dist/index.json", {
            channels: { body: { content: identical, mimetype: "application/json" } },
            tags: [],
        }, ctx, "file");
        await EntryCrud.writeEntry("/example.com/dist/index.json", {
            channels: { body: { content: identical, mimetype: "application/json" } },
            tags: [],
        }, ctx, "https");
        await new Worker().edit(editStmt(url("notes.md"), "the database connection failed with a timeout"), ctx);
        await SearchIndex.maintain(ctx);
        const lock = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/repo/dist/index.json" });
        const notes = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/notes.md" });
        const fixture = await db.test_entries_by_pathname.get<{ id: number }>({ pathname: "/example.com/dist/index.json" });
        const lockVecs = await db.test_count_embeddings.get<{ n: number }>({ entry_id: lock?.id ?? -1 });
        const noteVecs = await db.test_count_embeddings.get<{ n: number }>({ entry_id: notes?.id ?? -1 });
        assert.equal(lockVecs?.n, 0, "the lockfile matched the pattern — zero vectors");
        assert.ok((noteVecs?.n ?? 0) > 0, "the unmatched entry embeds fully");
        const lockFts = await db.test_fts_search.all({ workspace_id: workspaceId, query: "version" });
        assert.ok(!lockFts.some((row) => (row as { pathname: string }).pathname === "/repo/dist/index.json"), "excluded project content contributes no lexical result");
        assert.ok(lockFts.some((row) => (row as { pathname: string }).pathname === "/example.com/dist/index.json"), "the same resource path under HTTPS remains searchable");
        const disposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string }>({ entry_id: lock?.id ?? -1 });
        const includedDisposition = await db.test_derivation_disposition.get<{ disposition: string; reason: string | null; deep_hash: string }>({ entry_id: fixture?.id ?? -1 });
        assert.equal(disposition?.disposition, "excluded");
        assert.equal(disposition?.reason, "*/dist/*");
        assert.equal(includedDisposition?.disposition, "vector", "identical bytes at a non-file resource path remain searchable");
        // stamped: a second pass derives nothing (no eternal re-attempt of the suppressed entry)
        await SearchIndex.maintain(ctx);
        const lockVecs2 = await db.test_count_embeddings.get<{ n: number }>({ entry_id: lock?.id ?? -1 });
        assert.equal(lockVecs2?.n, 0, "still zero after a second pump pass — classified once, skipped");
    } finally {
        db.close();
        if (prev === undefined) delete process.env.PLURNK_MIMETYPES_SEARCH_EXCLUDE; else process.env.PLURNK_MIMETYPES_SEARCH_EXCLUDE = prev;
    }
});

test("[#337] the pump derives smallest-first — a fat outlier never clogs the corpus warm-up", async () => {
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
