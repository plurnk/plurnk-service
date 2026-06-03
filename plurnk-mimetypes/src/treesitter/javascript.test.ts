import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/javascript")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/javascript via tree-sitter registry", () => {
    it("function_declaration → function with params", async () => {
        const syms = await h().extractRaw("function add(a, b) { return a + b; }\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("class_declaration with method → class + method + field", async () => {
        const src = "class Counter {\n  count = 0;\n  increment(by) { this.count += by; }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Counter")?.kind, "class");
        const m = syms.find((s) => s.name === "increment");
        assert.equal(m?.kind, "method");
        assert.deepEqual(m?.params, ["by"]);
        assert.equal(syms.find((s) => s.name === "count")?.kind, "field");
    });

    it("const SCREAMING → constant; lowercase const → variable", async () => {
        const syms = await h().extractRaw("const MAX = 100;\nconst x = 1;\nlet y = 2;\n");
        assert.equal(syms.find((s) => s.name === "MAX")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "x")?.kind, "variable");
        assert.equal(syms.find((s) => s.name === "y")?.kind, "variable");
    });

    it("const arrow function → function with params", async () => {
        const syms = await h().extractRaw("const sum = (a, b) => a + b;\n");
        const fn = syms.find((s) => s.name === "sum");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("export declarations unwrap", async () => {
        const src = "export function foo() {}\nexport class Bar {}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "foo")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "Bar")?.kind, "class");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("function ((( broken"));
    });
});
