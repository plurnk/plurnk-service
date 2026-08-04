// Contract: {§mimetype-embedding-wire}. Issue #94 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import EmbeddingVector from "./EmbeddingVector.ts";

describe("EmbeddingVector", () => {
    it("encodes finite IEEE-754 binary32 values in fixed little-endian order", () => {
        const encoded = EmbeddingVector.encode([1, -2, 0.5]);

        assert.equal(EmbeddingVector.encoding, "float32-le");
        assert.deepEqual([...encoded], [
            0x00, 0x00, 0x80, 0x3f,
            0x00, 0x00, 0x00, 0xc0,
            0x00, 0x00, 0x00, 0x3f,
        ]);
    });

    it("decodes an unaligned wire view without host-endian or alignment assumptions", () => {
        const encoded = EmbeddingVector.encode([1, -2, 0.5]);
        const storage = new Uint8Array(encoded.byteLength + 1);
        storage.set(encoded, 1);

        assert.deepEqual([...EmbeddingVector.decode(storage.subarray(1))], [1, -2, 0.5]);
    });

    it("rejects invalid dimensions, byte extents, and non-finite values at the codec", () => {
        assert.throws(() => EmbeddingVector.encode([1], 2), /dimension 2.*1 value/i);
        assert.throws(() => EmbeddingVector.encode([]), /positive safe-integer dimension/i);
        assert.throws(() => EmbeddingVector.decode(new Uint8Array(0)), /positive safe-integer dimension/i);
        assert.throws(() => EmbeddingVector.decode(new Uint8Array(5)), /multiple of 4/i);
        assert.throws(() => EmbeddingVector.decode(EmbeddingVector.encode([1]), 2), /dimension 2.*4 bytes/i);
        assert.throws(() => EmbeddingVector.encode([Number.NaN]), /finite/i);
        assert.throws(() => EmbeddingVector.encode([Number.MAX_VALUE]), /finite binary32/i);

        const nonfinite = new Uint8Array(4);
        new DataView(nonfinite.buffer).setFloat32(0, Number.POSITIVE_INFINITY, true);
        assert.throws(() => EmbeddingVector.decode(nonfinite), /finite/i);
    });
});
