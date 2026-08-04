import test from "node:test";
import assert from "node:assert/strict";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import EntrySemantic from "./_entry-semantic.ts";

// These exercise the CAPABLE-embedder path (via a stub embedder), so the embedder must be ON —
// the Mock bootstrap disables it (PLURNK_SERVICE_EMBED_DISABLE=1), which would force #embedderInfo
// to null and collapse every assertion to the FTS fallback. Re-enable it for this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const wordCount = (t: string): number => (t.match(/\S+/g) ?? []).length;
const fakeVector = (s: string): Uint8Array => new Uint8Array(new Float32Array([s.length, wordCount(s), 0]).buffer);

// A capable embedder: reports a window + a word-count tokenizer + model id, batch-"embeds"
// any texts (the framework embedBatch seam — #272; vectors map 1:1 to inputs, in order).
const capable = {
    embedderInfo: () => ({ contextWindow: 10000, countTokens: wordCount, model: "stub@1" }),
    embedBatch: async (texts: readonly string[]) => texts.map(fakeVector),
} as unknown as Mimetypes;

// A dormant embedder: no capability surface; never tiles.
const dormant = { embedderInfo: async () => null, process: async () => ({ embedding: undefined, embeddingModel: undefined }) } as unknown as Mimetypes;

test("EntrySemantic.defaultTopK reads and validates the service-owned semantic result default", () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
    try {
        process.env.PLURNK_SERVICE_SEMANTIC_TOP_K = "12";
        assert.equal(EntrySemantic.defaultTopK(), 12);
        for (const invalid of ["", "0", "-1", "1.5", "unsafe"]) {
            process.env.PLURNK_SERVICE_SEMANTIC_TOP_K = invalid;
            assert.throws(() => EntrySemantic.defaultTopK(), /must be a positive safe integer/);
        }
        delete process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
        assert.throws(() => EntrySemantic.defaultTopK(), /got undefined/);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
        else process.env.PLURNK_SERVICE_SEMANTIC_TOP_K = prev;
    }
});

test("EntrySemantic.resultSelection preserves FIND pagination after an optional threshold", () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
    try {
        process.env.PLURNK_SERVICE_SEMANTIC_TOP_K = "12";
        assert.deepEqual(EntrySemantic.resultSelection(null), {
            threshold: null,
            page: null,
            limit: 12,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [4] }), {
            threshold: null,
            page: { marks: [4] },
            limit: 4,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [4, 9] }), {
            threshold: null,
            page: { marks: [4, 9] },
            limit: 9,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [1, -1] }), {
            threshold: null,
            page: { marks: [1, -1] },
            limit: -1,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7] }), {
            threshold: 0.7,
            page: null,
            limit: -1,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 4] }), {
            threshold: 0.7,
            page: { marks: [4] },
            limit: 4,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 4, 9] }), {
            threshold: 0.7,
            page: { marks: [4, 9] },
            limit: 9,
        });
        assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 1, -1] }), {
            threshold: 0.7,
            page: { marks: [1, -1] },
            limit: -1,
        });
        assert.equal(EntrySemantic.resultSelection({ marks: [0] }).limit, 0);
        assert.equal(EntrySemantic.resultSelection({ marks: [-2, 9] }).limit, -1);
        assert.equal(
            EntrySemantic.resultSelection({ marks: [0.7, 1, 2, 3] }).limit,
            -1,
            "an invalid page remains exhaustive so the shared pager can report its real extent",
        );
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_TOP_K;
        else process.env.PLURNK_SERVICE_SEMANTIC_TOP_K = prev;
    }
});

