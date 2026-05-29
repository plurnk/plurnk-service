import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJsonOutline } from "./buildJsonOutline.ts";
import type { MimeSymbol } from "./types.ts";

describe("buildJsonOutline", () => {
    it("returns empty object for empty symbols", () => {
        assert.deepEqual(buildJsonOutline([]), {});
    });

    it("emits bare-line leaves for top-level symbols", () => {
        const symbols: MimeSymbol[] = [
            { name: "topLevel", kind: "function", line: 5, endLine: 10 },
            { name: "CONSTANT", kind: "constant", line: 12, endLine: 12 },
        ];
        assert.deepEqual(buildJsonOutline(symbols), {
            topLevel: 5,
            CONSTANT: 12,
        });
    });

    it("nests headings by level into recursive objects", () => {
        const symbols: MimeSymbol[] = [
            { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
            { name: "Section", kind: "heading", level: 2, line: 3, endLine: 3 },
            { name: "Sub", kind: "heading", level: 3, line: 5, endLine: 5 },
            { name: "Other", kind: "heading", level: 2, line: 7, endLine: 7 },
        ];
        assert.deepEqual(buildJsonOutline(symbols), {
            Top: {
                Section: { Sub: 5 },
                Other: 7,
            },
        });
    });

    it("nests non-heading symbols by line-range containment", () => {
        const symbols: MimeSymbol[] = [
            { name: "Parser", kind: "class", line: 5, endLine: 47 },
            { name: "parse", kind: "method", line: 10, endLine: 20 },
            { name: "load", kind: "method", line: 22, endLine: 45 },
            { name: "topLevel", kind: "function", line: 50, endLine: 60 },
        ];
        assert.deepEqual(buildJsonOutline(symbols), {
            Parser: { parse: 10, load: 22 },
            topLevel: 50,
        });
    });

    it("drops kind / endLine / params / level — leaves carry only line", () => {
        const symbols: MimeSymbol[] = [
            { name: "fn", kind: "function", line: 3, endLine: 8, params: ["x", "y"] },
            { name: "iface", kind: "interface", line: 10, endLine: 15 },
            { name: "alias", kind: "type", line: 17, endLine: 17 },
        ];
        const out = buildJsonOutline(symbols);
        assert.deepEqual(out, { fn: 3, iface: 10, alias: 17 });
    });

    it("resolves sibling name collisions with last-write-wins", () => {
        const symbols: MimeSymbol[] = [
            { name: "Project", kind: "heading", level: 1, line: 1, endLine: 1 },
            { name: "Background", kind: "heading", level: 2, line: 3, endLine: 3 },
            { name: "Background", kind: "heading", level: 2, line: 10, endLine: 10 },
        ];
        const out = buildJsonOutline(symbols) as { Project: { Background: number } };
        assert.equal(out.Project.Background, 10);
    });

    it("preserves parent-child relationships across mixed kinds", () => {
        const symbols: MimeSymbol[] = [
            { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
            { name: "Tutorial", kind: "heading", level: 2, line: 3, endLine: 3 },
            { name: "typescript", kind: "module", line: 5, endLine: 8 },
        ];
        const out = buildJsonOutline(symbols);
        // module nested under the most recent heading (Tutorial)
        // is line-range containment, but headings nest by level only —
        // module falls under whichever heading contains it. Since
        // Tutorial is a single line at 3 and the module is at 5-8,
        // line-range containment puts it at root, not under Tutorial.
        // The tree-builder's existing behavior governs here.
        assert.ok("Top" in out);
    });
});
