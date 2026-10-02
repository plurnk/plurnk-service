// XML is itself the readable text, so both structural dialects may report
// honest regions in that same representation.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import ApplicationXml from "./ApplicationXml.ts";

const h = new ApplicationXml({ mimetype: "application/xml", glyph: "<>", extensions: [".xml"] as const });
const xml = "<root>\n  <a>1</a>\n  <b>\n    <c>x</c>\n  </b>\n</root>";

describe("XML structural match regions", () => {
    it("classifies exact and locator-only evidence explicitly", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: xml,
                dialect: "jsonpath",
                pattern: "$..children[?(@.type==\"a\")]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 3, endLine: 2, endColumn: 11,
                }]],
            },
            {
                source: xml,
                dialect: "xpath",
                pattern: "//b",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 3, startColumn: 3, endLine: 5, endColumn: 7,
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
            startLine: 2, startColumn: 3, endLine: 2, endColumn: 11,
        }]);
    });
    it("a multi-line element spans its content on both dialects", async () => {
        const jb = await h.query(xml, "jsonpath", "$..children[?(@.type==\"b\")]");
        const xb = await h.query(xml, "xpath", "//b");
        assert.deepEqual(jb[0].regions, [{
            startLine: 3, startColumn: 3, endLine: 5, endColumn: 7,
        }]);
        assert.deepEqual(xb[0].regions, jb[0].regions);
    });
    it("a computed scalar retains its expression without a text region", async () => {
        const out = await h.query(xml, "xpath", "count(//a)");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//a)");
    });
});

// {§slice-semantics-compose-pattern} — serialized values are not source spans.
for (const { source, pattern, selected } of [
    { source: '<root><item>A</item><other>B</other></root>', pattern: '//item', selected: ['<item>A</item>'] },
    { source: '<root><item>A<b>B</b>C</item></root>', pattern: '//item/text()', selected: ['A', 'C'] },
    { source: '<root><item id = \'old\'>A</item></root>', pattern: '//item/@id', selected: ["id = 'old'"] },
    { source: '<root><item>A &amp; B</item></root>', pattern: '//item/text()', selected: ['A &amp; B'] },
    { source: '<root><item>A&#10;B</item><item /></root>', pattern: '//item', selected: ['<item>A&#10;B</item>', '<item />'] },
    { source: '<root>😀\r\n  <item>😀&#x1F600;</item>\r</root>', pattern: '//item/text()', selected: ['😀&#x1F600;'] },
    { source: '<root><item><![CDATA[<x>]]></item></root>', pattern: '//item/text()', selected: ['<![CDATA[<x>]]>'] },
    { source: '<root><item>A<![CDATA[B]]>C&amp;D</item></root>', pattern: '//item/text()', selected: ['A<![CDATA[B]]>C&amp;D'] },
    { source: '<root><item><![CDATA[A]]><![CDATA[B]]></item></root>', pattern: '//item/text()', selected: ['<![CDATA[A]]><![CDATA[B]]>'] },
    { source: '<root><!-- a > b --><?check ok?></root>', pattern: '//comment() | //processing-instruction()', selected: ['<!-- a > b -->', '<?check ok?>'] },
]) {
    it(`XPath ${pattern} selects exact lexical source in ${JSON.stringify(source)}`, async () => {
        const matches = await h.query(source, "xpath", pattern);
        const coordinates = new TextCoordinates(source);
        assert.deepEqual(matches.map((match) => {
            assert.equal(match.regions?.length, 1, JSON.stringify(match));
            const region = match.regions![0];
            return source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
        }), selected);
    });
}

it("XPath text nodes follow the logical XML model, including coalesced CDATA and empty sections", async () => {
    const source = '<root><item>A<![CDATA[B]]>C</item><empty><![CDATA[]]></empty></root>';
    assert.deepEqual((await h.query(source, "xpath", "//item/text()")).map(({ matched }) => matched), ["ABC"]);
    assert.equal((await h.query(source, "xpath", "count(//item/text())"))[0].matched, "1");
    assert.deepEqual(await h.query(source, "xpath", "//empty/text()"), []);
    assert.equal((await h.query(source, "jsonpath", '$.children[0].children[0].text'))[0].matched, "ABC");
});

it("XPath excludes the XML declaration and document whitespace, but preserves processing instructions", async () => {
    const source = '<?xml version="1.0"?>\n<?check ready?>\n<root/>\n';
    assert.deepEqual(await h.query(source, "xpath", "/text()"), []);
    const instructions = await h.query(source, "xpath", "/processing-instruction()");
    assert.deepEqual(instructions.map(({ matched }) => matched), ["ready"]);
    assert.deepEqual(instructions[0].regions, [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 16 }]);
});
