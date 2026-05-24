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

    it("returns an empty SymbolPreview for HTML with no structural signal", async () => {
        const html = "<html><body><p>Just a paragraph.</p></body></html>";
        const syms = await symbolsOf(html);
        assert.deepEqual(syms, []);
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

    it("returns empty SymbolPreview for empty input", async () => {
        const syms = await symbolsOf("");
        assert.deepEqual(syms, []);
    });
});
