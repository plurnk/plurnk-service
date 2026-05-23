import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlain from "./TextPlain.ts";

const metadata = {
    mimetype: "text/plain",
    glyph: "📄",
    extensions: [".txt"] as const,
};

describe("TextPlain", () => {
    it("instantiates with metadata", () => {
        const handler = new TextPlain(metadata);
        assert.equal(handler.mimetype, "text/plain");
        assert.equal(handler.glyph, "📄");
        assert.deepEqual([...handler.extensions], [".txt"]);
    });

    it("extractRaw returns an empty array (text/plain has no structural symbols)", () => {
        const handler = new TextPlain(metadata);
        assert.deepEqual(handler.extractRaw("any content"), []);
    });

    it("symbolsRaw returns empty string for empty extractRaw", () => {
        const handler = new TextPlain(metadata);
        assert.equal(handler.symbolsRaw("any content"), "");
    });

    it("validate is a no-op (any content is valid plain text)", () => {
        const handler = new TextPlain(metadata);
        assert.doesNotThrow(() => handler.validate("anything"));
    });

    it("preview returns a head-oriented text Preview carrying the content", async () => {
        const handler = new TextPlain(metadata);
        const preview = await handler.preview("hello world");
        assert.deepEqual(preview, {
            kind: "text",
            text: "hello world",
            orientation: "head",
        });
    });
});
