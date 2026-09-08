import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, Validator } from "../../src/index.ts";

for (const op of ["NEXT", "WAIT", "DONE", "FAIL"]) {
    test(`standalone ${op} is the durable operation, not an executor or SEND alias`, () => {
        const result = PlurnkParser.parse(`\`\`\`PLAN\n[]\n\`\`\`\n\`\`\`READ (notes.md)\`\`\`\n\`\`\`${op}\nmessage\n\`\`\``);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
        const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map((statement) => statement.op), ["PLAN", "READ", op]);
        const last = statements.at(-1)!;
        assert.equal(Object.hasOwn(last, "status"), false, "the operation determines disposition; no contradictory status operand");
        assert.equal(Validator.validatePlurnkStatement(last).valid, true);
        const again = PlurnkParser.parseStatements(PlurnkParser.stringify(statements));
        assert.deepEqual(again.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["PLAN", "READ", op]);
    });
}

test("SEND messages do not conclude a turn and omitted disposition recovers NEXT", () => {
    const result = PlurnkParser.parse("```SEND (worker://peer)\nhello\n```");
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["SEND", "NEXT"]);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
});

test("a stray closing fence is described as outside a block, not as text before PLAN", () => {
    const result = PlurnkParser.parse("```READ (notes.md)\n```\n```\n```NEXT\nInspect the note.\n```");
    const errors = result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);
    assert.ok(errors.some((message) => message.startsWith("unexpected text outside an operation block")));
    assert.ok(errors.every((message) => !message.includes("before PLAN")));
});

test("WAIT alone carries numeric parking scope; DONE has no resource operand", () => {
    const wait = PlurnkParser.parseStatements("```WAIT <5,1>\nwaiting\n```");
    assert.deepEqual(wait.items.filter((item) => item.kind === "error"), []);
    const statement = wait.items[0];
    assert.equal(statement?.kind, "statement");
    if (statement?.kind === "statement") {
        assert.equal(statement.statement.op, "WAIT");
        assert.deepEqual(statement.statement.lineMarker, { marks: [5, 1] });
        for (const op of ["NEXT", "DONE", "FAIL"]) {
            assert.equal(Validator.validatePlurnkStatement({ ...statement.statement, op }).valid, false, `${op} cannot carry WAIT timing through the wire schema`);
            assert.equal(Validator.validatePlurnkStatement({ ...statement.statement, op, lineMarker: null }).valid, true);
        }
    }
    const invalid = PlurnkParser.parseStatements("```DONE (notes.md)\ncomplete\n```");
    assert.ok(invalid.items.some((item) => item.kind === "error"));
});
