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
        "## PLAN0",
        '[{"content":"Update the note, then read it.","status":"in_progress"}]',
        "### EDIT0 (worker:///note.md) <1,-1>",
        "alpha",
        "beta",
        "",
        "### READ0 (worker:///note.md)",
        "",
        "### SEND0 (NEXT)",
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
    assert.deepEqual(bodyOf(parsed[0]!), [{
            content: "Update the note, then read it.",
            status: "in_progress",
    }]);
    assert.equal(bodyOf(parsed[1]!), "alpha\nbeta");
    assert.equal(bodyOf(parsed[2]!), null);
    assert.equal(parsed[3].op === "SEND" ? parsed[3].body?.raw : null, "Waiting for the read result.");
});

test("{§section-boundary}: one separator line is structural and additional blank lines remain body content", () => {
    const input = '## PLAN0\n[]\n### EDIT0 (worker:///note.md)\nalpha\n\n\n### SEND0 (TERM)\ndone';
    const parsed = statements(input);
    assert.equal(bodyOf(parsed[1]!), "alpha\n");
});

test("{§delimiter-discipline}: differently delimited headings remain character-perfect outer body text", () => {
    const quoted = [
        "## PLAN2",
        '[{"content":"Store a quoted turn.","status":"in_progress"}]',
        "### EDIT2 (worker:///quoted.plurnk)",
        "## PLAN0",
        '[{"content":"Answer from memory.","status":"in_progress"}]',
        "### SEND0 (TERM)",
        "Paris.",
        "",
        "### SEND2 (TERM)",
        "Stored it.",
    ].join("\n");
    const parsed = statements(quoted);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[1].op, "EDIT");
    assert.equal(bodyOf(parsed[1]!), '## PLAN0\n[{"content":"Answer from memory.","status":"in_progress"}]\n### SEND0 (TERM)\nParis.');
});

test("{§tier-entrypoints}: parseLog uses consecutive PLAN turns without a TURN wrapper", () => {
    const input = [
        "## PLAN0",
        '[{"content":"First.","status":"in_progress"}]',
        "### SEND0 (TERM)",
        "One.",
        "",
        "## PLAN0",
        '[{"content":"Second.","status":"in_progress"}]',
        "### SEND0 (TERM)",
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

test("{§send-mid-reservation}: one disposition may precede ordinary operations without absorbing them", () => {
    for (const label of ["NEXT", "WAIT", "TERM", "FAIL"]) {
        for (const prefix of ["", "## PLAN0\n[]\n"]) {
            const input = `${prefix}### SEND0 (${label})\nAnswer.\n### KILL0 (log:///3/3/1/READ)\n### READ0 (notes.md)\n### SEND0 (worker://reviewer)\nCheck this.`;
            const result = PlurnkParser.parse(input);
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], label);
            assert.equal(result.unparsedTail, undefined);
            const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(ops.map(({ op }) => op), [...(prefix ? ["PLAN"] : []), "SEND", "KILL", "READ", "SEND"]);
            const send = ops.find((op) => op.op === "SEND");
            assert.equal(send?.body?.raw, "Answer.");
            assert.equal(ops.at(-3)?.position.line, prefix ? 5 : 3);
        }
    }
});

test("{§delimiter-discipline}: a disposition does not change its turn's delimiter", () => {
    const input = "## PLANouter\n[]\n### SENDouter (TERM)\nQuoted:\n### KILLother (notes.md)\n## PLANother\n[]\n### KILLouter (log:///1/2/3/READ)";
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(ops.map(({ op, delimiter }) => [op, delimiter]), [["PLAN", "outer"], ["SEND", "outer"], ["KILL", "outer"]]);
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
    const result = PlurnkParser.parseClient("### LOOK0 (worker:///note.md) <1,20>\n~recent thoughts");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind === "statement" ? item.statement.op : null, "LOOK");
});

test("{§canonical-statement}: prose without structural headings is not admitted", () => {
    const input = "PLAN: consider the request\nSEND 200: done";
    assert.equal(statements(input).length, 0);
    assert.ok(errors(input).length > 0);
});
