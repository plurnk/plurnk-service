import assert from "node:assert/strict";
import test from "node:test";
import type { ClientStatement, ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const bodyOf = (statement: ClientStatement | undefined) => statement !== undefined && "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw ?? null : null;
const RECEIPT = (op: string) => `\`${op}\` opened with no fence; the taught form is three backticks.`;

for (const [tier, parse] of [["model", PlurnkParser.parse], ["stored", PlurnkParser.parseStatements], ["client", PlurnkParser.parseClient]] as const) {
    test(`{§naked-operation}: ${tier} opens a name alone on a line as the operation, its body whole to the end of the turn`, () => {
        const answer = "The answer is **42**.\n\n```python\nprint(42)\n```\n\nDone.";
        const result = parse(`SEND\n${answer}\n`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map((s) => s.op), ["SEND"]);
        assert.equal(bodyOf(statements(result)[0]), answer, "a three-backtick code block inside is body, and nothing is cut back");
        assert.deepEqual(warnings(result), [RECEIPT("SEND")], "one receipt, naming the taught form");
    });
    test(`{§naked-operation}: ${tier} recovers one complete aside without changing the answer or executing its example`, () => {
        const answer = "First line.\nSecond line.";
        for (const gap of ["", " ", "\t"]) {
            for (const ending of ["\n", "\r\n"]) {
                const result = parse(`SEND${gap}<!-- deliverable (notes.md) <1,-1> \`\`\` é𝄞 -->\t${ending}${answer.replaceAll("\n", ending)}`);
                const executed = statements(result);
                assert.deepEqual(executed.map((s) => [s.op, "target" in s ? s.target : null]), [["SEND", null]]);
                assert.equal(executed[0]?.aside, "deliverable (notes.md) <1,-1> ``` é𝄞");
                assert.equal(bodyOf(executed[0]), answer.replaceAll("\n", ending));
                assert.deepEqual(warnings(result), [RECEIPT("SEND")]);
                assert.equal(result.items.some((item) => item.kind === "error" && item.error.severity !== "warning"), false);
                assert.equal(result.unparsedTail, undefined);
            }
        }
    });
}

test("{§naked-operation}: aside recovery uses every native operation's ordinary admission", () => {
    for (const op of ["FIND", "READ", "EDIT", "COPY", "MOVE", "SEND", "BARE", "NOTE", "WAIT", "WORK", "FORK", "KILL", "LOOK"]) {
        const parse = op === "LOOK" ? PlurnkParser.parseClient : PlurnkParser.parse;
        const expected = statements(parse(`\`\`\`${op} <!-- purpose -->\n\`\`\``));
        assert.deepEqual(statements(parse(`${op} <!-- purpose -->\n`)), expected, op);
    }
});

test("{§naked-operation}: an aside at end of input still permits an bodyless operation", () => {
    for (const aside of ["", "answer"]) {
        const result = PlurnkParser.parse(`SEND<!--${aside}-->`);
        assert.deepEqual(statements(result).map((s) => [s.op, s.aside, bodyOf(s)]), [["SEND", aside, null]]);
        assert.deepEqual(warnings(result), [RECEIPT("SEND")]);
    }
});

test("{§unfenced-operation}: aside recovery never admits operands, extra text, or incomplete/repeated asides", () => {
    for (const header of [
        "SEND (notes.md) <!-- delete -->", "SEND <1,-1> <!-- scope -->", "SEND [{\"x\":1}] <!-- metadata -->",
        "SEND <!-- aside --> (notes.md)", "SEND <!-- aside --> trailing", "SEND <!-- a --> <!-- b -->", "SEND <!-- unclosed",
        `SEND${" ".repeat(65_536)}still prose`,
    ]) {
        const result = PlurnkParser.parse(`${header}\n\`\`\`NOTE\nSibling.\n\`\`\``);
        assert.deepEqual(statements(result).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Sibling."]], header);
        assert.deepEqual(warnings(result), ["Unfenced `SEND` ignored."], header);
    }
});

test("{§naked-operation} {§quotation}: asides do not admit indented, quoted, or reasoning-channel names", () => {
    for (const op of ["NOTE", "FIND", "READ", "SEND"]) {
        const text = `${op} <!-- example -->\nOnly an example.\n`;
        for (const prefix of [" ", "\t", "> "]) assert.deepEqual(statements(PlurnkParser.parse(`${prefix}${text}`)), [], prefix + op);
        assert.deepEqual(statements(PlurnkParser.parse(`\`\`\`text\n${text}\`\`\``)), [], op);
        assert.deepEqual(PlurnkParser.parseReasoningOperations(text), [], op);
    }
    assert.deepEqual(statements(PlurnkParser.parse("sh <!-- example -->\necho hi\n", { executors: ["sh"] })), []);
});

test("{§naked-operation}: the name alone again closes the block; a heading ends it; the end of the turn ends it", () => {
    const closed = PlurnkParser.parse("SEND\nThe answer.\nSEND\n");
    assert.deepEqual(statements(closed).map((s) => [s.op, bodyOf(s)]), [["SEND", "The answer."]]);
    assert.deepEqual(warnings(closed), [RECEIPT("SEND")], "the closing name draws nothing of its own");
    const headed = PlurnkParser.parse("NOTE\nRemember this.\n```READ (x.md)\n```");
    assert.deepEqual(statements(headed).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Remember this."], ["READ", null]]);
    const shown = PlurnkParser.parse("SEND\nThe answer.\n```READ (x.md)\n```");
    assert.deepEqual(statements(shown).map((s) => [s.op, bodyOf(s)]), [["SEND", "The answer."], ["READ", null]]);
    const last = PlurnkParser.parse("Text first.\nSEND");
    assert.deepEqual(statements(last).map((s) => [s.op, bodyOf(s)]), [["SEND", null]], "a bare name as the last line has no body");
});

test("{§naked-operation}: bare native names open, but prose and executor names do not", () => {
    assert.deepEqual(statements(PlurnkParser.parse("WAIT\n")).map((s) => s.op), ["WAIT"]);
    const note = PlurnkParser.parse("NOTE\nRemember this.\n");
    assert.deepEqual(statements(note).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Remember this."]]);
    assert.deepEqual(statements(PlurnkParser.parse("READ\n")).map((s) => [s.op, (s as { target?: unknown }).target ?? null]), [["READ", null]], "a naked READ has no target; dispatch refuses it as any targetless READ");
    assert.deepEqual(statements(PlurnkParser.parse("  SEND\nThe answer.\n")), [], "an offset name is prose, as every offset example is");
    assert.deepEqual(statements(PlurnkParser.parse("SEND delivers messages.\n")), [], "prose after a name is not an aside or a naked heading");
    assert.deepEqual(warnings(PlurnkParser.parse("SEND delivers messages.\n")), ["Unfenced `SEND` ignored."], "it is the unfenced form, and still says so");
    assert.deepEqual(statements(PlurnkParser.parse("sh\necho hi\n", { executors: ["sh"] })), [], "an executor's name is a runtime, not an operation");
});

test("{§unfenced-operation}: a name with an operand and no fence still did not run, and says so", () => {
    for (const line of ["SEND (notes.md)", "READ (a.md) <1,-1>", "EDIT <3>", "FIND [{\"pattern\":\"x\"}]"]) {
        const result = PlurnkParser.parse(`${line}\n`);
        assert.deepEqual(statements(result), [], line);
        assert.deepEqual(warnings(result), [`Unfenced \`${line.split(/[ (<[]/u)[0]}\` ignored.`], line);
    }
    assert.deepEqual(warnings(PlurnkParser.parse("READ the file first, then decide.\n")), ["Unfenced `READ` ignored."], "a verb opening a column-zero line is the unfenced form, as before");
});

test("{§naked-operation}: reasoning is never read this way", () => {
    assert.deepEqual(PlurnkParser.parseReasoningOperations("NOTE\nA rehearsal, not a note.\n"), []);
});
