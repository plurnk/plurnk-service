import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationXml from "./ApplicationXml.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

// ─── ApplicationXml.test.ts ───
{
const metadata = {
    mimetype: "application/xml",
    glyph: "📐",
    extensions: [".xml"] as const,
};

describe("{§xml-shape} symbols are the root and its immediate children", () => {
    it("{§xml-shape} root element → module; immediate children with ids → field by id", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<library>
  <book id="b1"><title>One</title></book>
  <book id="b2"><title>Two</title></book>
</library>`;
        const syms = h.extractRaw(xml);
        assert.equal(syms[0].name, "library");
        assert.equal(syms[0].kind, "module");
        const fields = syms.filter((s) => s.kind === "field");
        assert.deepEqual(fields.map((s) => s.name), ["b1", "b2"]);
    });

    it("{§xml-shape} children with name attribute → field by name (when no id)", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<users><user name="alice"/><user name="bob"/></users>`;
        const syms = h.extractRaw(xml);
        assert.deepEqual(
            syms.filter((s) => s.kind === "field").map((s) => s.name),
            ["alice", "bob"],
        );
    });

    it("{§xml-shape} children without id/name → field by tag name", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<config><host>localhost</host><port>8080</port></config>`;
        const syms = h.extractRaw(xml);
        assert.deepEqual(
            syms.filter((s) => s.kind === "field").map((s) => s.name),
            ["host", "port"],
        );
    });

    it("{§xml-shape} empty input → empty symbols", () => {
        const h = new ApplicationXml(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });
});

describe("{§mimetype-symbol} direct children carry the root element as container", () => {
    it("{§xml-shape} direct children carry the root element name as container", async () => {
        const h = new ApplicationXml(metadata);
        const syms = h.extractRaw("<root><child/><other id='x'/></root>");
        assert.equal("container" in syms[0], false, "root carries no container");
        assert.equal(syms.find((s) => s.name === "child")?.container, "root");
        assert.equal(syms.find((s) => s.name === "x")?.container, "root");
    });
});

describe("{§mimetype-channel-architecture} deepJson is the DOM as nested objects", () => {
    it("{§xml-shape} returns document root with element tree", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<rss version='2.0'><channel><title>Feed</title></channel></rss>";
        const tree = await h.deepJson(xml) as {
            type: string;
            children: Array<{ type: string; attrs?: Record<string, string>; children?: unknown[] }>;
        };
        assert.equal(tree.type, "document");
        assert.equal(tree.children[0].type, "rss");
        assert.equal(tree.children[0].attrs?.version, "2.0");
    });

    it("{§xml-shape} text-only elements collapse to text field", async () => {
        const h = new ApplicationXml(metadata);
        const tree = await h.deepJson("<title>Hello</title>") as {
            children: Array<{ type: string; text?: string }>;
        };
        const title = tree.children[0];
        assert.equal(title.type, "title");
        assert.equal(title.text, "Hello");
    });

    it("{§xml-shape} attributes surface in the attrs field", async () => {
        const h = new ApplicationXml(metadata);
        const tree = await h.deepJson('<a href="https://x.example" class="ext">click</a>') as {
            children: Array<{ attrs?: Record<string, string>; text?: string }>;
        };
        const a = tree.children[0];
        assert.equal(a.attrs?.href, "https://x.example");
        assert.equal(a.attrs?.class, "ext");
        assert.equal(a.text, "click");
    });

    it("{§xml-shape} returns null on empty content", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(await h.deepJson(""), null);
    });
});

describe("{§xml-shape} xpath runs over the DOM and jsonpath over its projection", () => {
    it("{§xml-shape} xpath returns element matches", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<library><book><title>One</title></book><book><title>Two</title></book></library>";
        const out = await h.query(xml, "xpath", "//title");
        assert.equal(out.length, 2);
        assert.ok((out[0].matched as string).includes("One"));
        assert.ok((out[1].matched as string).includes("Two"));
    });

    it("{§xml-shape} reports the element region without surrounding indentation", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<library>\n  <book>One</book>\n  <book>Two</book>\n</library>";
        const out = await h.query(xml, "xpath", "//book");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 3, endLine: 2, endColumn: 19,
        }]);
        assert.deepEqual(out[1].regions, [{
            startLine: 3, startColumn: 3, endLine: 3, endColumn: 19,
        }]);
    });

    it("{§mimetype-query}: a computed scalar carries no lines", async () => {
        const h = new ApplicationXml(metadata);
        const out = await h.query("<a><b/><b/></a>", "xpath", "count(//b)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "2");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//b)");
    });

    it("{§xml-shape} xpath with attribute predicate returns attribute-filtered elements", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<users><user id="a">Alice</user><user id="b">Bob</user></users>`;
        const out = await h.query(xml, "xpath", "//user[@id='a']");
        assert.equal(out.length, 1);
        assert.ok((out[0].matched as string).includes("Alice"));
    });

    it("{§xml-shape} jsonpath dispatches against deepJson (filter elements by type)", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<doc><a/><b/><a/></doc>";
        const out = await h.query(xml, "jsonpath", "$..children[?(@.type=='a')]");
        assert.equal(out.length, 2);
    });

    it("{§xml-shape} regex inherits text-based scan", async () => {
        const h = new ApplicationXml(metadata);
        const out = await h.query("<doc>codename: phoenix</doc>", "regex", "codename: (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["phoenix"]);
    });
});

