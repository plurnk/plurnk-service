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

    it("extract returns an empty array (text/plain has no structural symbols)", () => {
        const handler = new TextPlain(metadata);
        assert.deepEqual(handler.extract("any content"), []);
    });

    it("symbols returns empty string for empty extract", () => {
        const handler = new TextPlain(metadata);
        assert.equal(handler.symbols("any content"), "");
    });

    it("validate is a no-op (any content is valid plain text)", () => {
        const handler = new TextPlain(metadata);
        assert.doesNotThrow(() => handler.validate("anything"));
    });

    it("preview returns empty when called with default tokenize (extract is empty)", async () => {
        const handler = new TextPlain(metadata);
        // BaseHandler.preview derives from extract(); for text/plain that's [].
        // The orchestrator's raw-content fallback is what supplies preview content
        // in production — the handler itself produces empty.
        assert.equal(await handler.preview("any content", 1000), "");
    });
});
