// {§pairing-objective} {§balanced-fences}: a heading the author enclosed in a wider fence is the example it was
// written as. A message whose own fence is narrower than the fences wrapping its examples still holds them; the
// reading that lets a wrapper close the message and runs the examples loses (#1147: a self-description reply ran
// twelve quoted examples that way).
import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "../../src/PlurnkParser.ts";

const ops = (text: string) => PlurnkParser.parse(text, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyOf = (statement: unknown): string => {
    const body = (statement as { body?: unknown }).body;
    return typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? "";
};

const wrapped = (op: string, example: string): string => "````\n```" + op + "\n" + example + "```\n````";
const REPLY_BODY = [
    "# Operations",
    "",
    "**NOTE** — working memory.",
    wrapped("NOTE <!-- plan -->", "Survey, then state the request.\n"),
    "",
    "**EDIT** — replace text by pattern.",
    wrapped("EDIT (notes.md) /draft/i", "final\n"),
    "",
    "**KILL** — retire log items.",
    wrapped("KILL (log:///1/[1-7]/*/{READ,emission})", ""),
    "",
    "Nothing above was executed.",
].join("\n");
const PLAN = "```NOTE <!-- plan -->\nExplain without running anything.\n```\n\n";

test("{§pairing-objective}: a reply narrower than the fences wrapping its examples still holds them", () => {
    // The outer fence is three wide and the wrappers four, closed as the author closed it: with a wrapper's width.
    const statements = ops(PLAN + "```SEND [200]\n" + REPLY_BODY + "\n````");
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "SEND"]);
    assert.equal(bodyOf(statements[1]), REPLY_BODY);
});

test("{§operation-fences}: the canonical wider outer fence reads the same reply identically", () => {
    const statements = ops(PLAN + "`````SEND [200]\n" + REPLY_BODY + "\n`````");
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "SEND"]);
    assert.equal(bodyOf(statements[1]), REPLY_BODY);
});

test("{§fence-pairing}: an example quoted at the reply's own width still ends the reply and runs", () => {
    const statements = ops("```SEND [200]\nUse this form:\n```\n```READ (a.md) <1,5>\n```\n```\nThat is all.\n```");
    assert.deepEqual(statements.map((statement) => statement.op), ["SEND", "READ"]);
    assert.equal(bodyOf(statements[0]), "Use this form:");
});
