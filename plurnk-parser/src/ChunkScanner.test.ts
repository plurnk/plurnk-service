import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { scanChunks } from "./ChunkScanner.ts";
import { buildExecutorSpellings } from "./OptionCoercion.ts";

const SPELLINGS = buildExecutorSpellings(["sh", "js", "python3", "plurnk", "gitea"]);

describe("ChunkScanner", () => {
    test("{§parser-build} {§whitespace-contract} {§slot-order}: scanChunks separates prose, comments, same-line continuations, glued transcript headings, and astral column offsets", () => {
        const input = [
            "  🚀 Intro prose",
            "// standalone comment line ignored at top level",
            'await plurnk.read({ path: "a.ts" }); await plurnk.read({ path: "b.ts" }) // second aside ### log:///1/2/3/read trailing echo',
            'await plurnk.note({ text: "done" }) // clean aside **gitea: issue_read** glued echo',
        ].join("\n");

        const { chunks, unparsedTail } = scanChunks(input, "model", SPELLINGS);
        assert.equal(unparsedTail, undefined);
        assert.equal(chunks.length, 6);
        // 🚀 is 1 codepoint at column 2 (two leading spaces)
        assert.deepEqual(chunks[0], { kind: "text", text: "  🚀 Intro prose", position: { line: 1, column: 2 } });
        assert.deepEqual(chunks[1], {
            kind: "code",
            text: 'await plurnk.read({ path: "a.ts" }); ',
            position: { line: 3, column: 0 },
            defaultAside: null,
        });
        assert.deepEqual(chunks[2], {
            kind: "code",
            text: 'await plurnk.read({ path: "b.ts" }) // second aside ',
            position: { line: 3, column: 37 },
            defaultAside: "second aside",
        });
        assert.deepEqual(chunks[3], {
            kind: "text",
            text: "### log:///1/2/3/read trailing echo",
            position: { line: 3, column: 89 },
        });
        assert.equal(chunks[4]?.kind, "code");
        if (chunks[4]?.kind === "code") {
            assert.equal(chunks[4].defaultAside, "clean aside");
        }
        assert.deepEqual(chunks[5], {
            kind: "text",
            text: "**gitea: issue_read** glued echo",
            position: { line: 4, column: 51 },
        });
    });

    test("{§fence-pairing} {§parse-recovery}: scanChunks handles inline heredocs, trailing heredocs, attached aside heredocs, block comments, and regex literals", () => {
        const input = [
            "/* leading block comment */ await plurnk.find({ path: \"src/**\", pattern: /a\\/b[/]c/i });",
            "await plurnk.edit({ path: \"x.ts\", text: <<<EOF",
            "line 1",
            "EOF }) <<<ASIDE",
            "attached heredoc aside",
            "ASIDE",
            "await plurnk.note(<<-TAIL)",
            "trailing heredoc body",
            "TAIL // trailing closer aside",
        ].join("\n");

        const { chunks, unparsedTail } = scanChunks(input, "model", SPELLINGS);
        assert.equal(unparsedTail, undefined);
        assert.equal(chunks.length, 3);
        assert.equal(chunks[0]?.kind, "code");
        assert.equal(chunks[1]?.kind, "code");
        if (chunks[1]?.kind === "code") {
            assert.equal(chunks[1].defaultAside, "attached heredoc aside");
        }
        assert.equal(chunks[2]?.kind, "code");
        if (chunks[2]?.kind === "code") {
            assert.equal(chunks[2].defaultAside, "trailing closer aside");
        }
    });

    test("{§whitespace-contract} {§parse-recovery}: model tier vs statements tier differentiates general JS prose from plurnk/executor/object-arg calls", () => {
        const input = [
            "const x = computeSomething(1, 2);",
            "const res = await gitea.issue_read({ index: 1 });",
            'const r2 = await unknown_mcp.fetch_item({ id: "abc" });',
            "helper.format(42);",
            'custom_svc.run({ key: "val" });',
        ].join("\n\n");

        const modelScan = scanChunks(input, "model", SPELLINGS);
        // In model tier: `const x = computeSomething(1, 2)` and `helper.format(42)` stay prose;
        // `const res = await gitea...`, `const r2 = await unknown_mcp.fetch_item({ ... })`, and `custom_svc.run({ ... })` enter code chunks
        // (so CallExpressionParser can refuse `const` with a targeted diagnostic or dispatch `custom_svc.run`).
        const modelCodeTexts = modelScan.chunks.filter((c) => c.kind === "code").map((c) => c.text.trim());
        assert.deepEqual(modelCodeTexts, [
            "const res = await gitea.issue_read({ index: 1 });",
            'const r2 = await unknown_mcp.fetch_item({ id: "abc" });',
            'custom_svc.run({ key: "val" });',
        ]);

        // In statements tier: `const x = computeSomething(1, 2);` and `helper.format(42);` are admitted as code chunks so callers get refusal errors rather than silent drops.
        const stmtScan = scanChunks("const x = Math.max(1, 2);\nhelper.format(42);", "statements", SPELLINGS);
        assert.equal(stmtScan.chunks.filter((c) => c.kind === "code").length, 2);
    });

    test("{§parse-recovery}: scanChunks recovers premature object close, missing closing paren after heredoc/transposed brace, and stray trailing quotes/dots", () => {
        const recoverable = [
            'await plurnk.edit({ path: "a.ts" }, text: "hi" });',
            'await plurnk.note({ text: <<<EOF\nhello\nEOF }; // missing ) after heredoc',
            'await plurnk.note({ text: "hi" }}; // transposed } for )',
            'await plurnk.read({ path: "a.ts" }"). // stray quote and dot',
        ].join("\n");
        const { chunks, unparsedTail } = scanChunks(recoverable, "model", SPELLINGS);
        assert.equal(unparsedTail, undefined);
        assert.equal(chunks.length, 4);
        assert.ok(chunks.every((c) => c.kind === "code"));
    });

    test("{§parse-recovery}: scanChunks reports unparsedTail on unterminated markdown fences, strings, block comments, inline/trailing heredocs, and incomplete calls", () => {
        const unterminatedCases: Array<[string, "model" | "statements", string, number]> = [
            ["Prose\n```python\ndef f():\n  pass", "model", "Unterminated fenced block at end of input.", 2],
            ['await plurnk.read({ path: "unclosed', "model", "Unterminated Code Mode statement at end of input.", 1],
            ["await plurnk.read(/* unclosed comment", "model", "Unterminated Code Mode statement at end of input.", 1],
            ['await plurnk.note({ text: <<<EOF\nno closer', "model", "Unterminated Code Mode statement at end of input.", 1],
            ["await plurnk.note(<<EOF)\nno trailing closer", "statements", "Unterminated Code Mode statement at end of input.", 1],
            ["await plurnk.note(<<EOF)", "statements", "Unterminated Code Mode statement at end of input.", 1],
            ["await plurnk.read", "model", "Unterminated Code Mode statement at end of input.", 1],
        ];
        for (const [source, tier, expectedReason, expectedLine] of unterminatedCases) {
            const res = scanChunks(source, tier, SPELLINGS);
            assert.ok(res.unparsedTail !== undefined, `Expected unparsedTail for: ${source}`);
            assert.equal(res.unparsedTail.reason, expectedReason, source);
            assert.equal(res.unparsedTail.from.line, expectedLine, source);
        }
    });
});
