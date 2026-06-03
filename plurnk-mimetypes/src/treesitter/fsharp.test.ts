import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-fsharp")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-fsharp via tree-sitter registry", () => {
    it("module + let function + record type + union type", async () => {
        const src = "module M\nlet add a b = a + b\ntype Person = { Name: string; Age: int }\ntype Color = Red | Green | Blue\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "M")?.kind, "module");
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.kind, "function");
        assert.deepEqual(add?.params, ["a", "b"]);
        assert.equal(syms.find((s) => s.name === "Person")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "Red")?.kind, "constant");
    });

    it("let value (no args) → constant", async () => {
        const syms = await h().extractRaw("module M\nlet pi = 3.14\n");
        assert.equal(syms.find((s) => s.name === "pi")?.kind, "constant");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("module ((( broken"));
    });
});
