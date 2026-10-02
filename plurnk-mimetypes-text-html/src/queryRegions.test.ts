import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
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
                verdict: "exact",
                expectRegions: [regions],
            },
            {
                source: html,
                dialect: "xpath",
                pattern: "//div",
                verdict: "exact",
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

for (const { source, pattern, selected } of [
    { source: '<p>first<br>second</p><p>other', pattern: '//p', selected: ['<p>first<br>second</p>', '<p>other'] },
    { source: '<ul><li>A<li>B</ul>', pattern: '//li', selected: ['<li>A', '<li>B'] },
    { source: '<a href = \'/here\'>here</a>', pattern: '//a/@href', selected: ["href = '/here'"] },
    { source: '<p>left <b>bold</b> &amp; right</p>', pattern: '//p/text()', selected: ['left ', ' &amp; right'] },
    { source: '😀\r\n<p>😀&amp;</p>', pattern: '//p/text()', selected: ['😀&amp;'] },
    { source: '<script>if (a < b) f();</script>', pattern: '//script/text()', selected: ['if (a < b) f();'] },
]) {
    it(`XPath ${pattern} follows the HTML parser's exact source bounds`, async () => {
        const matches = await h.query(source, "xpath", pattern);
        const coordinates = new TextCoordinates(source);
        assert.deepEqual(matches.map((match) => {
            assert.equal(match.regions?.length, 1, JSON.stringify(match));
            const region = match.regions![0];
            return source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
        }), selected);
    });
}

it("an implied HTML element has no invented source region", async () => {
    const [body] = await h.query("<p>text</p>", "xpath", "//body");
    assert.equal(body.matching, "//body");
    assert.equal(body.regions, undefined);
});
