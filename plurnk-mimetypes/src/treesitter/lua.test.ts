import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-lua")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-lua via tree-sitter registry", () => {
    it("local function → function; M.foo → method; Class:method → method", async () => {
        const src = "local M = {}\nfunction M.foo(x, y) return x + y end\nlocal function bar(z) return z end\nfunction Class:greet(a) return a end\nreturn M\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "M")?.kind, "variable");
        const foo = syms.find((s) => s.name === "foo");
        assert.equal(foo?.kind, "method");
        assert.deepEqual(foo?.params, ["x", "y"]);
        const bar = syms.find((s) => s.name === "bar");
        assert.equal(bar?.kind, "function");
        assert.deepEqual(bar?.params, ["z"]);
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.kind, "method");
        assert.deepEqual(greet?.params, ["a"]);
    });

    it("SCREAMING_SNAKE local → constant", async () => {
        const syms = await h().extractRaw("local MAX_SIZE = 100\n");
        assert.equal(syms.find((s) => s.name === "MAX_SIZE")?.kind, "constant");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("function ((( broken"));
    });
});
