import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-haskell")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-haskell via tree-sitter registry", () => {
    it("module header → module symbol", async () => {
        const syms = await h().extractRaw("module Foo where\n");
        const foo = syms.find((s) => s.name === "Foo");
        assert.ok(foo);
        assert.equal(foo.kind, "module");
    });

    it("data and newtype → class", async () => {
        const syms = await h().extractRaw("data Maybe a = Nothing | Just a\nnewtype Age = Age Int\n");
        assert.equal(syms.find((s) => s.name === "Maybe")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "Age")?.kind, "class");
    });

    it("type synonym → type", async () => {
        const syms = await h().extractRaw("type Name = String\n");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "type");
    });

    it("class → interface + method signatures → method", async () => {
        const syms = await h().extractRaw("class Eq a where\n  eq :: a -> a -> Bool\n");
        assert.equal(syms.find((s) => s.name === "Eq")?.kind, "interface");
        assert.equal(syms.find((s) => s.name === "eq")?.kind, "method");
    });

    it("function signature deduplicates function body", async () => {
        const syms = await h().extractRaw("bar :: Int -> Int\nbar x = x + 1\n");
        const bars = syms.filter((s) => s.name === "bar");
        assert.equal(bars.length, 1);
        assert.equal(bars[0]?.kind, "function");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("module ((( broken"));
    });
});

describe("text/x-haskell — container + columns (issue #18)", () => {
    it("class method signatures carry the type class as container; declarations are otherwise flat", async () => {
        const src = "module Foo where\nclass Eq a where\n  eq :: a -> a -> Bool\ndata Maybe a = Nothing | Just a\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Eq")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "eq")?.container, "Eq");
        assert.equal(syms.find((s) => s.name === "Maybe")?.container, undefined);
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "bar :: Int -> Int\nbar x = x + 1\n";
        const syms = await h().extractRaw(src);
        const bar = syms.find((s) => s.name === "bar");
        assert.equal(bar?.container, undefined);
        assert.equal(bar?.column, 1);
        assert.ok((bar?.endColumn ?? 0) >= 1);
    });
});
