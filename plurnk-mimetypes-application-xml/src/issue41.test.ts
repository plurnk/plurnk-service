// Issue #41: xml reports real source-line spans on BOTH dialects, consistently.
// (Previously jsonpath faked line 1 via a hardcoded deepJson annotation while
// xpath used real xmldom lines — a silent inconsistency.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationXml from "./ApplicationXml.ts";

const h = new ApplicationXml({ mimetype: "application/xml", glyph: "<>", extensions: [".xml"] as const });
const xml = "<root>\n  <a>1</a>\n  <b>\n    <c>x</c>\n  </b>\n</root>";

describe("issue #41 — xml dual-dialect source-line spans", () => {
    it("jsonpath carries real lines (not a hardcoded 1)", async () => {
        const a = await h.query(xml, "jsonpath", "$..children[?(@.type==\"a\")]");
        assert.deepEqual(a[0].lines, [{ line: 2, endLine: 2 }]);
    });
    it("a multi-line element spans its content on both dialects, identically", async () => {
        const jb = await h.query(xml, "jsonpath", "$..children[?(@.type==\"b\")]");
        const xb = await h.query(xml, "xpath", "//b");
        // b opens line 3, closes line 5 — the span covers the full element.
        assert.deepEqual(jb[0].lines, [{ line: 3, endLine: 5 }]);
        assert.deepEqual(xb[0].lines, jb[0].lines, "jsonpath and xpath must agree on the span");
    });
    it("computed scalar carries no lines (#41)", async () => {
        const out = await h.query(xml, "xpath", "count(//a)");
        assert.equal(out[0].lines, undefined);
    });
});
