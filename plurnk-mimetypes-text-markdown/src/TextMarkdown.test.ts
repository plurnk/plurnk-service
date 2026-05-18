import test from "node:test";
import assert from "node:assert/strict";
import TextMarkdown from "./TextMarkdown.ts";

test("mimetype + glyph declared on instance", () => {
    const m = new TextMarkdown();
    assert.equal(m.mimetype, "text/markdown");
    assert.equal(m.glyph, "📝");
});

test("validate: accepts any string", () => {
    const m = new TextMarkdown();
    assert.doesNotThrow(() => m.validate(""));
    assert.doesNotThrow(() => m.validate("# heading"));
    assert.doesNotThrow(() => m.validate("\x00\x01 garbage"));
});

test("symbols: extracts heading outline with level-based indent", () => {
    const m = new TextMarkdown();
    const md = [
        "# Title",
        "intro text",
        "## Section A",
        "### Sub",
        "## Section B",
    ].join("\n");
    assert.equal(m.symbols(md), [
        "Title",
        "  Section A",
        "    Sub",
        "  Section B",
    ].join("\n"));
});

test("symbols: empty content → empty string", () => {
    const m = new TextMarkdown();
    assert.equal(m.symbols(""), "");
});

test("symbols: no headings → empty string", () => {
    const m = new TextMarkdown();
    assert.equal(m.symbols("just plain paragraph text"), "");
});

test("symbols: supports all 6 heading levels", () => {
    const m = new TextMarkdown();
    const md = ["# h1", "## h2", "### h3", "#### h4", "##### h5", "###### h6"].join("\n");
    assert.equal(m.symbols(md), [
        "h1",
        "  h2",
        "    h3",
        "      h4",
        "        h5",
        "          h6",
    ].join("\n"));
});

test("preview: returns outline when headings exist, body when not, within budget", () => {
    const m = new TextMarkdown();
    const withHeadings = "# Foo\nbody text\n## Bar\nmore body";
    assert.equal(m.preview(withHeadings, 100), "Foo\n  Bar");

    const noHeadings = "plain text";
    assert.equal(m.preview(noHeadings, 100), "plain text");
});

test("preview: truncates to budget when result exceeds it", () => {
    const m = new TextMarkdown();
    const longContent = "a".repeat(500);
    const out = m.preview(longContent, 100);
    assert.equal(out.length, 100);
    assert.equal(out, "a".repeat(100));
});

test("preview: budget=0 returns empty string", () => {
    const m = new TextMarkdown();
    assert.equal(m.preview("anything", 0), "");
});
