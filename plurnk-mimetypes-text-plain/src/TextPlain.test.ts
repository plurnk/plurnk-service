import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlain from "./TextPlain.ts";
import type { SymbolPreview } from "@plurnk/plurnk-mimetypes";

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

    it("preview returns an empty SymbolPreview — no body leak into the radar", async () => {
        const handler = new TextPlain(metadata);
        const preview = (await handler.preview("hello world")) as SymbolPreview;
        assert.equal(preview.kind, "symbols");
        assert.deepEqual([...preview.symbols], []);
    });

    it("inherits query: regex against text body works", async () => {
        const handler = new TextPlain(metadata);
        const out = await handler.query("error: foo\nok: bar\nerror: baz", "regex", "error: \\w+");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "error: foo");
        assert.equal(out[1].matched, "error: baz");
    });

    it("inherits query: jsonpath against the (empty) outline returns no matches", async () => {
        const handler = new TextPlain(metadata);
        const out = await handler.query("any text", "jsonpath", "$.anything");
        assert.deepEqual(out, []);
    });
});
