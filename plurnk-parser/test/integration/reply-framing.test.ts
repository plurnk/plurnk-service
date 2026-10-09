import assert from "node:assert/strict";
import test from "node:test";
import { writtenOp, type ClientStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

for (const [tier, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§operation-fences}: ${tier} preserves nested examples in a final reply's ordinary body`, () => {
        for (const body of ["All done.", "```python\nprint(42)\n```", "```\n42\n```", "A\n````READ (example.md)````\nB"]) {
            const result = parse(PlurnkParser.frame("SEND [200]", body));
            assert.equal(result.unparsedTail, undefined);
            assert.deepEqual(result.items.filter((item) => item.kind === "error" || item.kind === "text"), []);
            const ops = statements(result);
            assert.deepEqual(ops.map(writtenOp), ["SEND"]);
            assert.equal(ops[0]!.op === "SEND" ? ops[0]!.body?.raw : null, body);
            assert.deepEqual(ops[0]!.op === "SEND" ? ops[0]!.metadata : null, ["200"]);
        }
    });

    test(`{§operation-fences}: ${tier} final reply closers preserve subsequent operations`, () => {
        for (const reply of ["```SEND [200]```", "```SEND [200]\nDone.\n```", "````SEND [200] <!-- answer -->\nDone.\n````"]) {
            const result = parse(`${reply}\n\n${PlurnkParser.frame("EDIT (next.md)", "replacement")}`);
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
            const ops = statements(result);
            assert.deepEqual(ops.map(writtenOp), ["SEND", "EDIT"]);
            assert.equal(ops[1]!.op === "EDIT" ? ops[1]!.body : null, "replacement");
        }
    });

    test(`{§kill-scope}: ${tier} a missing KILL target is refused without discarding siblings`, () => {
        const result = parse(`${PlurnkParser.frame("KILL", null)}\n${PlurnkParser.frame("READ (actual.md)", null)}`);
        assert.deepEqual(statements(result).map(writtenOp), ["READ"]);
        assert.ok(result.items.some((item) => item.kind === "error" && item.error.message === "KILL requires a target."));
    });
}

test("{§quotation}: a quoted operation does not claim the rest of the document", () => {
    const result = PlurnkParser.parse("````text\n```KILL (notes.md)\n```\n````\n```READ (actual.md)\n```");
    assert.deepEqual(statements(result).map(writtenOp), ["READ"]);
    assert.deepEqual(PlurnkParser.parseReasoningOperations("````text\n```SEND [200]\n```NOTE\nQuoted.\n```\n````\n```NOTE\nActual.\n```").map(({ body }) => body), ["Actual."]);
});
