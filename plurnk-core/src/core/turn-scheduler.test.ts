import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-grammar";
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
    const authored = statements(`
        <<PLAN:work:PLAN
        <<READ(notes.md)::READ
        <<EXEC:node verify.mjs:EXEC
        <<EDIT(notes.md)<2>:new:EDIT
        <<FIND(src/**)::FIND
        <<WORK(worker://reviewer):review:WORK
        <<KILL(node:///3/1/2)::KILL
        <<SEND[200]:done:SEND
    `);

    assert.deepEqual(
        scheduleTurnOps(authored).map(({ op }) => op),
        ["PLAN", "EDIT", "KILL", "READ", "FIND", "EXEC", "WORK", "SEND"],
    );
});

test("MODE preserves authored order within each phase", () => {
    const authored = statements(`
        <<EDIT(a.md)<1>:a:EDIT
        <<COPY(b.md):c.md:COPY
        <<READ(a.md)::READ
        <<READ(c.md)::READ
        <<EXEC:one:EXEC
        <<SEND(worker://reviewer):two:SEND
    `);

    assert.deepEqual(scheduleTurnOps(authored), authored);
});
