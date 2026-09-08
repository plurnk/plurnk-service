import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

// {§foreign-lane-advisory}
test("headings of another lane swallowed by a body raise one factual advisory per statement and suffix", () => {
    const out = PlurnkParser.parse([
        "## PLAN0", "[{\"content\":\"x\",\"status\":\"in_progress\"}]",
        "### EDIT0 (a.ts) <!-- new -->", "const a = 1;",
        "### EDIT1 (b.ts) <@abcde>", "const b = 2;",
        "### EDIT1 (c.ts) <@fghij>", "const c = 3;",
        "### EXEC2", "echo hi",
        "### SEND0 (NEXT)", "go", "",
    ].join("\n"));
    const statements = out.items.filter((i) => i.kind === "statement").map((i) => `${i.statement.op}${i.statement.delimiter}`);
    assert.deepEqual(statements, ["PLAN0", "EDIT0", "SEND0"], "the lane rule is unchanged: foreign headings stay body text");
    const advisories = out.items.filter((i) => i.kind === "error").map((i) => i.error);
    assert.equal(advisories.length, 2, "one advisory per foreign suffix");
    assert.equal(advisories[0]!.severity, "warning");
    assert.equal(advisories[0]!.line, 5, "positioned at the first swallowed heading");
    assert.match(advisories[0]!.message, /^2 OP-shaped headings \(EDIT\) carrying suffix `1` were taken as body text of EDIT0; this turn's lane is `0`/);
    assert.match(advisories[1]!.message, /^1 OP-shaped heading \(EXEC\) carrying suffix `2` were taken as body text of EDIT0/);
    assert.equal(out.items.indexOf(out.items.find((i) => i.kind === "error")!), 2, "the advisory follows the statement that swallowed the headings");
});

test("same-lane programs and bare-lane turns quoting suffixed examples read the advisory as confirmation, never as rejection", () => {
    const clean = PlurnkParser.parse("## PLAN0\n[]\n### EDIT0 (a.ts)\nconst a = 1;\n### SEND0 (NEXT)\nok\n");
    assert.equal(clean.items.filter((i) => i.kind === "error").length, 0);
    // A bare-lane turn quoting a lane-0 example inside a SEND message: the quote is inert and named.
    const quoting = PlurnkParser.parse("## PLAN\n[]\n### SEND (NEXT)\nThe example reads:\n### READ0 (report.md) <1,10>\nthen continues.\n");
    const advisories = quoting.items.filter((i) => i.kind === "error").map((i) => i.error);
    assert.equal(quoting.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(advisories.length, 1);
    assert.match(advisories[0]!.message, /1 OP-shaped heading \(READ\) carrying suffix `0` were taken as body text of SEND; this turn's lane is no suffix/);
});
