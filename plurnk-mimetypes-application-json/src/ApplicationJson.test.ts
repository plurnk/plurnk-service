import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationJson from "./ApplicationJson.ts";

const jsonMetadata = {
    mimetype: "application/json",
    glyph: "📋",
    extensions: [".json"] as const,
};

const jsoncMetadata = {
    mimetype: "application/jsonc",
    glyph: "📋",
    extensions: [".jsonc"] as const,
};

describe("ApplicationJson — instantiation", () => {
    it("instantiates with application/json metadata", () => {
        const h = new ApplicationJson(jsonMetadata);
        assert.equal(h.mimetype, "application/json");
        assert.equal(h.glyph, "📋");
    });

    it("instantiates with application/jsonc metadata", () => {
        const h = new ApplicationJson(jsoncMetadata);
        assert.equal(h.mimetype, "application/jsonc");
        assert.equal(h.glyph, "📋");
    });
});

describe("ApplicationJson — validate (application/json is strict)", () => {
    const h = new ApplicationJson(jsonMetadata);

    it("accepts well-formed JSON", () => {
        assert.doesNotThrow(() => h.validate(`{"a":1}`));
        assert.doesNotThrow(() => h.validate(`[1,2,3]`));
        assert.doesNotThrow(() => h.validate(`"string"`));
        assert.doesNotThrow(() => h.validate(`42`));
        assert.doesNotThrow(() => h.validate(`null`));
    });

    it("throws on malformed JSON", () => {
        assert.throws(() => h.validate(`{not valid}`));
        assert.throws(() => h.validate(`{"a":}`));
        assert.throws(() => h.validate(``));
    });

    it("throws on comments (strict mode)", () => {
        assert.throws(() => h.validate(`{ /* comment */ "a": 1 }`));
        assert.throws(() => h.validate(`{ "a": 1 } // trailing comment`));
    });

    it("throws on trailing commas (strict mode)", () => {
        assert.throws(() => h.validate(`{"a": 1, "b": 2,}`));
        assert.throws(() => h.validate(`[1, 2, 3,]`));
    });
});

describe("ApplicationJson — validate (application/jsonc is permissive)", () => {
    const h = new ApplicationJson(jsoncMetadata);

    it("accepts well-formed JSON", () => {
        assert.doesNotThrow(() => h.validate(`{"a":1}`));
    });

    it("accepts comments", () => {
        assert.doesNotThrow(() => h.validate(`{ /* block */ "a": 1 }`));
        assert.doesNotThrow(() => h.validate(`{ "a": 1 } // line`));
    });

    it("accepts trailing commas", () => {
        assert.doesNotThrow(() => h.validate(`{"a": 1, "b": 2,}`));
        assert.doesNotThrow(() => h.validate(`[1, 2, 3,]`));
    });

    it("throws on truly malformed content", () => {
        assert.throws(() => h.validate(`{not even close`));
    });
});

describe("ApplicationJson — extract", () => {
    const h = new ApplicationJson(jsonMetadata);

    it("returns top-level keys as field symbols", () => {
        const result = h.extract(`{"name":"plurnk","version":"0.2.0"}`);
        assert.deepEqual(
            result.map((s) => ({ name: s.name, kind: s.kind })),
            [
                { name: "name", kind: "field" },
                { name: "version", kind: "field" },
            ],
        );
    });

    it("recurses into nested objects (every depth, not just top-level)", () => {
        const src = [
            "{",
            '    "scripts": {',
            '        "test": "node --test",',
            '        "build": "tsc"',
            "    },",
            '    "dependencies": {',
            '        "antlr4ng": "^3.0.0"',
            "    }",
            "}",
        ].join("\n");
        const result = h.extract(src);
        const names = result.map((s) => s.name);
        assert.ok(names.includes("scripts"));
        assert.ok(names.includes("test"));
        assert.ok(names.includes("build"));
        assert.ok(names.includes("dependencies"));
        assert.ok(names.includes("antlr4ng"));
    });

    it("emits separate symbols for the same key name at distinct positions", () => {
        const src = [
            "{",
            '    "user": { "name": "alice" },',
            '    "admin": { "name": "bob" }',
            "}",
        ].join("\n");
        const result = h.extract(src);
        const nameEntries = result.filter((s) => s.name === "name");
        assert.equal(nameEntries.length, 2);
        assert.equal(nameEntries[0].line, 2);
        assert.equal(nameEntries[1].line, 3);
    });

    it("recurses through arrays of objects", () => {
        const src = [
            "{",
            '    "users": [',
            '        { "id": 1 },',
            '        { "id": 2 }',
            "    ]",
            "}",
        ].join("\n");
        const result = h.extract(src);
        const names = result.map((s) => s.name);
        assert.ok(names.includes("users"));
        assert.equal(names.filter((n) => n === "id").length, 2);
    });

    it("assigns line numbers from the parser's position tree", () => {
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

    it("returns empty array for array root", () => {
        assert.deepEqual(h.extract(`[1,2,3]`), []);
    });

    it("returns empty array for scalar root", () => {
        assert.deepEqual(h.extract(`42`), []);
        assert.deepEqual(h.extract(`"hello"`), []);
        assert.deepEqual(h.extract(`null`), []);
        assert.deepEqual(h.extract(`true`), []);
    });

    it("extract is non-throwing on malformed JSON (validate is the throwing path)", () => {
        assert.deepEqual(h.extract(`{not valid`), []);
    });

    it("handles empty object", () => {
        assert.deepEqual(h.extract(`{}`), []);
    });

    it("extracts from JSONC (comments + trailing commas) when handler is application/jsonc", () => {
        const jsoncHandler = new ApplicationJson(jsoncMetadata);
        const src = [
            "{",
            "    // top-level config",
            '    "name": "plurnk",',
            "    /* block comment */",
            '    "version": "0.2.0",  // with trailing comma',
            "}",
        ].join("\n");
        const result = jsoncHandler.extract(src);
        const names = result.map((s) => s.name);
        assert.ok(names.includes("name"));
        assert.ok(names.includes("version"));
    });

    it("filters look-alike key patterns inside string values (parser is authoritative)", () => {
        // The string value contains `"fake":` but it's parsed as a string,
        // not a key. jsonc-parser sees only one real property.
        const src = `{"real":"oops \\"fake\\": looks like a key"}`;
        const result = h.extract(src);
        assert.deepEqual(result.map((s) => s.name), ["real"]);
    });
});

describe("ApplicationJson — framework integration via BaseHandler", () => {
    it("symbols renders extracted fields via format()", () => {
        const h = new ApplicationJson(jsonMetadata);
        const out = h.symbols(`{"a":1,"b":2}`);
        assert.ok(out.includes("field a"));
        assert.ok(out.includes("field b"));
    });
});
