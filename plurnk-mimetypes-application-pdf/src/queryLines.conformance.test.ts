import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

// #41: pdf jsonpath (over the bookmark outline) carries source-line spans.
// pdf content is binary (Uint8Array), so the string conformance harness doesn't
// apply — this asserts the contract directly with a built PDF fixture.
const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

describe("#41 pdf query-line conformance", () => {
    it("a jsonpath bookmark match carries a source-line span", async () => {
        const pdf = buildPdf({ outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }] });
        const out = await h.query(pdf, "jsonpath", "$['Chapter 1']['Section 1.1']");
        assert.equal(out.length, 1);
        assert.ok(out[0].lines && out[0].lines.length > 0 && out[0].lines[0].line >= 1, "match carries a source-line span");
    });
});
