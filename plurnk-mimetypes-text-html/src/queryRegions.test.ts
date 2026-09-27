import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextHtml from "./TextHtml.ts";

const h = new TextHtml({ mimetype: "text/html", glyph: "H", extensions: [".html"] as const });
const html = "<html>\n<body>\n<div>\n<p>x</p>\n</div>\n</body>\n</html>";
const regions = [{ startLine: 3, startColumn: 1, endLine: 5, endColumn: 7 }];

describe("HTML structural match evidence", () => {
    it("{§mimetype-content-query} both structural dialects address the source markup", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: html,
                dialect: "jsonpath",
                pattern: "$..children[?(@.type==\"div\")]",
                verdict: "enclosing",
                expectRegions: [regions],
            },
            {
                source: html,
                dialect: "xpath",
                pattern: "//div",
                verdict: "enclosing",
                expectRegions: [regions],
            },
        ]);
    });

    it("both dialects retain locators alongside source coordinates", async () => {
        const j = await h.query(html, "jsonpath", "$..children[?(@.type==\"div\")]");
        const x = await h.query(html, "xpath", "//div");
        assert.deepEqual(j[0].regions, regions);
        assert.deepEqual(x[0].regions, regions);
        assert.ok(typeof j[0].matching === "string");
        assert.equal(x[0].matching, "//div");
    });
    it("a computed scalar retains its expression as a locator", async () => {
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//p)");
    });
});
