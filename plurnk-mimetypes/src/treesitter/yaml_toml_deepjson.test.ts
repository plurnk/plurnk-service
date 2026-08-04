import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TomlError } from "smol-toml";
import MimetypeInputError from "../MimetypeInputError.ts";
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

    it("classifies malformed YAML and preserves the parser cause", async () => {
        const h = new TreeSitterLanguageHandler(md, entry);
        await assert.rejects(
            h.deepJson(":\n:\n\t"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypeInputError);
                assert.equal(error.mimetype, "application/yaml");
                assert.equal((error.cause as Error).name, "YAMLParseError");
                return true;
            },
        );
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

    it("classifies malformed TOML and preserves the parser cause", async () => {
        const h = new TreeSitterLanguageHandler(md, entry);
        await assert.rejects(
            h.deepJson("[[[invalid"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypeInputError);
                assert.equal(error.mimetype, "application/toml");
                assert.ok(error.cause instanceof TomlError);
                return true;
            },
        );
    });
});
