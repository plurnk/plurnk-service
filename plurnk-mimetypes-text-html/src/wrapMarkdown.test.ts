import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownWrapColumns, wrapMarkdown } from "./wrapMarkdown.ts";

describe("wrapMarkdown", () => {
    it("wraps prose at whitespace without losing text", () => {
        const source = "One two three four five six seven eight nine ten eleven twelve.";
        const wrapped = wrapMarkdown(source, 20);
        assert.ok(wrapped.split("\n").every((line) => line.length <= 20));
        assert.equal(wrapped.replaceAll("\n", " "), source);
    });

    it("preserves fenced code, headings, tables, inline code, links, and raw tags", () => {
        const link = "[primary source](https://example.com/a_very_long_path?q=one%20two)";
        const code = "`const value = a + b`";
        const tag = "<span data-label=\"a long retained raw tag\">";
        const source = [
            "# A heading whose structure must remain a heading even when it is long",
            "",
            `Read ${link} and keep ${code} beside ${tag} safely.`,
            "",
            "| long table cell | another long table cell |",
            "| --- | --- |",
            "",
            "```js",
            "const unwrapped = \"a deliberately long source line inside a fenced code block\";",
            "```",
        ].join("\n");
        const wrapped = wrapMarkdown(source, 30);
        assert.ok(wrapped.includes(link));
        assert.ok(wrapped.includes(code));
        assert.ok(wrapped.includes(tag));
        assert.ok(wrapped.includes(source.split("\n")[0]));
        assert.ok(wrapped.includes(source.split("\n")[4]));
        assert.ok(wrapped.includes(source.split("\n")[8]));
    });

    it("keeps list and blockquote continuation inside their structures", () => {
        assert.equal(
            wrapMarkdown("- alpha beta gamma delta epsilon", 16),
            "- alpha beta\n  gamma delta\n  epsilon",
        );
        assert.equal(
            wrapMarkdown("> alpha beta gamma delta", 14),
            "> alpha beta\n> gamma delta",
        );
    });

    it("zero disables wrapping", () => {
        const source = "a long line that remains exactly as authored";
        assert.equal(wrapMarkdown(source, 0), source);
    });
});

describe("markdownWrapColumns", () => {
    it("reads zero or a positive integer and rejects malformed configuration", () => {
        const prior = process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS;
        try {
            process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = "100";
            assert.equal(markdownWrapColumns(), 100);
            process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = "0";
            assert.equal(markdownWrapColumns(), 0);
            for (const invalid of ["-1", "1.5", "wide"]) {
                process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = invalid;
                assert.throws(markdownWrapColumns, /must be 0 or a positive integer/);
            }
        } finally {
            if (prior === undefined) delete process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS;
            else process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = prior;
        }
    });
});
