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

describe("text/x-fsharp — container + columns (issue #18)", () => {
    it("module members carry the module; record fields and union cases append the type", async () => {
        const src = "module M\nlet add a b = a + b\ntype Person = { Name: string; Age: int }\ntype Color = Red | Green\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "M")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "add")?.container, "M");
        assert.equal(syms.find((s) => s.name === "Person")?.container, "M");
        assert.equal(syms.find((s) => s.name === "Name")?.container, "M.Person");
        assert.equal(syms.find((s) => s.name === "Color")?.container, "M");
        assert.equal(syms.find((s) => s.name === "Red")?.container, "M.Color");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "module M\nlet pi = 3.14\n";
        const syms = await h().extractRaw(src);
        const m = syms.find((s) => s.name === "M");
        assert.equal(m?.container, undefined);
        assert.equal(m?.column, 1);
        assert.ok((m?.endColumn ?? 0) >= 1);
    });
});

describe("text/x-fsharp — implicit-constructor types (issue #22)", () => {
    it("anon_type_defn emits the type and its members with dotted containers", async () => {
        const src = "module M\ntype Parser(token: string) =\n    member this.Run x = x\n    member val Count = 0 with get, set\n    let mutable cache = 0\n";
        const syms = await h().extractRaw(src);
        const parser = syms.find((s) => s.name === "Parser");
        assert.equal(parser?.kind, "class");
        assert.equal(parser?.container, "M");
        const run = syms.find((s) => s.name === "Run");
        assert.equal(run?.kind, "method");
        assert.equal(run?.container, "M.Parser");
        assert.deepEqual(run?.params, ["x"]);
        const count = syms.find((s) => s.name === "Count");
        assert.equal(count?.kind, "field");
        assert.equal(count?.container, "M.Parser");
        const cache = syms.find((s) => s.name === "cache");
        assert.equal(cache?.kind, "constant");
        assert.equal(cache?.container, "M.Parser");
    });

    it("abstract member signatures and interface implementations carry the type", async () => {
        const src = "module M\ntype Runnable =\n    abstract member Run: int -> int\ntype Parser() =\n    interface Runnable with\n        member this.Run x = x\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Runnable")?.kind, "class");
        const runs = syms.filter((s) => s.name === "Run");
        assert.deepEqual(runs.map((s) => s.container), ["M.Runnable", "M.Parser"]);
        assert.ok(runs.every((s) => s.kind === "method"));
    });
});
