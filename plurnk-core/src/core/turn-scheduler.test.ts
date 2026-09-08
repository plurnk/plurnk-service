import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { scheduleTurnOps } from "./turn-scheduler.ts";

const statements = (source: string): PlurnkStatement[] => {
    const parsed = PlurnkParser.parseStatements(source);
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    return parsed.items
        .filter((item) => item.kind === "statement")
        .map((item) => item.statement);
};

test("operations retain authored order across mutations, observations and asynchronous dispatch", () => {
    const authored = statements([
        "## PLAN_\nwork",
        "### READ_ (notes.md)",
        "### EXEC_\nnode verify.mjs",
        "### EDIT_ (notes.md) <2>\nnew",
        "### FIND_ (src/**)",
        "### BARE_\nclassify this independently",
        "### WORK_ (worker://reviewer)\nreview",
        "### KILL_ (node:///3/1/2/EXEC)",
        "### SEND_ (TERM)\ndone",
    ].join("\n\n"));

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["PLAN", "READ", "EXEC", "EDIT", "FIND", "BARE", "WORK", "KILL", "SEND"],
    );
});

test("scheduling preserves operation identity and does not mutate its input", () => {
    const authored = statements([
        "### EDIT_ (a.md) <1>\na",
        "### COPY_ (b.md) (c.md)",
        "### READ_ (a.md)",
        "### READ_ (c.md)",
        "### EXEC_\none",
        "### SEND_ (worker://reviewer)\ntwo",
    ].join("\n\n"));

    assert.deepEqual(scheduleTurnOps(authored), authored);
});

test("every disposition follows trailing operations without reordering those operations", () => {
    for (const label of ["NEXT", "WAIT", "TERM", "FAIL"]) {
        const authored = statements(`## PLAN_\n[]\n### SEND_ (${label})\nDisposition.\n### SEND_ (worker://reviewer)\nMessage.\n### READ_ (notes.md)\n### KILL_ (log:///1/2/3/READ)`);
        const disposition = authored[1];
        const scheduled = scheduleTurnOps(authored);
        assert.deepEqual(scheduled.map(({ op }) => op), ["PLAN", "SEND", "READ", "KILL", "SEND"], label);
        assert.equal(scheduled.at(-1), disposition, label);
        assert.equal(authored[1], disposition, "scheduling never rewrites authored order");
    }
});
