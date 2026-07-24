// Semantic derivation coverage: FTS is the explicit no-embedder fallback;
// when vectors exist, exhaustive cosine ranking has no lexical eligibility gate.

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import EntrySemantic from "../../src/schemes/_entry-semantic.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

// Despite the name, this suite includes chunked-embedding e2e cases that assert REAL vector ranking —
// re-enable the embedder the fast lane turns off (.env.test PLURNK_SERVICE_EMBED_DISABLE=1); per-file isolation.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await (db.test_fts_search as PrepMethod).all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("[#186-fts] manifest-add indexes body content into entry_fts; re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Worker().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await EntryManifest.maintainDerivations(ctx);

        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Worker().edit(editStmt(url("pay.ts"), "export function refund() {}\n", fullReplace), ctx);
        await EntryManifest.maintainDerivations(ctx);
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, workspaceId, "refund"), ["/pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "unchanged entry stays indexed");
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

test("[#186-cosine-recall] semantic_rank searches every vector without a lexical gate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fusion-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);

        // The auth entry has no query words but is the strongest semantic match.
        // A lexical prefilter would incorrectly make it invisible.
        const ENTRIES: ReadonlyArray<readonly [string, string, number[]]> = [
            ["pay1.ts", "process payment one", [0.9, 0.1, 0]],
            ["pay2.ts", "process payment two", [0.8, 0.2, 0]],
            ["pay3.ts", "process payment three", [0, 1, 0]],
            ["auth.ts", "authenticate the user", [1, 0, 0]],
        ];
        for (const [p, c] of ENTRIES) await new Worker().edit(editStmt(url(p), c), ctx);
        await EntryManifest.maintainDerivations(ctx);  // FTS-indexes every entry
        for (const [p, , v] of ENTRIES) {
            const e = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: `/${p}` });
            assert.ok(e);
            const derivation = await (db.test_derivation_for_entry as PrepMethod).get<{ id: number }>({ entry_id: e.id });
            assert.ok(derivation);
            // maintainDerivations stored a real one-chunk embedding; clear it and seed
            // the deterministic test vector as the artifact's single chunk.
            await (db.embedding_delete as PrepMethod).run({ derivation_id: derivation.id });
            await (db.embedding_set as PrepMethod).run({ derivation_id: derivation.id, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob(v), embedding_model: "test-model" });
        }

        const r = await (db.semantic_rank as PrepMethod).all<{ pathname: string }>({
            workspace_id: workspaceId, scheme: "worker",
            query_vector: blob([1, 0, 0]), embedding_model: "test-model", k: 1,
        });
        assert.deepEqual(r.map((x) => x.pathname), ["/auth.ts"],
            "the strongest semantic match remains visible despite zero lexical overlap");
    } finally { db.close(); }
});

test("[#chunk-maxpool] semantic_rank_threshold max-pools chunks — a hit in a non-first chunk clears the floor", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `maxpool-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const blob = (arr: number[]) => Buffer.from(new Float32Array(arr).buffer);
        // Both FTS-match "payment". doc.ts gets two chunks — first orthogonal to the
        // query, second a PERFECT match (the passage truncation would hide). other.ts
        // gets only an orthogonal chunk.
        await new Worker().edit(editStmt(url("doc.ts"), "alpha payment beta\nmore text here\nthe needle payment"), ctx);
        await new Worker().edit(editStmt(url("other.ts"), "payment unrelated text"), ctx);
        await EntryManifest.maintainDerivations(ctx);
        const derivationOf = async (p: string): Promise<number> => {
            const e = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: p });
            assert.ok(e, `entry ${p} found`);
            const derivation = await (db.test_derivation_for_entry as PrepMethod).get<{ id: number }>({ entry_id: e.id });
            assert.ok(derivation, `entry ${p} has a complete derivation`);
            return derivation.id;
        };
        const doc = await derivationOf("/doc.ts");
        const other = await derivationOf("/other.ts");
        for (const id of [doc, other]) await (db.embedding_delete as PrepMethod).run({ derivation_id: id });
        await (db.embedding_set as PrepMethod).run({ derivation_id: doc, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });
        await (db.embedding_set as PrepMethod).run({ derivation_id: doc, chunk_seq: 1, line_start: 3, line_end: 3, vector: blob([1, 0, 0]), embedding_model: "m" });
        await (db.embedding_set as PrepMethod).run({ derivation_id: other, chunk_seq: 0, line_start: 1, line_end: 1, vector: blob([0, 1, 0]), embedding_model: "m" });

        const r = await (db.semantic_rank_threshold as PrepMethod).all<{ pathname: string }>({
            workspace_id: workspaceId, scheme: "worker",
            query_vector: blob([1, 0, 0]), embedding_model: "m", threshold: 0.9, cap: -1,
        });
        assert.deepEqual(r.map((x) => x.pathname), ["/doc.ts"],
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
        const vec = (t: string) => new Uint8Array(new Float32Array(t.includes("photosynthesis") ? [1, 0, 0] : [0, 1, 0]).buffer);
        const embedder = {
            // process embeds the QUERY vector (rankSemantic); embedBatch embeds the chunk corpus (deriveEmbeddings, #272).
            process: async (input: { content: string }) => ({ embedding: vec(input.content), embeddingModel: "stub@e2e" }),
            embedBatch: async (texts: readonly string[]) => texts.map(vec),
            embedderInfo: () => ({ maxTokens: 30, countTokens: wc, model: "stub@e2e" }),
        } as unknown as Mimetypes;
        // Filler, then a distinctive late line → the concept lands in a NON-first chunk.
        const content = Array.from({ length: 40 }, () => "common filler words around here").join(" ") +
            "\nchloroplasts drive photosynthesis in green plants";
        await new Worker().edit(editStmt(url("bio.md"), content), ctx);
        const e = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/bio.md" });
        assert.ok(e);
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: embedder }));
        const stored = await (db.test_count_embeddings as PrepMethod).get<{ n: number }>({ entry_id: e.id });
        assert.ok((stored?.n ?? 0) > 1, `the body tiled into multiple stored chunks (got ${stored?.n ?? 0})`);
        const r = await EntrySemantic.rankSemantic(db, workspaceId, "worker", embedder, "photosynthesis chloroplasts", { first: 5, last: null });
        const hit = r.results.find((x) => x.pathname === "/bio.md");
        assert.ok(hit, "the deep chunk was embedded + stored, and ~query retrieved its entry via max-pool");
        assert.ok(hit.lineStart >= 1 && hit.lineEnd >= hit.lineStart, `the winning chunk's span rides out (got ${hit.lineStart}-${hit.lineEnd})`);
    } finally { db.close(); }
});

