import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-makefile")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-makefile via tree-sitter registry", () => {
    it("variable_assignment → variable; SCREAMING → constant", async () => {
        const src = "PREFIX = /usr/local\nlocal_var = x\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "PREFIX")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "local_var")?.kind, "variable");
    });

    it("rule targets → function per word", async () => {
        const src = "all: build\n\t@echo done\nbuild:\n\tgcc main.c\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "all")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "build")?.kind, "function");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw(":::\n"));
    });
});
