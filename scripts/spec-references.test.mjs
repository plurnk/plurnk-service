import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpecReferences } from "./spec-references.mjs";

const cite = (tag) => `{${"§"}${tag}}`;
const declare = (tag) => `${"§"}${tag}`;

test("the first semantic token of a SPEC heading, paragraph, list item, or table row declares a tag", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("one-owner")} First invariant`,
                "",
                `${declare("paragraph-owner")} **Second invariant.** Its continuation may cite`,
                `${cite("list-owner")} without declaring it again.`,
                "",
                `- ${declare("list-owner")} **Third invariant.**`,
                "",
                "| Contract | Meaning |",
                "|---|---|",
                `| ${declare("row-owner")} one | The row owns its invariant. |`,
            ].join("\n"),
        },
        {
            name: "beta/SPEC.md",
            text: `${declare("cross-package-owner")} **Cross-package invariant.** It cites ${cite("one-owner")}.`,
        },
        { name: "alpha/code.ts", text: `// ${cite("one-owner")} ${cite("paragraph-owner")} ${cite("row-owner")}` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("duplicate declarations and every ambiguous citation report all locations", () => {
    const files = [
        { name: "alpha/SPEC.md", text: `### ${declare("one-owner")} First` },
        { name: "beta/SPEC.md", text: `## ${declare("one-owner")} Second` },
        { name: "src/code.ts", text: `// ${cite("one-owner")}` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [{
            tag: "one-owner",
            declarations: [
                { name: "alpha/SPEC.md", line: 1 },
                { name: "beta/SPEC.md", line: 1 },
            ],
        }],
        unresolvedReferences: [],
        ambiguousReferences: [{ name: "src/code.ts", line: 1, tag: "one-owner" }],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("unresolved citations are checked inside and outside specifications", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("known")} Stable`,
                `Missing here: ${cite("missing-in-spec")}.`,
            ].join("\n"),
        },
        {
            name: "src/code.ts",
            text: [
                `// ${cite("known")}`,
                `// ${cite("missing-in-code")}`,
            ].join("\n"),
        },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [
            { name: "alpha/SPEC.md", line: 2, tag: "missing-in-spec" },
            { name: "src/code.ts", line: 2, tag: "missing-in-code" },
        ],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("an unbraced named tag outside a declaration position is invalid", () => {
    const files = [
        {
            name: "alpha/SPEC.md",
            text: [
                `### ${declare("declared")} Stable`,
                `Ordinary ${declare("declared")} is not a citation.`,
                `### Heading ${declare("late-tag")}`,
                "",
                "A paragraph begins here",
                `${declare("late-paragraph")} is not its first semantic token.`,
                "",
                `- A list item with ${declare("late-list")} later in it.`,
                "",
                `| a cell | Later ${declare("late-table")} is not a declaration. |`,
                "```md",
                `### ${declare("example-in-fence")} Not a declaration`,
                "```",
                "Numbered section references such as §3 and §3.bis remain presentation.",
            ].join("\n"),
        },
        { name: "README.md", text: `### ${declare("outside-spec")} Not a declaration` },
    ];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 2, tag: "declared" },
            { name: "alpha/SPEC.md", line: 3, tag: "late-tag" },
            { name: "alpha/SPEC.md", line: 6, tag: "late-paragraph" },
            { name: "alpha/SPEC.md", line: 8, tag: "late-list" },
            { name: "alpha/SPEC.md", line: 10, tag: "late-table" },
            { name: "README.md", line: 1, tag: "outside-spec" },
        ],
        emptyDeclarations: [],
    });
});

test("malformed named tags report the complete token instead of a valid prefix", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            `${declare("real-owner")} **Real invariant.**`,
            `A camel-case typo ${declare("isProposal")} must not be truncated to its lowercase prefix.`,
            `An underscore typo {${declare("old_anchor")}} is not a citation.`,
            `An uppercase typo ${declare("Imperatives")} is not a named contract tag.`,
            "Numeric presentation §3 and §3.bis remains outside the named-tag syntax.",
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 2, tag: "isProposal" },
            { name: "alpha/SPEC.md", line: 3, tag: "old_anchor" },
            { name: "alpha/SPEC.md", line: 4, tag: "Imperatives" },
        ],
        emptyDeclarations: [],
    });
});

test("a heading-looking line in a fenced block does not declare a tag", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            "```md",
            `### ${declare("not-real")} Example`,
            "```",
            cite("not-real"),
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [{ name: "alpha/SPEC.md", line: 4, tag: "not-real" }],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [],
    });
});

test("inline and indented code neither declare nor cite tags", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            `${declare("real-owner")} **Real invariant.**`,
            `Inline \`${cite("missing-inline")} ${declare("not-a-declaration")}\` is inert.`,
            `\`code\` ${declare("late-after-code")} is not a paragraph declaration.`,
            `### \`code\` ${declare("late-heading-code")} is not a heading declaration.`,
            `- \`code\` ${declare("late-list-code")} is not a list declaration.`,
            `| \`code\` ${declare("late-table-code")} | is not a table declaration. |`,
            "",
            `    ${cite("missing-indented")} ${declare("also-not-a-declaration")}`,
            `Outside code ${cite("real-owner")} resolves.`,
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [
            { name: "alpha/SPEC.md", line: 3, tag: "late-after-code" },
            { name: "alpha/SPEC.md", line: 4, tag: "late-heading-code" },
            { name: "alpha/SPEC.md", line: 5, tag: "late-list-code" },
            { name: "alpha/SPEC.md", line: 6, tag: "late-table-code" },
        ],
        emptyDeclarations: [],
    });
});

test("a declaration owns contract text in the same Markdown block", () => {
    const files = [{
        name: "alpha/SPEC.md",
        text: [
            declare("empty-heading"),
            "",
            `### ${declare("empty-heading-two")}`,
            "",
            `- ${declare("continued-list")}`,
            "  The list item's contract continues here.",
            "",
            declare("continued-paragraph"),
            "The paragraph's contract continues here.",
        ].join("\n"),
    }];

    assert.deepEqual(analyzeSpecReferences(files), {
        duplicateDeclarations: [],
        unresolvedReferences: [],
        ambiguousReferences: [],
        invalidTagUsages: [],
        emptyDeclarations: [
            { name: "alpha/SPEC.md", line: 1, tag: "empty-heading" },
            { name: "alpha/SPEC.md", line: 3, tag: "empty-heading-two" },
        ],
    });
});
