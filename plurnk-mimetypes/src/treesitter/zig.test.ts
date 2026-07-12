import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-zig")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-zig via tree-sitter registry", () => {
    it("function_declaration → function with params", async () => {
        const syms = await h().extractRaw("pub fn add(a: i32, b: i32) i32 { return a + b; }\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("struct → class with fields", async () => {
        const syms = await h().extractRaw("const Point = struct { x: i32, y: i32 };\n");
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "x")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "y")?.kind, "field");
    });

    it("enum → enum with constants", async () => {
        const syms = await h().extractRaw("const Color = enum { red, green };\n");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "red")?.kind, "constant");
    });

    it("SCREAMING const → constant; lowercase const → variable", async () => {
        const syms = await h().extractRaw("pub const MAX = 100;\nconst x = 1;\n");
        assert.equal(syms.find((s) => s.name === "MAX")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "x")?.kind, "variable");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("fn ((( broken"));
    });
});

describe("text/x-zig — container + columns (issue #18)", () => {
    it("struct fields and enum members carry the declared name as container", async () => {
        const src = "const Point = struct { x: f32, y: f32 };\nconst Color = enum { red, green };\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Point")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "x")?.container, "Point");
        assert.equal(syms.find((s) => s.name === "y")?.container, "Point");
        assert.equal(syms.find((s) => s.name === "red")?.container, "Color");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const syms = await h().extractRaw("fn solo() void {}\n");
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
