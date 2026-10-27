import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationJson from "./ApplicationJson.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

// ─── ApplicationJson.test.ts ───
{
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

describe("{§json-strictness} application/json validate is strict", () => {
    const h = new ApplicationJson(jsonMetadata);

    it("{§json-strictness} accepts well-formed JSON", () => {
        assert.doesNotThrow(() => h.validate(`{"a":1}`));
        assert.doesNotThrow(() => h.validate(`[1,2,3]`));
        assert.doesNotThrow(() => h.validate(`"string"`));
        assert.doesNotThrow(() => h.validate(`42`));
        assert.doesNotThrow(() => h.validate(`null`));
    });

    it("{§json-strictness} throws on malformed JSON", () => {
        assert.throws(() => h.validate(`{not valid}`));
        assert.throws(() => h.validate(`{"a":}`));
        assert.throws(() => h.validate(``));
    });

    it("{§json-strictness} throws on comments (strict mode)", () => {
        assert.throws(() => h.validate(`{ /* comment */ "a": 1 }`));
        assert.throws(() => h.validate(`{ "a": 1 } // trailing comment`));
    });

    it("{§json-strictness} throws on trailing commas (strict mode)", () => {
        assert.throws(() => h.validate(`{"a": 1, "b": 2,}`));
        assert.throws(() => h.validate(`[1, 2, 3,]`));
    });
});

describe("{§json-strictness} application/jsonc validate accepts comments and trailing commas", () => {
    const h = new ApplicationJson(jsoncMetadata);

    it("{§json-strictness} accepts well-formed JSON", () => {
        assert.doesNotThrow(() => h.validate(`{"a":1}`));
    });

    it("{§json-strictness} accepts comments", () => {
        assert.doesNotThrow(() => h.validate(`{ /* block */ "a": 1 }`));
        assert.doesNotThrow(() => h.validate(`{ "a": 1 } // line`));
    });

    it("{§json-strictness} accepts trailing commas", () => {
        assert.doesNotThrow(() => h.validate(`{"a": 1, "b": 2,}`));
        assert.doesNotThrow(() => h.validate(`[1, 2, 3,]`));
    });

    it("{§json-strictness} throws on truly malformed content", () => {
        assert.throws(() => h.validate(`{not even close`));
    });
});

describe("{§json-strictness} every key at every depth is a field symbol", () => {
    const h = new ApplicationJson(jsonMetadata);

    it("{§mimetype-symbol}: key regions count Unicode code points and lone CR lines", () => {
        assert.deepEqual(h.extractRaw('{"😀":1, "later":2,\r"final":3}').map(({ name, line, column, endLine, endColumn }) => ({ name, line, column, endLine, endColumn })), [
            { name: "😀", line: 1, column: 2, endLine: 1, endColumn: 5 },
            { name: "later", line: 1, column: 9, endLine: 1, endColumn: 16 },
            { name: "final", line: 2, column: 1, endLine: 2, endColumn: 8 },
        ]);
    });

    it("{§json-strictness} returns top-level keys as field symbols", () => {
        const result = h.extractRaw(`{"name":"plurnk","version":"0.2.0"}`);
        assert.deepEqual(
            result.map((s) => ({ name: s.name, kind: s.kind })),
            [
                { name: "name", kind: "field" },
                { name: "version", kind: "field" },
            ],
        );
    });

    it("{§json-strictness} recurses into nested objects (every depth, not just top-level)", () => {
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
        const names = new Set(result.map((s) => s.name));
        assert.ok(names.has("scripts"));
        assert.ok(names.has("test"));
        assert.ok(names.has("build"));
        assert.ok(names.has("dependencies"));
        assert.ok(names.has("antlr4ng"));
    });

    it("{§json-strictness} emits separate symbols for the same key name at distinct positions", () => {
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

    it("{§json-strictness} recurses through arrays of objects", () => {
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

    it("{§json-strictness} assigns line numbers from the parser's position tree", () => {
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

    it("{§json-strictness} returns empty array for array root", () => {
        assert.deepEqual(h.extractRaw(`[1,2,3]`), []);
    });

    it("{§json-strictness} returns empty array for scalar root", () => {
        assert.deepEqual(h.extractRaw(`42`), []);
        assert.deepEqual(h.extractRaw(`"hello"`), []);
        assert.deepEqual(h.extractRaw(`null`), []);
        assert.deepEqual(h.extractRaw(`true`), []);
    });

    it("{§json-strictness} extract is non-throwing on malformed JSON (validate is the throwing path)", () => {
        assert.deepEqual(h.extractRaw(`{not valid`), []);
    });

    it("{§json-strictness} handles empty object", () => {
        assert.deepEqual(h.extractRaw(`{}`), []);
    });

    it("{§json-strictness} extracts from JSONC (comments + trailing commas) when handler is application/jsonc", () => {
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
        const names = new Set(result.map((s) => s.name));
        assert.ok(names.has("name"));
        assert.ok(names.has("version"));
    });

    it("{§json-strictness} filters look-alike key patterns inside string values (parser is authoritative)", () => {
        // The string value contains `"fake":` but it's parsed as a string,
        // not a key. jsonc-parser sees only one real property.
        const src = `{"real":"oops \\"fake\\": looks like a key"}`;
        const result = h.extractRaw(src);
        assert.deepEqual(result.map((s) => s.name), ["real"]);
    });
});

describe("{§json-strictness} container is the dotted path of enclosing keys", () => {
    it("{§mimetype-symbol}: keys carry the dotted ancestor-key path as container", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const syms = h.extractRaw(`{"config":{"server":{"host":"x"}},"top":1}`);
        const byName = new Map(syms.map((s) => [s.name, s]));
        assert.equal("container" in byName.get("config")!, false, "top-level key: container absent");
        assert.equal(byName.get("server")!.container, "config");
        assert.equal(byName.get("host")!.container, "config.server");
        assert.equal("container" in byName.get("top")!, false);
    });

    it("{§mimetype-symbol}: array indices contribute nothing to the container path", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const syms = h.extractRaw(`{"users":[{"name":"a"},{"name":"b"}]}`);
        const names = syms.filter((s) => s.name === "name");
        assert.equal(names.length, 2);
        assert.equal(names[0].container, "users");
        assert.equal(names[1].container, "users");
    });
});

describe("{§mimetype-channel-architecture} deepJson is the parsed value", () => {
    it("{§json-strictness} returns the parsed JSON value tree", async () => {
        const h = new ApplicationJson(jsonMetadata);
        const tree = await h.deepJson(`{"name":"Alice","age":30,"tags":["a","b"]}`);
        assert.deepEqual(tree, { name: "Alice", age: 30, tags: ["a", "b"] });
    });

    it("{§json-strictness} returns null for binary content", async () => {
        const h = new ApplicationJson(jsonMetadata);
        assert.equal(await h.deepJson(new Uint8Array([1, 2, 3])), null);
    });

    it("{§json-strictness} returns null on malformed JSON without throwing", async () => {
        const h = new ApplicationJson(jsonMetadata);
        assert.equal(await h.deepJson("not json {{{"), null);
    });

    it("{§json-strictness} application/jsonc deepJson tolerates comments and trailing commas", async () => {
        const h = new ApplicationJson(jsoncMetadata);
        const tree = await h.deepJson(`{ /* a */ "x": 1, "y": 2, }`);
        assert.deepEqual(tree, { x: 1, y: 2 });
    });
});

describe("{§json-strictness} jsonpath selects values at their source spans", () => {
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

    it("{§json-strictness} returns the actual JSON value as matched (string), not a line number", async () => {
        const out = await h.query(src, "jsonpath", "$.users[0].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Alice");
    });

    it("{§json-strictness} returns an object subtree when the jsonpath resolves to one", async () => {
        const out = await h.query(src, "jsonpath", "$.users[1]");
        assert.equal(out.length, 1);
        // jsonc-parser creates objects with null prototype. Spread to compare
        // structural content — prototype doesn't survive JSON serialization
        // on the wire to plurnk-service anyway.
        assert.deepEqual({ ...(out[0].matched as object) }, { name: "Bob", role: "user" });
    });

    it("{§json-strictness} emits one match per wildcard hit with resolved matching path", async () => {
        const out = await h.query(src, "jsonpath", "$.users[*].name");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "Alice");
        assert.equal(out[1].matched, "Bob");
        assert.ok(out[0].matching?.includes("[0]"));
        assert.ok(out[1].matching?.includes("[1]"));
    });

    it("{§json-strictness} maps matches to exact value regions via jsonc-parser positions", async () => {
        const out = await h.query(src, "jsonpath", "$.version");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 6,
            startColumn: 16,
            endLine: 6,
            endColumn: 23,
        }]);
    });

    it("{§json-strictness} throws QueryParseFailureError on malformed JSON", async () => {
        await assert.rejects(
            async () => { await h.query("{not json", "jsonpath", "$.x"); },
            (err: unknown) => err instanceof Error && err.name === "QueryParseFailureError",
        );
    });

    it("{§json-strictness} inherits regex against the raw JSON source", async () => {
        const out = await h.query(src, "regex", '"name": "(\\w+)"');
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["Alice"]);
        assert.deepEqual(out[1].matched, ["Bob"]);
    });
});

