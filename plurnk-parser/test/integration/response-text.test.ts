import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

const textItems = (source: string) => PlurnkParser.parse(source).items.filter((item) => item.kind === "text");

test("{§response-text}: the model tier partitions outside text and operations in source order", () => {
    const source = "Before.\n\n````READ (notes.md)\n````\n\nBetween.\n\n````SEND\nAfter.\n````\nTail.";
    const items = PlurnkParser.parse(source).items;
    assert.deepEqual(items.map(({ kind }) => kind), ["text", "statement", "text", "statement", "text"]);
    assert.deepEqual(items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Before.\n\n", "\n\nBetween.\n\n", "\nTail."]);
    assert.deepEqual(items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "SEND"]);
});

test("{§response-text}: whitespace, operation bodies and asides are not outside response text", () => {
    const body = "READ (literal.md)\n\n```READ (also-literal.md)\n```\n<!-- literal comment -->";
    const source = " \r\n" + PlurnkParser.frame("SEND <!-- reply -->", body) + "\r\n\t";
    assert.deepEqual(textItems(source), []);
    const items = PlurnkParser.parse(source).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind === "statement" && items[0].statement.op === "SEND" ? items[0].statement.body?.raw : null, body);
});

for (const quote of [
    "`````text\n````SEND\nExample only.\n````\n`````",
    "```\n````KILL (worker:///keep.md)\n````\n```",
    "  ````READ (quoted.md)\n  ````",
    "~~~markdown\nExample.\n~~~",
]) {
    test(`{§response-text}: quotation stays one literal text span: ${JSON.stringify(quote)}`, () => {
        const items = PlurnkParser.parse(quote).items;
        assert.deepEqual(items.filter((item) => item.kind === "statement"), []);
        assert.deepEqual(items.flatMap((item) => item.kind === "text" ? [item.content] : []), [quote]);
    });
}

test("{§response-text}: a malformed operation and a lost boundary are not delivered as text", () => {
    const source = "Before.\n````EDIT (note.md) <bad>\nnot a message\n````\nAfter.\n````READ (unclosed";
    const parsed = PlurnkParser.parse(source);
    assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Before.\n", "\nAfter.\n"]);
    assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error"));
    assert.equal(parsed.unparsedTail?.from.line, 6);
});

test("{§response-text}: text positions use the lexer's Unicode and CRLF coordinates", () => {
    const source = "🐹 first\r\n````NOTE\r\nmemory\r\n````\r\n第二";
    assert.deepEqual(textItems(source).map((item) => ({ content: item.content, position: item.position })), [
        { content: "🐹 first\r\n", position: { line: 1, column: 0 } },
        { content: "\r\n第二", position: { line: 4, column: 4 } },
    ]);
});

test("{§response-text}: statement and client tiers still ignore outside text", () => {
    const source = "Before.\n````READ (notes.md)\n````\nAfter.";
    for (const parse of [PlurnkParser.parseStatements, PlurnkParser.parseClient]) {
        assert.deepEqual(parse(source).items.map(({ kind }) => kind), ["statement"]);
    }
});
