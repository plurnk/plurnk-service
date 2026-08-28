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

test("MODE schedules mutations, observations, actions, and terminal SEND in stable phases", () => {
    const authored = statements([
        "# PLAN0\nwork",
        "## READ0 (notes.md)",
        "## EXEC0\nnode verify.mjs",
        "## EDIT0 (notes.md) <2>\nnew",
        "## FIND0 (src/**)",
        "## BARE0\nclassify this independently",
        "## WORK0 (worker://reviewer)\nreview",
        "## KILL0 (node:///3/1/2)",
        "## SEND0 [200]\ndone",
    ].join("\n\n"));

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["PLAN", "EDIT", "KILL", "READ", "FIND", "BARE", "EXEC", "WORK", "SEND"],
    );
});

test("MODE preserves authored order within each phase", () => {
    const authored = statements([
        "## EDIT0 (a.md) <1>\na",
        "## COPY0 (b.md) (c.md)",
        "## READ0 (a.md)",
        "## READ0 (c.md)",
        "## EXEC0\none",
        "## SEND0 (worker://reviewer)\ntwo",
    ].join("\n\n"));

    assert.deepEqual(scheduleTurnOps(authored), authored);
});
