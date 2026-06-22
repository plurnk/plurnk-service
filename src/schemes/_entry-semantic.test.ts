import test from "node:test";
import assert from "node:assert/strict";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import EntrySemantic from "./_entry-semantic.ts";

const wordCount = (t: string): number => (t.match(/\S+/g) ?? []).length;
const fakeVector = (s: string): Uint8Array => new Uint8Array(new Float32Array([s.length, wordCount(s), 0]).buffer);

// A capable embedder: reports a window + a word-count tokenizer, "embeds" any text.
const capable = {
    embedderInfo: () => ({ maxTokens: 10000, countTokens: wordCount }),
    process: async (input: { content: string }) => ({ embedding: fakeVector(input.content), embeddingModel: "stub@1" }),
} as unknown as Mimetypes;

// A dormant embedder: no capability surface; never tiles.
const dormant = { process: async () => ({ embedding: undefined, embeddingModel: undefined }) } as unknown as Mimetypes;

test("EntrySemantic.deriveEmbeddings: capable embedder tiles a large body losslessly, embeds each chunk (#plan-semantics)", async () => {
    const prev = process.env.PLURNK_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SEMANTIC_CHUNK_TOKENS = "20"; // force tiling regardless of the .env.example default
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
        if (prev === undefined) delete process.env.PLURNK_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SEMANTIC_CHUNK_TOKENS = prev;
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

test("EntrySemantic.deriveEmbeddings: empty PLURNK_SEMANTIC_CHUNK_TOKENS = the embedder's reported window (scalable, no baked-in budget)", async () => {
    const prev = process.env.PLURNK_SEMANTIC_CHUNK_TOKENS;
    delete process.env.PLURNK_SEMANTIC_CHUNK_TOKENS; // empty = discover the window
    try {
        // A capable embedder advertising a SMALL window (5 tokens). The budget must come
        // from THAT window, not a hardcoded default — so ~80 words tiles into many chunks.
        // (Pre-fix, an empty knob fail-harded; this locks the scalable path.)
        const smallWindow = {
            embedderInfo: () => ({ maxTokens: 5, countTokens: wordCount }),
            process: async (input: { content: string }) => ({ embedding: fakeVector(input.content), embeddingModel: "small@1" }),
        } as unknown as Mimetypes;
        const content = Array.from({ length: 20 }, (_, i) => `line ${i} a b`).join("\n");
        const { chunks } = await EntrySemantic.deriveEmbeddings(smallWindow, content, [], undefined, undefined);
        assert.ok(chunks.length > 3, `budget came from the model window (5), not a baked-in number — got ${chunks.length} chunks`);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SEMANTIC_CHUNK_TOKENS = prev;
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
