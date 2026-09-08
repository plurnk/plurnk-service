import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

test("framing a large body does not spread its backtick runs into function arguments", () => {
    const body = "`quoted` ".repeat(100_000);
    assert.equal(PlurnkParser.frame("EDIT (large.md)", body), "```EDIT (large.md)\n" + body + "\n```");
});

// {§fence-boundary}
test("quoted programs are exact body content without speculative diagnostics", () => {
    const body = "```sh\necho hello\n```\n## PLAN_\n### READ_ (example.md)";
    const input = PlurnkParser.frame("DONE", body);
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const send = parsed.items.find((item) => item.kind === "statement" && item.statement.op === "DONE");
    assert.equal(send?.kind === "statement" && send.statement.op === "DONE" ? send.statement.body?.raw : null, body);
});

test("an unfinished outer body cannot dispatch inner programs", () => {
    const input = "```READ (before.md)```\n````EDIT (notes.md)\n```sh\nrm notes.md\n```";
    const parsed = PlurnkParser.parseStatements(input);
    assert.deepEqual(parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ"]);
    assert.match(parsed.unparsedTail?.reason ?? "", /not closed with 4 backticks/);
});
