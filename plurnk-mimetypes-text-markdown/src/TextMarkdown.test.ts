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
        const symbols = h.extractRaw("# Title\n");
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
        const symbols = h.extractRaw(src);
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
        const symbols = h.extractRaw(src);
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
        const symbols = h.extractRaw(src);
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
        const symbols = h.extractRaw(src);
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
        const symbols = h.extractRaw(src);
        assert.equal(symbols.length, 1);
        assert.equal(symbols[0].name, "Heading");
    });

    it("returns empty array for content with no headings or code blocks", () => {
        const h = new TextMarkdown(metadata);
        assert.deepEqual(h.extractRaw("Just a paragraph with no structure."), []);
    });

    it("returns empty array for empty input", () => {
        const h = new TextMarkdown(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("symbolsRaw() renders heading hierarchy via format()", () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "# Top",
            "",
            "## Section",
            "",
            "### Subsection",
        ].join("\n");
        const out = h.symbolsRaw(src);
        assert.ok(out.includes("# Top"));
        assert.ok(out.includes("## Section"));
        assert.ok(out.includes("### Subsection"));
    });

    it("preview returns a SymbolPreview wrapping extractRaw output", async () => {
        const h = new TextMarkdown(metadata);
        const preview = await h.preview("# Top\n\n## Section\n");
        assert.equal(preview?.kind, "symbols");
        if (preview?.kind !== "symbols") return;
        const names = [...preview.symbols].map((s) => s.name);
        assert.deepEqual(names, ["Top", "Section"]);
    });

    it("inherits jsonpath query against the bare-leaves outline tree", async () => {
        const h = new TextMarkdown(metadata);
        const src = ["# Top", "", "## Section", "", "### Sub"].join("\n");
        // Navigate via heading names.
        const sub = await h.query(src, "jsonpath", "$.Top.Section.Sub");
        assert.equal(sub.length, 1);
        assert.equal(sub[0].matched, 5);
        assert.equal(sub[0].line, 5);

        const sectionSubtree = await h.query(src, "jsonpath", "$.Top.Section");
        assert.equal(sectionSubtree.length, 1);
        assert.deepEqual(sectionSubtree[0].matched, { Sub: 5 });
    });

    it("inherits regex query against the raw markdown body", async () => {
        const h = new TextMarkdown(metadata);
        const src = "# Top\n\nSome body with codename: phoenix in it.";
        const out = await h.query(src, "regex", "codename: (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["codename: phoenix", "phoenix"]);
    });
});
