import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationJson from "./ApplicationJson.ts";

const metadata = {
    mimetype: "application/json",
    glyph: "📋",
    extensions: [".json"] as const,
};

describe("ApplicationJson", () => {
    it("instantiates with metadata", () => {
        const h = new ApplicationJson(metadata);
        assert.equal(h.mimetype, "application/json");
        assert.equal(h.glyph, "📋");
    });

    it("validate accepts valid JSON", () => {
        const h = new ApplicationJson(metadata);
        assert.doesNotThrow(() => h.validate(`{"a":1}`));
        assert.doesNotThrow(() => h.validate(`[1,2,3]`));
        assert.doesNotThrow(() => h.validate(`"string"`));
        assert.doesNotThrow(() => h.validate(`42`));
        assert.doesNotThrow(() => h.validate(`null`));
    });

    it("validate throws on malformed JSON", () => {
        const h = new ApplicationJson(metadata);
        assert.throws(() => h.validate(`{not valid}`));
        assert.throws(() => h.validate(`{"a":}`));
        assert.throws(() => h.validate(``));
    });

    it("extract returns top-level object keys as field symbols", () => {
        const h = new ApplicationJson(metadata);
        const result = h.extract(`{"name":"plurnk","version":"0.1.0","keywords":["a","b"]}`);
        assert.deepEqual(
            result.map((s) => ({ name: s.name, kind: s.kind })),
            [
                { name: "name", kind: "field" },
                { name: "version", kind: "field" },
                { name: "keywords", kind: "field" },
            ],
        );
    });

    it("extract assigns line numbers from a source scan", () => {
        const h = new ApplicationJson(metadata);
        const src = [
            "{",
            '    "first": 1,',
            '    "second": 2,',
            '    "third": 3',
            "}",
        ].join("\n");
        const result = h.extract(src);
        const byName = new Map(result.map((s) => [s.name, s.line]));
        assert.equal(byName.get("first"), 2);
        assert.equal(byName.get("second"), 3);
        assert.equal(byName.get("third"), 4);
    });

    it("extract returns empty array for array root", () => {
        const h = new ApplicationJson(metadata);
        assert.deepEqual(h.extract(`[1,2,3]`), []);
    });

    it("extract returns empty array for scalar root", () => {
        const h = new ApplicationJson(metadata);
        assert.deepEqual(h.extract(`42`), []);
        assert.deepEqual(h.extract(`"hello"`), []);
        assert.deepEqual(h.extract(`null`), []);
        assert.deepEqual(h.extract(`true`), []);
    });

    it("extract returns empty array for malformed JSON (doesn't throw)", () => {
        const h = new ApplicationJson(metadata);
        // extract is non-throwing per framework contract; validate is the
        // throwing path.
        assert.deepEqual(h.extract(`{not valid`), []);
    });

    it("extract ignores nested keys (only top-level)", () => {
        const h = new ApplicationJson(metadata);
        const result = h.extract(`{"outer":{"inner":1,"deep":{"deeper":2}}}`);
        assert.deepEqual(result.map((s) => s.name), ["outer"]);
    });

    it("extract handles empty object", () => {
        const h = new ApplicationJson(metadata);
        assert.deepEqual(h.extract(`{}`), []);
    });

    it("symbols renders extracted fields via framework format()", () => {
        const h = new ApplicationJson(metadata);
        const out = h.symbols(`{"a":1,"b":2}`);
        // format() renders "field name [line]" or "[line-endLine]"
        assert.ok(out.includes("field a"));
        assert.ok(out.includes("field b"));
    });
});
