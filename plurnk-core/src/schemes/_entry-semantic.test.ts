import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingVector, type Mimetypes } from "@plurnk/plurnk-mimetypes";
import EntrySemantic, { type SemanticPlan } from "./_entry-semantic.ts";

// These exercise the CAPABLE-embedder path (via a stub embedder), so the embedder must be ON —
// the Mock bootstrap disables it (PLURNK_SERVICE_EMBED_DISABLE=1), which would force #embedderInfo
// to null and collapse every assertion to the FTS fallback. Re-enable it for this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const wordCount = (t: string): number => (t.match(/\S+/g) ?? []).length;
const fakeVector = (s: string): Uint8Array => EmbeddingVector.encode([s.length, wordCount(s), 0]);
const wireVector = (values: readonly number[]): Uint8Array => EmbeddingVector.encode(values);
const embeddingMetadata = { inputTokens: null, warnings: [] } as const;
const executeDocuments = (plan: SemanticPlan): Mimetypes["embedDocuments"] =>
    (texts, options) => plan.mimetypes.embedDocuments(texts, options);
const embedderInfo = (contextWindow: number, model: string) => ({
    dimension: 3,
    contextWindow,
    countTokens: wordCount,
    tokenizerModel: null,
    model,
});

// A capable embedder with the ordered batch surface. {§mimetype-embedding}
const capable = {
    embedderInfo: () => embedderInfo(10000, "stub@1"),
    embedDocuments: async (texts: readonly string[]) => ({
        vectors: texts.map(fakeVector),
        metadata: embeddingMetadata,
    }),
} as unknown as Mimetypes;

// A dormant embedder: no capability surface; never tiles.
const dormant = { embedderInfo: async () => null, process: async () => ({ embedding: undefined, embeddingModel: undefined }) } as unknown as Mimetypes;

test("EntrySemantic.cosine decodes the owned wire and refuses malformed operands (#94)", () => {
    assert.ok(Math.abs(EntrySemantic.cosine(wireVector([1, 0]), wireVector([1, 1])) - Math.SQRT1_2) < 1e-6);
    assert.throws(() => EntrySemantic.cosine(wireVector([1, 0]), wireVector([1])), /same dimension/i);
    assert.throws(() => EntrySemantic.cosine(new Uint8Array(0), wireVector([1, 0])), /positive safe-integer dimension/i);

    const nonfinite = wireVector([1, 0]);
    new DataView(nonfinite.buffer).setFloat32(0, Number.NaN, true);
    assert.throws(() => EntrySemantic.cosine(nonfinite, wireVector([1, 0])), /finite/i);
});

test("EntrySemantic.resultSelection preserves FIND pagination after an optional threshold", () => {
    assert.deepEqual(EntrySemantic.resultSelection(null), {
        threshold: null,
        page: { marks: [1, 16] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [4] }), {
        threshold: null,
        page: { marks: [4] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [4, 9] }), {
        threshold: null,
        page: { marks: [4, 9] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [1, -1] }), {
        threshold: null,
        page: { marks: [1, -1] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7] }), {
        threshold: 0.7,
        page: { marks: [1, 16] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 4] }), {
        threshold: 0.7,
        page: { marks: [4] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 4, 9] }), {
        threshold: 0.7,
        page: { marks: [4, 9] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 1, -1] }), {
        threshold: 0.7,
        page: { marks: [1, -1] },
    });
    assert.deepEqual(EntrySemantic.resultSelection({ marks: [0.7, 1, 2, 3] }).page, { marks: [1, 2, 3] });
});

test("{§semantic-max-embed-size}: vector eligibility obeys the exact configured byte ceiling and explicit unlimited override", () => {
    const previous = process.env.PLURNK_SERVICE_MAX_EMBED_SIZE;
    try {
        process.env.PLURNK_SERVICE_MAX_EMBED_SIZE = "262144";
        assert.equal(EntrySemantic.embedSizeRejection("x".repeat(262144)), null, "the byte ceiling is inclusive");
        assert.deepEqual(
            EntrySemantic.embedSizeRejection("x".repeat(262145)),
            { actualBytes: 262145, maxBytes: 262144 },
        );

        process.env.PLURNK_SERVICE_MAX_EMBED_SIZE = "0";
        assert.equal(EntrySemantic.embedSizeRejection("x".repeat(262145)), null, "zero remains the deliberate unlimited posture");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_EMBED_SIZE;
        else process.env.PLURNK_SERVICE_MAX_EMBED_SIZE = previous;
    }
});

test("EntrySemantic.deriveEmbeddings: capable embedder tiles a large body losslessly, embeds each chunk (#plan-semantics)", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "20"; // force tiling regardless of the .env.defaults default
    try {
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n"); // ~200 words
        const plan = await EntrySemantic.prepareEmbeddings(capable);
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), content, [], undefined, undefined);
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

