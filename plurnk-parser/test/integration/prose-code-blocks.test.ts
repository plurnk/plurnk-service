// {§prose-code-blocks} {§terminal-kill} {§balanced-fences} {§naked-operation} — message, prompt and deliverable bodies
// holding fenced code stay whole; replays of the recorded glm run142, qflash run218 and qflash run118 turns (#853).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlurnkParser } from "../../src/index.ts";

const recorded = (name: string) => readFileSync(new URL(`../fixtures/recorded/${name}`, import.meta.url), "utf8");
const parse = (input: string, executors = ["sh", "python3"]) => PlurnkParser.parse(input, { executors });
const statements = (input: string, executors?: string[]) => parse(input, executors).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyOf = (statement: ReturnType<typeof statements>[number] | undefined): string | null => {
    if (statement === undefined || !("body" in statement) || statement.body === null) return null;
    return typeof statement.body === "string" ? statement.body : statement.body.raw;
};

test("{§balanced-fences} the triage's KILL keeps every line after its inner fence pair, fenced or naked (#853 item 1)", () => {
    const fenced = statements("```KILL\nRan the tests:\n```\ntraceback\n```\nAll done.\n```");
    assert.deepEqual(fenced.map(({ op }) => op), ["KILL"]);
    assert.equal(bodyOf(fenced[0]), "Ran the tests:\n```\ntraceback\n```\nAll done.");
    for (const op of ["SEND", "WORK (worker://verify)"]) {
        const [statement] = statements(`\`\`\`${op}\nRan the tests:\n\`\`\`\ntraceback\n\`\`\`\nAll done.\n\`\`\``);
        assert.equal(bodyOf(statement), "Ran the tests:\n```\ntraceback\n```\nAll done.", op);
    }
});

test("{§naked-operation} a naked KILL's final unpaired fence is its closer, not the deliverable's last line", () => {
    const [kill] = statements("KILL\nRan the tests:\n```\ntraceback\n```\nAll done.\n```");
    assert.equal(bodyOf(kill), "Ran the tests:\n```\ntraceback\n```\nAll done.");
    assert.equal(bodyOf(statements("KILL\nAll done.\n```")[0]), "All done.");
    assert.equal(bodyOf(statements("KILL\n```\ncode\n```")[0]), "```\ncode\n```", "a paired final fence stays body");
});

test("{§terminal-kill} glm run142's child report keeps all three failure sections (recorded)", () => {
    const text = recorded("glm-run142-packet018.md");
    const [kill, ...rest] = statements(text);
    assert.equal(rest.length, 0);
    assert.equal(kill?.op, "KILL");
    assert.equal(bodyOf(kill), text.replace(/\n$/u, "").split("\n").slice(1, -1).join("\n"), "every line between the opener and the final closer");
    assert.match(bodyOf(kill)!, /### 3\. FAILURE: `test_serialize_class_based_validators`/);
});

test("{§prose-code-blocks} qflash run218's WORK task keeps the `sh` script it hands the child, and the parent runs nothing (recorded)", () => {
    const executed = statements(recorded("qflash-run218-packet015.md"));
    assert.deepEqual(executed.map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["EDIT", "WORK"]);
    const task = bodyOf(executed[1]);
    assert.match(task!, /^Run this test in the sympy repository/u);
    assert.match(task!, /```sh\ncd \/home\/user\/repos\/sympy && python3 -c "/u);
    assert.match(task!, /print\(result\.stderr\[-500:\] if len\(result\.stderr\) > 500 else result\.stderr\)\n"\n```$/u, "the script's own closer ends it; the task runs to the end of the turn");
});

test("{§prose-code-blocks} qflash run118's SEND report keeps its quoted code and every paragraph after it (recorded)", () => {
    const text = recorded("qflash-run118-packet046.md");
    const result = parse(text, ["sh", "python", "python3"]);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map(({ op }) => op), ["SEND"], "the quoted `python` block never runs in the parent");
    assert.match(bodyOf(executed[0])!, /```python\n# Current broken code/u);
    assert.match(bodyOf(executed[0])!, /This means no tests can run/u, "the paragraph after the last inner block is still the message");
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
});

test("{§prose-code-blocks} a native operation's heading still ends an unclosed message; an executor heading ends a non-prose body", () => {
    assert.deepEqual(statements("```SEND\nDone.\n```WAIT\n```").map(({ op }) => op), ["SEND", "WAIT"]);
    assert.deepEqual(statements("```WORK (worker://a)\nRun:\n```sh\nls\n```").map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["WORK"]);
    assert.deepEqual(statements("```EDIT (notes.md)\nRun:\n```sh\nls\n```").map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["EDIT", "sh"]);
});

test("{§message-run-on} qflash run192's deliverable runs past its inner code block to the end of the turn (recorded)", () => {
    const text = recorded("qflash-run192-packet038.md");
    const executed = statements(text);
    assert.deepEqual(executed.map(({ op }) => op), ["KILL"]);
    assert.equal(bodyOf(executed[0]), text.replace(/\n$/u, "").split("\n").slice(1).join("\n"), "every line after the opener is the deliverable");
    assert.deepEqual(parse(text).items.filter((item) => item.kind === "text"), []);
});

test("{§message-run-on} running on never hides an operation the author wrote: a closed WORK keeps its WAIT (recorded)", () => {
    const executed = statements(recorded("django-12747-packet043.md"));
    assert.deepEqual(executed.map(({ op }) => op), ["NOTE", "WORK", "WAIT"]);
    assert.match(bodyOf(executed[1])!, /^Run from the repository root[\s\S]*including any FAILED\/ERROR blocks and tracebacks\.$/u);
});

test("{§naked-kill} a naked KILL shows a fenced `KILL (notes.md)` without running it; the deliverable is the whole turn (recorded rtx5070 demo)", () => {
    const text = recorded("rtx5070-show-dont-run-77bf0104-1-2.md");
    const result = parse(text);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map(({ op }) => op), ["KILL"], "no targeted KILL runs");
    const [kill] = executed;
    assert.equal(kill?.op === "KILL" ? kill.target : "targeted", null, "the one statement is the parameterless completion");
    assert.equal(bodyOf(kill), text.split("\n").slice(1).join("\n"), "the deliverable is every line after the naked name");
    assert.match(bodyOf(kill)!, /```KILL \(notes\.md\)\n```/u);
    assert.match(bodyOf(kill)!, /I'm leaving it in place\.$/u);
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), ["`KILL` opened with no fence; the taught form is three backticks."]);
    const closed = statements("KILL\nShown:\n```READ (a.md)\n```\nKILL\n```READ (b.md)\n```");
    assert.deepEqual(closed.map((statement) => `${statement.op}${"target" in statement && statement.target ? ` ${statement.target.raw}` : ""}`), ["KILL", "READ b.md"], "the name alone still closes a naked block; a fence inside never does");
});

