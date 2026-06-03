import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-ocaml")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-ocaml via tree-sitter registry", () => {
    it("module M = struct ... end → module", async () => {
        const syms = await h().extractRaw("module M = struct\nend\n");
        assert.equal(syms.find((s) => s.name === "M")?.kind, "module");
    });

    it("type record / variant → class; type alias → type", async () => {
        const syms = await h().extractRaw("type t = { x: int; y: int }\ntype direction = North | South\ntype name = string\n");
        assert.equal(syms.find((s) => s.name === "t")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "direction")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "name")?.kind, "type");
    });

    it("let with params → function; let without → constant", async () => {
        const syms = await h().extractRaw("let add x y = x + y\nlet pi = 3.14\n");
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.kind, "function");
        assert.deepEqual(add?.params, ["x", "y"]);
        assert.equal(syms.find((s) => s.name === "pi")?.kind, "constant");
    });

    it("exception → class", async () => {
        const syms = await h().extractRaw("exception NotFound\n");
        assert.equal(syms.find((s) => s.name === "NotFound")?.kind, "class");
    });

    it("class definition → class", async () => {
        const syms = await h().extractRaw("class point x y = object\n  val mutable x = x\nend\n");
        assert.equal(syms.find((s) => s.name === "point")?.kind, "class");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("module ((( broken"));
    });
});
