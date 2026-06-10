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

    it("symbolsRaw() renders heading hierarchy via format()", async () => {
        const h = new TextMarkdown(metadata);
        const src = [
            "# Top",
            "",
            "## Section",
            "",
            "### Subsection",
        ].join("\n");
        const out = await h.symbolsRaw(src);
        assert.ok(out.includes("# Top"));
        assert.ok(out.includes("## Section"));
        assert.ok(out.includes("### Subsection"));
    });

    it("extractRaw returns [] for prose with no headings or code blocks (poem case)", async () => {
        const h = new TextMarkdown(metadata);
        const poem = "Some prose without headings.\nMore prose. Still no structure.";
        assert.deepEqual(h.extractRaw(poem), []);
    });

    it("headings carry ancestor-heading container paths (issue #18)", async () => {
        const h = new TextMarkdown(metadata);
        const src = "# A\n\n## B\n\n### C\n\n## D\n";
        const syms = h.extractRaw(src);
        const byName = new Map(syms.map((s) => [s.name, s]));
        assert.equal("container" in byName.get("A")!, false, "top-level heading: container absent");
        assert.equal(byName.get("B")!.container, "A");
        assert.equal(byName.get("C")!.container, "A.B");
        assert.equal(byName.get("D")!.container, "A", "level-2 D closes B and C");
    });

    it("code blocks carry the innermost open heading as container (issue #18)", async () => {
        const h = new TextMarkdown(metadata);
        const src = "# A\n\n## B\n\n```ts\nconst x = 1;\n```\n";
        const syms = h.extractRaw(src);
        assert.equal(syms.find((s) => s.kind === "module")!.container, "A.B");
    });

    it("code block before any heading has no container (issue #18)", async () => {
        const h = new TextMarkdown(metadata);
        const src = "```ts\nconst x = 1;\n```\n\n# After\n";
        const syms = h.extractRaw(src);
        assert.equal("container" in syms.find((s) => s.kind === "module")!, false);
    });

    it("deepJson returns the marked AST as a document tree with line annotations", async () => {
        const h = new TextMarkdown(metadata);
        const tree = await h.deepJson("# Top\n\nA paragraph.\n\n```ts\nconst x = 1;\n```\n") as {
            type: string;
            children: Array<{ type: string; level?: number; text?: string; lang?: string }>;
        };
        assert.equal(tree.type, "document");
        const heading = tree.children.find((c) => c.type === "heading");
        assert.ok(heading);
        assert.equal(heading!.level, 1);
        assert.equal(heading!.text, "Top");
        const code = tree.children.find((c) => c.type === "code");
        assert.ok(code);
        assert.equal(code!.lang, "ts");
    });

    it("deepJson returns null for binary content", async () => {
        const h = new TextMarkdown(metadata);
        assert.equal(await h.deepJson(new Uint8Array([1, 2, 3])), null);
    });

    it("inherits jsonpath query against the deep-json markdown AST (issue #10)", async () => {
        const h = new TextMarkdown(metadata);
        const src = ["# Top", "", "## Section", "", "### Sub"].join("\n");
        // Find all heading nodes via filter expression — full-tree reach per
        // the deep-json contract.
        const headings = await h.query(src, "jsonpath", "$..children[?(@.type=='heading')]");
        assert.equal(headings.length, 3);
        const names = headings.map((m) => (m.matched as { text: string }).text);
        assert.deepEqual(names, ["Top", "Section", "Sub"]);

        // Filter by level — possible because the deep tree preserves it.
        const h1s = await h.query(src, "jsonpath", "$..children[?(@.type=='heading' && @.level==1)]");
        assert.equal(h1s.length, 1);
        assert.equal((h1s[0].matched as { text: string }).text, "Top");
    });

    it("inherits regex query against the raw markdown body", async () => {
        const h = new TextMarkdown(metadata);
        const src = "# Top\n\nSome body with codename: phoenix in it.";
        const out = await h.query(src, "regex", "codename: (\\w+)");
        assert.equal(out.length, 1);
        // Anonymous captures per grammar #17: array of capture values only
        // (the full match itself is not included).
        assert.deepEqual(out[0].matched, ["phoenix"]);
    });
});
