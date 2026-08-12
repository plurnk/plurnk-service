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
        "# PLAN1\nwork",
        "## READ1 (notes.md)",
        "## EXEC1\nnode verify.mjs",
        "## EDIT1 (notes.md) <2>\nnew",
        "## FIND1 (src/**)",
        "## WORK1 (worker://reviewer)\nreview",
        "## KILL1 (node:///3/1/2)",
        "## SEND1 [200]\ndone",
    ].join("\n\n"));

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["PLAN", "EDIT", "KILL", "READ", "FIND", "EXEC", "WORK", "SEND"],
    );
});

test("MODE preserves authored order within each phase", () => {
    const authored = statements([
        "## EDIT1 (a.md) <1>\na",
        "## COPY1 (b.md)\nc.md",
        "## READ1 (a.md)",
        "## READ1 (c.md)",
        "## EXEC1\none",
        "## SEND1 (worker://reviewer)\ntwo",
    ].join("\n\n"));

    assert.deepEqual(scheduleTurnOps(authored), authored);
});
