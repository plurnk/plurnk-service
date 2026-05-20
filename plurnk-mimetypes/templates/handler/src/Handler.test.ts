import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {{CLASS_NAME}} from "./{{CLASS_NAME}}.ts";

const metadata = {
    mimetype: "{{MIMETYPE}}",
    glyph: "{{GLYPH}}",
    extensions: {{EXTENSIONS}} as const,
};

describe("{{CLASS_NAME}}", () => {
    it("instantiates with metadata", () => {
        const handler = new {{CLASS_NAME}}(metadata);
        assert.equal(handler.mimetype, "{{MIMETYPE}}");
        assert.equal(handler.glyph, "{{GLYPH}}");
    });

    it("extract returns an array (TODO: replace with real assertions)", () => {
        const handler = new {{CLASS_NAME}}(metadata);
        const result = handler.extract("sample content");
        assert.ok(Array.isArray(result));
    });

    // TODO: add tests for the actual declarations this handler extracts.
});
