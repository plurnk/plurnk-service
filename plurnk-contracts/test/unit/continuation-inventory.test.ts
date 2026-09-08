import test from "node:test";
import assert from "node:assert/strict";
import { PLURNK_OPS, PlurnkParser, Validator } from "../../src/index.ts";

const parse = (header: string, body: string | null) => {
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body));
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const statement = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])[0]!;
    assert.ok("body" in statement);
    return statement;
};

test("{§plan-value} NEXT and WAIT carry the canonical inventory with whole-body plaintext tolerance", () => {
    for (const op of ["NEXT", "WAIT"] as const) {
        const inventory = [{ content: "Review the results.", status: "pending" }];
        const statement = parse(op, JSON.stringify(inventory));
        assert.equal(statement.op, op);
        assert.deepEqual(statement.body, inventory);
        assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
        assert.deepEqual(parse(op, "Check the next result.").body, [{ content: "Check the next result.", status: "in_progress" }]);
        assert.deepEqual(parse(op, null).body, []);
        assert.deepEqual(parse(op, '{"broken":').body, [{ content: '{"broken":', status: "in_progress" }]);
        assert.deepEqual(parse(op, "[]").body, []);
        const roundTrip = PlurnkParser.parseStatements(PlurnkParser.stringify([statement]));
        assert.deepEqual(roundTrip.items.flatMap((item) => item.kind === "statement" && "body" in item.statement ? [item.statement.body] : []), [inventory]);
    }
});

test("{§op-shapes} PLAN is not a native operation or synthesized envelope", () => {
    assert.equal((PLURNK_OPS as readonly string[]).includes("PLAN"), false);
    const former = parse("PLAN", "[]");
    assert.equal(former.op, "EXEC");
    assert.equal(former.op === "EXEC" ? former.executor : null, "PLAN");
    const parsed = PlurnkParser.parse(PlurnkParser.frame("READ (notes.md)", null));
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["READ", "NEXT"]);
    const next = statements.at(-1);
    assert.ok(next?.op === "NEXT");
    assert.deepEqual(next.body, []);
});

test("{§turn-disposition} WAIT retains timing; DONE, FAIL and SEND retain message bodies", () => {
    const wait = parse("WAIT <60,10>", "[]");
    assert.deepEqual("lineMarker" in wait ? wait.lineMarker : null, { marks: [60, 10] });
    assert.equal(Validator.validatePlurnkStatement(wait).valid, true);
    for (const op of ["DONE", "FAIL", "SEND"] as const) {
        assert.deepEqual(parse(op, "Delivered.").body, { raw: "Delivered.", json: null });
    }
    assert.equal(Validator.validatePlurnkStatement({ ...wait, body: { raw: "[]", json: [] } }).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...parse("DONE", "done"), body: [] }).valid, false);
});
