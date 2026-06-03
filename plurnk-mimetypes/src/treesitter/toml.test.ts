import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("application/toml")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("application/toml via tree-sitter registry", () => {
    it("table → module + pairs → fields", async () => {
        const src = "[server]\nhost = \"localhost\"\nport = 8080\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "server")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "host")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "port")?.kind, "field");
    });

    it("dotted table key surfaces full path", async () => {
        const src = "[database.options]\nname = \"db\"\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "database.options")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("[[[broken"));
    });
});
