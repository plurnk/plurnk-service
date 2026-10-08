import assert from "node:assert/strict";
import test from "node:test";
import { writtenOp, type ClientStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const answer = (result: ParseResult<ClientStatement>) => {
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
    const ops = statements(result);
    assert.deepEqual(ops.map(writtenOp), ["KILL"]);
    assert.equal(ops[0]!.op, "KILL");
    return ops[0]!.op === "KILL" ? ops[0]!.body : null;
};

for (const [tier, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§terminal-kill}: ${tier} retains a complete report after bare inner fences without an outer closer`, () => {
        const body = "# Result\n```\n98 tests passed\n```\n## Verification\nThe complete report reaches the recipient.";
        assert.equal(answer(parse(`\`\`\`KILL\n${body}`)), body);
    });

    test(`{§terminal-kill}: ${tier} treats everything after an early closer as literal answer text`, () => {
        const body = "Done.\n```\n```EDIT (must-not-execute.md)\nquoted replacement\n```\n### log:///1/2/3/EDIT\nThis is a quoted receipt, not a fabricated operation result.";
        assert.equal(answer(parse(`\`\`\`KILL\n${body}`)), body);
    });

    test(`{§terminal-kill}: ${tier} accepts the tail after a compact or naked KILL`, () => {
        for (const header of ["```KILL```", "````KILL <!-- complete -->````", "KILL", "KILL <!-- complete -->"]) {
            const body = "The whole answer.\n```READ (example.md)\n```\nThis example must not run.";
            assert.equal(answer(parse(`${header}\n${body}`)), body, header);
        }
    });

    test(`{§terminal-kill}: ${tier} preserves nested Markdown and removes only an actual final wrapper`, () => {
        for (const body of ["All done.", "```python\nprint(42)\n```", "```\n42\n```", "A\n````READ (example.md)````\nB"]) {
            for (const width of [3, 4, 7]) {
                const fence = "`".repeat(width);
                assert.equal(answer(parse(`${fence}KILL\n${body}\n${fence}`)), body, `${width}: ${body}`);
            }
            assert.equal(answer(parse(`\`\`\`KILL\n${body}`)), body);
            assert.equal(answer(parse(PlurnkParser.frame("KILL", body))), body);
        }
    });
}

test("{§terminal-kill}: targeted KILL and prior operations retain their ordinary program boundaries", () => {
    const result = PlurnkParser.parse("```KILL (old.md)\n```\n```READ (current.md)\n```\n```KILL\nAnswer.\n```\nTail.");
    assert.deepEqual(statements(result).map(writtenOp), ["KILL", "READ", "KILL"]);
    const final = statements(result).at(-1)!;
    assert.equal(final.op === "KILL" ? final.body : null, "Answer.\n```\nTail.");
});

test("{§terminal-kill}: a quoted KILL does not claim the rest of the document", () => {
    const result = PlurnkParser.parse("````text\n```KILL\nNot a final answer.\n```\n````\n```READ (actual.md)\n```");
    assert.deepEqual(statements(result).map(writtenOp), ["READ"]);
    assert.deepEqual(PlurnkParser.parseReasoningOperations("````text\n```KILL\n```NOTE\nQuoted.\n```\n````\n```NOTE\nActual.\n```").map(({ body }) => body), ["Actual."]);
});
