import { test } from "node:test";
import assert from "node:assert/strict";
import Plurnkdown from "./Plurnkdown.ts";

const linter = new Plurnkdown();

test("run-on length counts rendered text, not markdown syntax", () => {
    const url = `https://example.com/${"p".repeat(400)}`; // source far past RUNON_LIMIT
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
    const source = `# Heading\n\nShort intro.\n\n${"z".repeat(300)}.`;
    const diagnostics = linter.lint(source).filter(d => d.rule === "run-on");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].line, 5);
});

test("operation names in Markdown headings are ordinary documentation", () => {
    assert.deepEqual(linter.lint("## PLAN\n\nDescribe the plan.\n\n### READ\n\nDescribe reading."), []);
});

test("a longer fence preserves nested programs as literal body text", () => {
    const source = "````EDIT (notes.md)\n```READ (file.md) <N>```\n````";
    assert.deepEqual(linter.lint(source), []);
});

test("a malformed compact op is flagged by op-syntax", () => {
    const source = "Example:\n\n```READ (file.md) <N>```";
    const diagnostics = linter.lint(source).filter(d => d.rule === "op-syntax");
    assert.equal(diagnostics.length >= 1, true, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].line, 3);
});

// {§packet-operation-fences} {§unparsed-tail-boundary}
test("an unfinished modifier in an op fence surfaces the parser-owned tail diagnostic", () => {
    const source = "Example:\n\n```EDIT (worker:///note.md";
    const diagnostics = linter.lint(source).filter(d => d.rule === "op-syntax");
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].severity, "error");
    assert.match(diagnostics[0].message, /target/i);
    assert.equal(diagnostics[0].line, 3);
});

test("native and named-executor blocks pass op-syntax", () => {
    const source = "```PLAN\n[]\n```\n\n```READ (file.md) <5>```\n\n```gitea (list_issues)\n{\"repo_id\": 42}\n```";
    assert.deepEqual(linter.lint(source).filter(d => d.rule === "op-syntax"), []);
});

test("an anonymous documentation fence is never op-validated", () => {
    const source = "````\n```READ (file.md) <N>```\n````";
    assert.deepEqual(linter.lint(source).filter(d => d.rule === "op-syntax"), []);
});

test("a long run-on prose sentence warns (not errors)", () => {
    const warns = linter.lint("x".repeat(190) + ".").filter(d => d.rule === "run-on");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].severity, "warning");
});

test("a semicolon-welded clause pair warns under the run-on length", () => {
    const welded = "a".repeat(60) + "; " + "b".repeat(60) + "."; // 123 chars, welded, < 180
    const warns = linter.lint(welded).filter(d => d.rule === "run-on");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].severity, "warning");
});

test("short atomic sentences do not warn", () => {
    const source = "Open every turn with a PLAN. Conclude with a SEND. Keep it short.";
    assert.deepEqual(linter.lint(source).filter(d => d.rule === "run-on"), []);
});