test("{§derivation-dedup-parallel} deriveEmbeddings sends every tile through one embedDocuments call", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "20";
    try {
        const batchSizes: number[] = [];
        const spy = {
            embedderInfo: () => embedderInfo(10000, "stub@1"),
            embedDocuments: async (texts: readonly string[]) => {
                batchSizes.push(texts.length);
                return { vectors: texts.map(fakeVector), metadata: embeddingMetadata };
            },
        } as unknown as Mimetypes;
        const content = Array.from({ length: 40 }, (_, i) => `line ${i} alpha beta gamma`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(spy);
        const { chunks } = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), content, [], undefined, undefined);
        assert.ok(chunks.length > 1, `tiled into multiple chunks (got ${chunks.length})`);
        assert.equal(batchSizes.length, 1, "exactly one embedDocuments call — the parallel path, not a sequential per-chunk loop");
        assert.equal(batchSizes[0], chunks.length, "the single batch carried every tiled chunk text");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("{§derivation-dedup-parallel} deriveEmbeddings reports planning and embedding progress within one large entry", async () => {
    const prev = process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
    process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = "4";
    try {
        const events: Array<{ phase: "planning" | "embedding"; completed: number; total: number }> = [];
        const reporting = {
            embedderInfo: () => embedderInfo(10000, "stub@1"),
            embedDocuments: async (texts: readonly string[], options: { onProgress?: (progress: { completed: number; total: number }) => void }) => {
                const vectors = [];
                for (let i = 0; i < texts.length; i++) {
                    vectors.push(fakeVector(texts[i]));
                    options.onProgress?.({ completed: i + 1, total: texts.length });
                }
                return { vectors, metadata: embeddingMetadata };
            },
        } as unknown as Mimetypes;
        const content = Array.from({ length: 12 }, (_, i) => `line ${i} alpha`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(reporting);
        await EntrySemantic.deriveEmbeddings(
            plan,
            executeDocuments(plan),
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
    const fallback = EmbeddingVector.encode([1, 2, 3]);
    const plan = await EntrySemantic.prepareEmbeddings(dormant);
    const { chunks, model } = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), "a\nb\nc", [], fallback, "real@1");
    assert.equal(chunks.length, 1, "one whole-entry chunk");
    assert.deepEqual({ s: chunks[0].lineStart, e: chunks[0].lineEnd }, { s: 1, e: 3 });
    assert.equal(model, "real@1");

    const empty = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), "x", [], undefined, undefined);
    assert.deepEqual(empty.chunks, [], "no fallback vector → cleared");
    assert.equal(empty.model, undefined);

    const terminated = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), "a\nb\n", [], fallback, "real@1");
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
            embedderInfo: () => embedderInfo(5, "small@1"),
            embedDocuments: async (texts: readonly string[]) => ({
                vectors: texts.map(fakeVector),
                metadata: embeddingMetadata,
            }),
        } as unknown as Mimetypes;
        const content = Array.from({ length: 20 }, (_, i) => `line ${i} a b`).join("\n");
        const plan = await EntrySemantic.prepareEmbeddings(smallWindow);
        const { chunks } = await EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), content, [], undefined, undefined);
        assert.ok(chunks.length > 3, `budget came from the model window (5), not a baked-in number — got ${chunks.length} chunks`);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS;
        else process.env.PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS = prev;
    }
});

test("{§semantic-embed-dedup}: a same-window model swap re-derives", async () => {
    const mk = (model: string) => ({ embedderInfo: async () => embedderInfo(1000, model) }) as unknown as Mimetypes;
    const a = (await EntrySemantic.prepareEmbeddings(mk("e5@1"))).signature;
    const b = (await EntrySemantic.prepareEmbeddings(mk("e5@2"))).signature; // identical window + knobs, different model
    assert.notEqual(a, b, "a same-window model swap changes the signature → the deep_hash gate re-derives every entry");
    assert.equal(a, (await EntrySemantic.prepareEmbeddings(mk("e5@1"))).signature, "same model + knobs is stable → no needless re-derivation");
    assert.match(a, /chunker=2/, "the deterministic tiling revision participates in derivation identity");
    assert.match(a, /wire=float32-le/, "the persisted vector encoding participates in derivation identity");
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
    const configured = {
        embedderInfo: async () => ({
            dimension: 3,
            contextWindow: 1000,
            countTokens: null,
            tokenizerModel: "fixture/tokenizer",
            model: "fixture/stub@profile-a",
        }),
        tokenizer: async () => {
            resolutions++;
            return resolution;
        },
    } as unknown as Mimetypes;

    const plan = await EntrySemantic.prepareEmbeddings(configured);

    assert.equal(resolutions, 1);
    assert.equal(plan.tokenizer, resolution, "identity, exactness, and degradation evidence stay together");
    assert.equal(plan.countTokens, resolution.countTokens, "chunking consumes the counter from that same resolution");
    assert.match(plan.signature, /tokenizer=heuristic:chars2:estimate/, "counter identity and exactness enter the derivation key");
});

test("EntrySemantic.deriveEmbeddings refuses degraded counters before embedding arbitrary content (#95)", async () => {
    let embedCalls = 0;
    const configured = {
        embedderInfo: async () => ({
            dimension: 3,
            contextWindow: 8,
            countTokens: null,
            tokenizerModel: "fixture/tokenizer",
            model: "fixture/unmatched-embedding-model@profile-a",
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
        embedDocuments: async () => {
            embedCalls++;
            return { vectors: [], metadata: embeddingMetadata };
        },
    } as unknown as Mimetypes;
    const plan = await EntrySemantic.prepareEmbeddings(configured);

    for (const specimen of ["漢字🙂".repeat(8), JSON.stringify({ compact: ["punctuation", 1, true, null] })]) {
        await assert.rejects(
            EntrySemantic.deriveEmbeddings(plan, executeDocuments(plan), specimen, [], undefined, undefined),
            /exact token counter.*fixture\/unmatched-embedding-model@profile-a/i,
        );
    }
    assert.equal(embedCalls, 0, "no content reaches the hosted embedder under an estimated admission count");
});
