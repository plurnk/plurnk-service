import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";
import type { ClientStatement, ParseResult } from "@plurnk/plurnk-contracts";

const statementsOf = (parsed: ParseResult) => parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warningsOf = (parsed: ParseResult) => parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const assertAdmitted = (parsed: ParseResult) => assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
const marksOf = (statement: ClientStatement | undefined) => statement !== undefined && "lineMarker" in statement ? statement.lineMarker?.marks : undefined;

for (const [scope, marks] of [
    ["<395,12>", [395, 406]],
    ["<395, 12>", [395, 406]],
    ["<395-12>", [395, 406]],
    ["<395,+12>", [395, 407]],
    ["<395, +12>", [395, 407]],
    ["<395,+0>", [395, 395]],
    ["<395,1>", [395, 395]],
] as const) {
    for (const op of ["FIND", "READ", "EDIT", "KILL"] as const) {
        test(`{§scope-range-recovery} ${op} ${scope} normalizes once without an error`, () => {
            const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md) ${scope}`, op === "EDIT" ? "changed" : null));
            assertAdmitted(parsed);
            const [statement] = statementsOf(parsed);
            assert.equal(statement?.op, op);
            assert.deepEqual(statement?.lineMarker?.marks, marks);
            assert.deepEqual(warningsOf(parsed), [`Scope ${scope} was read as <${marks.join(",")}>.`]);
        });
    }
    for (const op of ["COPY", "MOVE"] as const) {
        test(`{§scope-range-recovery} ${op} normalizes each operand ${scope}`, () => {
            const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (a.md) ${scope} (b.md) ${scope}`, null));
            assertAdmitted(parsed);
            const [statement] = statementsOf(parsed);
            assert.ok(statement?.op === op);
            assert.deepEqual(statement.source.lineMarker?.marks, marks);
            assert.deepEqual(statement.destination.lineMarker?.marks, marks);
            assert.deepEqual(warningsOf(parsed), Array(2).fill(`Scope ${scope} was read as <${marks.join(",")}>.`));
        });
    }
}

test("{§scope-range-recovery} reasoning and client scopes use the same normalization", () => {
    const reasoning = PlurnkParser.parseReasoningOperations(PlurnkParser.frame("READ (file.md) <395,+12>", null));
    assert.deepEqual(reasoning[0]?.lineMarker?.marks, [395, 407]);
    const client = PlurnkParser.parseClient(PlurnkParser.frame("LOOK (file.md) <395,12>", null));
    assert.deepEqual(client.items.flatMap((item) => item.kind === "statement" ? [marksOf(item.statement)] : []), [[395, 406]]);
    assert.deepEqual(client.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), ["Scope <395,12> was read as <395,406>."]);
});

test("{§scope-range-recovery} range syntax tolerances compose inside target parentheses", () => {
    for (const op of ["READ", "FIND"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md <395,+12>)`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), [395, 407]);
        assert.ok(warningsOf(parsed).includes("Scope <395,+12> was read as <395,407>."));
    }
});

test("{§scope-range-recovery} a scope after the pattern uses the same normalization", () => {
    for (const op of ["READ", "FIND"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md) /needle/ <395,+12>`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), [395, 407]);
        assert.ok(warningsOf(parsed).includes("Scope <395,+12> was read as <395,407>."));
    }
});

test("{§scope-range-recovery} canonical ranges, sentinels, decimals, regions and anchors retain their meaning", () => {
    for (const [scope, marks] of [
        ["<2,5>", [2, 5]], ["<2,2>", [2, 2]], ["<1,-1>", [1, -1]],
        ["<0,120>", [0, 120]], ["<5,0>", [5, 0]], ["<-3,-1>", [-3, -1]],
        ["<5.5,2>", [5.5, 2]], ["<5,2.5>", [5, 2.5]],
        ["<5,2,1>", [5, 2, 1]], ["<5,2,1,1>", [5, 2, 1, 1]],
        ["<@abcde,@fghij>", ["@abcde", "@fghij"]], ["<5,@abcde>", [5, "@abcde"]],
        ["<@abcde,+2>", ["@abcde", "@abcde+2"]],
    ] as const) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`READ (file.md) ${scope}`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), marks, scope);
        assert.deepEqual(warningsOf(parsed), [], scope);
    }
});

test("{§scope-range-recovery} relative arithmetic requires a positive base and a safe endpoint", () => {
    for (const scope of ["<+2>", "<0,+2>", "<-1,+2>", "<1.5,+2>", "<5,1,+2,3>", "<9007199254740991,+1>", "<9007199254740991,2>"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`READ (file.md) ${scope}`, null));
        assert.equal(statementsOf(parsed).length, 0, scope);
        assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error" && /scope/i.test(item.error.message)), scope);
    }
});

test("{§scope-range-recovery} SEND and WAIT keep their owner-defined scopes", () => {
    const sent = PlurnkParser.parse(PlurnkParser.frame("SEND (sh:///test) <395,12>", "input"));
    assertAdmitted(sent);
    assert.deepEqual(marksOf(statementsOf(sent)[0]), [395, 12]);
    assert.deepEqual(warningsOf(sent), []);
    const waiting = PlurnkParser.parse(PlurnkParser.frame("WAIT <395,12>", null));
    assertAdmitted(waiting);
    assert.deepEqual(warningsOf(waiting), ["Ignored WAIT duration <395,12>."]);
});
