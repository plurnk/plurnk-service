import test from "node:test";
import assert from "node:assert/strict";
import TextMarkdown from "../../src/mimetypes/TextMarkdown.ts";

test("TextMarkdown: mimetype identifier is 'text/markdown'", () => {
    assert.equal(new TextMarkdown().mimetype, "text/markdown");
});

test("TextMarkdown: glyph is 📝", () => {
    assert.equal(new TextMarkdown().glyph, "📝");
});

test("TextMarkdown: validate accepts any string", () => {
    const h = new TextMarkdown();
    h.validate("");
    h.validate("# heading");
    h.validate("just prose");
});

test("TextMarkdown: symbols extracts a single h1 heading", () => {
    const h = new TextMarkdown();
    assert.equal(h.symbols("# Hello"), "Hello");
});

test("TextMarkdown: symbols indents headings by level", () => {
    const h = new TextMarkdown();
    const md = "# Top\n## Section\n### Sub";
    assert.equal(h.symbols(md), "Top\n  Section\n    Sub");
});

test("TextMarkdown: symbols ignores non-heading lines", () => {
    const h = new TextMarkdown();
    const md = "# Heading\n\nSome body text.\n\n## Sub";
    assert.equal(h.symbols(md), "Heading\n  Sub");
});

test("TextMarkdown: symbols returns empty string for prose-only content", () => {
    const h = new TextMarkdown();
    assert.equal(h.symbols("just some text"), "");
    assert.equal(h.symbols(""), "");
});

test("TextMarkdown: symbols handles all six heading levels", () => {
    const h = new TextMarkdown();
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    assert.equal(h.symbols(md), "H1\n  H2\n    H3\n      H4\n        H5\n          H6");
});

test("TextMarkdown: symbols requires whitespace after # — not just any line starting with #", () => {
    const h = new TextMarkdown();
    assert.equal(h.symbols("#notspaced"), "");
    assert.equal(h.symbols("# spaced"), "spaced");
});

test("TextMarkdown: symbols ignores 7+ pound signs (not valid markdown headings)", () => {
    const h = new TextMarkdown();
    assert.equal(h.symbols("####### too deep"), "");
});

test("TextMarkdown: symbols trims trailing whitespace from heading text", () => {
    const h = new TextMarkdown();
    assert.equal(h.symbols("# trailing space   "), "trailing space");
});

test("TextMarkdown: preview returns the heading outline when headings exist", () => {
    const h = new TextMarkdown();
    const md = "# Heading\n\nProse goes here.\n\n## Sub";
    assert.equal(h.preview(md, 100), "Heading\n  Sub");
});

test("TextMarkdown: preview falls back to content when no headings", () => {
    const h = new TextMarkdown();
    assert.equal(h.preview("just prose", 100), "just prose");
});

test("TextMarkdown: preview respects budget when symbols outline exceeds it", () => {
    const h = new TextMarkdown();
    const md = "# A long heading line that exceeds the chosen budget";
    assert.equal(h.preview(md, 10), "A long hea");
});

test("TextMarkdown: preview respects budget when fallback content exceeds it", () => {
    const h = new TextMarkdown();
    assert.equal(h.preview("a".repeat(50), 10), "a".repeat(10));
});
