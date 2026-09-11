import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

test("{§statement-rendering}: canonical frames close on their own line and preserve ordinary nested code", () => {
    assert.equal(PlurnkParser.frame("READ (note.md)", null), "````READ (note.md)\n````");
    const body = "```json\n{\"ok\":true}\n```";
    assert.equal(PlurnkParser.frame("SEND", body), `\`\`\`\`SEND\n${body}\n\`\`\`\``);
    const nested = "````SEND\n" + body + "\n````";
    assert.equal(PlurnkParser.frame("EDIT (example.md)", nested), "`````EDIT (example.md)\n" + nested + "\n`````");
});

test("{§statement-rendering}: inline input remains legal but is never the canonical rendering", () => {
    const parsed = PlurnkParser.parse("````READ (note.md) <1,-1> <!-- inspect note -->````");
    assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    const rendered = PlurnkParser.stringify(statements);
    assert.equal(rendered, "````READ (note.md) <1,-1> <!-- inspect note -->\n````");
    const reparsed = PlurnkParser.parse(rendered);
    assert.deepEqual(reparsed.items, parsed.items);
});

test("{§statement-rendering}: programs separate fenced operations without changing body whitespace", () => {
    const body = "# Example\n\n```sh\necho 42\n```\n";
    const blocks = [
        PlurnkParser.frame("READ (note.md)", null),
        PlurnkParser.frame("EDIT (example.md)", body),
        PlurnkParser.frame("TASK", '[{"content":"Verify the edit.","status":"in_progress"}]'),
    ];
    const parsed = PlurnkParser.parse(blocks.join("\n"));
    assert.ok(parsed.items.every((item) => item.kind === "statement"));
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    const source = PlurnkParser.stringify(statements);
    assert.equal(source, blocks.join("\n\n"));
    const reparsed = PlurnkParser.parse(source);
    assert.deepEqual(reparsed.items.map((item) => item.kind), ["statement", "statement", "statement"]);
    const edit = reparsed.items[1];
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, body);
});

test("framing a large body does not spread its backtick runs into function arguments", () => {
    const body = "`quoted` ".repeat(100_000);
    assert.equal(PlurnkParser.frame("EDIT (large.md)", body), "````EDIT (large.md)\n" + body + "\n````");
});

// {§fence-boundary}
test("quoted programs are exact body content without speculative diagnostics", () => {
    const body = "```sh\necho hello\n```\n## PLAN_\n### READ_ (example.md)";
    const input = PlurnkParser.frame("SEND", body) + "\n" + PlurnkParser.frame("TASK", '[{"content":"Example delivered.","status":"completed"}]');
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const send = parsed.items.find((item) => item.kind === "statement" && item.statement.op === "SEND");
    assert.equal(send?.kind === "statement" && send.statement.op === "SEND" ? send.statement.body?.raw : null, body);
});

test("an unfinished outer body cannot dispatch inner programs", () => {
    const input = "```READ (before.md)```\n````EDIT (notes.md)\n```sh\nrm notes.md\n```";
    const parsed = PlurnkParser.parseStatements(input);
    assert.deepEqual(parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ"]);
    assert.match(parsed.unparsedTail?.reason ?? "", /not closed with 4 backticks/);
});
