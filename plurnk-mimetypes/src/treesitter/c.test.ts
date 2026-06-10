import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-c")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-c via tree-sitter registry", () => {
    it("function_definition → function with params", async () => {
        const syms = await h().extractRaw("int add(int a, int b) { return a + b; }\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("struct + union with body → class", async () => {
        const syms = await h().extractRaw("struct Point { int x; int y; };\nunion U { int i; float f; };\n");
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "U")?.kind, "class");
    });

    it("enum → enum + enumerators as constants", async () => {
        const syms = await h().extractRaw("enum Color { RED, GREEN, BLUE };\n");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "RED")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "GREEN")?.kind, "constant");
    });

    it("typedef → type", async () => {
        const syms = await h().extractRaw("typedef int my_int_t;\n");
        assert.equal(syms.find((s) => s.name === "my_int_t")?.kind, "type");
    });

    it("file-scope variable → variable; function prototype excluded", async () => {
        const syms = await h().extractRaw("int counter = 0;\nint missing_proto(int x);\n");
        assert.equal(syms.find((s) => s.name === "counter")?.kind, "variable");
        assert.equal(syms.find((s) => s.name === "missing_proto"), undefined);
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("int ((( broken"));
    });
});

describe("text/x-c — container + columns (issue #18)", () => {
    it("enumerators carry the named enum as container", async () => {
        const syms = await h().extractRaw("enum Color { RED, GREEN };\n");
        assert.equal(syms.find((s) => s.name === "Color")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "RED")?.container, "Color");
        assert.equal(syms.find((s) => s.name === "GREEN")?.container, "Color");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const syms = await h().extractRaw("int solo(void) { return 0; }\n");
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
