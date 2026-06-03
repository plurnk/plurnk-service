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
        const result = h.extractRaw(`{"name":"plurnk","version":"0.2.0"}`);
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
        const result = h.extractRaw(src);
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
        const result = h.extractRaw(src);
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
        const result = h.extractRaw(src);
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
        const result = h.extractRaw(src);
        const byName = new Map(result.map((s) => [s.name, s.line]));
        assert.equal(byName.get("first"), 2);
        assert.equal(byName.get("second"), 3);
        assert.equal(byName.get("third"), 4);
    });

    it("returns empty array for array root", () => {
        assert.deepEqual(h.extractRaw(`[1,2,3]`), []);
    });

    it("returns empty array for scalar root", () => {
        assert.deepEqual(h.extractRaw(`42`), []);
        assert.deepEqual(h.extractRaw(`"hello"`), []);
        assert.deepEqual(h.extractRaw(`null`), []);
        assert.deepEqual(h.extractRaw(`true`), []);
    });

    it("extract is non-throwing on malformed JSON (validate is the throwing path)", () => {
        assert.deepEqual(h.extractRaw(`{not valid`), []);
    });

    it("handles empty object", () => {
        assert.deepEqual(h.extractRaw(`{}`), []);
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
        const result = jsoncHandler.extractRaw(src);
        const names = result.map((s) => s.name);
        assert.ok(names.includes("name"));
        assert.ok(names.includes("version"));
    });

    it("filters look-alike key patterns inside string values (parser is authoritative)", () => {
        // The string value contains `"fake":` but it's parsed as a string,
        // not a key. jsonc-parser sees only one real property.
        const src = `{"real":"oops \\"fake\\": looks like a key"}`;
        const result = h.extractRaw(src);
        assert.deepEqual(result.map((s) => s.name), ["real"]);
    });
});

describe("ApplicationJson — framework integration via BaseHandler", () => {
    it("symbolsRaw renders extracted fields via format()", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const out = await h.symbolsRaw(`{"a":1,"b":2}`);
        assert.ok(out.includes("field a"));
        assert.ok(out.includes("field b"));
    });

    it("preview returns a SymbolPreview wrapping extractRaw output", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const preview = await h.preview(`{"a":1,"b":2}`);
        assert.equal(preview?.kind, "symbols");
        if (preview?.kind !== "symbols") return;
        const names = [...preview.symbols].map((s) => s.name);
        assert.deepEqual(names, ["a", "b"]);
    });
});

describe("ApplicationJson — deepJson (issue #10 channel)", () => {
    it("returns the parsed JSON value tree", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const tree = await h.deepJson(`{"name":"Alice","age":30,"tags":["a","b"]}`);
        assert.deepEqual(tree, { name: "Alice", age: 30, tags: ["a", "b"] });
    });

    it("returns null for binary content", async () => {
        const h = new ApplicationJson(jsonMetadata);
        assert.equal(await h.deepJson(new Uint8Array([1, 2, 3])), null);
    });

    it("returns null on malformed JSON without throwing", async () => {
        const h = new ApplicationJson(jsonMetadata);
        assert.equal(await h.deepJson("not json {{{"), null);
    });

    it("application/jsonc deepJson tolerates comments and trailing commas", async () => {
        const h = new ApplicationJson(jsoncMetadata);
        const tree = await h.deepJson(`{ /* a */ "x": 1, "y": 2, }`);
        assert.deepEqual(tree, { x: 1, y: 2 });
    });
});

describe("ApplicationJson — query (jsonpath against parsed value)", () => {
    const h = new ApplicationJson(jsonMetadata);
    const src = [
        "{",
        '    "users": [',
        '        { "name": "Alice", "role": "admin" },',
        '        { "name": "Bob", "role": "user" }',
        "    ],",
        '    "version": "0.6.0"',
        "}",
    ].join("\n");

    it("returns the actual JSON value as matched (string), not a line number", async () => {
        const out = await h.query(src, "jsonpath", "$.users[0].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Alice");
    });

    it("returns an object subtree when the jsonpath resolves to one", async () => {
        const out = await h.query(src, "jsonpath", "$.users[1]");
        assert.equal(out.length, 1);
        // jsonc-parser creates objects with null prototype. Spread to compare
        // structural content — prototype doesn't survive JSON serialization
        // on the wire to plurnk-service anyway.
        assert.deepEqual({ ...(out[0].matched as object) }, { name: "Bob", role: "user" });
    });

    it("emits one match per wildcard hit with resolved matching path", async () => {
        const out = await h.query(src, "jsonpath", "$.users[*].name");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "Alice");
        assert.equal(out[1].matched, "Bob");
        assert.ok(out[0].matching?.includes("[0]"));
        assert.ok(out[1].matching?.includes("[1]"));
    });

    it("maps matches back to source lines via jsonc-parser positions", async () => {
        const out = await h.query(src, "jsonpath", "$.version");
        assert.equal(out.length, 1);
        // "version" key is on line 6
        assert.equal(out[0].line, 6);
    });

    it("throws QueryParseFailureError on malformed JSON", async () => {
        await assert.rejects(
            async () => { await h.query("{not json", "jsonpath", "$.x"); },
            (err: unknown) => err instanceof Error && err.name === "QueryParseFailureError",
        );
    });

    it("inherits regex against the raw JSON source", async () => {
        const out = await h.query(src, "regex", '"name": "(\\w+)"');
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["Alice"]);
        assert.deepEqual(out[1].matched, ["Bob"]);
    });
});