test("{§naked-kill} an aside on a naked KILL preserves its quoted deletion (recorded Cerebras demo)", () => {
    const text = recorded("cerebras-show-dont-run-aa4faa76-1-2.md");
    const result = parse(text);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map((s) => [s.op, "target" in s ? s.target : null]), [["KILL", null]]);
    assert.equal(executed[0]?.aside, "deliverable for message://aa4faa76/039632ea");
    assert.equal(bodyOf(executed[0]), text.trimEnd().split("\n").slice(3).join("\n"));
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []),
        ["`KILL` opened with no fence; the taught form is three backticks."]);
});

test("{§unclosed-mutation-yields} glm run158: an unclosed EDIT never swallows the EDIT after it; both run and no heading is written (recorded)", () => {
    const text = recorded("glm-run158-packet007.md");
    const result = parse(text);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map((statement) => [statement.op, "target" in statement ? statement.target?.raw : null]), [
        ["EDIT", "django/utils/functional.py"],
        ["EDIT", "tests/utils_tests/test_simplelazyobject.py"],
    ]);
    const [first, second] = executed;
    assert.equal(bodyOf(first), text.split("\n").slice(1, 7).join("\n"), "the first body ends before the second heading, its blank line the supplied closer's line ending");
    assert.match(bodyOf(first)!, /return other \+ self\._wrapped$/u);
    assert.match(bodyOf(second)!, /^\n    def test_radd\(self\):[\s\S]*self\.assertEqual\(6, 1 \+ x\)$/u);
    for (const statement of executed) assert.doesNotMatch(bodyOf(statement)!, /```EDIT/u, "no body carries an EDIT heading");
    const text2 = result.items.filter((item) => item.kind === "text").map((item) => item.kind === "text" ? item.content : "");
    assert.equal(text2.length, 1);
    assert.match(text2[0]!, /Now verify with the existing and new tests:```sh/u, "the trailing prose and inline sh are outside text, not a body");
});

test("{§unclosed-mutation-yields} an EDIT body holds a same-width native heading only inside a wider fence; equal widths run it", () => {
    const unclosed = statements("```EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n");
    assert.deepEqual(unclosed.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before."], ["KILL", null]], "shape (c): the closer is supplied before the heading, and KILL (x) runs");
    const closed = statements("```EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n```\n");
    assert.deepEqual(closed.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before."], ["KILL", null]], "shape (b) is fence-identical to run158 and reads the same way");
    const wider = statements("````EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n````\n");
    assert.deepEqual(wider.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before.\n```KILL (x)\n```\nAfter."]], "shape (a): the taught wider fence holds the example as text");
});
