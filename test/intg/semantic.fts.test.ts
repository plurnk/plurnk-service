// ~semantic FTS half (#186) — the manifest-add hook indexes body content into
// entry_fts (the keyword/narrowing half of the fusion), gated by deep_hash so it
// re-indexes only on content change. (Cosine over embeddings — the precise half —
// lands when the embedding channel does.)

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntrySemantic from "../../src/schemes/_entry-semantic.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const fts = async (db: Db, sessionId: number, query: string): Promise<string[]> => {
    const rows = await (db.test_fts_search as PrepMethod).all<{ pathname: string }>({ session_id: sessionId, query });
    return rows.map((r) => r.pathname);
};

test("[#186-fts] manifest-add indexes body content into entry_fts; re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `fts-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Known().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await EntryManifest.buildManifestBody(ctx);

        assert.deepEqual(await fts(db, sessionId, "processPayment"), ["/pay.ts"]);
        assert.deepEqual(await fts(db, sessionId, "authenticate"), ["/auth.ts"]);
        assert.deepEqual(await fts(db, sessionId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Known().edit(editStmt(url("pay.ts"), "export function refund() {}\n"), ctx);
        await EntryManifest.buildManifestBody(ctx);
        assert.deepEqual(await fts(db, sessionId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, sessionId, "refund"), ["/pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, sessionId, "authenticate"), ["/auth.ts"], "unchanged entry stays indexed");
    } finally { db.close(); }
});

test("[#186-cosine] the cosine SqlRite function ranks Float32-BLOB vectors", async () => {
    const db = await openMigrated();
    try {
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);
        const sim = async (a: number[], b: number[]): Promise<number> => {
            const r = await (db.test_cosine as PrepMethod).get<{ sim: number }>({ a: blob(a), b: blob(b) });
            assert.ok(r, "cosine returned a row");
            return r.sim;
        };
        assert.equal(Math.round(await sim([1, 0, 0], [1, 0, 0])), 1, "identical → 1");
        assert.equal(await sim([1, 0, 0], [0, 1, 0]), 0, "orthogonal → 0");
        assert.ok((await sim([1, 0, 0], [0.9, 0.1, 0.05])) > 0.98, "near-parallel → ~1");
    } finally { db.close(); }
});

test("[#186-fusion] semantic_rank fuses FTS narrowing with cosine ranking", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `fusion-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);

        // Three "payment" entries (FTS-match) with distinct embeddings, plus an "auth"
        // entry whose embedding is a PERFECT cosine match but whose content does NOT
        // match the keyword — the narrow must exclude it (FTS before cosine).
        const ENTRIES: ReadonlyArray<readonly [string, string, number[]]> = [
            ["pay1.ts", "process payment one", [1, 0, 0]],
            ["pay2.ts", "process payment two", [0.9, 0.1, 0]],
            ["pay3.ts", "process payment three", [0, 1, 0]],
            ["auth.ts", "authenticate the user", [1, 0, 0]],
        ];
        for (const [p, c] of ENTRIES) await new Known().edit(editStmt(url(p), c), ctx);
        await EntryManifest.buildManifestBody(ctx);  // FTS-indexes every entry
        for (const [p, , v] of ENTRIES) {
            const e = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: `/${p}` });
            assert.ok(e);
            // buildManifestBody stored a real one-chunk embedding; clear it and seed
            // the deterministic test vector as the entry's single chunk.
            await (db.embedding_delete as PrepMethod).run({ entry_id: e.id });
            await (db.embedding_set as PrepMethod).run({ entry_id: e.id, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob(v), embedding_model: "test-model" });
        }

        const r = await (db.semantic_rank as PrepMethod).all<{ pathname: string }>({
            fts_query: "payment", session_id: sessionId, scheme: "known",
            query_vector: blob([1, 0, 0]), embedding_model: "test-model", k: 2,
        });
        assert.deepEqual(r.map((x) => x.pathname), ["/pay1.ts", "/pay2.ts"],
            "FTS narrows to payment entries; cosine ranks them; auth (perfect cosine, no keyword) excluded by the narrow");
    } finally { db.close(); }
});

test("[#chunk-maxpool] semantic_rank_threshold max-pools chunks — a hit in a non-first chunk clears the floor", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `maxpool-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);
        // Both FTS-match "payment". doc.ts gets two chunks — first orthogonal to the
        // query, second a PERFECT match (the passage truncation would hide). other.ts
        // gets only an orthogonal chunk.
        await new Known().edit(editStmt(url("doc.ts"), "alpha payment beta\nmore text here\nthe needle payment"), ctx);
        await new Known().edit(editStmt(url("other.ts"), "payment unrelated text"), ctx);
        await EntryManifest.buildManifestBody(ctx);
        const idOf = async (p: string): Promise<number> => {
            const e = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: p });
            assert.ok(e, `entry ${p} found`);
            return e.id;
        };
        const doc = await idOf("/doc.ts");
        const other = await idOf("/other.ts");
        for (const id of [doc, other]) await (db.embedding_delete as PrepMethod).run({ entry_id: id });
        await (db.embedding_set as PrepMethod).run({ entry_id: doc, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });
        await (db.embedding_set as PrepMethod).run({ entry_id: doc, chunk_seq: 1, line_start: 3, line_end: 3, vector: blob([1, 0, 0]), embedding_model: "m" });
        await (db.embedding_set as PrepMethod).run({ entry_id: other, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });

        const r = await (db.semantic_rank_threshold as PrepMethod).all<{ pathname: string }>({
            fts_query: "payment", session_id: sessionId, scheme: "known",
            query_vector: blob([1, 0, 0]), embedding_model: "m", threshold: 0.9, cap: -1,
        });
        assert.deepEqual(r.map((x) => x.pathname), ["/doc.ts"],
            "doc clears the 0.9 floor via its second chunk (cosine 1) — its first chunk (0) alone would not; other (low-only) excluded");
    } finally { db.close(); }
});

