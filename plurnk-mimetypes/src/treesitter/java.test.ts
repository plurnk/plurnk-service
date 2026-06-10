import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-java")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-java via tree-sitter registry", () => {
    it("class + method → class + method", async () => {
        const src = "public class Foo {\n  public void bar(int x, String y) {}\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.kind, "class");
        const bar = syms.find((s) => s.name === "bar");
        assert.equal(bar?.kind, "method");
        assert.deepEqual(bar?.params, ["x", "y"]);
    });

    it("interface → interface", async () => {
        const syms = await h().extractRaw("public interface Doable {\n  void doIt();\n}\n");
        assert.equal(syms.find((s) => s.name === "Doable")?.kind, "interface");
        assert.equal(syms.find((s) => s.name === "doIt")?.kind, "method");
    });

    it("enum + enum_constant → enum + constant", async () => {
        const syms = await h().extractRaw("enum Color { RED, GREEN, BLUE }\n");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "RED")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "GREEN")?.kind, "constant");
    });

    it("record → class", async () => {
        const syms = await h().extractRaw("record Point(int x, int y) {}\n");
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
    });

    it("field_declaration → field", async () => {
        const src = "class C {\n  private int count;\n  public String name;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "count")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
    });

    it("constructor → method", async () => {
        const src = "class C {\n  public C(int x) {}\n}\n";
        const syms = await h().extractRaw(src);
        const ctor = syms.find((s) => s.name === "C" && s.kind === "method");
        assert.ok(ctor, "constructor should produce a method symbol");
        assert.deepEqual(ctor?.params, ["x"]);
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});

describe("text/x-java — container + columns (issue #18)", () => {
    it("members carry the enclosing class as container; nesting is dotted", async () => {
        const src = "class Outer {\n  class Inner {\n    void deep() {}\n  }\n  void shallow() {}\n  int count;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Outer")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "Inner")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "deep")?.container, "Outer.Inner");
        assert.equal(syms.find((s) => s.name === "shallow")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "count")?.container, "Outer");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "enum Color { RED }\n";
        const syms = await h().extractRaw(src);
        const color = syms.find((s) => s.name === "Color");
        assert.equal(color?.container, undefined);
        assert.equal(color?.column, 1);
        assert.equal(syms.find((s) => s.name === "RED")?.container, "Color");
        assert.ok((color?.endColumn ?? 0) >= 1);
    });
});
