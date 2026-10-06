import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationXml from "./ApplicationXml.ts";


const metadata = {
    mimetype: "application/xml",
    glyph: "📐",
    extensions: [".xml"] as const,
};

describe("ApplicationXml — symbols channel", () => {
    it("root element → module; immediate children with ids → field by id", async () => {
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

    it("children with name attribute → field by name (when no id)", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<users><user name="alice"/><user name="bob"/></users>`;
        const syms = h.extractRaw(xml);
        assert.deepEqual(
            syms.filter((s) => s.kind === "field").map((s) => s.name),
            ["alice", "bob"],
        );
    });

    it("children without id/name → field by tag name", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<config><host>localhost</host><port>8080</port></config>`;
        const syms = h.extractRaw(xml);
        assert.deepEqual(
            syms.filter((s) => s.kind === "field").map((s) => s.name),
            ["host", "port"],
        );
    });

    it("empty input → empty symbols", () => {
        const h = new ApplicationXml(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });
});

describe("ApplicationXml — container ({§mimetype-symbol-container})", () => {
    it("direct children carry the root element name as container", async () => {
        const h = new ApplicationXml(metadata);
        const syms = h.extractRaw("<root><child/><other id='x'/></root>");
        assert.equal("container" in syms[0], false, "root carries no container");
        assert.equal(syms.find((s) => s.name === "child")?.container, "root");
        assert.equal(syms.find((s) => s.name === "x")?.container, "root");
    });

    it("returns [] for empty content", async () => {
        const h = new ApplicationXml(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });
});

describe("ApplicationXml — deepJson ({§mimetype-channel-architecture})", () => {
    it("returns document root with element tree", async () => {
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

    it("text-only elements collapse to text field", async () => {
        const h = new ApplicationXml(metadata);
        const tree = await h.deepJson("<title>Hello</title>") as {
            children: Array<{ type: string; text?: string }>;
        };
        const title = tree.children[0];
        assert.equal(title.type, "title");
        assert.equal(title.text, "Hello");
    });

    it("attributes surface in the attrs field", async () => {
        const h = new ApplicationXml(metadata);
        const tree = await h.deepJson('<a href="https://x.example" class="ext">click</a>') as {
            children: Array<{ attrs?: Record<string, string>; text?: string }>;
        };
        const a = tree.children[0];
        assert.equal(a.attrs?.href, "https://x.example");
        assert.equal(a.attrs?.class, "ext");
        assert.equal(a.text, "click");
    });

    it("returns null on empty content", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(await h.deepJson(""), null);
    });
});

describe("ApplicationXml — query (xpath against DOM, jsonpath against deepJson)", () => {
    it("xpath returns element matches", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<library><book><title>One</title></book><book><title>Two</title></book></library>";
        const out = await h.query(xml, "xpath", "//title");
        assert.equal(out.length, 2);
        assert.ok((out[0].matched as string).includes("One"));
        assert.ok((out[1].matched as string).includes("Two"));
    });

    it("reports the element region without surrounding indentation", async () => {
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

    it("xpath with attribute predicate returns attribute-filtered elements", async () => {
        const h = new ApplicationXml(metadata);
        const xml = `<users><user id="a">Alice</user><user id="b">Bob</user></users>`;
        const out = await h.query(xml, "xpath", "//user[@id='a']");
        assert.equal(out.length, 1);
        assert.ok((out[0].matched as string).includes("Alice"));
    });

    it("jsonpath dispatches against deepJson (filter elements by type)", async () => {
        const h = new ApplicationXml(metadata);
        const xml = "<doc><a/><b/><a/></doc>";
        const out = await h.query(xml, "jsonpath", "$..children[?(@.type=='a')]");
        assert.equal(out.length, 2);
    });

    it("regex inherits text-based scan", async () => {
        const h = new ApplicationXml(metadata);
        const out = await h.query("<doc>codename: phoenix</doc>", "regex", "codename: (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["phoenix"]);
    });
});

// {§mimetype-parse-issues} — parser recovery is advisory: a recoverable report is counted and the
// document still projects; content that is not a document projects nothing and never throws (#1004).
describe("ApplicationXml — parse issues ({§mimetype-parse-issues})", () => {
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

    it("an undeclared-to-xmldom entity is one recovery site; the document still has its symbols", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(await h.parseIssues(internalSubset), 1);
        assert.deepEqual((await h.extractRaw(internalSubset)).map(({ name, kind }) => `${kind}:${name}`), ["module:page", "field:title", "field:usage"]);
        assert.notEqual(await h.deepJson(internalSubset), null);
        assert.equal((await h.query(internalSubset, "xpath", "//section")).length, 1, "XPath runs over the recovered document");
    });

    it("content that is not a document has no symbols and no deep projection, one issue, and never throws", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(await h.parseIssues(template), 1);
        assert.deepEqual(await h.extractRaw(template), []);
        assert.equal(await h.deepJson(template), null);
        await assert.rejects(h.query(template, "xpath", "//ShortName"), { name: "QueryParseFailureError" }, "a structural query still says the source does not parse");
        assert.equal((await h.query(template, "regex", "Put e\\.g\\.")).length, 1, "text matching is unaffected");
    });

    it("a well-formed document reports no issues", async () => {
        const h = new ApplicationXml(metadata);
        assert.equal(await h.parseIssues("<doc><a id=\"x\"/></doc>"), 0);
        assert.equal(await h.parseIssues(""), 0);
    });
});
