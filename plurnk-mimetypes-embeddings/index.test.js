import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dimension, embed } from "./index.js";

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
