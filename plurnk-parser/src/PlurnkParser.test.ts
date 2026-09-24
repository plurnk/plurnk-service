import test from "node:test";
import assert from "node:assert/strict";
import { writtenOp } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

test("{§statement-rendering}: canonical frames close on their own line and preserve ordinary nested code", () => {
    assert.equal(PlurnkParser.frame("READ (note.md)", null), "```READ (note.md)\n```");
    const body = "```json\n{\"ok\":true}\n```";
    assert.equal(PlurnkParser.frame("SEND", body), `\`\`\`\`SEND\n${body}\n\`\`\`\``);
    const nested = "````SEND\n" + body + "\n````";
    // {§balanced-fences} — a body holding a four-backtick heading is framed one wider.
    assert.equal(PlurnkParser.frame("EDIT (example.md)", nested), "`````EDIT (example.md)\n" + nested + "\n`````");
});

test("{§statement-rendering}: inline input remains legal but is never the canonical rendering", () => {
    const parsed = PlurnkParser.parse("````READ (note.md) <1,-1> <!-- inspect note -->````");
    assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    const rendered = PlurnkParser.stringify(statements);
    assert.equal(rendered, "```READ (note.md) <1,-1> <!-- inspect note -->\n```");
    const reparsed = PlurnkParser.parse(rendered);
    assert.deepEqual(reparsed.items, parsed.items);
});

test("{§statement-rendering}: programs separate fenced operations without changing body whitespace", () => {
    const body = "# Example\n\n````sh\necho 42\n````\n";
    const blocks = [
        PlurnkParser.frame("READ (note.md)", null),
        PlurnkParser.frame("EDIT (example.md)", body),
        PlurnkParser.frame("SEND", "The edit is ready for verification."),
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
    assert.equal(PlurnkParser.frame("EDIT (large.md)", body), "```EDIT (large.md)\n" + body + "\n```");
});

// {§fence-boundary}
test("quoted programs are exact body content without speculative diagnostics", () => {
    const body = "````sh\necho hello\n````\n## PLAN_\n### READ_ (example.md)";
    const input = PlurnkParser.frame("SEND", body) + "\n" + PlurnkParser.frame("NOTE", "Example delivered.");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const send = parsed.items.find((item) => item.kind === "statement" && item.statement.op === "SEND");
    assert.equal(send?.kind === "statement" && send.statement.op === "SEND" ? send.statement.body?.raw : null, body);
});

test("an unfinished wider body ends at the next known heading; the wider fence holds it only while it closes", () => {
    const unfinished = PlurnkParser.parseStatements("````READ (before.md)````\n````EDIT (notes.md)\n```sh\necho literal\n```");
    assert.deepEqual(unfinished.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["READ", "EDIT", "sh"]);
    assert.equal(unfinished.unparsedTail, undefined);
    const closed = PlurnkParser.parseStatements("````READ (before.md)````\n````EDIT (notes.md)\n```sh\necho literal\n```\n````");
    assert.deepEqual(closed.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["READ", "EDIT"]);
    const edit = closed.items.find((item) => item.kind === "statement" && item.statement.op === "EDIT");
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, "```sh\necho literal\n```");
});

test("{§response-text}: prose and operation-shaped text stay literal, without guessing intent", () => {
    const executors = ["sh", "node"];
    for (const source of [
        "The answer is 42.\n\n```ts\nconst x = 1;\n```",
        "Example:\n\n```text\n````READ (x.md\n````\n```",
        "I will look.\n\n    ```FIND (ledger.md) /shutdown/i\n    ```",
        "Thinking.\n\n    ```NOTE\nhello\n    ```",
        "Run:\n\n    ```sh (x)\nnpm test\n    ```",
        "sh [{\"cwd\":\"/\"}]",
        "### log:///1/2/3/READ\n{}",
    ]) {
        const parsed = PlurnkParser.parse(source, { executors });
        assert.deepEqual(parsed.items.filter((item) => item.kind === "statement"), []);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), [source]);
    }
});

test("{§unfenced-operation}: an operation written without its fence is not response text; the prose beside it is", () => {
    // A column-zero line that opens with an operation's name and anything else is the unfenced
    // shape, whether an operand or a sentence follows ("KILL The answer…" in the declaration).
    for (const [source, texts] of [
        ["Let me look.\nREAD (x.md)", ["Let me look.\n"]],
        ["READ the file first, then decide.\nsh is a shell.", ["sh is a shell."]],
    ] as const) {
        const parsed = PlurnkParser.parse(source, { executors: ["sh", "node"] });
        assert.deepEqual(parsed.items.filter((item) => item.kind === "statement"), [], source);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), [...texts], source);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []),
            ["`READ` has no fence, so it did not run."], source);
    }
});

test("{§operation-fences}: three backticks open an operation and draw nothing; ordinary code stays prose", () => {
    const warnings = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items.flatMap((item) =>
        item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const statements = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items.filter((item) => item.kind === "statement").length;
    assert.equal(statements("```READ (notes.md)\n```\n\n```sh\nnpm test\n```"), 2, "three backticks open an operation");
    assert.deepEqual(warnings("```READ (notes.md)\n```"), [], "the taught width draws nothing");
    assert.deepEqual(warnings("```sh\nnpm test\n```"), []);
    assert.deepEqual(warnings("````READ (notes.md)\n````"), [], "a wider fence is the same statement");
    assert.equal(statements("````READ (notes.md)\n````"), 1);
    assert.deepEqual(warnings("The config:\n\n```ts\nexport default {};\n```"), [], "an ordinary code block draws nothing");
    // {§quotation} — an operation inside an unlabeled code block is shown, not run; it is told once.
    assert.deepEqual(warnings("Example:\n\n````\n```READ (notes.md)\n```\n````"), ["`READ` inside a code block was shown, not run."]);
    assert.deepEqual(warnings("```\n```READ (notes.md)\n```"), ["`READ` inside a code block was shown, not run."], "a same-width wrapper is told the same");
    assert.deepEqual(warnings("    ```READ (notes.md)\n    ```"), [], "the taught offset draws nothing");
    assert.deepEqual(warnings("```plurnk\n```READ (notes.md)\n```\n```"), [], "a labeled code block is an example by declaration");
    assert.deepEqual(warnings("````typo (x)\n````"), [], "an unknown name is a code block at any width");
    assert.equal(statements("````typo (x)\n````"), 0);
});
