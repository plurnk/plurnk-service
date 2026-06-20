import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { countTokens, dimension, dispose, embed, maxTokens, model } from "./index.js";

function toVector(bytes) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function l2Norm(v) {
    return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

// Vectors are L2-normalized, so cosine is the plain dot product.
function cosine(a, b) {
    return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

describe("embedder duck surface", () => {
    it("dimension is 384", () => {
        assert.equal(dimension, 384);
    });

    it("model identity is derived from .model-pin and carries the quantization", () => {
        // Guards against the hardcoded-literal regression: the identity MUST
        // track the pinned revision and dtype, not a hand-synced string.
        const pin = readFileSync(new URL(".model-pin", import.meta.url), "utf-8").trim();
        assert.equal(model, `Xenova/all-MiniLM-L6-v2@${pin.slice(0, 8)}+q8`);
    });

    it("embed('hello') returns exactly 4 × dimension bytes owning its buffer", async () => {
        const bytes = await embed("hello");
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(bytes.length, 1536);
        assert.equal(bytes.byteOffset, 0);
        assert.equal(bytes.buffer.byteLength, 1536);
    });

    it("is deterministic — same text → identical bytes", async () => {
        const [a, b] = await Promise.all([embed("hello"), embed("hello")]);
        assert.deepEqual(a, b);
    });

    it("output is L2-normalized (norm ≈ 1)", async () => {
        const v = toVector(await embed("the quick brown fox"));
        assert.ok(Math.abs(l2Norm(v) - 1) < 1e-3, `norm ${l2Norm(v)} not within 1e-3 of 1`);
    });

    it("different texts produce different vectors", async () => {
        const a = await embed("hello");
        const b = await embed("goodbye");
        assert.notDeepEqual(a, b);
    });

    it("truncates input beyond the model window instead of throwing", async () => {
        const bytes = await embed("database connection retry backoff ".repeat(2000));
        assert.equal(bytes.length, 1536);
    });

    it("maxTokens is the model window (512)", () => {
        assert.equal(maxTokens, 512);
    });

    it("countTokens counts in the model tokenizer, including special tokens", async () => {
        // CLS + SEP bracket every input → empty string is 2 tokens.
        assert.equal(await countTokens(""), 2);
        // A short phrase is more than empty but well under the window.
        const five = await countTokens("the quick brown fox jumps");
        assert.ok(five > 2 && five < maxTokens, `expected 2 < ${five} < ${maxTokens}`);
    });

    it("countTokens is untruncated — reports overflow past the window", async () => {
        // The losslessness guarantee: a body that overflows must report its
        // TRUE count, not a clamp at maxTokens, or the chunker can't tile it.
        const n = await countTokens("database connection retry ".repeat(400));
        assert.ok(n > maxTokens, `expected overflow count > ${maxTokens}, got ${n}`);
    });

    it("dispose() is idempotent and re-lazy-inits (#36)", async () => {
        await dispose(); // before any use — no-op, must not throw
        await embed("warm");
        await dispose();
        // after disposal, the pipeline re-initializes transparently
        const again = await embed("again");
        assert.equal(again.length, 4 * dimension);
    });

    it("a process that embeds then dispose()s exits on its own — no leaked native handles (#36)", () => {
        // The deliverable: without dispose() the embedder's onnxruntime threads
        // keep the event loop alive and the process hangs at exit. With it, the
        // process must drain and exit. Run as a child with a hard timeout — a
        // hang makes execFileSync throw, failing the test.
        const indexPath = path.join(import.meta.dirname, "index.js");
        const src = `import { embed, dispose } from ${JSON.stringify(indexPath)};\n`
            + `await embed("hello");\n`
            + `await dispose();\n`;
        // Throws on timeout (hang) or non-zero exit; returning = clean self-exit.
        execFileSync(process.execPath, ["--input-type=module", "--eval", src], {
            timeout: 60000,
            stdio: "ignore",
        });
    });

    it("cosine sanity — semantic neighbors beat unrelated text", async () => {
        const query = toVector(await embed("database connection error"));
        const near = toVector(await embed("sql connection failure"));
        const far = toVector(await embed("birthday cake recipe"));
        const nearSim = cosine(query, near);
        const farSim = cosine(query, far);
        assert.ok(
            nearSim > farSim,
            `expected near (${nearSim}) > far (${farSim})`,
        );
    });
});
