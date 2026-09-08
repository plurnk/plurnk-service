import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

const errors = (input: string) =>
    PlurnkParser.parse(input).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

const bodyOf = (statement: ReturnType<typeof statements>[number]) =>
    "body" in statement ? statement.body : undefined;

test("{§canonical-statement}: H1 PLAN owns a lane and H2 operations retain exact section bodies", () => {
    const input = [
        "## PLAN_",
        '[{"content":"Update the note, then read it.","status":"in_progress"}]',
        "### EDIT_ (worker:///note.md) <1,-1>",
        "alpha",
        "beta",
        "",
        "### READ_ (worker:///note.md)",
        "",
        "### SEND_ (NEXT)",
        "Waiting for the read result.",
    ].join("\n");

    const result = PlurnkParser.parse(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    const parsed = statements(input);
    assert.deepEqual(parsed.map(({ op, delimiter }) => [op, delimiter]), [
        ["PLAN", "_"],
        ["EDIT", "_"],
        ["READ", "_"],
        ["SEND", "_"],
    ]);
    assert.deepEqual(bodyOf(parsed[0]!), [{
            content: "Update the note, then read it.",
            status: "in_progress",
    }]);
    assert.equal(bodyOf(parsed[1]!), "alpha\nbeta");
    assert.equal(bodyOf(parsed[2]!), null);
    assert.equal(parsed[3].op === "SEND" ? parsed[3].body?.raw : null, "Waiting for the read result.");
});

test("{§section-boundary}: one separator line is structural and additional blank lines remain body content", () => {
    const input = '## PLAN_\n[]\n### EDIT_ (worker:///note.md)\nalpha\n\n\n### SEND_ (TERM)\ndone';
    const parsed = statements(input);
    assert.equal(bodyOf(parsed[1]!), "alpha\n");
});

test("{§delimiter-discipline}: differently delimited headings remain character-perfect outer body text", () => {
    const quoted = [
        "## PLAN2",
        '[{"content":"Store a quoted turn.","status":"in_progress"}]',
        "### EDIT2 (worker:///quoted.plurnk)",
        "## PLAN_",
        '[{"content":"Answer from memory.","status":"in_progress"}]',
        "### SEND_ (TERM)",
        "Paris.",
        "",
        "### SEND2 (TERM)",
        "Stored it.",
    ].join("\n");
    const parsed = statements(quoted);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[1].op, "EDIT");
    assert.equal(bodyOf(parsed[1]!), '## PLAN_\n[{"content":"Answer from memory.","status":"in_progress"}]\n### SEND_ (TERM)\nParis.');
});

test("{§tier-entrypoints}: parseLog uses consecutive PLAN turns without a TURN wrapper", () => {
    const input = [
        "## PLAN_",
        '[{"content":"First.","status":"in_progress"}]',
        "### SEND_ (TERM)",
        "One.",
        "",
        "## PLAN_",
        '[{"content":"Second.","status":"in_progress"}]',
        "### SEND_ (TERM)",
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
        "## PLANouter",
        '[{"content":"First.","status":"in_progress"}]',
        "### SENDouter (TERM)",
        "One.",
        "",
        "## PLANnext",
        '[{"content":"Second.","status":"in_progress"}]',
        "### SENDnext (TERM)",
        "Two.",
    ].join("\n");
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [[item.statement.op, item.statement.delimiter]] : []),
        [["PLAN", "outer"], ["SEND", "outer"], ["PLAN", "next"], ["SEND", "next"]],
    );
});

test("{§disposition-ends-turn}: operations after the disposition are recognized as operations, dropped, and diagnosed once", () => {
    for (const label of ["NEXT", "WAIT", "TERM", "FAIL"]) {
        for (const prefix of ["", "## PLAN_\n[]\n"]) {
            const input = `${prefix}### SEND_ (${label})\nAnswer.\n### KILL_ (log:///3/3/1/READ)\n### READ_ (notes.md)\n### SEND_ (worker://reviewer)\nCheck this.`;
            const result = PlurnkParser.parse(input);
            const errors = result.items.filter((item) => item.kind === "error");
            assert.deepEqual(errors.map((item) => item.error.code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION], label);
            assert.equal(
                errors[0]!.error.message,
                `The disposition \`### SEND_ (${label})\` ended the turn; 3 operations after its body were not admitted (KILL ×1, READ ×1, SEND ×1). Every OP, including KILL, precedes the disposition SEND.`,
            );
            // Anchored at the first dropped operation: the trailing headings were operations, never body text.
            assert.equal(errors[0]!.error.line, prefix ? 5 : 3);
            assert.equal(result.unparsedTail, undefined);
            const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(ops.map(({ op }) => op), [...(prefix ? ["PLAN"] : []), "SEND"]);
            const send = ops.at(-1);
            assert.equal(send?.op === "SEND" ? send.body?.raw : null, "Answer.");
        }
    }
});

test("{§delimiter-discipline}: a disposition does not change its turn's delimiter", () => {
    const input = "## PLANouter\n[]\n### SENDouter (TERM)\nQuoted:\n### KILLother (notes.md)\n## PLANother\n[]\n### KILLouter (log:///1/2/3/READ)";
    const parsed = PlurnkParser.parse(input);
    // {§foreign-lane-advisory} — the quoted lane-`other` headings are body text, and the parser says so
    // once as a warning; nothing hard is diagnosed.
    // {§disposition-ends-turn} — the lane-`outer` KILL after the disposition is an operation of this turn (not
    // body text), so it is dropped and diagnosed as one; the advisory about the quoted headings stands.
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors.map((item) => item.error.severity), ["warning", "error"]);
    assert.match(errors[0]!.error.message, /2 OP-shaped headings \(KILL, PLAN\) carrying suffix `other` were taken as body text of SENDouter/u);
    assert.equal(errors[1]!.error.code, PlurnkParser.OPERATIONS_AFTER_DISPOSITION);
    assert.match(errors[1]!.error.message, /^The disposition `### SENDouter \(TERM\)` ended the turn; 1 operation after its body was not admitted \(KILL ×1\)\./u);
    const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(ops.map(({ op, delimiter }) => [op, delimiter]), [["PLAN", "outer"], ["SEND", "outer"]]);
    const send = ops[1];
    assert.equal(send?.op === "SEND" ? send.body?.raw : null, "Quoted:\n### KILLother (notes.md)\n## PLANother\n[]");
});

test("{§tier-entrypoints}: saved turns retain post-disposition operations before the next PLAN", () => {
    const result = PlurnkParser.parseLog("## PLANa\n[]\n### SENDa (NEXT)\nContinue.\n### KILLa (log:///1/1/1/READ)\n## PLANb\n[]\n### SENDb (TERM)\nDone.\n### KILLb (log:///1/2/1/READ)");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [[item.statement.op, item.statement.delimiter]] : []), [
        ["PLAN", "a"], ["SEND", "a"], ["KILL", "a"], ["PLAN", "b"], ["SEND", "b"], ["KILL", "b"],
    ]);
});

test("{§tier-entrypoints}: client-only operations use H2 sections", () => {
    const result = PlurnkParser.parseClient("### LOOK_ (worker:///note.md) <1,20>\n~recent thoughts");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind === "statement" ? item.statement.op : null, "LOOK");
});

test("{§canonical-statement}: prose without structural headings is not admitted", () => {
    const input = "PLAN: consider the request\nSEND 200: done";
    assert.equal(statements(input).length, 0);
    assert.ok(errors(input).length > 0);
});
