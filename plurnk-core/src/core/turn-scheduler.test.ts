import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { scheduleTurnOps } from "./turn-scheduler.ts";
import { writtenOp } from "@plurnk/plurnk-contracts";

const statements = (source: string): PlurnkStatement[] => {
    const parsed = PlurnkParser.parseStatements(source);
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    return parsed.items
        .filter((item) => item.kind === "statement")
        .map((item) => item.statement);
};

test("{§op-methods-op-dispatch} operations retain authored order across mutations, observations and asynchronous dispatch", () => {
    const authored = statements([
        'await plurnk.read({ path: "notes.md" });',
        'await plurnk.sh({ command: "node verify.mjs" });',
        'await plurnk.edit({ path: "notes.md", range: "2", content: "new" });',
        'await plurnk.find({ path: "src/**" });',
        'await plurnk.bare({ prompt: "classify this independently" });',
        'await plurnk.work({ target: "session://reviewer", prompt: "review" });',
        'await plurnk.kill({ path: "js:///3/1/2/js" });',
        'await plurnk.send({ text: "done" });',
        'await plurnk.wait({});',
    ].join("\n"));

    assert.deepEqual(
        scheduleTurnOps(authored).map(writtenOp),
        ["READ", "sh", "EDIT", "FIND", "BARE", "WORK", "KILL", "SEND", "WAIT"],
    );
});

test("{§op-methods-op-dispatch} scheduling preserves operation identity and does not mutate its input", () => {
    const authored = statements([
        'await plurnk.edit({ path: "a.md", range: "1", content: "a" });',
        'await plurnk.copy({ from: "b.md", to: "c.md" });',
        'await plurnk.read({ path: "a.md" });',
        'await plurnk.read({ path: "c.md" });',
        'await plurnk.sh({ command: "one" });',
        'await plurnk.send({ target: "session://reviewer", text: "two" });',
    ].join("\n"));

    assert.deepEqual(scheduleTurnOps(authored), authored);
});

test("{§op-methods-op-dispatch} every disposition follows trailing operations without reordering those operations", () => {
    for (const op of ["WAIT"] as const) {
        const authored = statements([
            'await plurnk.wait({ text: "Observe the results." });',
            'await plurnk.send({ target: "session://reviewer", text: "Message." });',
            'await plurnk.read({ path: "notes.md" });',
            'await plurnk.kill({ path: "log:///1/2/3/READ" });',
        ].join("\n"));
        const disposition = authored[0];
        const scheduled = scheduleTurnOps(authored);
        assert.deepEqual(scheduled.map((item) => item.op), ["SEND", "READ", "KILL", op], op);
        assert.equal(scheduled.at(-1), disposition, op);
        assert.equal(authored[0], disposition, "scheduling never rewrites authored order");
    }
});
