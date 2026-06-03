import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-cpp")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-cpp via tree-sitter registry", () => {
    it("class with method → class + method", async () => {
        const src = "class Foo {\npublic:\n  void bar(int x) { }\n};\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.kind, "class");
        const bar = syms.find((s) => s.name === "bar");
        assert.equal(bar?.kind, "method");
        assert.deepEqual(bar?.params, ["x"]);
    });

    it("struct → class with fields", async () => {
        const syms = await h().extractRaw("struct P { int x; int y; };\n");
        assert.equal(syms.find((s) => s.name === "P")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "x")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "y")?.kind, "field");
    });

    it("namespace → module; nested types surface", async () => {
        const src = "namespace ns {\nclass Inner { };\nint global = 1;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "ns")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "Inner")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "global")?.kind, "variable");
    });

    it("enum + enumerators", async () => {
        const syms = await h().extractRaw("enum Color { RED, GREEN };\n");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "RED")?.kind, "constant");
    });

    it("template_declaration → unwrap to inner class/function", async () => {
        const src = "template<typename T>\nclass Box { T value; };\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Box")?.kind, "class");
    });

    it("using alias → type", async () => {
        const syms = await h().extractRaw("using MyInt = int;\n");
        assert.equal(syms.find((s) => s.name === "MyInt")?.kind, "type");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});
