import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, Validator } from "@plurnk/plurnk-contracts";

test("{§send-wait-scope} WAIT preserves a non-negative duration in seconds in every program tier", () => {
    for (const seconds of [0, 1, 600, 0.25]) {
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

test("{§send-wait-scope} duration composition keeps the earliest scalar without binding the target", () => {
    const result = PlurnkParser.parse(PlurnkParser.frame("WAIT (sh:///tests) <600> <120> <0>", null));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const item = result.items[0];
    assert.ok(item?.kind === "statement" && item.statement.op === "WAIT");
    assert.equal(item.statement.target?.raw, "sh:///tests");
    assert.deepEqual(item.statement.lineMarker, { marks: [0] });
    for (const marks of [[-1], [1, 2], []]) {
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

    test(`{§send-wait-scope} ${op} retains its optional path and ignores metadata`, () => {
        const body = "Let the verification suite finish.";
        for (const decoration of [
            "(10)", "(notes.md)", "(sh:///56d607dc)", "[{\"trace\":true}]",
            "(worker://missing) [{\"timeout\":42}]",
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

test("{§send-wait-scope} invalid WAIT durations warn without rejecting the WAIT or changing its other slots", () => {
    for (const scope of ["<10s>", "<-1>", "<1,2>", "<>", "<result range>", "<sh:///468a112b>", "<0x10>", "<1e2>", `<${"9".repeat(400)}>`]) {
        const source = PlurnkParser.frame(`WAIT (sh:///tests) ${scope} <!-- checking -->`, "Await results.");
        const result = PlurnkParser.parse(source);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [{ severity: item.error.severity, message: item.error.message }] : []),
            [{ severity: "warning", message: `Ignored WAIT duration ${scope}.` }], source);
        const waits = result.items.flatMap((item) => item.kind === "statement" && item.statement.op === "WAIT" ? [item.statement] : []);
        assert.equal(waits.length, 1, source);
        assert.equal(waits[0].target?.raw, "sh:///tests", source);
        assert.equal(waits[0].aside, "checking", source);
        assert.equal(waits[0].body, "Await results.", source);
        assert.equal(waits[0].lineMarker, null, source);
        assert.equal(Validator.validatePlurnkStatement(waits[0]).valid, true);
    }
});

test("{§send-wait-scope} an invalid duration does not discard a valid bound or warn about the default", () => {
    for (const seconds of [0, 15]) {
        const result = PlurnkParser.parse(PlurnkParser.frame(`WAIT <60> <10s> <${seconds}>`, null));
        const item = result.items.find((entry) => entry.kind === "statement");
        assert.ok(item?.kind === "statement" && item.statement.op === "WAIT");
        assert.deepEqual(item.statement.lineMarker, { marks: [seconds] });
        assert.deepEqual(result.items.flatMap((entry) => entry.kind === "error" ? [entry.error.message] : []), ["Ignored WAIT duration <10s>."]);
    }
});
