import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

// {§foreign-lane-advisory}
test("headings of another lane swallowed by a body raise one factual advisory per statement and suffix", () => {
    const out = PlurnkParser.parse([
        "## PLAN_", "[{\"content\":\"x\",\"status\":\"in_progress\"}]",
        "### EDIT_ (a.ts) <!-- new -->", "const a = 1;",
        "### EDIT1 (b.ts) <@abcde>", "const b = 2;",
        "### EDIT1 (c.ts) <@fghij>", "const c = 3;",
        "### EXEC2", "echo hi",
        "### SEND_ (NEXT)", "go", "",
    ].join("\n"));
    const statements = out.items.filter((i) => i.kind === "statement").map((i) => `${i.statement.op}${i.statement.delimiter}`);
    assert.deepEqual(statements, ["PLAN_", "EDIT_", "SEND_"], "the lane rule is unchanged: foreign headings stay body text");
    const advisories = out.items.filter((i) => i.kind === "error").map((i) => i.error);
    assert.equal(advisories.length, 2, "one advisory per foreign suffix");
    assert.equal(advisories[0]!.severity, "warning");
    assert.equal(advisories[0]!.line, 5, "positioned at the first swallowed heading");
    assert.match(advisories[0]!.message, /^2 OP-shaped headings \(EDIT\) carrying suffix `1` were taken as body text of EDIT_; this turn's lane is `_`/);
    assert.match(advisories[1]!.message, /^1 OP-shaped heading \(EXEC\) carrying suffix `2` were taken as body text of EDIT_/);
    assert.equal(out.items.indexOf(out.items.find((i) => i.kind === "error")!), 2, "the advisory follows the statement that swallowed the headings");
});

test("same-lane programs and bare-lane turns quoting suffixed examples read the advisory as confirmation, never as rejection", () => {
    const clean = PlurnkParser.parse("## PLAN_\n[]\n### EDIT_ (a.ts)\nconst a = 1;\n### SEND_ (NEXT)\nok\n");
    assert.equal(clean.items.filter((i) => i.kind === "error").length, 0);
    // A bare-lane turn quoting a lane `_` example inside a SEND message: the quote is inert and named.
    const quoting = PlurnkParser.parse("## PLAN\n[]\n### SEND (NEXT)\nThe example reads:\n### READ_ (report.md) <1,10>\nthen continues.\n");
    const advisories = quoting.items.filter((i) => i.kind === "error").map((i) => i.error);
    assert.equal(quoting.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(advisories.length, 1);
    assert.match(advisories[0]!.message, /1 OP-shaped heading \(READ\) carrying suffix `_` were taken as body text of SEND; this turn's lane is no suffix/);
});
