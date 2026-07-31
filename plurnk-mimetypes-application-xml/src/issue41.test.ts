// XML is itself the readable text, so both structural dialects may report
// honest regions in that same representation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import ApplicationXml from "./ApplicationXml.ts";

const h = new ApplicationXml({ mimetype: "application/xml", glyph: "<>", extensions: [".xml"] as const });
const xml = "<root>\n  <a>1</a>\n  <b>\n    <c>x</c>\n  </b>\n</root>";

describe("XML structural match regions", () => {
    it("classifies enclosing and locator-only evidence explicitly", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: xml,
                dialect: "jsonpath",
                pattern: "$..children[?(@.type==\"a\")]",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 11,
                }]],
            },
            {
                source: xml,
                dialect: "xpath",
                pattern: "//b",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 3, startColumn: 1, endLine: 5, endColumn: 7,
                }]],
            },
            {
                source: xml,
                dialect: "xpath",
                pattern: "count(//a)",
                verdict: "locator-only",
            },
        ]);
    });

    it("jsonpath carries an honest readable region", async () => {
        const a = await h.query(xml, "jsonpath", "$..children[?(@.type==\"a\")]");
        assert.deepEqual(a[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 11,
        }]);
    });
    it("a multi-line element spans its content on both dialects", async () => {
        const jb = await h.query(xml, "jsonpath", "$..children[?(@.type==\"b\")]");
        const xb = await h.query(xml, "xpath", "//b");
        assert.deepEqual(jb[0].regions, [{
            startLine: 3, startColumn: 1, endLine: 5, endColumn: 7,
        }]);
        assert.deepEqual(xb[0].regions, jb[0].regions);
    });
    it("a computed scalar retains its expression without a text region", async () => {
        const out = await h.query(xml, "xpath", "count(//a)");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//a)");
    });
});
