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
    const authored = statements("\n```READ (notes.md)```\n```EXEC\nnode verify.mjs\n```\n\n```EDIT (notes.md) <2>\nnew\n```\n\n```FIND (src/**)```\n```BARE\nclassify this independently\n```\n\n```WORK (worker://reviewer)\nreview\n```\n\n```KILL (node:///3/1/2/node)```\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```");

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["READ", "EXEC", "EDIT", "FIND", "BARE", "WORK", "KILL", "SEND", "TASK"],
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
    for (const status of ["pending", "in_progress", "waiting", "completed", "failed"]) {
        const authored = statements(`\`\`\`TASK
[{"content":"Task progress.","status":"${status}"}]
\`\`\`
\`\`\`SEND (worker://reviewer)
Message.
\`\`\`
\`\`\`READ (notes.md)\`\`\`
\`\`\`KILL (log:///1/2/3/READ)\`\`\``);
        const disposition = authored[0];
        const scheduled = scheduleTurnOps(authored);
        assert.deepEqual(scheduled.map(({ op }) => op), ["SEND", "READ", "KILL", "TASK"], status);
        assert.equal(scheduled.at(-1), disposition, status);
        assert.equal(authored[0], disposition, "scheduling never rewrites authored order");
    }
});
