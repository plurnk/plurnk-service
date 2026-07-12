import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

// #41: pdf carries source-line spans on BOTH dialects. pdf content is binary
// (Uint8Array), so the string conformance harness doesn't apply — this asserts
// the contract directly with built PDF fixtures. pdfjs detaches the buffer per
// call, so each query gets a freshly built fixture.
const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });
const fixture = () => buildPdf({ outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }] });

describe("#41 pdf query-line conformance (both dialects)", () => {
    it("a jsonpath bookmark match carries a source-line span", async () => {
        const out = await h.query(fixture(), "jsonpath", "$['Chapter 1']['Section 1.1']");
        assert.equal(out.length, 1);
        assert.ok(out[0].lines && out[0].lines.length > 0 && out[0].lines[0].line >= 1, "match carries a source-line span");
    });

    it("xpath matches over the deep document model all carry source-line spans", async () => {
        const out = await h.query(fixture(), "xpath", "//*");
        assert.ok(out.length > 0, "xpath returns matches");
        assert.ok(out.every((m) => m.lines && m.lines.length > 0 && m.lines[0].line >= 1), "every match carries a span");
    });

    it("a named outline_item xpath match carries its own real line", async () => {
        const out = await h.query(fixture(), "xpath", "//outline_item");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].lines, [{ line: 1, endLine: 1 }]);
        assert.deepEqual(out[1].lines, [{ line: 2, endLine: 2 }]);
    });
});
