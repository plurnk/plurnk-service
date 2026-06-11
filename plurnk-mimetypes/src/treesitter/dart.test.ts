import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-dart")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-dart via tree-sitter registry", () => {
    it("class + method + field", async () => {
        const src = "class Foo {\n  String name = '';\n  void greet(String prefix) {}\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.kind, "class");
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.kind, "method");
        assert.deepEqual(greet?.params, ["prefix"]);
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
    });

    it("top-level function_signature → function", async () => {
        const syms = await h().extractRaw("int add(int a, int b) => a + b;\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("mixin → class", async () => {
        const syms = await h().extractRaw("mixin Greeter { void hi() {} }\n");
        assert.equal(syms.find((s) => s.name === "Greeter")?.kind, "class");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});

describe("text/x-dart — container + columns (issue #18)", () => {
    it("class and mixin members carry the owning declaration as container", async () => {
        const src = "class Foo {\n  String name = '';\n  void greet(String prefix) {}\n}\nmixin Greeter { void hi() {} }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "name")?.container, "Foo");
        assert.equal(syms.find((s) => s.name === "greet")?.container, "Foo");
        assert.equal(syms.find((s) => s.name === "hi")?.container, "Greeter");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "int add(int a, int b) => a + b;\n";
        const syms = await h().extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.container, undefined);
        assert.equal(add?.column, 1);
        assert.ok((add?.endColumn ?? 0) >= 1);
    });
});

describe("text/x-dart — def spans cover sibling bodies (issue #22)", () => {
    it("multi-line method def endLine covers the body's last line", async () => {
        const src = "class Foo {\n  int twice(int n) {\n    final m = n * 2;\n    return m;\n  }\n}\n";
        const syms = await h().extractRaw(src);
        const twice = syms.find((s) => s.name === "twice");
        assert.equal(twice?.line, 2);
        assert.equal(twice?.endLine, 5);
    });

    it("multi-line top-level function def endLine covers the body's last line", async () => {
        const src = "int add(int a, int b) {\n  return a + b;\n}\n";
        const syms = await h().extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.line, 1);
        assert.equal(add?.endLine, 3);
    });

    it("multi-line getter and constructor bodies are covered", async () => {
        const src = "class Foo {\n  Foo(this.x) {\n    init();\n  }\n  int get size {\n    return 42;\n  }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo" && s.kind === "method")?.endLine, 4);
        assert.equal(syms.find((s) => s.name === "size")?.endLine, 7);
    });
});

describe("text/x-dart — enum constants surface from the enum body", () => {
    it("emits each enum constant with the enum as container", async () => {
        const src = "enum Color {\n  red,\n  green,\n  blue,\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "red")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "red")?.container, "Color");
        assert.equal(syms.find((s) => s.name === "blue")?.container, "Color");
    });
});
