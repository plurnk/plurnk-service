import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, Validator } from "@plurnk/plurnk-contracts";

for (const [op, status] of [["WAIT", 202]] as const) {
    test(`{§turn-disposition} ${op} determines lifecycle independently of its literal body`, () => {
        for (const body of [null, "Inspect the evidence.", "{broken JSON", "[]"]) {
            const result = PlurnkParser.parse(PlurnkParser.frame(op, body));
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
            const statement = result.items[0];
            assert.ok(statement?.kind === "statement" && TurnDisposition.is(statement.statement));
            const value = statement.statement;
            assert.equal(value.op, op);
            assert.equal(value.body, body);
            assert.equal(TurnDisposition.status(value), status);
            assert.equal(Validator.validatePlurnkStatement(value).valid, true);
            const again = PlurnkParser.parseStatements(PlurnkParser.stringify([value]));
            assert.deepEqual(again.items, result.items);
        }
    });

    test(`{§send-wait-scope} ${op} retains its optional path and discards scope and metadata in every program tier`, () => {
        const body = "Let the verification suite finish.";
        for (const decoration of [
            "<5,1>", "(notes.md)", "(sh:///56d607dc)", "[{\"trace\":true}]",
            "(worker://missing) <60,60> [{\"timeout\":42}]", "<1> (sh:///missing)",
            "(sh:///missing)[{\"trace\":true}]<0>",
        ]) {
            const source = PlurnkParser.frame(`${op} ${decoration} <!-- suite -->`, body);
            for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseClient]) {
                const result = parse(source);
                assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], source);
                const item = result.items[0];
                assert.ok(item?.kind === "statement" && TurnDisposition.is(item.statement));
                const path = decoration.match(/\(([^)]+)\)/u)?.[1] ?? null;
                assert.equal(item.statement.target?.raw ?? null, path, source);
                assert.equal(item.statement.lineMarker, null);
                assert.equal(item.statement.metadata, null);
                assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
                assert.equal(PlurnkParser.stringify([item.statement]), PlurnkParser.frame(`${op}${path === null ? "" : ` (${path})`} <!-- suite -->`, body));
            }
        }
    });
}

test("{§turn-disposition} two decorated WAITs are two statements of one turn, each keeping its label", () => {
    const result = PlurnkParser.parse(`${PlurnkParser.frame("WAIT (sh:///one)", null)}\n${PlurnkParser.frame("WAIT (sh:///two)", null)}`);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" && item.statement.op === "WAIT" ? [item.statement.target?.raw ?? null] : []),
        ["sh:///one", "sh:///two"],
    );
});

test("{§turn-shape} tolerating WAIT decorations does not admit unclosed slots", () => {
    for (const source of [
        "````WAIT (sh:///unfinished",
        "````WAIT [{\"unfinished\":",
    ]) {
        const result = PlurnkParser.parse(source);
        assert.ok(result.items.some((item) => item.kind === "error" && item.error.severity === "error") || result.unparsedTail !== undefined, source);
    }
});

test("{§turn-shape} SEND does not conclude a turn or manufacture a disposition", () => {
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND (worker://peer)", "hello"));
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["SEND"]);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("{§interstitial-fence} an unlabeled fence between operations does not hide WAIT", () => {
    const result = PlurnkParser.parse("````READ (notes.md)\n````\n```\n````WAIT\nDone.\n````");
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "WAIT"]);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("{§send-wait-scope} any WAIT scope is skipped unread; the WAIT keeps its target and aside (#756)", () => {
    for (const [source, aside] of [
        [PlurnkParser.frame("WAIT <sh:///468a112b> <!-- waiting for core test suite to finish -->", null), "waiting for core test suite to finish"],
        [PlurnkParser.frame("WAIT <> <5,1>", null), null],
        [PlurnkParser.frame("WAIT <result range>", null), null],
    ] as const) {
        const result = PlurnkParser.parse(source);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], source);
        const waits = result.items.flatMap((item) => item.kind === "statement" && item.statement.op === "WAIT" ? [item.statement] : []);
        assert.equal(waits.length, 1, source);
        assert.equal(waits[0].aside, aside, source);
        assert.equal(waits[0].lineMarker, null, source);
    }
});
