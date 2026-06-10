import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlain from "./TextPlain.ts";

const plainMetadata = {
    mimetype: "text/plain",
    glyph: "📄",
    extensions: [".txt"] as const,
};

const streamMetadata = {
    mimetype: "text/stream",
    glyph: "📡",
    extensions: [] as const,
};

describe("TextPlain — text/plain (prose)", () => {
    it("instantiates with text/plain metadata", () => {
        const h = new TextPlain(plainMetadata);
        assert.equal(h.mimetype, "text/plain");
        assert.equal(h.glyph, "📄");
        assert.deepEqual([...h.extensions], [".txt"]);
    });

    it("extractRaw is empty (no structural symbols in plain text)", () => {
        const h = new TextPlain(plainMetadata);
        assert.deepEqual(h.extractRaw("any content"), []);
    });

    it("symbolsRaw is empty (no structural symbols in plain text)", async () => {
        const h = new TextPlain(plainMetadata);
        assert.equal(await h.symbolsRaw("any content"), "");
    });

    it("validate is a no-op (any content is valid plain text)", () => {
        const h = new TextPlain(plainMetadata);
        assert.doesNotThrow(() => h.validate("anything"));
    });
});

describe("TextPlain — text/stream (live data)", () => {
    it("instantiates with text/stream metadata and reports its own mimetype", () => {
        const h = new TextPlain(streamMetadata);
        assert.equal(h.mimetype, "text/stream");
        assert.equal(h.glyph, "📡");
        assert.deepEqual([...h.extensions], []);
    });

    it("extractRaw is empty (no structural symbols in stream text)", () => {
        const h = new TextPlain(streamMetadata);
        assert.deepEqual(h.extractRaw("log line 1\nlog line 2"), []);
    });
});

describe("TextPlain — query (inherited)", () => {
    it("regex against text body works on both mimetypes", async () => {
        const plain = new TextPlain(plainMetadata);
        const stream = new TextPlain(streamMetadata);
        const text = "error: foo\nok: bar\nerror: baz";
        const plainOut = await plain.query(text, "regex", "error: \\w+");
        const streamOut = await stream.query(text, "regex", "error: \\w+");
        assert.equal(plainOut.length, 2);
        assert.equal(streamOut.length, 2);
    });

    it("jsonpath against the (empty) outline returns no matches", async () => {
        const h = new TextPlain(plainMetadata);
        const out = await h.query("any text", "jsonpath", "$.anything");
        assert.deepEqual(out, []);
    });
});
