import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextMarkdown from "./TextMarkdown.ts";

const metadata = {
    mimetype: "text/markdown",
    glyph: "📝",
    extensions: [".md", ".markdown"] as const,
};

describe("TextMarkdown", () => {
    it("instantiates with metadata", () => {
        const h = new TextMarkdown(metadata);
        assert.equal(h.mimetype, "text/markdown");
        assert.equal(h.glyph, "📝");
    });

    it("validate is a no-op (any string is valid markdown)", () => {
        const h = new TextMarkdown(metadata);
        assert.doesNotThrow(() => h.validate(""));
        assert.doesNotThrow(() => h.validate("not really markdown @@@"));
    });

    it("extracts a single ATX heading", () => {
        const h = new TextMarkdown(metadata);
        const symbols = h.extract("# Title\n");
        assert.equal(symbols.length, 1);
        assert.deepEqual(symbols[0], {
            name: "Title",
            kind: "heading",
            level: 1,
            line: 1,
            endLine: 1,
        });
    });

    it("extracts multiple headings at distinct levels with correct line numbers", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "# Top",
            "",
            "## Section",
            "",
            "Some prose paragraph.",
            "",
            "### Subsection",
            "",
            "## Other",
        ].join("\n");
        const symbols = h.extract(src);
        const byName = new Map(symbols.map((s) => [s.name, s]));
        assert.equal(byName.get("Top")?.line, 1);
        assert.equal(byName.get("Top")?.level, 1);
        assert.equal(byName.get("Section")?.line, 3);
        assert.equal(byName.get("Section")?.level, 2);
        assert.equal(byName.get("Subsection")?.line, 7);
        assert.equal(byName.get("Subsection")?.level, 3);
        assert.equal(byName.get("Other")?.line, 9);
        assert.equal(byName.get("Other")?.level, 2);
    });

    it("extracts setext headings (=== and ---)", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "Title One",
            "=========",
            "",
            "Title Two",
            "---------",
        ].join("\n");
        const symbols = h.extract(src);
        const names = symbols.map((s) => s.name);
        assert.ok(names.includes("Title One"));
        assert.ok(names.includes("Title Two"));
        const titleOne = symbols.find((s) => s.name === "Title One");
        const titleTwo = symbols.find((s) => s.name === "Title Two");
        assert.equal(titleOne?.level, 1);
        assert.equal(titleTwo?.level, 2);
    });

    it("extracts a fenced code block with its language", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "Before code.",
            "",
            "```typescript",
            "const x = 1;",
            "```",
            "",
            "After code.",
        ].join("\n");
        const symbols = h.extract(src);
        const code = symbols.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "typescript");
        assert.equal(code.line, 3);
        assert.equal(code.endLine, 5);
    });

    it("extracts a fenced code block without language as kind=module name=code", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "```",
            "raw code",
            "```",
        ].join("\n");
        const symbols = h.extract(src);
        const code = symbols.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "code");
    });

    it("ignores inline content (paragraphs, links, lists) — only headings and code blocks", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "# Heading",
            "",
            "A paragraph with [a link](http://example.com).",
            "",
            "- item one",
            "- item two",
        ].join("\n");
        const symbols = h.extract(src);
        assert.equal(symbols.length, 1);
        assert.equal(symbols[0].name, "Heading");
    });

    it("returns empty array for content with no headings or code blocks", () => {
        const h = new TextMarkdown(metadata);
        assert.deepEqual(h.extract("Just a paragraph with no structure."), []);
    });

    it("returns empty array for empty input", () => {
        const h = new TextMarkdown(metadata);
        assert.deepEqual(h.extract(""), []);
    });

    it("symbols() renders heading hierarchy via format()", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "# Top",
            "",
            "## Section",
            "",
            "### Subsection",
        ].join("\n");
        const out = h.symbols(src);
        assert.ok(out.includes("# Top"));
        assert.ok(out.includes("## Section"));
        assert.ok(out.includes("### Subsection"));
    });
});
