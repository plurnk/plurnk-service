// Layout-aware body text (Tier 2). pdfjs's own hasEOL markers drive line
// breaks, so distinct visual lines become distinct text lines — queryable with
// anchored/multiline regex — without custom geometry heuristics. Exercised
// through the regex query surface (toText is protected).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildTaggedPdf } from "./buildTaggedPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

describe("ApplicationPdf — layout-aware text (hasEOL line breaks)", () => {
    it("distinct visual lines are distinct text lines (anchored multiline match)", async () => {
        const pdf = buildTaggedPdf([{ level: 1, text: "First Line" }, { level: 1, text: "Second Line" }]);
        assert.equal((await h.query(pdf, "regex", "^Second Line$", "m")).length, 1);
        assert.equal((await h.query(pdf, "regex", "^First Line$", "m")).length, 1);
    });

    it("text content remains findable (floor preserved)", async () => {
        const pdf = buildTaggedPdf([{ level: 1, text: "Findable Heading" }]);
        assert.equal((await h.query(pdf, "regex", "Findable Heading")).length, 1);
    });

    it("a single-line run is not split (no spurious breaks)", async () => {
        const pdf = buildTaggedPdf([{ level: 1, text: "One Whole Phrase" }]);
        // The whole phrase matches as one line.
        assert.equal((await h.query(pdf, "regex", "^One Whole Phrase$", "m")).length, 1);
    });
});
