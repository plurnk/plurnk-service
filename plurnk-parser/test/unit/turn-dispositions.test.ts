import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, Validator } from "@plurnk/plurnk-contracts";

test("{§send-wait-scope} WAIT preserves a positive duration in seconds in every program tier", () => {
    for (const seconds of [1, 600, 0.25]) {
        const source = PlurnkParser.frame(`WAIT <${seconds}> <!-- reassess -->`, "Check the running tests again.");
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseClient]) {
            const result = parse(source);
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
            const item = result.items[0];
            assert.ok(item?.kind === "statement" && item.statement.op === "WAIT");
            assert.deepEqual(item.statement.lineMarker, { marks: [seconds] });
            assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
            assert.equal(PlurnkParser.stringify([item.statement]), source);
        }
    }
});

test("{§send-wait-scope} duration composition keeps the earliest positive scalar without binding the target", () => {
    const result = PlurnkParser.parse(PlurnkParser.frame("WAIT (sh:///tests) <600> <120> <0> <9,2>", null));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items[0];
    assert.ok(item?.kind === "statement" && item.statement.op === "WAIT");
    assert.equal(item.statement.target?.raw, "sh:///tests");
    assert.deepEqual(item.statement.lineMarker, { marks: [120] });
    for (const marks of [[0], [-1], [1, 2], []]) {
        assert.equal(Validator.validatePlurnkStatement({ ...item.statement, lineMarker: { marks } }).valid, false);
    }
});

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

    test(`{§send-wait-scope} ${op} retains its optional path and ignores decorations that are not positive durations`, () => {
        const body = "Let the verification suite finish.";
        for (const decoration of [
            "<5,1>", "(notes.md)", "(sh:///56d607dc)", "[{\"trace\":true}]",
            "(worker://missing) <60,60> [{\"timeout\":42}]", "<-1> (sh:///missing)",
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

test("{§quotation} an unlabeled fence between operations quotes to its first closer at least as wide", () => {
    const result = PlurnkParser.parse("````READ (notes.md)\n````\n```\n````WAIT\nDone.\n````");
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ"]);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), ["`WAIT` inside a code block was shown, not run."]);
});

test("{§send-wait-scope} non-duration WAIT scopes are ignored; the WAIT keeps its target and aside", () => {
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
