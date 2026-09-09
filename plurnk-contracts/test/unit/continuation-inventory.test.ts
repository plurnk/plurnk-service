import test from "node:test";
import assert from "node:assert/strict";
import { PLURNK_OPS, PlurnkParser, Validator } from "../../src/index.ts";

const parse = (header: string, body: string | null, warnings = 0) => {
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body));
    const diagnostics = parsed.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.equal(diagnostics.length, warnings);
    assert.ok(diagnostics.every(({ severity }) => severity === "warning"));
    const statement = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])[0]!;
    assert.ok("body" in statement);
    return statement;
};

test("{§plan-value} TASK carries canonical inventory with whole-body plaintext tolerance", () => {
    for (const status of ["pending", "in_progress", "waiting", "completed", "failed"] as const) {
        const op = "TASK";
        const inventory = [{ content: "Review the results.", status }];
        const statement = parse(op, JSON.stringify(inventory));
        assert.equal(statement.op, op);
        assert.deepEqual(statement.body, inventory);
        assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
        assert.deepEqual(parse(op, "Check the next result.", 1).body, [{ content: "Check the next result.", status: "in_progress" }]);
        assert.deepEqual(parse(op, null).body, []);
        assert.deepEqual(parse(op, '{"broken":', 1).body, [{ content: '{"broken":', status: "in_progress" }]);
        assert.deepEqual(parse(op, "[]").body, []);
        const roundTrip = PlurnkParser.parseStatements(PlurnkParser.stringify([statement]));
        assert.deepEqual(roundTrip.items.flatMap((item) => item.kind === "statement" && "body" in item.statement ? [item.statement.body] : []), [inventory]);
    }
});

test("{§op-shapes} former workflow labels are not native operations or aliases", () => {
    for (const name of ["PLAN", "NEXT", "WAIT", "DONE", "FAIL"]) {
        assert.equal((PLURNK_OPS as readonly string[]).includes(name), false);
        const former = parse(name, "[]");
        assert.equal(former.op, "EXEC");
        assert.equal(former.op === "EXEC" ? former.executor : null, name);
    }
    const parsed = PlurnkParser.parse(PlurnkParser.frame("READ (notes.md)", null));
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["READ", "TASK"]);
    const next = statements.at(-1);
    assert.ok(next?.op === "TASK");
    assert.deepEqual(next.body, []);
});

test("{§turn-disposition} TASK retains timing and SEND retains a message body", () => {
    const wait = parse("TASK <60,10>", "[]");
    assert.deepEqual("lineMarker" in wait ? wait.lineMarker : null, { marks: [60, 10] });
    assert.equal(Validator.validatePlurnkStatement(wait).valid, true);
    assert.deepEqual(parse("SEND", "Delivered.").body, { raw: "Delivered.", json: null });
    assert.equal(Validator.validatePlurnkStatement({ ...wait, body: { raw: "[]", json: [] } }).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...parse("SEND", "done"), body: [] }).valid, false);
});
