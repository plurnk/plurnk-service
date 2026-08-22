import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

const errors = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

test("{§canonical-statement}: H1 PLAN owns a lane and H2 operations retain exact section bodies", () => {
    const input = [
        "# PLAN0",
        '{"entries":[{"content":"Update the note, then read it.","status":"in_progress"}]}',
        "## EDIT0 [+draft] (worker:///note.md) <1,-1>",
        "alpha",
        "beta",
        "",
        "## READ0 (worker:///note.md)",
        "",
        "## SEND0 [102]",
        "Waiting for the read result.",
    ].join("\n");

    const result = PlurnkParser.parse(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    const parsed = statements(input);
    assert.deepEqual(parsed.map(({ op, delimiter }) => [op, delimiter]), [
        ["PLAN", "0"],
        ["EDIT", "0"],
        ["READ", "0"],
        ["SEND", "0"],
    ]);
    assert.deepEqual(parsed[0].body, {
        entries: [{
            content: "Update the note, then read it.",
            priority: "medium",
            status: "in_progress",
        }],
    });
    assert.equal(parsed[1].body, "alpha\nbeta");
    assert.equal(parsed[2].body, null);
    assert.equal(parsed[3].op === "SEND" ? parsed[3].body?.raw : null, "Waiting for the read result.");
});

test("{§section-boundary}: one separator line is structural and additional blank lines remain body content", () => {
    const input = '# PLAN0\n{"entries":[]}\n## EDIT0 (worker:///note.md)\nalpha\n\n\n## SEND0 [200]\ndone';
    const parsed = statements(input);
    assert.equal(parsed[1].body, "alpha\n");
});

test("{§delimiter-discipline}: differently delimited headings remain character-perfect outer body text", () => {
    const quoted = [
        "# PLAN2",
        '{"entries":[{"content":"Store a quoted turn.","status":"in_progress"}]}',
        "## EDIT2 (worker:///quoted.plurnk)",
        "# PLAN0",
        '{"entries":[{"content":"Answer from memory.","status":"in_progress"}]}',
        "## SEND0 [200]",
        "Paris.",
        "",
        "## SEND2 [200]",
        "Stored it.",
    ].join("\n");
    const parsed = statements(quoted);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[1].op, "EDIT");
    assert.equal(parsed[1].body, '# PLAN0\n{"entries":[{"content":"Answer from memory.","status":"in_progress"}]}\n## SEND0 [200]\nParis.');
});

test("{§tier-entrypoints}: parseLog uses consecutive PLAN turns without a TURN wrapper", () => {
    const input = [
        "# PLAN0",
        '{"entries":[{"content":"First.","status":"in_progress"}]}',
        "## SEND0 [200]",
        "One.",
        "",
        "# PLAN0",
        '{"entries":[{"content":"Second.","status":"in_progress"}]}',
        "## SEND0 [200]",
        "Two.",
    ].join("\n");
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["PLAN", "SEND", "PLAN", "SEND"],
    );
});

test("{§lane-match}: parseLog establishes a fresh lane after each terminal SEND", () => {
    const input = [
        "# PLANouter",
        '{"entries":[{"content":"First.","status":"in_progress"}]}',
        "## SENDouter [200]",
        "One.",
        "",
        "# PLANnext",
        '{"entries":[{"content":"Second.","status":"in_progress"}]}',
        "## SENDnext [200]",
        "Two.",
    ].join("\n");
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [[item.statement.op, item.statement.delimiter]] : []),
        [["PLAN", "outer"], ["SEND", "outer"], ["PLAN", "next"], ["SEND", "next"]],
    );
});

test("{§tier-entrypoints}: client-only operations use H2 sections", () => {
    const result = PlurnkParser.parseClient("## LOOK0 [draft] (worker:///note.md) <1,20>\n~recent thoughts");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind === "statement" ? item.statement.op : null, "LOOK");
});

test("{§canonical-statement}: prose without structural headings is not admitted", () => {
    const input = "PLAN: consider the request\nSEND 200: done";
    assert.equal(statements(input).length, 0);
    assert.ok(errors(input).length > 0);
});
