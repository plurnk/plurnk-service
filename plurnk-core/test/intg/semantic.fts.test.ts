// {§persistent-search-index}, {§find-semantic-selection}. FTS is the
// explicit no-embedder fallback;
// when vectors exist, exhaustive cosine ranking has no lexical eligibility gate.

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import assert from "node:assert/strict";
import type { FindStatement, LineMarker, MatcherBody, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import type { Db } from "../../src/core/Db.ts";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntrySemantic from "../../src/schemes/_entry-semantic.ts";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, mimetypesFixture } from "./_helpers.ts";
import { resourcePaths } from "./_find.ts";

// Despite the name, this suite includes chunked-embedding e2e cases that assert REAL vector ranking —
// re-enable the embedder the Mock bootstrap turns off; per-file isolation.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});
const semanticStmt = (target: UrlPath, query: string, last: number | null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target,
    lineMarker: last === null ? null : { marks: [1, last] },
    body: { dialect: "semantic", raw: query } as MatcherBody,
    position: { line: 1, column: 1 },
});

const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

const searchCandidates = async (db: Db, workspaceId: number): Promise<Array<{ key: string; deepHash: string }>> => {
    const rows = await db.test_entries_with_hash_by_scheme_prefix.all<{ pathname: string; deep_hash: string }>({
        workspace_id: workspaceId,
        scheme: "worker",
        prefix: "/%",
    });
    return rows.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash }));
};

test("persistent-index maintenance indexes body content into derivation_fts and re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Worker().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await SearchIndex.maintain(ctx);

        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Worker().edit(editStmt(url("pay.ts"), "export function refund() {}\n", fullReplace), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, workspaceId, "refund"), ["/pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "unchanged entry stays indexed");
    } finally { db.close(); }
});

test("semantic artifacts index the exact READ body rather than a hidden mimetype projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-readable-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(
            editStmt(url("authored.html"), "<main data-rawonlymarker=\"yes\">Visible prose</main>\n"),
            ctx,
        );
        await SearchIndex.maintain(ctx);

        assert.deepEqual(
            await fts(db, workspaceId, "rawonlymarker"),
            ["/authored.html"],
            "an authored HTML file is indexed in the same verbatim coordinate space READ exposes",
        );
    } finally { db.close(); }
});

test("the cosine SqlRite function ranks canonical wire vectors", async () => {
    const db = await openMigrated();
    try {
        const blob = (arr: number[]) => Buffer.from(EmbeddingVector.encode(arr));
        const sim = async (a: number[], b: number[]): Promise<number> => {
            const r = await db.test_cosine.get<{ sim: number }>({ a: blob(a), b: blob(b) });
            assert.ok(r, "cosine returned a row");
            return r.sim;
        };
        assert.equal(Math.round(await sim([1, 0, 0], [1, 0, 0])), 1, "identical → 1");
        assert.equal(await sim([1, 0, 0], [0, 1, 0]), 0, "orthogonal → 0");
        assert.ok((await sim([1, 0, 0], [0.9, 0.1, 0.05])) > 0.98, "near-parallel → ~1");
    } finally { db.close(); }
});

test("semantic_rank searches every vector without a lexical gate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fusion-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const blob = (arr: number[]) => Buffer.from(EmbeddingVector.encode(arr));

        // The auth entry has no query words but is the strongest semantic match.
        // A lexical prefilter would incorrectly make it invisible.
        const ENTRIES: ReadonlyArray<readonly [string, string, number[]]> = [
            ["pay1.ts", "process payment one", [0.9, 0.1, 0]],
            ["pay2.ts", "process payment two", [0.8, 0.2, 0]],
            ["pay3.ts", "process payment three", [0, 1, 0]],
            ["auth.ts", "authenticate the user", [1, 0, 0]],
        ];
        for (const [p, c] of ENTRIES) await new Worker().edit(editStmt(url(p), c), ctx);
        await SearchIndex.maintain(ctx);  // FTS-indexes every entry
        for (const [p, , v] of ENTRIES) {
            const e = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: `/${p}` });
            assert.ok(e);
            const derivation = await db.test_derivation_for_entry.get<{ id: number }>({ entry_id: e.id });
            assert.ok(derivation);
            // SearchIndex.maintain stored a real one-chunk embedding; clear it and seed
            // the deterministic test vector as the artifact's single chunk.
            await db.embedding_delete.run({ derivation_id: derivation.id });
            await db.embedding_set.run({ derivation_id: derivation.id, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob(v), embedding_model: "test-model" });
        }

        const r = await db.semantic_rank_candidates.all<{ key: string }>({
            candidates: JSON.stringify(await searchCandidates(db, workspaceId)),
            query_vector: blob([1, 0, 0]),
            embedding_model: "test-model",
            k: 1,
        });
        assert.deepEqual(r.map((x) => x.key), ["/auth.ts"],
            "the strongest semantic match remains visible despite zero lexical overlap");
    } finally { db.close(); }
});

