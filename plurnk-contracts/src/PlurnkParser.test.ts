import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

test("{§statement-rendering}: canonical executable frames use four ticks and preserve ordinary nested code", () => {
    assert.equal(PlurnkParser.frame("READ (note.md)", null), "````READ (note.md)````");
    const body = "```json\n{\"ok\":true}\n```";
    assert.equal(PlurnkParser.frame("SEND", body), `\`\`\`\`SEND\n${body}\n\`\`\`\``);
    const nested = "````SEND\n" + body + "\n````";
    assert.equal(PlurnkParser.frame("EDIT (example.md)", nested), "`````EDIT (example.md)\n" + nested + "\n`````");
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
