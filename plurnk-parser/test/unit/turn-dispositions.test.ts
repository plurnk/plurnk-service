import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, Validator } from "@plurnk/plurnk-contracts";

for (const [op, intent, status] of [["WAIT", "wait", 202], ["DONE", "complete", 200], ["FAIL", "fail", 499]] as const) {
    test(`{§turn-disposition} ${op} determines lifecycle independently of its literal body`, () => {
        for (const body of [null, "Inspect the evidence.", "{broken JSON", "[]"]) {
            const result = PlurnkParser.parse(PlurnkParser.frame(op, body));
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
            const statement = result.items[0];
            assert.ok(statement?.kind === "statement" && TurnDisposition.is(statement.statement));
            const value = statement.statement;
            assert.equal(value.op, op);
            assert.equal(value.body, body);
            assert.equal(TurnDisposition.intent(value), intent);
            assert.equal(TurnDisposition.status(value), status);
            assert.equal(Validator.validatePlurnkStatement(value).valid, true);
            const again = PlurnkParser.parseStatements(PlurnkParser.stringify([value]));
            assert.deepEqual(again.items, result.items);
        }
    });

    test(`{§send-wait-scope} ${op} scope reaches runtime admission, but target and metadata are not slots`, () => {
        const result = PlurnkParser.parseStatements(PlurnkParser.frame(`${op} <5,1>`, null));
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
        const item = result.items[0];
        assert.ok(item?.kind === "statement" && TurnDisposition.is(item.statement));
        assert.deepEqual(item.statement.lineMarker, { marks: [5, 1] });
        assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
        for (const operand of ["(notes.md)", "[{\"trace\":true}]"]) {
            const invalid = PlurnkParser.parseStatements(PlurnkParser.frame(`${op} ${operand}`, null));
            assert.ok(invalid.items.some((entry) => entry.kind === "error"), operand);
        }
    });
}

test("{§turn-shape} SEND does not conclude a turn or manufacture a disposition", () => {
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND (worker://peer)", "hello"));
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["SEND"]);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("{§interstitial-fence} an unlabeled fence between operations does not hide DONE", () => {
    const result = PlurnkParser.parse("```READ (notes.md)\n```\n```\n```DONE\nDone.\n```");
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "DONE"]);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});
