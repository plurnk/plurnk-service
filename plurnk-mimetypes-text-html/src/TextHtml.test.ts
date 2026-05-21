import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";

const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

describe("TextHtml — preview produces markdown", () => {
    it("converts a simple HTML page to markdown", async () => {
        const html = "<h1>Title</h1><p>Some paragraph.</p>";
        const md = await h.preview(html, Number.POSITIVE_INFINITY);
        assert.ok(md.includes("# Title"));
        assert.ok(md.includes("Some paragraph."));
    });

    it("preserves heading hierarchy", async () => {
        const html = "<h1>Top</h1><h2>Section</h2><h3>Sub</h3>";
        const md = await h.preview(html, Number.POSITIVE_INFINITY);
        assert.ok(md.includes("# Top"));
        assert.ok(md.includes("## Section"));
        assert.ok(md.includes("### Sub"));
    });

    it("emits fenced code blocks", async () => {
        const html = "<pre><code>const x = 1;</code></pre>";
        const md = await h.preview(html, Number.POSITIVE_INFINITY);
        assert.ok(md.includes("```"));
        assert.ok(md.includes("const x = 1;"));
    });

    it("converts links and encodes parens in hrefs (safe-links rule)", async () => {
        const html = '<a href="https://example.com/path(x)y">label</a>';
        const md = await h.preview(html, Number.POSITIVE_INFINITY);
        assert.ok(md.includes("[label]("));
        // The opening paren in the href should be encoded as %28; the closing as %29.
        assert.ok(md.includes("%28"));
        assert.ok(md.includes("%29"));
    });

    it("preserves link title attributes", async () => {
        const html = '<a href="https://x.test" title="A nice link">label</a>';
        const md = await h.preview(html, Number.POSITIVE_INFINITY);
        assert.ok(md.includes('"A nice link"'));
    });

    it("returns empty string for empty input", async () => {
        const md = await h.preview("", Number.POSITIVE_INFINITY);
        assert.equal(md, "");
    });

    it("accepts Uint8Array content (decodes as utf-8)", async () => {
        const html = "<h1>From Bytes</h1>";
        const bytes = new TextEncoder().encode(html);
        const md = await h.preview(bytes, Number.POSITIVE_INFINITY);
        assert.ok(md.includes("# From Bytes"));
    });

    it("budgets via the injected tokenize function", async () => {
        const tokenizingHandler = new TextHtml(metadata, {
            tokenize: (text) => text.length, // 1 char = 1 token
        });
        const html = "<p>This is a longer paragraph that should get truncated.</p>";
        const md = await tokenizingHandler.preview(html, 10);
        assert.ok(md.length <= 10);
    });
});

describe("TextHtml — symbols and validate inherit framework defaults", () => {
    it("symbols returns empty string by design (preview is the value-add)", () => {
        const html = "<h1>Title</h1>";
        assert.equal(h.symbols(html), "");
    });

    it("extract returns empty array by design", () => {
        const html = "<h1>Title</h1>";
        assert.deepEqual(h.extract(html), []);
    });

    it("validate is a no-op (HTML is forgiving)", () => {
        assert.doesNotThrow(() => h.validate("<not really><valid html>"));
        assert.doesNotThrow(() => h.validate(""));
    });
});
