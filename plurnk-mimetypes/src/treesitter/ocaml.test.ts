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

describe("text/x-ocaml — container + columns (issue #18)", () => {
    it("struct-body declarations carry the enclosing module path as container", async () => {
        const src = "module Outer = struct\n  module Inner = struct\n    let deep x = x\n  end\n  let shallow = 1\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Outer")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "Inner")?.container, "Outer");
        assert.equal(syms.find((s) => s.name === "deep")?.container, "Outer.Inner");
        assert.equal(syms.find((s) => s.name === "shallow")?.container, "Outer");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const src = "module M = struct\nend\nlet add x y = x + y\n";
        const syms = await h().extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.equal(add?.container, undefined);
        // `add` anchors on the let_binding, which starts after `let `.
        assert.equal(add?.column, 5);
        assert.ok((add?.endColumn ?? 0) >= 1);
        assert.equal(syms.find((s) => s.name === "M")?.column, 1);
    });
});
