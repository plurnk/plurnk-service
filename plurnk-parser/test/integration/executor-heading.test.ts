import assert from "node:assert/strict";
import test from "node:test";
import { isExecution, writtenOp, type ParseResult } from "@plurnk/plurnk-contracts";
import PlurnkParser from "../../src/PlurnkParser.ts";

const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const body = '{"query":"unchanged"}';

for (const tier of ["parse", "parseStatements"] as const) {
    for (const heading of [
        "fresh (lookup)", "FrEsH(lookup)", 'fresh [{"lifetime":"30s"}] (lookup)',
        'fresh (lookup) [{"lifetime":"30s"}]', "fresh <1> (lookup)", "fresh (lookup) <1>",
        'fresh [{"lifetime":"30s"}]', "fresh <1>", "fresh (lookup) <!-- query -->",
    ]) test(`{§executor-heading}: ${tier} reads ${heading} independently of registration`, () => {
        for (const width of [3, 4, 6]) {
            const fence = "`".repeat(width);
            const source = `${fence}${heading}\n${body}\n${fence}`;
            const unknown = PlurnkParser[tier](source);
            const known = PlurnkParser[tier](source, { executors: ["fresh"] });
            assert.deepEqual(unknown, known, source);
            assert.deepEqual(errors(unknown), [], source);
            const [statement] = statements(unknown);
            assert.ok(statement !== undefined && isExecution(statement), source);
            assert.equal(statement.runtime, "fresh");
            assert.equal(statement.body, body);
            assert.deepEqual(statements(PlurnkParser[tier](PlurnkParser.stringify([statement]))), [statement], "canonical rendering retains every slot and body");
        }
    });

    test(`{§executor-heading}: ${tier} keeps unknown slotless fences and quoted invocations inert`, () => {
        const call = PlurnkParser.frame("fresh (lookup)", body);
        for (const source of [
            PlurnkParser.frame("fresh", body), PlurnkParser.frame("fresh <!-- example -->", body),
            PlurnkParser.frame("python", "print(1)"), PlurnkParser.frame("markdown", call),
            `~~~~\n${call}\n~~~~`, `\t${call.replaceAll("\n", "\n\t")}`,
            `    ${call.replaceAll("\n", "\n    ")}`, `> ${call.replaceAll("\n", "\n> ")}`,
        ]) assert.deepEqual(statements(PlurnkParser[tier](source)), [], source);
        const known = statements(PlurnkParser[tier](PlurnkParser.frame("fresh", body), { executors: ["fresh"] }));
        assert.deepEqual(known.map(writtenOp), ["fresh"], "the supplied vocabulary permits slotless invocation");
        for (const op of ["SEND", "NOTE", "EDIT (worker:///example.md) <1>"]) {
            const outer = statements(PlurnkParser[tier](PlurnkParser.frame(op, call)));
            assert.equal(outer.length, 1);
            assert.ok("body" in outer[0]);
            const literal = outer[0].body;
            assert.equal(typeof literal === "string" ? literal : literal?.raw, call, op);
        }
    });

    test(`{§executor-heading}: ${tier} leaves slot validation and native precedence with the grammar`, () => {
        const native = statements(PlurnkParser[tier](PlurnkParser.frame("READ (x)", null), { executors: ["READ"] }));
        assert.deepEqual(native.map(writtenOp), ["READ"]);
        const malformed = PlurnkParser[tier](PlurnkParser.frame("fresh (a) (b)", body));
        assert.deepEqual(statements(malformed), []);
        assert.ok(errors(malformed).some((error) => error.message === "fresh accepts one `(program)` path at most once"));
        const unclosed = PlurnkParser[tier](PlurnkParser.frame("NOTE", "retained") + "\n\n```fresh (lookup");
        assert.deepEqual(statements(unclosed).map(writtenOp), ["NOTE"]);
        assert.equal(unclosed.unparsedTail?.from.line, 5);
    });
}

test("{§executor-heading}: unknown invocations retain inline chains, split headings, and missing-closer recovery", () => {
    for (const source of [
        "```fresh (lookup)``` ```READ (x)```",
        "```fresh (lookup)\n``` ```READ (x)```",
        "```fresh (lookup)\n{}\n```READ (x)\n```",
        "```\nfresh (lookup)\n{}\n```\n```READ (x)\n```",
    ]) assert.deepEqual(statements(PlurnkParser.parse(source)).map(writtenOp), ["fresh", "READ"], source);
});

test("{§executor-heading} {§reasoning-operations}: explicit invocation slots cannot admit executors from reasoning", () => {
    const read = PlurnkParser.frame("READ (secret)", null);
    assert.deepEqual(PlurnkParser.parseReasoningOperations(PlurnkParser.frame("fresh (lookup)", read)), []);
    assert.deepEqual(PlurnkParser.parseReasoningOperations(PlurnkParser.frame("fresh [{}]", body)), []);
});

test("{§heading-inline-body}: every executor's heading object is body, never inferred metadata", () => {
    for (const runtime of ["sh", "fresh"]) for (const executors of [[], [runtime]]) {
        const parsed = PlurnkParser.parse(`\`\`\`${runtime} (lookup) ${body}\nsecond line\n\`\`\``, { executors });
        const [statement] = statements(parsed);
        assert.ok(statement !== undefined && isExecution(statement));
        assert.equal(statement.metadata, null);
        assert.equal(statement.body, `${body}\nsecond line`);
        assert.deepEqual(errors(parsed).map(({ message }) => message), [
            `\`${runtime}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`,
        ]);
    }
});
