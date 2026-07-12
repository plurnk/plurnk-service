import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-odin")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-odin via tree-sitter registry", () => {
    it("package + proc + struct + enum + const", async () => {
        const src = "package main\nadd :: proc(a, b: int) -> int { return a + b }\nPoint :: struct { x, y: int }\nColor :: enum { Red, Green }\nMAX :: 100\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "main")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "add")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "Red")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "MAX")?.kind, "constant");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("proc ((( broken"));
    });
});

describe("text/x-odin — container + columns (issue #18)", () => {
    it("struct fields and enum constants carry the owning type as container", async () => {
        const src = "package main\nPoint :: struct { x: int, y: int }\nColor :: enum { Red, Green }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Point")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "x")?.container, "Point");
        assert.equal(syms.find((s) => s.name === "y")?.container, "Point");
        assert.equal(syms.find((s) => s.name === "Color")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "Red")?.container, "Color");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "package main\nadd :: proc(a, b: int) -> int { return a + b }\n";
        const syms = await h().extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.container, undefined);
        assert.equal(add?.column, 1);
        assert.ok((add?.endColumn ?? 0) >= 1);
    });
});
