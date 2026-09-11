import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

for (const [source, expected] of [
    ["````READ (notes.md)````", ["READ"]],
    ["````SEND\nProgress update.\n````", ["SEND"]],
    ["````EDIT (notes.md)\n```TASK\nLiteral example.\n```\n````", ["EDIT"]],
    ["````READ (notes.md)````\n\n````KILL (log:///**/READ) <17,-1>````", ["READ", "KILL"]],
] as const) {
    test(`{§turn-shape} omitted TASK preserves only authored operations: ${expected.join(",")}`, () => {
        const result = PlurnkParser.parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error] : []), []);
        const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map(({ op }) => op), expected);
        assert.ok(statements.every(({ position }) => position.line > 0));
    });
}

test("{§turn-shape} omitted TASK does not hide a bounded malformed sibling", () => {
    const result = PlurnkParser.parse("````READ (notes.md)````\n\n````FIND (*) [{\"pattern\": \"/broken/ trailing\"}]````");
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ"]);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []),
        ["Regex matcher has trailing text after `/pattern/flags`."]);
});
