import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import { contextWindow, countTokens, dimension, dispose, embedDocuments, embedQuery, model } from "./index.js";
import { assertEmbeddingConformance } from "./test/conformance.js";

const nodeEvalArgs = (source) => ["--conditions=plurnk-dev", "--input-type=module", "--eval", source];

function toVector(bytes) {
    return EmbeddingVector.decode(bytes, dimension);
}

const queryVector = async (text) => (await embedQuery(text)).vector;
const documentVectors = async (texts, options) => (await embedDocuments(texts, options)).vectors;

function l2Norm(v) {
    return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

// Vectors are L2-normalized, so cosine is the plain dot product.
function cosine(a, b) {
    return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

describe("embedder duck surface", () => {
    it("passes the common EmbeddingModelV4-backed conformance suite", async () => {
        await assertEmbeddingConformance({ embedQuery, embedDocuments }, { dimension, symmetric: true });
    });

    it("dimension is 384", () => {
        assert.equal(dimension, 384);
    });

    it("model identity is derived from .model-pin and carries the quantization", () => {
        // Guards against the hardcoded-literal regression: the identity MUST
        // track the pinned revision and dtype, not a hand-synced string.
        const pin = readFileSync(new URL(".model-pin", import.meta.url), "utf-8").trim();
        assert.equal(model, `Xenova/all-MiniLM-L6-v2@${pin.slice(0, 8)}+q8`);
    });

    it("embedQuery('hello') returns exactly 4 × dimension bytes owning its buffer", async () => {
        const { vector: bytes, metadata } = await embedQuery("hello");
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(bytes.length, 1536);
        assert.equal(bytes.byteOffset, 0);
        assert.equal(bytes.buffer.byteLength, 1536);
        assert.deepEqual(metadata, { inputTokens: null, warnings: [], accounting: [] });
    });

    it("is deterministic — same text → identical bytes", async () => {
        const [a, b] = await Promise.all([queryVector("hello"), queryVector("hello")]);
        assert.deepEqual(a, b);
    });

    it("output is L2-normalized (norm ≈ 1)", async () => {
        const v = toVector(await queryVector("the quick brown fox"));
        assert.ok(Math.abs(l2Norm(v) - 1) < 1e-3, `norm ${l2Norm(v)} not within 1e-3 of 1`);
    });

    it("different texts produce different vectors", async () => {
        const a = await queryVector("hello");
        const b = await queryVector("goodbye");
        assert.notDeepEqual(a, b);
    });

    it("truncates input beyond the model window instead of throwing", async () => {
        const bytes = await queryVector("database connection retry backoff ".repeat(2000));
        assert.equal(bytes.length, 1536);
    });

    it("contextWindow is the model input window (512)", () => {
        assert.equal(contextWindow, 512);
    });

    it("countTokens counts in the model tokenizer, including special tokens", async () => {
        // CLS + SEP bracket every input → empty string is 2 tokens.
        assert.equal(await countTokens(""), 2);
        // A short phrase is more than empty but well under the window.
        const five = await countTokens("the quick brown fox jumps");
        assert.ok(five > 2 && five < contextWindow, `expected 2 < ${five} < ${contextWindow}`);
    });

    it("countTokens is untruncated — reports overflow past the window", async () => {
        // The losslessness guarantee: a body that overflows must report its
        // TRUE count, not a clamp at contextWindow, or the chunker can't tile it.
        const n = await countTokens("database connection retry ".repeat(400));
        assert.ok(n > contextWindow, `expected overflow count > ${contextWindow}, got ${n}`);
    });

    it("overlapping token counts preserve each input across the shared pool", async () => {
        const texts = Array.from(
            { length: 48 },
            (_, i) => `${"token ".repeat(i + 1)}distinct-${i}`,
        );
        const concurrent = await Promise.all(texts.map((text) => countTokens(text)));
        const sequential = [];
        for (const text of texts) sequential.push(await countTokens(text));
        assert.deepEqual(concurrent, sequential);
    });

    it("vector-preserving: output matches the native (onnxruntime-node) baseline", async () => {
        // The identity-stability contract for the WASM-runtime switch: these
        // first six floats were captured from the old
        // @huggingface/transformers / onnxruntime-node path. The model id is
        // deliberately unchanged, so stored vectors stay comparable — this guards
        // against a future dep bump silently drifting them past that promise.
        // Tolerance is float32 summation-order noise (~1e-7), not model slack.
        const NATIVE = {
            hello: [-0.07562684267759323, 0.04754344001412392, 0.03647792339324951, 0.09108457714319229, -0.07077883183956146, -0.08546268194913864],
            "database connection error": [0.05036694183945656, -0.03440168872475624, -0.06667469441890717, 0.003910769708454609, -0.1688850373029709, 0.01926480233669281],
        };
        for (const [text, first6] of Object.entries(NATIVE)) {
            const v = toVector(await queryVector(text));
            for (let i = 0; i < first6.length; i += 1) {
                assert.ok(
                    Math.abs(v[i] - first6[i]) < 1e-5,
                    `${text}[${i}]: ${v[i]} drifted from native ${first6[i]}`,
                );
            }
        }
    });

    it("protobufjs is never loaded at runtime (vendoring phantom invariant)", () => {
        // The vendored onnxruntime-web build drops protobufjs from the install
        // tree; this guards the assumption it rests on — that the inference path
        // never actually loads it (the .onnx protobuf is parsed inside the wasm).
        // Run as a child so the check is isolated to a single real embed().
        const indexPath = path.join(import.meta.dirname, "index.js");
        const src = `import { createRequire } from "node:module";\n`
            + `import { embedQuery, dispose } from ${JSON.stringify(indexPath)};\n`
            + `const require = createRequire(${JSON.stringify(indexPath)});\n`
            + `await embedQuery("does this touch protobufjs?");\n`
            + `await dispose();\n`
            + `const inCache = Object.keys(require.cache).filter((p) => /protobuf/i.test(p)).length;\n`
            + `const inList = (process.moduleLoadList || []).filter((m) => /protobuf/i.test(m)).length;\n`
            + `if (inCache || inList) { console.error("protobufjs loaded: cache=" + inCache + " list=" + inList); process.exit(3); }\n`;
        // Throws on non-zero exit (protobufjs detected) or timeout.
        execFileSync(process.execPath, nodeEvalArgs(src), {
            timeout: 60000,
            stdio: "ignore",
        });
    });

    it("{§mimetype-lifecycle}: dispose() is idempotent and re-lazy-inits", async () => {
        await dispose(); // before any use — no-op, must not throw
        await embedQuery("warm");
        await dispose();
        // after disposal, the pipeline re-initializes transparently
        const again = await embedQuery("again");
        assert.equal(again.vector.length, 4 * dimension);
    });

    it("{§mimetype-lifecycle}: explicit embedder disposal leaves no native handles", () => {
        // The deliverable: a process that loaded the embedder must drain and
        // exit. Run as a child with a hard timeout — a hang makes execFileSync
        // throw, failing the test.
        const indexPath = path.join(import.meta.dirname, "index.js");
        const src = `import { embedQuery, dispose } from ${JSON.stringify(indexPath)};\n`
            + `await embedQuery("hello");\n`
            + `await dispose();\n`;
        // Throws on timeout (hang) or non-zero exit; returning = clean self-exit.
        execFileSync(process.execPath, nodeEvalArgs(src), {
            timeout: 60000,
            stdio: "ignore",
        });
    });

    it("the WASM runtime drains without explicit disposal", () => {
        // The structural win of the onnxruntime-web move: the old native runtime
        // held active+referenced libuv handles, so an undisposed embedder hung
        // the loop. The single-threaded WASM backend holds none — so even with
        // no dispose() the process drains on its own. dispose() is now hygiene,
        // not a correctness requirement.
        const indexPath = path.join(import.meta.dirname, "index.js");
        const src = `import { embedQuery } from ${JSON.stringify(indexPath)};\n`
            + `await embedQuery("hello");\n`; // no dispose() — must still exit
        execFileSync(process.execPath, nodeEvalArgs(src), {
            timeout: 60000,
            stdio: "ignore",
        });
    });

    it("{§mimetype-embedding}: embedDocuments preserves order and query wire identity for the symmetric local model", async () => {
        const texts = ["hello", "database connection error", "the quick brown fox", "birthday cake recipe"];
        const batch = await documentVectors(texts);
        assert.equal(batch.length, texts.length);
        for (let i = 0; i < texts.length; i += 1) {
            assert.equal(batch[i].length, 4 * dimension);
            // The data-parallel pool must produce the SAME bytes as the single
            // path — each worker is single-threaded, so determinism holds.
            assert.deepEqual(batch[i], await queryVector(texts[i]), `index ${i} diverged from embedQuery()`);
        }
    });

    it("overlapping singleton batches preserve each text's vector across the shared pool", async () => {
        const texts = Array.from({ length: 12 }, (_, i) => `distinct concurrent embedding input ${i}`);
        const concurrent = await Promise.all(texts.map(async (text) => (await documentVectors([text]))[0]));
        for (let i = 0; i < texts.length; i += 1) {
            assert.deepEqual(concurrent[i], await queryVector(texts[i]), `concurrent singleton ${i} received another job's vector`);
        }
    });

    it("{§mimetype-embedding}: embedDocuments reports completed and total progress", async () => {
        const seen = [];
        const texts = ["a", "b", "c", "d", "e"];
        await embedDocuments(texts, { onProgress: (p) => seen.push(p) });
        assert.equal(seen.length, texts.length, "one progress tick per text");
        assert.deepEqual(seen.at(-1), { completed: texts.length, total: texts.length });
        // monotonic 1..total
        assert.deepEqual(seen.map((p) => p.completed), [1, 2, 3, 4, 5]);
        assert.ok(seen.every((p) => p.total === texts.length));
    });

    it("{§mimetype-embedding}: embedDocuments([]) is a no-op with explicit metadata", async () => {
        assert.deepEqual(await embedDocuments([]), {
            vectors: [],
            metadata: { inputTokens: 0, warnings: [], accounting: [] },
        });
    });

    it("{§mimetype-embedding}: embedDocuments rejects an aborted signal", async () => {
        await assert.rejects(
            embedDocuments(["x", "y"], { signal: AbortSignal.abort() }),
            (e) => e.name === "AbortError",
        );
    });

    it("an idle embedDocuments pool does not hold the process open", () => {
        // The pool reuses single-threaded workers; they're unref'd while idle so
        // the process drains without dispose().
        const indexPath = path.join(import.meta.dirname, "index.js");
        const src = `import { embedDocuments } from ${JSON.stringify(indexPath)};\n`
            + `await embedDocuments(["one", "two", "three"]);\n`;
        execFileSync(process.execPath, nodeEvalArgs(src), {
            timeout: 60000,
            stdio: "ignore",
        });
    });

    it("cosine sanity — semantic neighbors beat unrelated text", async () => {
        const query = toVector(await queryVector("database connection error"));
        const near = toVector(await queryVector("sql connection failure"));
        const far = toVector(await queryVector("birthday cake recipe"));
        const nearSim = cosine(query, near);
        const farSim = cosine(query, far);
        assert.ok(
            nearSim > farSim,
            `expected near (${nearSim}) > far (${farSim})`,
        );
    });
});

describe("PLURNK_EMBEDDING_WORKERS contract: -1 matches cores", () => {
    const indexPath = path.join(import.meta.dirname, "index.js");
    // Load index.js in a child with a given env value (bare import runs the
    // top-level requireWorkers; the pool/model stay lazy, so it's cheap).
    // Throws on non-zero exit = the module crashed on load.
    const load = (value) => {
        const env = { ...process.env };
        if (value === undefined) delete env.PLURNK_EMBEDDING_WORKERS;
        else env.PLURNK_EMBEDDING_WORKERS = value;
        execFileSync(process.execPath, nodeEvalArgs(`import ${JSON.stringify(indexPath)};`), {
            env, timeout: 30000, stdio: "pipe",
        });
    };

    it("-1 sizes to the host (availableParallelism) — loads, never crashes", () => {
        load("-1"); // returns cleanly = loaded; execFileSync throws on non-zero exit
    });

    it("a positive integer loads", () => {
        load("4");
    });

    for (const automatic of [undefined, ""]) {
        it(`${JSON.stringify(automatic)} selects the host-relative default`, () => {
            load(automatic);
        });
    }

    for (const bad of ["0", "-2", "abc", "1.5"]) {
        it(`crashes on invalid ${JSON.stringify(bad)}`, () => {
            assert.throws(() => load(bad));
        });
    }
});
