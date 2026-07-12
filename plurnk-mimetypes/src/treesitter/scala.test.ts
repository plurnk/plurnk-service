import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-scala")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-scala via tree-sitter registry", () => {
    it("class + def → class + method with params", async () => {
        const src = "class Foo {\n  def bar(x: Int, y: Int): Int = x + y\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.kind, "class");
        const bar = syms.find((s) => s.name === "bar");
        assert.equal(bar?.kind, "method");
        assert.deepEqual(bar?.params, ["x", "y"]);
    });

    it("object → class (singleton)", async () => {
        const syms = await h().extractRaw("object Main { def main(args: Array[String]): Unit = () }\n");
        assert.equal(syms.find((s) => s.name === "Main")?.kind, "class");
    });

    it("trait → interface", async () => {
        const syms = await h().extractRaw("trait Doable { def run(): Unit }\n");
        assert.equal(syms.find((s) => s.name === "Doable")?.kind, "interface");
    });

    it("top-level val → constant; class-body val → field", async () => {
        const src = "val pi = 3.14\nclass C { val x = 1 }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "pi")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "x")?.kind, "field");
    });

    it("type → type", async () => {
        const syms = await h().extractRaw("type Name = String\n");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "type");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});

describe("text/x-scala — container + columns (issue #18)", () => {
    it("members carry the enclosing scope as container; nesting is dotted", async () => {
        const src = "object Outer {\n  object Inner {\n    def deep() = 1\n  }\n  def shallow() = 1\n  val k = 1\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Outer")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "Inner")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "deep")?.container, "Outer.Inner");
        assert.equal(syms.find((s) => s.name === "shallow")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "k")?.container, "Outer");
    });

    it("package blocks qualify the container but keep top-level kinds", async () => {
        const src = "package foo.bar {\n  class C {\n    def m() = 1\n  }\n  def free() = 1\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "C")?.container, "foo.bar");
        assert.equal(syms.find((s) => s.name === "m")?.container, "foo.bar.C");
        const free = syms.find((s) => s.name === "free");
        assert.equal(free?.kind, "function");
        assert.equal(free?.container, "foo.bar");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "def solo(x: Int) = x\n";
        const syms = await h().extractRaw(src);
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
