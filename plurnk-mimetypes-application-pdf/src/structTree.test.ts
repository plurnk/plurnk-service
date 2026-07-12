// Logical-structure-tree symbols (Tier 1 headline). Tagged PDFs yield a real
// heading hierarchy (H1..H6) via getStructTree() + marked-content correlation;
// the symbols cascade prefers it over the bookmark outline, which it prefers
// over the metadata Title. Verified against genuine pdfjs output (the fixture
// is a real tagged PDF, not a mock).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildTaggedPdf } from "./buildTaggedPdf.ts";
import { buildPdf } from "./buildPdf.ts";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

describe("ApplicationPdf — structTree heading hierarchy", () => {
    it("extracts tagged headings with their text and H-level", async () => {
        const syms = await h.extractRaw(buildTaggedPdf([
            { level: 1, text: "Introduction" },
            { level: 2, text: "Background" },
            { level: 3, text: "Prior Work" },
            { level: 1, text: "Method" },
        ]));
        assert.deepEqual(
            syms.map((s) => [s.name, s.kind, s.level]),
            [["Introduction", "heading", 1], ["Background", "heading", 2], ["Prior Work", "heading", 3], ["Method", "heading", 1]],
        );
    });

    it("structTree wins the cascade over an outline when both exist", async () => {
        // A tagged PDF has no bookmark outline here; assert the headings come
        // from the structure tree (richer than a single Title fallback would be).
        const syms = await h.extractRaw(buildTaggedPdf([{ level: 1, text: "Only Heading" }]));
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Only Heading");
    });

    it("untagged PDF falls back to the bookmark outline (cascade tier 2)", async () => {
        const syms = await h.extractRaw(buildPdf({ outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }] }));
        const names = syms.map((s: MimeSymbol) => s.name);
        assert.deepEqual(names, ["Chapter 1", "Section 1.1"]);
    });

    it("untitled, untagged, un-bookmarked PDF yields no symbols (honest empty)", async () => {
        assert.deepEqual(await h.extractRaw(buildPdf({})), []);
    });

    it("deepJson children reflect the structTree headings", async () => {
        const model = (await h.deepJson(buildTaggedPdf([{ level: 1, text: "Intro" }, { level: 2, text: "Sub" }]))) as {
            children: Array<{ name: string; level?: number }>;
        };
        assert.deepEqual(model.children.map((c) => [c.name, c.level]), [["Intro", 1], ["Sub", 2]]);
    });
});
