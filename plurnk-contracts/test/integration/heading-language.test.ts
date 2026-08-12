import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

const errors = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

test("{§canonical-statement}: H1 PLAN owns a lane and H2 operations retain exact section bodies", () => {
    const input = [
        "# PLAN1",
        "Update the note, then read it.",
        "",
        "## EDIT1 [draft] (worker:///note.md) <1,-1>",
        "alpha",
        "beta",
        "",
        "## READ1 (worker:///note.md)",
        "",
        "## SEND1 [102]",
        "Waiting for the read result.",
    ].join("\n");

    const result = PlurnkParser.parse(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    const parsed = statements(input);
    assert.deepEqual(parsed.map(({ op, suffix }) => [op, suffix]), [
        ["PLAN", "1"],
        ["EDIT", "1"],
        ["READ", "1"],
        ["SEND", "1"],
    ]);
    assert.equal(parsed[0].body, "Update the note, then read it.");
    assert.equal(parsed[1].body, "alpha\nbeta");
    assert.equal(parsed[2].body, null);
    assert.equal(parsed[3].op === "SEND" ? parsed[3].body?.raw : null, "Waiting for the read result.");
});

test("{§section-boundary}: one separator line is structural and additional blank lines remain body content", () => {
    const input = "# PLAN1\np\n\n## EDIT1 (worker:///note.md)\nalpha\n\n\n## SEND1 [200]\ndone";
    const parsed = statements(input);
    assert.equal(parsed[1].body, "alpha\n");
});

test("{§suffix-discipline}: differently suffixed headings remain character-perfect outer body text", () => {
    const quoted = [
        "# PLAN2",
        "Store a quoted turn.",
        "",
        "## EDIT2 (worker:///quoted.plurnk)",
        "# PLAN1",
        "Answer from memory.",
        "",
        "## SEND1 [200]",
        "Paris.",
        "",
        "## SEND2 [200]",
        "Stored it.",
    ].join("\n");
    const parsed = statements(quoted);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[1].op, "EDIT");
    assert.equal(parsed[1].body, "# PLAN1\nAnswer from memory.\n\n## SEND1 [200]\nParis.");
});

test("{§tier-entrypoints}: parseLog uses consecutive PLAN turns without a TURN wrapper", () => {
    const input = [
        "# PLAN1",
        "First.",
        "",
        "## SEND1 [200]",
        "One.",
        "",
        "# PLAN1",
        "Second.",
        "",
        "## SEND1 [200]",
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
        "First.",
        "",
        "## SENDouter [200]",
        "One.",
        "",
        "# PLANnext",
        "Second.",
        "",
        "## SENDnext [200]",
        "Two.",
    ].join("\n");
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [[item.statement.op, item.statement.suffix]] : []),
        [["PLAN", "outer"], ["SEND", "outer"], ["PLAN", "next"], ["SEND", "next"]],
    );
});

test("{§tier-entrypoints}: client-only operations use H2 sections", () => {
    const result = PlurnkParser.parseClient("## LOOK1 [draft] (worker:///note.md) <1,20>\n~recent thoughts");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind === "statement" ? item.statement.op : null, "LOOK");
});

test("{§canonical-statement}: prose without structural headings is not admitted", () => {
    const input = "PLAN: consider the request\nSEND 200: done";
    assert.equal(statements(input).length, 0);
    assert.ok(errors(input).length > 0);
});
