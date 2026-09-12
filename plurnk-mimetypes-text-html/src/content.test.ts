import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";

const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

// An article-shaped page: header/nav chrome, an <article> body, footer chrome.
// Readability should keep the article and drop the chrome.
const ARTICLE = `<!DOCTYPE html>
<html>
<head><title>My Great Article</title></head>
<body>
<header><nav>
<a href="/home">HomeNavLink</a>
<a href="/about">AboutNavLink</a>
</nav></header>
<article>
<h1>The Great Heading</h1>
<p>This is the opening paragraph with a <a href="https://example.com">ExampleLink</a> inside it.</p>
<h2>A Subsection Heading</h2>
<ul><li>First list item</li><li>Second list item</li></ul>
<p>${"Substantial article body text that gives Readability enough signal. ".repeat(15)}</p>
</article>
<footer><p>FooterChromeCopyright 2026</p></footer>
</body>
</html>`;

describe("TextHtml — content channel ({§mimetype-content})", () => {
    it("returns markdown containing the article text", () => {
        const md = h.content(ARTICLE);
        assert.equal(typeof md, "string");
        assert.ok(md!.includes("The Great Heading"), "article heading text present");
        assert.ok(md!.includes("opening paragraph"), "article body present");
    });

    it("excludes nav and footer chrome", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(!md.includes("HomeNavLink"), "nav link stripped");
        assert.ok(!md.includes("AboutNavLink"), "nav link stripped");
        assert.ok(!md.includes("FooterChromeCopyright"), "footer stripped");
    });

    it("strips all HTML tags (no '<' in the output)", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(!md.includes("<"), "no markup angle brackets remain");
    });

    it("preserves headings, lists, and links as markdown", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(/(^|\n)#{1,6} /.test(md), "ATX heading marker present");
        assert.ok(md.includes("First list item"), "list content present");
        assert.ok(/(^|\n)-\s+/.test(md), "markdown bullet marker present");
        assert.ok(md.includes("[ExampleLink](https://example.com)"), "markdown link present");
    });

    it("wraps projected prose at the configured default", () => {
        const prose = `${"readable prose ".repeat(30)}`.trim();
        const md = h.content(`<article><p>${prose}</p></article>`) as string;
        assert.ok(md.split("\n").length > 1, "the dense source paragraph gained line boundaries");
        assert.ok(md.split("\n").every((line) => line.length <= 100), "ordinary prose respects the 100-column floor");
        assert.equal(md.replaceAll("\n", " "), prose);
    });

    it("falls back to body markdown for a non-article fragment (<form>)", () => {
        const md = h.content("<form><h2>Sign up</h2><p>Enter your details below.</p></form>");
        assert.equal(typeof md, "string");
        assert.ok(md!.length > 0, "non-empty");
        assert.ok(!md!.includes("<"), "tag-free");
        assert.ok(md!.includes("Sign up"), "fragment heading present");
        assert.ok(md!.includes("Enter your details"), "fragment body present");
    });

    it("falls back to body markdown for a bare <div> of text", () => {
        const md = h.content("<div>Just some plain text in a div, no article structure.</div>");
        assert.equal(md, "Just some plain text in a div, no article structure.");
    });

    it("returns undefined for empty input", () => {
        assert.equal(h.content(""), undefined);
    });

    it("returns undefined for whitespace-only input", () => {
        assert.equal(h.content("   \n\t  "), undefined);
    });

    it("decodes Uint8Array content as utf-8", () => {
        const bytes = new TextEncoder().encode("<div>Bytes become markdown.</div>");
        const md = h.content(bytes);
        assert.equal(md, "Bytes become markdown.");
    });
});

describe("TextHtml — toText is the raw markup, the projection is content()", () => {
    it("toText() returns the source itself, never the projection", () => {
        // {§mimetype-content}: the projection is a channel the consumer stores; regex and glob
        // over the source channel see the markup.
        const toText = (h as unknown as { toText(c: string): string }).toText.bind(h);
        assert.equal(toText(ARTICLE), ARTICLE);
        assert.notEqual(h.content(ARTICLE), ARTICLE);
    });

    it("content() is absent when there is no readable projection, and toText() is still the source", () => {
        const html = "<html><body><!-- TODO: cleanup --></body></html>";
        const toText = (h as unknown as { toText(c: string): string }).toText.bind(h);
        assert.equal(h.content(html), undefined);
        assert.equal(toText(html), html);
    });
});

describe("TextHtml — content channel integration", () => {
    it("a known article's nav text is absent while the article survives", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(md.includes("The Great Heading"));
        assert.ok(md.includes("A Subsection Heading"));
        assert.ok(!md.includes("HomeNavLink"));
        assert.ok(!md.includes("FooterChromeCopyright"));
    });

    it("regex matches the markup it is given, in the markup's own coordinates", async () => {
        // {§mimetype-content}: the projection is a channel of its own; a regex over the source
        // channel sees tags and attributes, and its region addresses the source.
        const html = `<article>\n<h1>FindableHeading</h1>\n<p class="prose">${"body text ".repeat(20)}</p></article>`;
        const found = await h.query(html, "regex", "FindableHeading");
        assert.equal(found.length, 1);
        assert.deepEqual(found[0]!.regions, [{ startLine: 2, startColumn: 5, endLine: 2, endColumn: 20 }]);
        const cls = await h.query(html, "regex", "prose");
        assert.equal(cls.length, 1, "the class attribute is source text");
        const tag = await h.query(html, "regex", "<h[1-6]");
        assert.equal(tag.length, 1, "the sweep's case: a heading tag is matchable in the source");
    });
});
