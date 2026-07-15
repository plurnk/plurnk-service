import { test } from "node:test";
import assert from "node:assert/strict";
import Plurnkdown from "./Plurnkdown.ts";

const linter = new Plurnkdown();

test("free prose over 280 chars is flagged", () => {
    const prose = "x ".repeat(200).trim(); // 399 chars on one line → one paragraph
    const diagnostics = linter.lint(prose);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].rule, "prose-280");
    assert.equal(diagnostics[0].severity, "error");
    assert.equal(diagnostics[0].line, 1);
});

test("free prose at exactly 280 chars passes", () => {
    assert.deepEqual(linter.lint("a".repeat(280)), []);
});

test("prose length counts rendered text, not markdown syntax", () => {
    const url = `https://example.com/${"p".repeat(400)}`; // source >> 280
    const source = `See [the docs](${url}) for the full story.`; // renders ~32 chars
    assert.deepEqual(linter.lint(source), []);
});

test("structural blocks are exempt regardless of length", () => {
    const long = "word ".repeat(100).trim(); // ~499 chars
    const heading = `# ${long}`;
    const listItem = `- ${long}`;
    const fence = `\`\`\`\n${long}\n\`\`\``;
    for (const source of [heading, listItem, fence]) {
        assert.deepEqual(linter.lint(source), [], `expected no diagnostics for: ${source.slice(0, 16)}…`);
    }
});

test("line number tracks the offending prose block", () => {
    const source = `# Heading\n\nShort intro.\n\n${"z".repeat(300)}`;
    const diagnostics = linter.lint(source);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].rule, "prose-280");
    assert.equal(diagnostics[0].line, 5);
});

test("a bare Plurnk op inside a prose block is flagged for fencing", () => {
    const source = "Here is an example.\n<<PLAN:do the thing:PLAN\nThat op should be fenced.";
    const opFence = linter.lint(source).filter(d => d.rule === "op-fence");
    assert.equal(opFence.length, 1);
    assert.equal(opFence[0].line, 2);
});

test("an op inside a plurnk fence is exempt", () => {
    const source = "```plurnk\n<<PLAN:do the thing:PLAN\n```";
    assert.deepEqual(linter.lint(source), []);
});
