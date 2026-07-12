// Layout-aware body text (Tier 2). pdfjs's own hasEOL markers drive line
// breaks, so distinct visual lines become distinct text lines — queryable with
// anchored/multiline regex — without custom geometry heuristics. Exercised
// through the regex query surface (toText is protected).
//
// NOTE: pdfjs detaches the input ArrayBuffer per parse (documented handler
// contract — the orchestrator reads fresh per call), so each query() here gets
// its own freshly-built buffer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildTaggedPdf, type TaggedHeading } from "./buildTaggedPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

// Fresh buffer per query — never reuse a detached one.
function q(headings: TaggedHeading[], pattern: string, flags?: string): Promise<unknown[]> {
    return h.query(buildTaggedPdf(headings), "regex", pattern, flags);
}

describe("ApplicationPdf — layout-aware text (hasEOL line breaks)", () => {
    it("distinct visual lines are distinct text lines (anchored multiline match)", async () => {
        const two: TaggedHeading[] = [{ level: 1, text: "First Line" }, { level: 1, text: "Second Line" }];
        assert.equal((await q(two, "^Second Line$", "m")).length, 1);
        assert.equal((await q(two, "^First Line$", "m")).length, 1);
    });

    it("flat single-line search still finds content (floor preserved)", async () => {
        assert.equal((await q([{ level: 1, text: "Findable Heading" }], "Findable Heading")).length, 1);
    });

    it("a single-line run is not split (no spurious breaks)", async () => {
        assert.equal((await q([{ level: 1, text: "One Whole Phrase" }], "^One Whole Phrase$", "m")).length, 1);
    });
});
