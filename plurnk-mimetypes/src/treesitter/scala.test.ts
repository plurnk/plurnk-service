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
