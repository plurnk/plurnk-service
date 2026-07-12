import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-ruby")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-ruby via tree-sitter registry", () => {
    it("module → module + class → class + method → method", async () => {
        const src = "module MyApp\n  class User\n    def initialize(name)\n      @name = name\n    end\n  end\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "MyApp")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "User")?.kind, "class");
        const init = syms.find((s) => s.name === "initialize");
        assert.equal(init?.kind, "method");
        assert.deepEqual(init?.params, ["name"]);
    });

    it("UPPER_CASE constant assignment → constant", async () => {
        const syms = await h().extractRaw("CONST = 42\n");
        assert.equal(syms.find((s) => s.name === "CONST")?.kind, "constant");
    });

    it("attr_accessor :name → field", async () => {
        const syms = await h().extractRaw("class C\n  attr_accessor :name, :age\nend\n");
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "age")?.kind, "field");
    });

    it("def self.foo → method (singleton)", async () => {
        const syms = await h().extractRaw("class C\n  def self.find(id)\n    nil\n  end\nend\n");
        const find = syms.find((s) => s.name === "find");
        assert.equal(find?.kind, "method");
        assert.deepEqual(find?.params, ["id"]);
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("class ((( broken"));
    });
});

describe("text/x-ruby — container + columns (issue #18)", () => {
    it("symbols carry the enclosing module/class path as container; nesting is dotted", async () => {
        const src = "module MyApp\n  class User\n    def initialize(name)\n      @name = name\n    end\n  end\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "MyApp")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "User")?.container, "MyApp");
        assert.equal(syms.find((s) => s.name === "initialize")?.container, "MyApp.User");
    });

    it("top-level symbols carry no container; columns are 1-indexed", async () => {
        const syms = await h().extractRaw("def solo(x)\n  x\nend\n");
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
