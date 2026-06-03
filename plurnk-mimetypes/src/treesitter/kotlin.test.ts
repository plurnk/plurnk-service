import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-kotlin")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-kotlin via tree-sitter registry", () => {
    it("class + fun + property", async () => {
        const src = "class Foo {\n  val name: String = \"\"\n  fun greet(prefix: String): String = prefix + name\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Foo")?.kind, "class");
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.kind, "method");
        assert.deepEqual(greet?.params, ["prefix"]);
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
    });

    it("top-level fun → function", async () => {
        const syms = await h().extractRaw("fun add(a: Int, b: Int): Int = a + b\n");
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.kind, "function");
        assert.deepEqual(add?.params, ["a", "b"]);
    });

    it("object → class (singleton)", async () => {
        const syms = await h().extractRaw("object Singleton { fun x() = 1 }\n");
        assert.equal(syms.find((s) => s.name === "Singleton")?.kind, "class");
    });

    it("package_header → module", async () => {
        const syms = await h().extractRaw("package com.example.app\nclass C {}\n");
        const m = syms.find((s) => s.kind === "module");
        assert.ok(m, "package_header should produce a module symbol");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});