test("[#semantic-json-tile] deriveEmbeddings embeds tiled chunks via embedBatch (raw text) — a JSON fragment is never re-validated under the entry mimetype (#272)", async () => {
    // A tile of a JSON document is an invalid JSON fragment. Embedding it under application/json
    // would re-validate and throw on the partial — which crashed every turn that held a JSON entry
    // large enough to tile. embedBatch takes RAW TEXT (no mimetype path to validate against), so the
    // hazard is structurally gone: the chunk corpus goes through embedBatch, never the JSON-validating
    // process. The process stub here throws on application/json precisely to catch a regression to it.
    const wc = (t: string) => (t.match(/\S+/g) ?? []).length;
    const batched: string[][] = [];
    const embedder = {
        process: async (input: { content: string; hint: string }) => {
            if (input.hint === "application/json") JSON.parse(input.content); // throws on a partial tile — must NEVER be hit for chunks
            return { embedding: new Uint8Array(new Float32Array([1, 0]).buffer), embeddingModel: "stub" };
        },
        embedBatch: async (texts: readonly string[]) => { batched.push([...texts]); return texts.map(() => new Uint8Array(new Float32Array([1, 0]).buffer)); },
        embedderInfo: () => ({ maxTokens: 20, countTokens: wc, model: "stub" }),
    } as unknown as Mimetypes;

    const json = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, items: [1, 2, 3, 4, 5, 6, 7, 8] }, null, 2);
    const { chunks } = await EntrySemantic.deriveEmbeddings(embedder, json, [], undefined, undefined);
    assert.ok(chunks.length > 1, `the JSON body tiled into multiple chunks (got ${chunks.length})`);
    assert.equal(batched.length, 1, "the chunk corpus embeds in ONE embedBatch call — never the per-chunk mimetype process");
    assert.equal(batched[0].length, chunks.length, "the single batch carried every tile's raw text (no JSON re-validation)");
});

test("[#fts-fallback] no embedder → ~query<K> degrades to an FTS keyword rank; <0.x> threshold stays 501", async () => {
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
        const noEmbedder = { process: async () => ({}), embedderInfo: () => null } as unknown as Mimetypes;
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: noEmbedder }));

        const topK = await EntrySemantic.rankSemantic(db, workspaceId, "worker", noEmbedder, "payment", { first: 5, last: null });
        assert.equal(topK.status, 200, "no embedder no longer 501s the top-K form");
        assert.deepEqual(topK.results.map((x) => x.pathname), ["/heavy.ts", "/light.ts"],
            "BM25 ranks heavy (two hits) above light (one); auth (no keyword) excluded by the narrow");
        const heavy = topK.results.find((x) => x.pathname === "/heavy.ts");
        assert.ok(heavy && heavy.lineStart === 1 && heavy.lineEnd === 2, `whole-entry span, no chunk vectors (got ${heavy?.lineStart}-${heavy?.lineEnd})`);

        // The similarity-threshold form needs a cosine score the FTS half can't supply.
        const thresh = await EntrySemantic.rankSemantic(db, workspaceId, "worker", noEmbedder, "payment", { first: 0.5, last: null });
        assert.equal(thresh.status, 501, "the <0.x> threshold form is cosine-intrinsic → 501 without an embedder");
    } finally { db.close(); }
});
