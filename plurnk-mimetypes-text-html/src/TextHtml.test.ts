import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";
import type { TextPreview } from "@plurnk/plurnk-mimetypes";

const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

async function previewText(html: string | Uint8Array): Promise<string> {
    const p = (await h.preview(html)) as TextPreview;
    assert.equal(p.kind, "text");
    return p.text;
}

describe("TextHtml — preview produces a head-oriented markdown TextPreview", () => {
    it("converts a simple HTML page to markdown", async () => {
        const md = await previewText("<h1>Title</h1><p>Some paragraph.</p>");
        assert.ok(md.includes("# Title"));
        assert.ok(md.includes("Some paragraph."));
    });

    it("preserves heading hierarchy", async () => {
        const md = await previewText("<h1>Top</h1><h2>Section</h2><h3>Sub</h3>");
        assert.ok(md.includes("# Top"));
        assert.ok(md.includes("## Section"));
        assert.ok(md.includes("### Sub"));
    });

    it("emits fenced code blocks", async () => {
        const md = await previewText("<pre><code>const x = 1;</code></pre>");
        assert.ok(md.includes("```"));
        assert.ok(md.includes("const x = 1;"));
    });

    it("converts links and encodes parens in hrefs (safe-links rule)", async () => {
        const md = await previewText('<a href="https://example.com/path(x)y">label</a>');
        assert.ok(md.includes("[label]("));
        assert.ok(md.includes("%28"));
        assert.ok(md.includes("%29"));
    });

    it("preserves link title attributes", async () => {
        const md = await previewText('<a href="https://x.test" title="A nice link">label</a>');
        assert.ok(md.includes('"A nice link"'));
    });

    it("returns an empty-text TextPreview for empty input", async () => {
        const p = (await h.preview("")) as TextPreview;
        assert.equal(p.kind, "text");
        assert.equal(p.text, "");
        assert.equal(p.orientation, "head");
    });

    it("accepts Uint8Array content (decodes as utf-8)", async () => {
        const bytes = new TextEncoder().encode("<h1>From Bytes</h1>");
        const md = await previewText(bytes);
        assert.ok(md.includes("# From Bytes"));
    });

    it("declares head orientation (documents read top-down)", async () => {
        const p = (await h.preview("<h1>X</h1>")) as TextPreview;
        assert.equal(p.orientation, "head");
    });
});

describe("TextHtml — symbolsRaw and validate inherit framework defaults", () => {
    it("symbolsRaw returns empty string by design (preview is the value-add)", () => {
        assert.equal(h.symbolsRaw("<h1>Title</h1>"), "");
    });

    it("extractRaw returns empty array by design", () => {
        assert.deepEqual(h.extractRaw("<h1>Title</h1>"), []);
    });

    it("validate is a no-op (HTML is forgiving)", () => {
        assert.doesNotThrow(() => h.validate("<not really><valid html>"));
        assert.doesNotThrow(() => h.validate(""));
    });
});
