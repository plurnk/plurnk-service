import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/typescript")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/typescript via tree-sitter registry", () => {
    it("interface_declaration → interface + methods/properties", async () => {
        const src = "interface Doable {\n  run(x: number): void;\n  ready: boolean;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Doable")?.kind, "interface");
        assert.equal(syms.find((s) => s.name === "run")?.kind, "method");
        assert.equal(syms.find((s) => s.name === "ready")?.kind, "field");
    });

    it("type_alias_declaration → type", async () => {
        const syms = await h().extractRaw("type Name = string;\n");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "type");
    });

    it("enum_declaration → enum + members as constants", async () => {
        const syms = await h().extractRaw("enum Color { Red = 'red', Green = 'green' }\n");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "Red")?.kind, "constant");
    });

    it("namespace/module → module + recurse", async () => {
        const src = "namespace ns {\n  export function inner() {}\n  export const X = 1;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "ns")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "inner")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "X")?.kind, "constant");
    });

    it("falls through to JS dispatch for shared node types", async () => {
        const src = "function plain() {}\nclass C { foo(x: number) {} }\nconst MAX: number = 1;\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "plain")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "C")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "foo")?.kind, "method");
        assert.equal(syms.find((s) => s.name === "MAX")?.kind, "constant");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("interface ((( broken"));
    });
});
