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

test("a bare Plurnk op inside a prose block is flagged for fencing", () => {
    const source = "Here is an example.\n<<PLAN:do the thing:PLAN\nThat op should be fenced.";
    const opFence = linter.lint(source).filter(d => d.rule === "op-fence");
    assert.equal(opFence.length, 1);
    assert.equal(opFence[0].line, 2);
});

test("an op inside a plurnk fence is exempt from op-fence", () => {
    const source = "```plurnk\n<<PLAN:do the thing:PLAN\n```";
    assert.deepEqual(linter.lint(source).filter(d => d.rule === "op-fence"), []);
});

test("a malformed op inside a plurnk fence is flagged by op-syntax", () => {
    const source = "```plurnk\n<<READ(file.md)<N>::READ\n```"; // <N> — letters aren't valid scope
    const diagnostics = linter.lint(source).filter(d => d.rule === "op-syntax");
    assert.equal(diagnostics.length >= 1, true, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].line, 2); // the op line inside the fence
});

// {§packet-operation-fences} {§unparsed-tail-boundary}
test("#135: an unterminated op fence surfaces the one parser-owned tail diagnostic", () => {
    const source = "```plurnk\n<<EDIT(worker:///note.md):unterminated\n```";
    const diagnostics = linter.lint(source).filter(d => d.rule === "op-syntax");
    assert.deepEqual(diagnostics, [{
        rule: "op-syntax",
        severity: "error",
        message: "body of `<<EDIT` opened at line 1 but never closed - add `:EDIT` to terminate",
        line: 2,
        column: 0,
    }]);
});

test("valid ops inside a plurnk fence pass op-syntax", () => {
    const source = "```plurnk\n<<PLAN:go:PLAN\n<<READ(file.md)<5>::READ\n```";
    assert.deepEqual(linter.lint(source).filter(d => d.rule === "op-syntax"), []);
});

test("a plain (non-plurnk) fence is never op-validated", () => {
    const source = "```\n<<OPsuffix[signal]?(path)?:body?:OPsuffix\n```";
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
