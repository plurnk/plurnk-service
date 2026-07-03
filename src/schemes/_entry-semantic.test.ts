import test from "node:test";
import assert from "node:assert/strict";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import EntrySemantic from "./_entry-semantic.ts";

// These exercise the CAPABLE-embedder path (via a stub embedder), so the embedder must be ON —
// the fast lane disables it in .env.test (PLURNK_SERVICE_EMBED_DISABLE=1), which would force #embedderInfo
// to null and collapse every assertion to the FTS fallback. Re-enable it for this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const wordCount = (t: string): number => (t.match(/\S+/g) ?? []).length;
const fakeVector = (s: string): Uint8Array => new Uint8Array(new Float32Array([s.length, wordCount(s), 0]).buffer);

// A capable embedder: reports a window + a word-count tokenizer + model id, batch-"embeds"
// any texts (the framework embedBatch seam — #272; vectors map 1:1 to inputs, in order).
const capable = {
    embedderInfo: () => ({ maxTokens: 10000, countTokens: wordCount, model: "stub@1" }),
    embedBatch: async (texts: readonly string[]) => texts.map(fakeVector),
} as unknown as Mimetypes;

// A dormant embedder: no capability surface; never tiles.
const dormant = { process: async () => ({ embedding: undefined, embeddingModel: undefined }) } as unknown as Mimetypes;

test("EntrySemantic.deriveEmbeddings: capable embedder tiles a large body losslessly, embeds each chunk (#plan-semantics)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "20"; // force tiling regardless of the .env.example default
    try {
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n"); // ~200 words
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(capable, content, [], undefined, undefined);
        assert.ok(chunks.length > 1, `tiled into multiple chunks (got ${chunks.length})`);
        assert.equal(model, "stub@1");
        const covered = new Set<number>();
        for (const c of chunks) for (let l = c.lineStart; l <= c.lineEnd; l++) covered.add(l);
        for (let l = 1; l <= 40; l++) assert.ok(covered.has(l), `line ${l} covered (lossless)`);
        assert.ok(chunks.every((c) => c.vector.byteLength > 0), "each chunk embedded");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.deriveEmbeddings: batches all tiled chunks into ONE embedBatch call, not a per-chunk loop (#272)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "20";
    try {
        const batchSizes: number[] = [];
        const spy = {
            embedderInfo: () => ({ maxTokens: 10000, countTokens: wordCount, model: "stub@1" }),
            embedBatch: async (texts: readonly string[]) => { batchSizes.push(texts.length); return texts.map(fakeVector); },
        } as unknown as Mimetypes;
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n");
        const { chunks } = await EntrySemantic.deriveEmbeddings(spy, content, [], undefined, undefined);
        assert.ok(chunks.length > 1, `tiled into multiple chunks (got ${chunks.length})`);
        assert.equal(batchSizes.length, 1, "exactly one embedBatch call — the parallel path, not a sequential per-chunk loop");
        assert.equal(batchSizes[0], chunks.length, "the single batch carried every tiled chunk text");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.deriveEmbeddings: no embedder capability → one whole-entry chunk from the fallback vector", async () => {
    const fallback = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
    const { chunks, model } = await EntrySemantic.deriveEmbeddings(dormant, "a\nb\nc", [], fallback, "real@1");
    assert.equal(chunks.length, 1, "one whole-entry chunk");
    assert.deepEqual({ s: chunks[0].lineStart, e: chunks[0].lineEnd }, { s: 1, e: 3 });
    assert.equal(model, "real@1");

    const empty = await EntrySemantic.deriveEmbeddings(dormant, "x", [], undefined, undefined);
    assert.deepEqual(empty.chunks, [], "no fallback vector → cleared");
    assert.equal(empty.model, undefined);
});

test("EntrySemantic.deriveEmbeddings: empty PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = the embedder's reported window (scalable, no baked-in budget)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS; // empty = discover the window
    try {
        // A capable embedder advertising a SMALL window (5 tokens). The budget must come
        // from THAT window, not a hardcoded default — so ~80 words tiles into many chunks.
        // (Pre-fix, an empty knob fail-harded; this locks the scalable path.)
        const smallWindow = {
            embedderInfo: () => ({ maxTokens: 5, countTokens: wordCount, model: "small@1" }),
            embedBatch: async (texts: readonly string[]) => texts.map(fakeVector),
        } as unknown as Mimetypes;
        const content = Array.from({ length: 20 }, (_, i) => `line ${i} a b`).join("\n");
        const { chunks } = await EntrySemantic.deriveEmbeddings(smallWindow, content, [], undefined, undefined);
        assert.ok(chunks.length > 3, `budget came from the model window (5), not a baked-in number — got ${chunks.length} chunks`);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.deepConfigSignature: folds the embedder model id — a same-window model swap re-derives (#31)", async () => {
    const mk = (model: string) => ({ embedderInfo: () => ({ maxTokens: 1000, countTokens: wordCount, model }) }) as unknown as Mimetypes;
    const a = await EntrySemantic.deepConfigSignature(mk("e5@1"));
    const b = await EntrySemantic.deepConfigSignature(mk("e5@2")); // identical window + knobs, different model
    assert.notEqual(a, b, "a same-window model swap changes the signature → the deep_hash gate re-derives every entry");
    assert.equal(a, await EntrySemantic.deepConfigSignature(mk("e5@1")), "same model + knobs is stable → no needless re-derivation");
    assert.equal(await EntrySemantic.deepConfigSignature(dormant), "embed:none", "no embedder → dormant signature, never folds a model");
});