// {§mimetype-channel-selection} — parser recovery is advisory: a recoverable report is counted and the
// document still projects; content that is not a document projects nothing and never throws (#1004).
describe("{§xml-shape} parse issues", () => {
    // A DocBook page's shape: entities declared in the internal DTD subset, which xmldom does not expand.
    const internalSubset = [
        "<?xml version='1.0'?>",
        "<!DOCTYPE page [",
        "  <!ENTITY product \"isympy\">",
        "]>",
        "<page>",
        "  <title>&product; reference</title>",
        "  <section id=\"usage\">run it</section>",
        "</page>",
    ].join("\n");
    // A Jinja template's shape: a tag inside a template comment leaves the file unbalanced.
    const template = [
        "<?xml version=\"1.0\"?>",
        "<OpenSearchDescription>",
        "  <ShortName>{{ project|e }}</ShortName>",
        "  {# Put e.g. an <Image> element here. #}",
        "</OpenSearchDescription>",
    ].join("\n");

    it("{§xml-shape} an undeclared-to-xmldom entity is one recovery site; the document still has its symbols", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(h.parseIssues(internalSubset), 1);
        assert.deepEqual(h.extractRaw(internalSubset).map(({ name, kind }) => `${kind}:${name}`), ["module:page", "field:title", "field:usage"]);
        assert.notEqual(await h.deepJson(internalSubset), null);
        assert.equal((await h.query(internalSubset, "xpath", "//section")).length, 1, "XPath runs over the recovered document");
    });

    it("{§xml-shape} content that is not a document has no symbols and no deep projection, one issue, and never throws", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(h.parseIssues(template), 1);
        assert.deepEqual(h.extractRaw(template), []);
        assert.equal(await h.deepJson(template), null);
        await assert.rejects(h.query(template, "xpath", "//ShortName"), { name: "QueryParseFailureError" }, "a structural query still says the source does not parse");
        assert.equal((await h.query(template, "regex", "Put e\\.g\\.")).length, 1, "text matching is unaffected");
    });

    it("{§xml-shape} a well-formed document reports no issues", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(h.parseIssues("<doc><a id=\"x\"/></doc>"), 0);
        assert.equal(h.parseIssues(""), 0);
    });
});
}

// ─── queryRegions.test.ts ───
{
// XML is itself the readable text, so both structural dialects may report
// honest regions in that same representation.





const h = new ApplicationXml({ mimetype: "application/xml", glyph: "<>", extensions: [".xml"] as const });
const xml = "<root>\n  <a>1</a>\n  <b>\n    <c>x</c>\n  </b>\n</root>";

describe("{§xml-shape} structural match regions", () => {
    it("{§xml-shape} classifies exact and locator-only evidence explicitly", async () => {
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
    it("{§xml-shape} a multi-line element spans its content on both dialects", async () => {
        const jb = await h.query(xml, "jsonpath", "$..children[?(@.type==\"b\")]");
        const xb = await h.query(xml, "xpath", "//b");
        assert.deepEqual(jb[0].regions, [{
            startLine: 3, startColumn: 3, endLine: 5, endColumn: 7,
        }]);
        assert.deepEqual(xb[0].regions, jb[0].regions);
    });
});

// {§zero-width-column-one-insert} — serialized values are not source spans.
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
    it(`{§xml-shape} XPath ${pattern} selects exact lexical source in ${JSON.stringify(source)}`, async () => {
        const matches = await h.query(source, "xpath", pattern);
        const coordinates = new TextCoordinates(source);
        assert.deepEqual(matches.map((match) => {
            assert.equal(match.regions?.length, 1, JSON.stringify(match));
            const region = match.regions[0];
            return source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
        }), selected);
    });
}

it("{§xml-shape} XPath text nodes follow the logical XML model, including coalesced CDATA and empty sections", async () => {
    const source = '<root><item>A<![CDATA[B]]>C</item><empty><![CDATA[]]></empty></root>';
    assert.deepEqual((await h.query(source, "xpath", "//item/text()")).map(({ matched }) => matched), ["ABC"]);
    assert.equal((await h.query(source, "xpath", "count(//item/text())"))[0].matched, "1");
    assert.deepEqual(await h.query(source, "xpath", "//empty/text()"), []);
    assert.equal((await h.query(source, "jsonpath", '$.children[0].children[0].text'))[0].matched, "ABC");
});

it("{§xml-shape} XPath excludes the XML declaration and document whitespace, but preserves processing instructions", async () => {
    const source = '<?xml version="1.0"?>\n<?check ready?>\n<root/>\n';
    assert.deepEqual(await h.query(source, "xpath", "/text()"), []);
    const instructions = await h.query(source, "xpath", "/processing-instruction()");
    assert.deepEqual(instructions.map(({ matched }) => matched), ["ready"]);
    assert.deepEqual(instructions[0].regions, [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 16 }]);
});
}
