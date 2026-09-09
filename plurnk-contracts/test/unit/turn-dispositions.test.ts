import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, Validator } from "../../src/index.ts";

for (const status of ["pending", "in_progress", "waiting", "completed", "failed"]) {
    test(`TASK ${status} is durable inventory, not an executor or SEND alias`, () => {
        const body = JSON.stringify([{ content: "Task state.", status }]);
        const result = PlurnkParser.parse(`\`\`\`READ (notes.md)\`\`\`
\`\`\`TASK\n${body}\n\`\`\``);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
        const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map((statement) => statement.op), ["READ", "TASK"]);
        const last = statements.at(-1)!;
        assert.equal(Object.hasOwn(last, "status"), false, "inventory determines disposition; no contradictory status operand");
        assert.equal(Validator.validatePlurnkStatement(last).valid, true);
        const again = PlurnkParser.parseStatements(PlurnkParser.stringify(statements));
        assert.deepEqual(again.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "TASK"]);
    });
}

test("SEND messages do not conclude a turn and omitted disposition recovers empty TASK", () => {
    const result = PlurnkParser.parse("```SEND (worker://peer)\nhello\n```");
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["SEND", "TASK"]);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
});

test("{§whitespace-contract}: a stray outside closing fence is ignored", () => {
    const result = PlurnkParser.parse("```READ (notes.md)\n```\n```\n```TASK\n[{\"content\":\"Inspect the note.\",\"status\":\"in_progress\"}]\n```");
    assert.deepEqual(result.items.map((item) => item.kind), ["statement", "statement"]);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "TASK"]);
});

test("TASK admits timing independent of intent but never a resource operand", () => {
    const wait = PlurnkParser.parseStatements("```TASK <5,1>\n[{\"content\":\"waiting\",\"status\":\"waiting\"}]\n```");
    assert.deepEqual(wait.items.filter((item) => item.kind === "error"), []);
    const statement = wait.items[0];
    assert.equal(statement?.kind, "statement");
    if (statement?.kind === "statement") {
        assert.equal(statement.statement.op, "TASK");
        assert.deepEqual(statement.statement.lineMarker, { marks: [5, 1] });
        for (const status of ["pending", "in_progress", "completed", "failed"]) {
            const body = [{ content: "Task state.", status }];
            assert.equal(Validator.validatePlurnkStatement({ ...statement.statement, body }).valid, true);
            assert.equal(Validator.validatePlurnkStatement({ ...statement.statement, body, lineMarker: null }).valid, true);
        }
    }
    const invalid = PlurnkParser.parseStatements("```SEND\ncomplete\n```\n```TASK (notes.md)\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```");
    assert.ok(invalid.items.some((item) => item.kind === "error"));
});
