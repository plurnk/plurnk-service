import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

// PDF structural coordinates refer to pages, not regions in the extracted text.
// Structural matches therefore retain canonical locators without fabricating
// text regions. pdfjs detaches the buffer per call, so every query gets a
// freshly built fixture.
const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });
const fixture = () => buildPdf({ outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }] });

describe("PDF structural match evidence", () => {
    it("a JSONPath bookmark match retains a locator only", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: fixture(),
            dialect: "jsonpath",
            pattern: "$.children[1].name",
            verdict: "locator-only",
        }]);
    });

    it("XPath matches over the deep document model retain locators only", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: fixture(),
            dialect: "xpath",
            pattern: "//*",
            verdict: "locator-only",
        }]);
    });

    it("named outline items receive distinct canonical XPath locators", async () => {
        const out = await h.query(fixture(), "xpath", "//outline_item");
        assert.equal(out.length, 2);
        assert.equal(out[0].matching, "(//outline_item)[1]");
        assert.equal(out[1].matching, "(//outline_item)[2]");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[1].regions, undefined);
    });
});
