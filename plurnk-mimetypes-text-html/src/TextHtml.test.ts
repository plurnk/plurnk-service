import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";
import type { SymbolPreview } from "@plurnk/plurnk-mimetypes";

const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

async function symbolsOf(html: string | Uint8Array) {
    const preview = (await h.preview(html)) as SymbolPreview;
    assert.equal(preview.kind, "symbols");
    return [...preview.symbols];
}

describe("TextHtml — heading extraction", () => {
    it("emits <h1>-<h6> as heading symbols with level from the tag", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 3);
        assert.deepEqual(headings.map((h) => ({ n: h.name, l: h.level })), [
            { n: "Top", l: 1 },
            { n: "Section", l: 2 },
            { n: "Sub", l: 3 },
        ]);
    });

    it("captures source line numbers from parse5", async () => {
        const html = "<html>\n<body>\n<h1>One</h1>\n<h2>Two</h2>\n</body>\n</html>";
        const syms = await symbolsOf(html);
        const one = syms.find((s) => s.name === "One");
        const two = syms.find((s) => s.name === "Two");
        assert.equal(one?.line, 3);
        assert.equal(two?.line, 4);
    });

    it("collects nested text inside a heading (anchors, spans, emphasis)", async () => {
        const html = "<h2>Hello <strong>brave</strong> <em>world</em></h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Hello brave world");
    });

    it("skips headings whose text content is empty after trimming", async () => {
        const html = "<h1>   </h1><h2>Real</h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Real");
    });

    it("falls back to head-oriented TextPreview when no headings/title exist (hybrid)", async () => {
        const html = "<html><body><p>Just a paragraph.</p></body></html>";
        const preview = await h.preview(html);
        assert.equal(preview?.kind, "text");
        if (preview?.kind !== "text") return;
        assert.equal(preview.text, html);
        assert.equal(preview.orientation, "head");
    });

    it("falls back to TextPreview for empty input rather than going dark", async () => {
        const preview = await h.preview("");
        // Empty input → no structural symbols → text fallback with empty content.
        // Framework's fitContent returns "" for empty content anyway.
        assert.equal(preview?.kind, "text");
    });
});

describe("TextHtml — <title> fallback", () => {
    it("promotes <title> to a level-1 heading when no <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h2>S</h2></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Page Title");
        assert.equal(syms[0].kind, "heading");
        assert.equal(syms[0].level, 1);
    });

    it("does NOT inject the title when a real <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h1>Real Top</h1></body></html>";
        const syms = await symbolsOf(html);
        // Only the h1 — no duplicate from the title.
        const h1s = syms.filter((s) => s.kind === "heading" && s.level === 1);
        assert.equal(h1s.length, 1);
        assert.equal(h1s[0].name, "Real Top");
    });

    it("handles documents with title but no body content", async () => {
        const html = "<html><head><title>Only Title</title></head><body></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Only Title");
    });
});

describe("TextHtml — code blocks", () => {
    it("emits <pre><code> as a module symbol named 'code' when no language class", async () => {
        const html = "<h1>X</h1><pre><code>const x = 1;</code></pre>";
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "code");
    });

    it("extracts language from class='language-X' (highlight.js convention)", async () => {
        const html = '<h1>X</h1><pre><code class="language-typescript">const x: number = 1;</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "typescript");
    });

    it("supports multiple classes alongside language- (e.g. 'highlight language-python')", async () => {
        const html = '<h1>X</h1><pre><code class="highlight language-python token">x = 1</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.equal(code?.name, "python");
    });

    it("does not enter pre's children (no spurious nested symbols from code content)", async () => {
        const html = "<pre><code>&lt;h1&gt;Not a real heading&lt;/h1&gt;</code></pre>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 0);
    });
});

describe("TextHtml — content shape", () => {
    it("accepts Uint8Array content (decoded as utf-8)", async () => {
        const html = "<h1>From Bytes</h1>";
        const bytes = new TextEncoder().encode(html);
        const syms = await symbolsOf(bytes);
        assert.equal(syms[0].name, "From Bytes");
    });

    it("validate is a no-op (HTML is forgiving by spec)", () => {
        assert.doesNotThrow(() => h.validate("<not really><valid html>"));
        assert.doesNotThrow(() => h.validate(""));
    });

    it("falls back to (empty) TextPreview for empty input", async () => {
        // No structural signal → text fallback. The text is empty but the
        // preview shape is text/head, not symbols.
        const preview = await h.preview("");
        assert.equal(preview?.kind, "text");
    });
});

describe("TextHtml — xpath query", () => {
    it("matches elements and returns serialized XML as `matched`", async () => {
        const html = "<html><body><p>One</p><p>Two</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 2);
        const first = out[0].matched as string;
        assert.ok(first.includes("One"));
        assert.ok(first.includes("<p"));
    });

    it("emits `matching` with indexed xpath form when there are multiple results", async () => {
        const html = "<html><body><p>A</p><p>B</p><p>C</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 3);
        assert.equal(out[0].matching, "(//p)[1]");
        assert.equal(out[1].matching, "(//p)[2]");
        assert.equal(out[2].matching, "(//p)[3]");
    });

    it("omits `matching` for single results", async () => {
        const html = "<html><body><h1>Only</h1></body></html>";
        const out = await h.query(html, "xpath", "//h1");
        assert.equal(out.length, 1);
        assert.equal(out[0].matching, undefined);
    });

    it("returns string for attribute-axis queries", async () => {
        const html = '<html><body><a href="x">a</a><a href="y">b</a></body></html>';
        const out = await h.query(html, "xpath", "//a/@href");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "x");
        assert.equal(out[1].matched, "y");
    });

    it("returns string for text() node queries", async () => {
        const html = "<html><body><p>Hello world</p></body></html>";
        const out = await h.query(html, "xpath", "//p/text()");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Hello world");
    });

    it("returns a single primitive for string() function expressions", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "string(//h1)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Top");
    });

    it("returns [] when xpath matches nothing", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "//nonexistent");
        assert.deepEqual(out, []);
    });
});

describe("TextHtml — regex/jsonpath inheritance", () => {
    it("inherits regex query against the raw HTML source", async () => {
        const html = "<html><body><!-- TODO: cleanup --></body></html>";
        const out = await h.query(html, "regex", "TODO: (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["cleanup"]);
    });

    it("inherits jsonpath query against the outline (heading navigation)", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const out = await h.query(html, "jsonpath", "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(typeof out[0].matched, "number");
    });
});
