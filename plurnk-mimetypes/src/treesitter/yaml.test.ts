import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("application/yaml")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("application/yaml via tree-sitter registry", () => {
    it("top-level mapping keys → fields", async () => {
        const src = "name: Alice\nage: 30\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "age")?.kind, "field");
    });

    it("nested mapping keys also surface", async () => {
        const src = "server:\n  host: localhost\n  port: 8080\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "server")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "host")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "port")?.kind, "field");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("::::"));
    });
});
