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

describe("TextHtml — content channel (SPEC §18)", () => {
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

describe("TextHtml — toText routes through the same projection", () => {
    it("toText() returns the same markdown as content() for an article", () => {
        // toText is protected; reach it via the regex query path is awkward, so
        // assert the shared projection directly through a typed cast.
        const toText = (h as unknown as { toText(c: string): string }).toText.bind(h);
        assert.equal(toText(ARTICLE), h.content(ARTICLE));
    });

    it("toText() falls back to raw HTML when there is no readable markdown", () => {
        // A comment-only body has no readable content (content() → undefined),
        // so toText must degrade to the raw HTML rather than empty string —
        // keeping regex/glob body matchers functional.
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

    it("regex body-matcher scans the markdown, not the raw HTML", async () => {
        // The class attribute lives only in raw HTML; the readable text lives
        // only in markdown. A regex for the article text matches; a regex for
        // a class name does not — proving toText fed the markdown.
        const html = `<article><h1>FindableHeading</h1><p class="prose">${"body text ".repeat(20)}</p></article>`;
        const found = await h.query(html, "regex", "FindableHeading");
        assert.equal(found.length, 1);
        const cls = await h.query(html, "regex", "prose");
        assert.equal(cls.length, 0, "raw HTML class attr absent from the markdown projection");
    });
});