test("[#semantic-e2e] chunked ~query full pipeline: tile → embed → store → max-pool rank finds an entry via a deep chunk", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `e2e-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        // Controlled embedder: a small window + word tokenizer to force tiling, and a
        // deterministic vector "near" the query ONLY for the chunk holding the concept.
        // (The fast tier declines the real model; real-model ~query is covered in
        // semantic.test.ts — this asserts the chunked CHAIN: derive → store → rank.)
        const wc = (t: string) => (t.match(/\S+/g) ?? []).length;
        const vec = (t: string) => new Uint8Array(new Float32Array(t.includes("photosynthesis") ? [1, 0, 0] : [0, 1, 0]).buffer);
        const embedder = {
            process: async (input: { content: string }) => ({ embedding: vec(input.content), embeddingModel: "stub@e2e" }),
            embedderInfo: () => ({ maxTokens: 30, countTokens: wc }),
        } as unknown as Mimetypes;
        // Filler, then a distinctive late line → the concept lands in a NON-first chunk.
        const content = Array.from({ length: 40 }, () => "common filler words around here").join(" ") +
            "\nchloroplasts drive photosynthesis in green plants";
        await new Known().edit(editStmt(url("bio.md"), content), ctx);
        const e = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme: "known", pathname: "/bio.md" });
        assert.ok(e);
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(embedder, content, "text/markdown", [], undefined, undefined);
        assert.ok(chunks.length > 1, `the body tiled into multiple chunks (got ${chunks.length})`);
        await EntrySemantic.indexFts(db, e.id, content);
        await EntrySemantic.indexEmbedding(db, e.id, chunks, model);
        const r = await EntrySemantic.rankSemantic(db, sessionId, "known", embedder, "photosynthesis chloroplasts", { first: 5, last: null });
        assert.ok(r.pathnames.includes("/bio.md"), "the deep chunk was embedded + stored, and ~query retrieved its entry via max-pool");
    } finally { db.close(); }
});

test("[#semantic-json-tile] deriveEmbeddings embeds a tiled entry's chunks as text — a fragment is never re-validated under the entry mimetype", async () => {
    // A tile of a JSON document is an invalid JSON fragment. The real framework process()
    // validates application/json and throws on it — which crashed every turn that held a
    // JSON entry large enough to tile. The default intg harness declines the embedder, so
    // the chunking path never ran in tests; this stub mimics the handler's validation to
    // exercise it. deriveEmbeddings must hand each tile over as text, not the entry mimetype.
    const wc = (t: string) => (t.match(/\S+/g) ?? []).length;
    const hints: string[] = [];
    const embedder = {
        process: async (input: { content: string; hint: string }) => {
            hints.push(input.hint);
            if (input.hint === "application/json") JSON.parse(input.content); // throws on a partial tile
            return { embedding: new Uint8Array(new Float32Array([1, 0]).buffer), embeddingModel: "stub" };
        },
        embedderInfo: () => ({ maxTokens: 20, countTokens: wc }),
    } as unknown as Mimetypes;

    const json = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, items: [1, 2, 3, 4, 5, 6, 7, 8] }, null, 2);
    const { chunks } = await EntrySemantic.deriveEmbeddings(embedder, json, "application/json", [], undefined, undefined);
    assert.ok(chunks.length > 1, `the JSON body tiled into multiple chunks (got ${chunks.length})`);
    assert.ok(hints.length > 0 && hints.every((h) => h === "text/plain"), `every chunk embeds as text/plain, not the entry mimetype; got ${JSON.stringify([...new Set(hints)])}`);
});