describe("{§json-strictness} xpath and jsonpath agree on exact columns", () => {
    const metadata = { mimetype: "application/json", glyph: "{}", extensions: [".json"] as const };
    const content = "{\"items\":[{\"name\":\"alpha\",\"size\":3},{\"name\":\"beta\",\"size\":7}],\"host\":\"db.internal\"}";

    it("{§json-strictness} deep-xml carries pk:column/pk:endColumn from the parse tree", async () => {
        const xml = await new ApplicationJson(metadata).deepXml(content);
        assert.match(xml, /<name pk:line="1" pk:endLine="1" pk:column="19" pk:endColumn="26">alpha<\/name>/);
    });

    it("{§json-strictness} an xpath row reports the same region as the jsonpath row", async () => {
        const h = new ApplicationJson(metadata);
        const viaXpath = await h.query(content, "xpath", "//items/name");
        const viaJsonpath = await h.query(content, "jsonpath", "$.items[*].name");
        assert.deepEqual(viaXpath.map((m) => m.regions), viaJsonpath.map((m) => m.regions));
        assert.deepEqual(viaXpath[0]?.regions, [{ startLine: 1, startColumn: 19, endLine: 1, endColumn: 26 }]);
    });
});
}

// ─── queryRegions.test.ts ───
{
// {§zero-width-column-one-insert} — JSONPath selects the value's source text.






const h = new ApplicationJson({ mimetype: "application/json", glyph: "{}", extensions: [".json"] as const });

describe("{§json-strictness} structural match regions", () => {
    it("{§json-strictness} XPath data keys cannot impersonate tree metadata or disappear", async () => {
        const source = '{"type":"custom","text":"body","line":99,"endLine":100,"attrs":{"level":3},"empty":null}';
        const coordinates = new TextCoordinates(source);
        for (const [path, xml] of [["$.type", "//type"], ["$.text", "//text"], ["$.line", "//line"], ["$.endLine", "//endLine"], ["$.attrs.level", "//attrs/level"], ["$.empty", "//empty"]]) {
            const [json] = await h.query(source, "jsonpath", path);
            const matches = await h.query(source, "xpath", xml);
            assert.equal(matches.length, 1, xml);
            assert.deepEqual(matches[0].regions, json.regions, xml);
            const region = matches[0].regions![0];
            const text = source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
            assert.notEqual(text.length, 0, xml);
        }
    });
    it("{§json-strictness} classifies exact, enclosing, and locator-only evidence explicitly", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}',
                dialect: "jsonpath",
                pattern: "$.xs[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 4, startColumn: 5, endLine: 4, endColumn: 8,
                }]],
            },
            {
                source: '{\n  "host": "db.internal",\n  "pool": 5\n}',
                dialect: "jsonpath",
                pattern: "$.host",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 11, endLine: 2, endColumn: 24,
                }]],
            },
            {
                source: '{\n  "host": "db.internal"\n}',
                dialect: "xpath",
                pattern: "count(//host)",
                verdict: "locator-only",
            },
        ]);
    });

    it("{§json-strictness} a multi-line value excludes its member name and colon", async () => {
        const src = '{\n  "cfg": {\n    "a": 1,\n    "b": 2\n  }\n}';
        const out = await h.query(src, "jsonpath", "$.cfg");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 10, endLine: 5, endColumn: 4,
        }]);
    });

    it("{§json-strictness} xpath and jsonpath both report honest regions in the same readable text", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": {\n    "size": 5\n  }\n}';
        const jh = await h.query(src, "jsonpath", "$.host");
        const xh = await h.query(src, "xpath", "//host");
        assert.equal(xh[0].regions?.[0].startLine, jh[0].regions?.[0].startLine);
        const js = await h.query(src, "jsonpath", "$.pool.size");
        const xs = await h.query(src, "xpath", "//size");
        // #372 — the deep-xml projection carries the parse tree's columns, so the xpath
        // row is the jsonpath row's exact region, not the enclosing line.
        assert.deepEqual(xs[0].regions, js[0].regions);
        assert.deepEqual(xs[0].regions, [{
            startLine: 4, startColumn: 13, endLine: 4, endColumn: 14,
        }]);
    });

    for (const { pattern, selected } of [
        { pattern: "$['']", selected: '"empty"' },
        { pattern: "$['0']", selected: '"zero"' },
        { pattern: "$['01']", selected: '"leading"' },
        { pattern: "$['a/b~c']", selected: '"escaped"' },
        { pattern: "$.list[0]['0']", selected: '"nested"' },
        { pattern: "$.list[1]", selected: '"array"' },
        { pattern: "$.quoted", selected: '"a\\\"b"' },
        { pattern: "$.unicode", selected: '"\\u0061"' },
    ]) {
        it(`{§json-strictness} ${pattern} retains the exact value spelling at its JSON Pointer`, async () => {
            const source = '{"":"empty","0":"zero","01":"leading","a/b~c":"escaped","list":[{"0":"nested"},"array"],"quoted":"a\\\"b","unicode":"\\u0061"}';
            const [match] = await h.query(source, "jsonpath", pattern);
            assert.ok(match?.regions?.length === 1, JSON.stringify(match));
            const [region] = match.regions;
            const coordinates = new TextCoordinates(source);
            assert.equal(source.slice(
                coordinates.offsetAtPosition(region.startLine, region.startColumn),
                coordinates.offsetAtPosition(region.endLine, region.endColumn),
            ), selected);
        });
    }
});
}
