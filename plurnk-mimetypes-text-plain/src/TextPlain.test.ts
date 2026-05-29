import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlain from "./TextPlain.ts";
import type { TextPreview } from "@plurnk/plurnk-mimetypes";

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

describe("TextPlain — text/plain (head-oriented prose)", () => {
    it("instantiates with text/plain metadata", () => {
        const h = new TextPlain(plainMetadata);
        assert.equal(h.mimetype, "text/plain");
        assert.equal(h.glyph, "📄");
        assert.deepEqual([...h.extensions], [".txt"]);
    });

    it("preview returns a head-oriented TextPreview carrying the content", async () => {
        const h = new TextPlain(plainMetadata);
        const preview = (await h.preview("hello world")) as TextPreview;
        assert.deepEqual(preview, { kind: "text", text: "hello world", orientation: "head" });
    });

    it("preview decodes Uint8Array content as utf-8", async () => {
        const h = new TextPlain(plainMetadata);
        const bytes = new TextEncoder().encode("from bytes");
        const preview = (await h.preview(bytes)) as TextPreview;
        assert.equal(preview.text, "from bytes");
        assert.equal(preview.orientation, "head");
    });

    it("extractRaw is empty (no structural symbols in plain text)", () => {
        const h = new TextPlain(plainMetadata);
        assert.deepEqual(h.extractRaw("any content"), []);
    });

    it("symbolsRaw is empty (no structural symbols in plain text)", () => {
        const h = new TextPlain(plainMetadata);
        assert.equal(h.symbolsRaw("any content"), "");
    });

    it("validate is a no-op (any content is valid plain text)", () => {
        const h = new TextPlain(plainMetadata);
        assert.doesNotThrow(() => h.validate("anything"));
    });
});

describe("TextPlain — text/stream (tail-oriented live data)", () => {
    it("instantiates with text/stream metadata and reports its own mimetype", () => {
        const h = new TextPlain(streamMetadata);
        assert.equal(h.mimetype, "text/stream");
        assert.equal(h.glyph, "📡");
        assert.deepEqual([...h.extensions], []);
    });

    it("preview returns a tail-oriented TextPreview", async () => {
        const h = new TextPlain(streamMetadata);
        const preview = (await h.preview("log line 1\nlog line 2\nlog line 3")) as TextPreview;
        assert.equal(preview.kind, "text");
        assert.equal(preview.orientation, "tail");
        assert.equal(preview.text, "log line 1\nlog line 2\nlog line 3");
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
