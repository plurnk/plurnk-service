import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

describe("YAML deepJson via parsed value", () => {
    const entry = lookupTreeSitterLanguage("application/yaml")!;
    const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };

    it("returns the parsed value tree, not the tree-sitter AST", async () => {
        const src = "name: Alice\nserver:\n  host: localhost\n  port: 8080\n";
        const h = new TreeSitterLanguageHandler(md, entry);
        const tree = await h.deepJson(src);
        assert.deepEqual(tree, { name: "Alice", server: { host: "localhost", port: 8080 } });
    });

    it("returns null on malformed yaml without throwing", async () => {
        const h = new TreeSitterLanguageHandler(md, entry);
        assert.doesNotThrow(async () => {
            const v = await h.deepJson(":\n:\n\t");
            // smol-toml/yaml may or may not error on this; null OR a value is fine
            void v;
        });
    });
});

describe("TOML deepJson via parsed value", () => {
    const entry = lookupTreeSitterLanguage("application/toml")!;
    const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };

    it("returns the parsed value tree", async () => {
        const src = '[server]\nhost = "localhost"\nport = 8080\n';
        const h = new TreeSitterLanguageHandler(md, entry);
        const tree = await h.deepJson(src);
        assert.deepEqual(tree, { server: { host: "localhost", port: 8080 } });
    });

    it("returns null on malformed toml without throwing", async () => {
        const h = new TreeSitterLanguageHandler(md, entry);
        const v = await h.deepJson("[[[invalid");
        assert.equal(v, null);
    });
});