test("EntrySemantic.deriveEmbeddings: capable embedder tiles a large body losslessly, embeds each chunk (#plan-semantics)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "20"; // force tiling regardless of the .env.defaults default
    try {
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n"); // ~200 words
        const plan = await EntrySemantic.prepareEmbeddings(capable);
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(plan, content, [], undefined, undefined);
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
            embedderInfo: () => ({ contextWindow: 10000, countTokens: wordCount, model: "stub@1" }),
            embedBatch: async (texts: readonly string[]) => { batchSizes.push(texts.length); return texts.map(fakeVector); },
        } as unknown as Mimetypes;
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(spy);
        const { chunks } = await EntrySemantic.deriveEmbeddings(plan, content, [], undefined, undefined);
        assert.ok(chunks.length > 1, `tiled into multiple chunks (got ${chunks.length})`);
        assert.equal(batchSizes.length, 1, "exactly one embedBatch call — the parallel path, not a sequential per-chunk loop");
        assert.equal(batchSizes[0], chunks.length, "the single batch carried every tiled chunk text");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.deriveEmbeddings reports planning and embedding progress within one large entry (#588)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "4";
    try {
        const events: Array<{ phase: "planning" | "embedding"; completed: number; total: number }> = [];
        const reporting = {
            embedderInfo: () => ({ contextWindow: 10000, countTokens: wordCount, model: "stub@1" }),
            embedBatch: async (texts: readonly string[], options: { onProgress?: (progress: { completed: number; total: number }) => void }) => {
                const vectors = [];
                for (let i = 0; i < texts.length; i++) {
                    vectors.push(fakeVector(texts[i]));
                    options.onProgress?.({ completed: i + 1, total: texts.length });
                }
                return vectors;
            },
        } as unknown as Mimetypes;
        const content = Array.from({ length: 12 }, (_, i) => `line ${i} alpha`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(reporting);
        await EntrySemantic.deriveEmbeddings(
            plan,
            content,
            [],
            undefined,
            undefined,
            undefined,
            (progress) => events.push(progress),
        );
        const planning = events.filter((event) => event.phase === "planning");
        const embedding = events.filter((event) => event.phase === "embedding");
        assert.deepEqual(planning.at(-1), { phase: "planning", completed: 12, total: 12 });
        assert.equal(embedding.at(-1)?.completed, embedding.at(-1)?.total);
        assert.ok((embedding.at(-1)?.total ?? 0) > 1);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.deriveEmbeddings: no embedder capability → one whole-entry chunk from the fallback vector", async () => {
    const fallback = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
    const plan = await EntrySemantic.prepareEmbeddings(dormant);
    const { chunks, model } = await EntrySemantic.deriveEmbeddings(plan, "a\nb\nc", [], fallback, "real@1");
    assert.equal(chunks.length, 1, "one whole-entry chunk");
    assert.deepEqual({ s: chunks[0].lineStart, e: chunks[0].lineEnd }, { s: 1, e: 3 });
    assert.equal(model, "real@1");

    const empty = await EntrySemantic.deriveEmbeddings(plan, "x", [], undefined, undefined);
    assert.deepEqual(empty.chunks, [], "no fallback vector → cleared");
    assert.equal(empty.model, undefined);

    const terminated = await EntrySemantic.deriveEmbeddings(plan, "a\nb\n", [], fallback, "real@1");
    assert.deepEqual(
        terminated.chunks.map(({ lineStart, lineEnd }) => ({ lineStart, lineEnd })),
        [{ lineStart: 1, lineEnd: 2 }],
        "a terminal newline does not create a phantom fallback span",
    );
});

test("EntrySemantic.deriveEmbeddings: empty PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = the embedder's reported window (scalable, no baked-in budget)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS; // empty = discover the window
    try {
        // A capable embedder advertising a SMALL window (5 tokens). The budget must come
        // from THAT window, not a hardcoded default — so ~80 words tiles into many chunks.
        // (Pre-fix, an empty knob fail-harded; this locks the scalable path.)
        const smallWindow = {
            embedderInfo: () => ({ contextWindow: 5, countTokens: wordCount, model: "small@1" }),
            embedBatch: async (texts: readonly string[]) => texts.map(fakeVector),
        } as unknown as Mimetypes;
        const content = Array.from({ length: 20 }, (_, i) => `line ${i} a b`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(smallWindow);
        const { chunks } = await EntrySemantic.deriveEmbeddings(plan, content, [], undefined, undefined);
        assert.ok(chunks.length > 3, `budget came from the model window (5), not a baked-in number — got ${chunks.length} chunks`);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("EntrySemantic.prepareEmbeddings: folds the embedder model id — a same-window model swap re-derives (#31)", async () => {
    const mk = (model: string) => ({ embedderInfo: async () => ({ dimension: 3, contextWindow: 1000, countTokens: wordCount, model }) }) as unknown as Mimetypes;
    const a = (await EntrySemantic.prepareEmbeddings(mk("e5@1"))).signature;
    const b = (await EntrySemantic.prepareEmbeddings(mk("e5@2"))).signature; // identical window + knobs, different model
    assert.notEqual(a, b, "a same-window model swap changes the signature → the deep_hash gate re-derives every entry");
    assert.equal(a, (await EntrySemantic.prepareEmbeddings(mk("e5@1"))).signature, "same model + knobs is stable → no needless re-derivation");
    assert.equal((await EntrySemantic.prepareEmbeddings(dormant)).signature, "embed:none", "no embedder → dormant signature, never folds a model");
});

test("EntrySemantic.prepareEmbeddings preserves one fallback tokenizer resolution (#87)", async () => {
    const resolution = {
        countTokens: async (text: string) => Math.ceil(text.length / 2),
        tokenizerId: "heuristic:chars2",
        exact: false,
        notices: [{
            source: "tokenizer",
            kind: "tokenizer_unavailable",
            level: "warn",
            message: "no exact tokenizer",
            position: null,
        }],
    } as const;
    let resolutions = 0;
    const remote = {
        embedderInfo: async () => ({
            dimension: 3,
            contextWindow: 1000,
            countTokens: null,
            model: "remote:stub@d3",
        }),
        tokenizer: async () => {
            resolutions++;
            return resolution;
        },
    } as unknown as Mimetypes;

    const plan = await EntrySemantic.prepareEmbeddings(remote);

    assert.equal(resolutions, 1);
    assert.equal(plan.tokenizer, resolution, "identity, exactness, and degradation evidence stay together");
    assert.equal(plan.countTokens, resolution.countTokens, "chunking consumes the counter from that same resolution");
    assert.match(plan.signature, /tokenizer=heuristic:chars2:estimate/, "counter identity and exactness enter the derivation key");
});

test("EntrySemantic.deriveEmbeddings refuses degraded counters before embedding arbitrary content (#95)", async () => {
    let embedCalls = 0;
    const remote = {
        embedderInfo: async () => ({
            dimension: 3,
            contextWindow: 8,
            countTokens: null,
            model: "remote:unmatched-embedding-model@d3",
        }),
        tokenizer: async () => ({
            countTokens: async (text: string) => Math.ceil(text.length / 2),
            tokenizerId: "heuristic:chars2",
            exact: false,
            notices: [{
                source: "tokenizer",
                kind: "tokenizer_unavailable",
                level: "warn",
                message: "no exact tokenizer",
                position: null,
            }],
        }),
        embedBatch: async () => {
            embedCalls++;
            return [];
        },
    } as unknown as Mimetypes;
    const plan = await EntrySemantic.prepareEmbeddings(remote);

    for (const specimen of ["漢字🙂".repeat(8), JSON.stringify({ compact: ["punctuation", 1, true, null] })]) {
        await assert.rejects(
            EntrySemantic.deriveEmbeddings(plan, specimen, [], undefined, undefined),
            /exact token counter.*remote:unmatched-embedding-model@d3/i,
        );
    }
    assert.equal(embedCalls, 0, "no content reaches the remote embedder under an estimated admission count");
});
