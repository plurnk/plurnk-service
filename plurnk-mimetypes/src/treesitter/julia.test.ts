import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-julia")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-julia via tree-sitter registry", () => {
    it("module + struct + function + abstract", async () => {
        const src = "module M\nstruct Point\n  x::Int\nend\nfunction add(a, b) a + b end\nabstract type Shape end\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "M")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.kind, "method");
        assert.deepEqual(add?.params, ["a", "b"]);
        assert.equal(syms.find((s) => s.name === "Shape")?.kind, "class");
    });

    it("short_function_definition → function", async () => {
        const syms = await h().extractRaw("sq(x) = x * x\n");
        const sq = syms.find((s) => s.name === "sq");
        assert.equal(sq?.kind, "function");
        assert.deepEqual(sq?.params, ["x"]);
    });

    it("mutable struct → class", async () => {
        const syms = await h().extractRaw("mutable struct Counter\n  n::Int\nend\n");
        assert.equal(syms.find((s) => s.name === "Counter")?.kind, "class");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("module ((( broken"));
    });
});

describe("text/x-julia — container + columns (issue #18)", () => {
    it("symbols carry the enclosing module path as container; nesting is dotted", async () => {
        const src = "module Outer\nmodule Inner\nf(x) = x\nend\nstruct Point\n  x::Int\nend\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Outer")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "Inner")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "f")?.container, "Outer.Inner");
        assert.equal(syms.find((s) => s.name === "Point")?.container, "Outer");
    });

    it("top-level symbols carry no container; columns are 1-indexed", async () => {
        const syms = await h().extractRaw("sq(x) = x * x\n");
        const sq = syms.find((s) => s.name === "sq");
        assert.equal(sq?.container, undefined);
        assert.equal(sq?.column, 1);
        assert.ok((sq?.endColumn ?? 0) >= 1);
    });
});
