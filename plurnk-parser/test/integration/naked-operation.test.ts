import assert from "node:assert/strict";
import test from "node:test";
import type { ClientStatement, ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const bodyOf = (statement: ClientStatement | undefined) => statement !== undefined && "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw ?? null : null;
const RECEIPT = (op: string) => `\`${op}\` opened with no fence; the taught form is four backticks.`;

for (const [tier, parse] of [["model", PlurnkParser.parse], ["stored", PlurnkParser.parseStatements], ["client", PlurnkParser.parseClient]] as const) {
    test(`{§naked-operation}: ${tier} opens a name alone on a line as the operation, its body whole to the end of the turn`, () => {
        const answer = "The answer is **42**.\n\n```sh\necho hi\n```\n\nDone.";
        const result = parse(`KILL\n${answer}\n`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map((s) => s.op), ["KILL"]);
        assert.equal(bodyOf(statements(result)[0]), answer, "a three-backtick code block inside is body, and nothing is cut back");
        assert.deepEqual(warnings(result), [RECEIPT("KILL")], "one receipt, naming the taught form");
    });
}

test("{§naked-operation}: the name alone again closes the block; a four-backtick heading ends it; the end of the turn ends it", () => {
    const closed = PlurnkParser.parse("KILL\nThe answer.\nKILL\n");
    assert.deepEqual(statements(closed).map((s) => [s.op, bodyOf(s)]), [["KILL", "The answer."]]);
    assert.deepEqual(warnings(closed), [RECEIPT("KILL")], "the closing name draws nothing of its own");
    const headed = PlurnkParser.parse("KILL\nThe answer.\n````READ (x.md)\n````");
    assert.deepEqual(statements(headed).map((s) => [s.op, bodyOf(s)]), [["KILL", "The answer."], ["READ", null]]);
    const last = PlurnkParser.parse("Text first.\nKILL");
    assert.deepEqual(statements(last).map((s) => [s.op, bodyOf(s)]), [["KILL", null]], "a bare name as the last line concludes with no body");
});

test("{§naked-operation}: one rule for every native operation, and only the bare name", () => {
    assert.deepEqual(statements(PlurnkParser.parse("WAIT\n")).map((s) => s.op), ["WAIT"]);
    const note = PlurnkParser.parse("NOTE\nRemember this.\n");
    assert.deepEqual(statements(note).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Remember this."]]);
    assert.deepEqual(statements(PlurnkParser.parse("READ\n")).map((s) => [s.op, (s as { target?: unknown }).target ?? null]), [["READ", null]], "a naked READ has no target; dispatch refuses it as any targetless READ");
    assert.deepEqual(statements(PlurnkParser.parse("  KILL\nThe answer.\n")), [], "an offset name is prose, as every offset example is");
    assert.deepEqual(statements(PlurnkParser.parse("KILL is what ends a loop.\n")), [], "a name with anything else on its line is not the naked form");
    assert.deepEqual(warnings(PlurnkParser.parse("KILL is what ends a loop.\n")), ["`KILL` has no fence, so it did not run."], "it is the unfenced form, and still says so");
    assert.deepEqual(statements(PlurnkParser.parse("sh\necho hi\n", { executors: ["sh"] })), [], "an executor's name is a runtime, not an operation");
});

test("{§unfenced-operation}: a name with an operand and no fence still did not run, and says so", () => {
    for (const line of ["KILL (notes.md)", "READ (a.md) <1,-1>", "EDIT <3>", "FIND [{\"pattern\":\"x\"}]"]) {
        const result = PlurnkParser.parse(`${line}\n`);
        assert.deepEqual(statements(result), [], line);
        assert.deepEqual(warnings(result), [`\`${line.split(/[ (<[]/u)[0]}\` has no fence, so it did not run.`], line);
    }
    assert.deepEqual(warnings(PlurnkParser.parse("READ the file first, then decide.\n")), ["`READ` has no fence, so it did not run."], "a verb opening a column-zero line is the unfenced form, as before");
});

test("{§naked-operation}: reasoning is never read this way", () => {
    assert.deepEqual(PlurnkParser.parseReasoningNotes("NOTE\nA rehearsal, not a note.\n"), []);
});
