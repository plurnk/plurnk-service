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
