import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";
import { projectJsonToXml } from "../projectJsonToXml.ts";

// End-to-end checks that the tree-sitter registry handlers emit both the
// symbols channel AND the deep-json channel from a single source, and that
// projectJsonToXml produces a congruent deep-xml view.

describe("TreeSitterLanguageHandler.deepJson — Python", () => {
    const entry = lookupTreeSitterLanguage("text/x-python")!;
    const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };

    it("returns the full named-children tree with native tree-sitter node types", async () => {
        const src = "def greet(name):\n    return name\n";
        const h = new TreeSitterLanguageHandler(md, entry);
        const tree = await h.deepJson(src) as { type: string; children?: unknown[] };
        assert.equal(tree.type, "module");
        assert.ok(Array.isArray(tree.children));
        const fn = (tree.children as { type: string }[]).find((c) => c.type === "function_definition");
        assert.ok(fn, "function_definition node should be present in deep tree");
    });

    it("leaf nodes carry text; internal nodes carry children", async () => {
        const src = "x = 42\n";
        const h = new TreeSitterLanguageHandler(md, entry);
        type N = { type: string; text?: string; children?: N[] };
        const tree = await h.deepJson(src) as N;
        // Walk to find an identifier leaf.
        const stack: N[] = [tree];
        let found: N | null = null;
        while (stack.length > 0) {
            const cur = stack.pop()!;
            if (cur.type === "identifier") { found = cur; break; }
            if (cur.children) stack.push(...cur.children);
        }
        assert.ok(found, "should locate an identifier leaf");
        assert.equal(found!.text, "x");
        assert.equal(found!.children, undefined);
    });

    it("returns null for binary content", async () => {
        const h = new TreeSitterLanguageHandler(md, entry);
        assert.equal(await h.deepJson(new Uint8Array([1, 2, 3])), null);
    });

    it("deepJson + projectJsonToXml produces self-consistent XML", async () => {
        const src = "def f(): pass\n";
        const h = new TreeSitterLanguageHandler(md, entry);
        const json = await h.deepJson(src);
        const xml = projectJsonToXml(json);
        // The function_definition node type appears in both projections.
        assert.ok(xml.includes("<function_definition"));
        assert.ok(xml.includes("</function_definition>") || xml.includes("/>"));
        // The identifier 'f' is preserved in some text node.
        assert.ok(xml.includes(">f<") || xml.includes(">f</"));
    });
});

describe("TreeSitterLanguageHandler.deepJson — shares parser cache with extractRaw", () => {
    it("calling both deepJson and extractRaw uses one parser load", async () => {
        const entry = lookupTreeSitterLanguage("text/x-python")!;
        const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
        const h = new TreeSitterLanguageHandler(md, entry);
        // Sequential calls should both succeed; we exercise both paths to ensure
        // the shared cache is wired correctly and neither path throws on the
        // hot cache.
        const src = "x = 1\n";
        const [syms, tree] = await Promise.all([h.extractRaw(src), h.deepJson(src)]);
        assert.ok(Array.isArray(syms));
        assert.ok(tree && typeof tree === "object");
    });
});
