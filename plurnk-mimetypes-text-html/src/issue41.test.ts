import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextHtml from "./TextHtml.ts";

const h = new TextHtml({ mimetype: "text/html", glyph: "H", extensions: [".html"] as const });
const html = "<html>\n<body>\n<div>\n<p>x</p>\n</div>\n</body>\n</html>";

describe("HTML structural match evidence", () => {
    it("classifies both transformed structural dialects as locator-only", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: html,
                dialect: "jsonpath",
                pattern: "$..children[?(@.type==\"div\")]",
                verdict: "locator-only",
            },
            {
                source: html,
                dialect: "xpath",
                pattern: "//div",
                verdict: "locator-only",
            },
        ]);
    });

    it("both dialects retain locators without raw-HTML coordinates in Markdown", async () => {
        const j = await h.query(html, "jsonpath", "$..children[?(@.type==\"div\")]");
        const x = await h.query(html, "xpath", "//div");
        assert.equal(j[0].regions, undefined);
        assert.equal(x[0].regions, undefined);
        assert.ok(typeof j[0].matching === "string");
        assert.equal(x[0].matching, "//div");
    });
    it("a computed scalar retains its expression as a locator", async () => {
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//p)");
    });
});
