import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    TREE_SITTER_REGISTRY,
    lookupTreeSitterLanguage,
    lookupTreeSitterByExtension,
} from "./registry.ts";

describe("TreeSitter registry", () => {
    it("lists at least one entry", () => {
        assert.ok(TREE_SITTER_REGISTRY.length >= 1);
    });

    it("lookupTreeSitterLanguage matches a known mimetype", () => {
        const entry = lookupTreeSitterLanguage("text/x-python");
        assert.ok(entry);
        assert.equal(entry.mimetype, "text/x-python");
        assert.equal(entry.wasmPackage, "tree-sitter-python");
    });

    it("lookupTreeSitterLanguage returns null for unknown mimetype", () => {
        const entry = lookupTreeSitterLanguage("text/x-unknown-language");
        assert.equal(entry, null);
    });

    it("lookupTreeSitterByExtension matches a known extension (case-insensitive)", () => {
        const entry = lookupTreeSitterByExtension(".py");
        assert.ok(entry);
        assert.equal(entry.mimetype, "text/x-python");
        const upper = lookupTreeSitterByExtension(".PY");
        assert.equal(upper?.mimetype, "text/x-python", "extension match is case-insensitive");
    });

    it("lookupTreeSitterByExtension returns null for unclaimed extension", () => {
        const entry = lookupTreeSitterByExtension(".unknownext");
        assert.equal(entry, null);
    });

    it("every registry entry has a non-empty mimetype, glyph, slug, extensions", () => {
        for (const entry of TREE_SITTER_REGISTRY) {
            assert.ok(entry.mimetype.length > 0, `mimetype empty: ${JSON.stringify(entry)}`);
            assert.ok(entry.glyph.length > 0, `glyph empty: ${entry.mimetype}`);
            assert.ok(entry.slug.length > 0, `slug empty: ${entry.mimetype}`);
            assert.ok(entry.extensions.length > 0, `extensions empty: ${entry.mimetype}`);
            assert.equal(typeof entry.importMapping, "function");
            // wasmPackage / wasmFile are optional legacy fallback fields;
            // either both are populated or both are null (matched-pair invariant).
            assert.equal(
                entry.wasmPackage === null,
                entry.wasmFile === null,
                `wasmPackage/wasmFile null mismatch: ${entry.mimetype}`,
            );
        }
    });

    it("mimetypes are unique across the registry", () => {
        const seen = new Set<string>();
        for (const entry of TREE_SITTER_REGISTRY) {
            assert.ok(!seen.has(entry.mimetype), `duplicate mimetype: ${entry.mimetype}`);
            seen.add(entry.mimetype);
        }
    });
});