test("[#chunk-maxpool] semantic_rank_threshold max-pools chunks — a hit in a non-first chunk clears the floor", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `maxpool-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const blob = (arr: number[]) => Buffer.from(EmbeddingVector.encode(arr));
        // Both FTS-match "payment". doc.ts gets two chunks — first orthogonal to the
        // query, second a PERFECT match (the passage truncation would hide). other.ts
        // gets only an orthogonal chunk.
        await new Worker().edit(editStmt(url("doc.ts"), "alpha payment beta\nmore text here\nthe needle payment"), ctx);
        await new Worker().edit(editStmt(url("other.ts"), "payment unrelated text"), ctx);
        await SearchIndex.maintain(ctx);
        const derivationOf = async (p: string): Promise<number> => {
            const e = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: p });
            assert.ok(e, `entry ${p} found`);
            const derivation = await db.test_derivation_for_entry.get<{ id: number }>({ entry_id: e.id });
            assert.ok(derivation, `entry ${p} has a complete derivation`);
            return derivation.id;
        };
        const doc = await derivationOf("/doc.ts");
        const other = await derivationOf("/other.ts");
        for (const id of [doc, other]) await db.embedding_delete.run({ derivation_id: id });
        await db.embedding_set.run({ derivation_id: doc, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });
        await db.embedding_set.run({ derivation_id: doc, chunk_seq: 1, line_start: 3, line_end: 3, vector: blob([1, 0, 0]), embedding_model: "m" });
        await db.embedding_set.run({ derivation_id: other, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });

        const r = await db.semantic_rank_candidates_threshold.all<{ key: string }>({
            candidates: JSON.stringify(await searchCandidates(db, workspaceId)),
            query_vector: blob([1, 0, 0]),
            embedding_model: "m",
            threshold: 0.9,
            cap: -1,
        });
        assert.deepEqual(r.map((x) => x.key), ["/doc.ts"],
            "doc clears the 0.9 floor via its second chunk (cosine 1) — its first chunk (0) alone would not; other (low-only) excluded");
    } finally { db.close(); }
});

test("[#semantic-e2e] chunked ~query full pipeline: tile → embed → store → max-pool rank finds an entry via a deep chunk", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `e2e-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        // Controlled embedder: a small window + word tokenizer to force tiling, and a
        // deterministic vector "near" the query ONLY for the chunk holding the concept.
        // (The fast tier declines the real model; real-model ~query is covered in
        // semantic.test.ts — this asserts the chunked CHAIN: derive → store → rank.)
        const wc = (t: string) => (t.match(/\S+/g) ?? []).length;
        const vec = (t: string) => EmbeddingVector.encode(t.includes("photosynthesis") ? [1, 0, 0] : [0, 1, 0]);
        const embedder = mimetypesFixture({
            // Queries use process; the indexed chunk corpus uses embedBatch.
            // {§mimetype-embedding}
            process: async (input: { content: string }) => ({ embedding: vec(input.content), embeddingModel: "stub@e2e" }),
            embedBatch: async (texts: readonly string[]) => texts.map(vec),
            embedderInfo: () => ({ contextWindow: 30, countTokens: wc, model: "stub@e2e" }),
        });
        // Filler, then a distinctive late line → the concept lands in a NON-first chunk.
        const content = Array.from({ length: 40 }, () => "common filler words around here").join(" ") +
            "\nchloroplasts drive photosynthesis in green plants";
        await new Worker().edit(editStmt(url("bio.md"), content), ctx);
        const e = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/bio.md" });
        assert.ok(e);
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: embedder }));
        const stored = await db.test_count_embeddings.get<{ n: number }>({ entry_id: e.id });
        assert.ok((stored?.n ?? 0) > 1, `the body tiled into multiple stored chunks (got ${stored?.n ?? 0})`);
        const r = await EntrySemantic.rankCandidates(
            db,
            await searchCandidates(db, workspaceId),
            embedder,
            "photosynthesis chloroplasts",
            { threshold: null },
        );
        const hit = r.results.find((x) => x.key === "/bio.md");
        assert.ok(hit, "the deep chunk was embedded + stored, and ~query retrieved its entry via max-pool");
        assert.ok(hit.lineStart >= 1 && hit.lineEnd >= hit.lineStart, `the winning chunk's span rides out (got ${hit.lineStart}-${hit.lineEnd})`);
    } finally { db.close(); }
});

test("semantic FIND maps a terminal-newline chunk to an addressable TextRegion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `newline-region-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const vector = EmbeddingVector.encode([1, 0]);
        const embedder = mimetypesFixture({
            process: async () => ({ embedding: vector, embeddingModel: "stub@newline" }),
            embedBatch: async (texts: readonly string[]) => texts.map(() => vector),
            embedderInfo: () => ({
                contextWindow: 100,
                countTokens: (text: string) => (text.match(/\S+/g) ?? []).length,
                model: "stub@newline",
            }),
        });
        const seed = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(
            editStmt(url("todo.ts"), "export const ready = true;\n// TODO audit this\n"),
            seed,
        );
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: embedder });
        await SearchIndex.maintain(ctx);

        const result = await new Worker().find(
            semanticStmt(url("todo.ts"), "TODO audit", 1),
            ctx,
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.results, [{
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 2,
                endColumn: 19,
            },
        }]);
    } finally { db.close(); }
});

