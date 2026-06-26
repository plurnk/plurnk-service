import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";

const h = new TextHtml({ mimetype: "text/html", glyph: "H", extensions: [".html"] as const });
const html = "<html>\n<body>\n<div>\n<p>x</p>\n</div>\n</body>\n</html>";

describe("issue #41 — html dual-dialect source-line spans", () => {
    it("a multi-line element spans identically on jsonpath and xpath", async () => {
        const j = await h.query(html, "jsonpath", "$..children[?(@.type==\"div\")]");
        const x = await h.query(html, "xpath", "//div");
        assert.deepEqual(j[0].lines, [{ line: 3, endLine: 5 }]);
        assert.deepEqual(x[0].lines, j[0].lines, "jsonpath and xpath must agree");
    });
    it("computed scalar carries no lines", async () => {
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out[0].lines, undefined);
    });
});
