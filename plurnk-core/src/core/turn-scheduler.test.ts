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
        "```PLAN",
        "work",
        "```",
        "",
        "```READ (notes.md)```",
        "```EXEC",
        "node verify.mjs",
        "```",
        "",
        "```EDIT (notes.md) <2>",
        "new",
        "```",
        "",
        "```FIND (src/**)```",
        "```BARE",
        "classify this independently",
        "```",
        "",
        "```WORK (worker://reviewer)",
        "review",
        "```",
        "",
        "```KILL (node:///3/1/2/EXEC)```",
        "```DONE",
        "done",
        "```",
    ].join("\n"));

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["PLAN", "READ", "EXEC", "EDIT", "FIND", "BARE", "WORK", "KILL", "DONE"],
    );
});

test("scheduling preserves operation identity and does not mutate its input", () => {
    const authored = statements([
        "```EDIT (a.md) <1>",
        "a",
        "```",
        "",
        "```COPY (b.md) (c.md)```",
        "```READ (a.md)```",
        "```READ (c.md)```",
        "```EXEC",
        "one",
        "```",
        "",
        "```SEND (worker://reviewer)",
        "two",
        "```",
    ].join("\n"));

    assert.deepEqual(scheduleTurnOps(authored), authored);
});

test("every disposition follows trailing operations without reordering those operations", () => {
    for (const label of ["NEXT", "WAIT", "DONE", "FAIL"]) {
        const authored = statements(`\`\`\`PLAN
[]
\`\`\`
\`\`\`${label}
Disposition.
\`\`\`
\`\`\`SEND (worker://reviewer)
Message.
\`\`\`
\`\`\`READ (notes.md)\`\`\`
\`\`\`KILL (log:///1/2/3/READ)\`\`\``);
        const disposition = authored[1];
        const scheduled = scheduleTurnOps(authored);
        assert.deepEqual(scheduled.map(({ op }) => op), ["PLAN", "SEND", "READ", "KILL", label], label);
        assert.equal(scheduled.at(-1), disposition, label);
        assert.equal(authored[1], disposition, "scheduling never rewrites authored order");
    }
});
