import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-go")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-go via tree-sitter registry", () => {
    it("package clause → module", async () => {
        const syms = await h().extractRaw("package foo\n");
        assert.equal(syms.find((s) => s.name === "foo")?.kind, "module");
    });

    it("function_declaration → function", async () => {
        const src = "package x\nfunc Add(a int, b int) int { return a + b }\n";
        const syms = await h().extractRaw(src);
        const fn = syms.find((s) => s.name === "Add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("method_declaration → method", async () => {
        const src = "package x\ntype T struct{}\nfunc (t *T) Do(x int) {}\n";
        const syms = await h().extractRaw(src);
        const m = syms.find((s) => s.name === "Do");
        assert.equal(m?.kind, "method");
        assert.deepEqual(m?.params, ["x"]);
    });

    it("type_declaration: struct → class, interface → interface, alias → type", async () => {
        const src = "package x\ntype Point struct { X, Y int }\ntype Reader interface { Read() int }\ntype Name = string\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Point")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "Reader")?.kind, "interface");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "type");
    });

    it("const + var → constant + variable", async () => {
        const src = "package x\nconst Max = 100\nvar Count int\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Max")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "Count")?.kind, "variable");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("package ((( broken"));
    });
});

describe("text/x-go — container + columns (issue #18)", () => {
    it("flat mapping: no symbol carries a container", async () => {
        const src = "package x\ntype T struct{}\nfunc (t *T) Do() {}\nfunc free() {}\n";
        const syms = await h().extractRaw(src);
        assert.ok(syms.length > 0);
        assert.ok(syms.every((s) => s.container === undefined));
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const syms = await h().extractRaw("package x\nfunc solo() {}\n");
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