test("{§mimetype-embedding} tiled JSON embeds as raw fragments without format revalidation", async () => {
    // The throwing process stub detects any regression from the raw batch seam
    // to format-validating per-fragment projection.
    const wc = (t: string) => (t.match(/\S+/g) ?? []).length;
    const batched: string[][] = [];
    const embedder = mimetypesFixture({
        process: async (input: { content: string; hint: string }) => {
            if (input.hint === "application/json") JSON.parse(input.content); // throws on a partial tile — must NEVER be hit for chunks
            return { embedding: EmbeddingVector.encode([1, 0]), embeddingModel: "stub" };
        },
        embedBatch: async (texts: readonly string[]) => { batched.push([...texts]); return texts.map(() => EmbeddingVector.encode([1, 0])); },
        embedderInfo: () => ({ contextWindow: 20, countTokens: wc, model: "stub" }),
    });

    const json = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, items: [1, 2, 3, 4, 5, 6, 7, 8] }, null, 2);
    const plan = await EntrySemantic.prepareEmbeddings(embedder);
    const { chunks } = await EntrySemantic.deriveEmbeddings(plan, json, [], undefined, undefined);
    assert.ok(chunks.length > 1, `the JSON body tiled into multiple chunks (got ${chunks.length})`);
    assert.equal(batched.length, 1, "the chunk corpus embeds in ONE embedBatch call — never the per-chunk mimetype process");
    assert.equal(batched[0].length, chunks.length, "the single batch carried every tile's raw text (no JSON re-validation)");
});

test("[#fts-fallback] no embedder uses FTS for unthresholded rank; <0.x> stays 501", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-fallback-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        // "payment" twice in heavy, once in light; auth has none → the keyword narrow excludes it.
        const mk = async (p: string, content: string): Promise<void> => {
            await new Worker().edit(editStmt(url(p), content), ctx);
        };
        await mk("heavy.ts", "payment refund payment\nmore");
        await mk("light.ts", "payment once");
        await mk("auth.ts", "authenticate user");
        // No embedder: process() yields no embedding channel → the fallback fires.
        const noEmbedder = mimetypesFixture({
            process: async () => ({}),
            embedderInfo: () => null,
        });
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }));
        const candidates = await searchCandidates(db, workspaceId);

        const ranked = await EntrySemantic.rankCandidates(db, candidates, noEmbedder, "payment", { threshold: null });
        assert.equal(ranked.status, 200, "no embedder retains the unthresholded ranked path");
        assert.deepEqual(ranked.results.map((x) => x.key), ["/heavy.ts", "/light.ts"],
            "BM25 ranks heavy (two hits) above light (one); auth (no keyword) excluded by the narrow");
        const heavy = ranked.results.find((x) => x.key === "/heavy.ts");
        assert.ok(heavy && heavy.lineStart === 1 && heavy.lineEnd === 2, `whole-entry span, no chunk vectors (got ${heavy?.lineStart}-${heavy?.lineEnd})`);

        const firstTwo = await new Worker().find(
            semanticStmt(url(""), "payment", 2),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }),
        );
        assert.deepEqual(resourcePaths(firstTwo), ["worker:///heavy.ts", "worker:///light.ts"]);
        const second = await new Worker().find(
            {
                ...semanticStmt(url(""), "payment", 2),
                lineMarker: { marks: [2] },
            },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }),
        );
        assert.deepEqual(
            resourcePaths(second),
            ["worker:///light.ts"],
            "semantic FIND <2> selects ranked result 2 instead of returning the first two",
        );

        const exactMiss = await new Worker().find(
            semanticStmt(url("auth.ts"), "payment", null),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }),
        );
        assert.equal(exactMiss.status, 204);
        assert.deepEqual(exactMiss.results, [],
            "semantic ranking is constrained by the exact target before ranking — matches elsewhere never leak in");
        const exactHit = await new Worker().find(
            semanticStmt(url("heavy.ts"), "payment", null),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }),
        );
        assert.equal(exactHit.status, 200);
        assert.equal(exactHit.matchingPathCount, 1, "an exact target ranks only that entry");
        assert.deepEqual(exactHit.results, [{
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 2,
                endColumn: 5,
            },
        }], "FTS fallback evidence identifies the exact whole-entry searchable region");

        await mk("cr.ts", "payment\ragain\r");
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }));
        const crHit = await new Worker().find(
            semanticStmt(url("cr.ts"), "payment", null),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }),
        );
        assert.deepEqual(crHit.results, [{
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 2,
                endColumn: 6,
            },
        }], "FTS fallback uses the universal CR/CRLF/LF physical-line model");

        // The similarity-threshold form needs a cosine score the FTS half can't supply.
        const thresh = await EntrySemantic.rankCandidates(db, candidates, noEmbedder, "payment", { threshold: 0.5 });
        assert.equal(thresh.status, 501, "the <0.x> threshold form is cosine-intrinsic → 501 without an embedder");
    } finally { db.close(); }
});
