import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

const task = PlurnkParser.frame("TASK", '[{"content":"Observe the result.","status":"completed"}]');
const statements = (result: ReturnType<typeof PlurnkParser.parse>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

test("{§whitespace-contract}: provider preamble is ignored with or without a separating newline", () => {
    for (const prefix of ["plain preamble\n", "harmless status."]) {
        const result = PlurnkParser.parse(prefix + PlurnkParser.frame("READ (worker:///x)", null) + "\n" + task);
        assert.deepEqual(result.items.map((item) => item.kind), ["statement", "statement"]);
        assert.deepEqual(statements(result).map(({ op }) => op), ["READ", "TASK"]);
        assert.deepEqual(statements(result)[0].position, prefix.endsWith("\n") ? { line: 2, column: 0 } : { line: 1, column: prefix.length });
    }
});

test("{§fence-boundary}: ignored preamble does not promote headings or inline body examples", () => {
    const body = "keep inline ### READ_ (worker:///not-an-operation) as body";
    const result = PlurnkParser.parse("ordinary.## Heading! remains preamble\n" + PlurnkParser.frame("TASK", JSON.stringify([{ content: body, status: "completed" }])));
    assert.deepEqual(result.items.map((item) => item.kind), ["statement"]);
    const first = statements(result)[0];
    assert.equal(first.op === "TASK" ? first.body[0]?.content : undefined, body);
});

test("{§whitespace-contract}: the topology witness ignores a model-written result between intact operations", () => {
    const source = [
        "I'll confirm the count exactly with jq, then reply.",
        "````jq (data/users.json)",
        "length",
        "````",
        "3",
        "````SEND",
        "3",
        "Top-level JSON array.",
        "````",
        task,
        "Postscript: finished.",
    ].join("\n");
    const parsed = PlurnkParser.parse(source, { executors: ["jq"] });
    assert.equal(parsed.unparsedTail, undefined);
    assert.deepEqual(parsed.items.map((item) => item.kind), ["statement", "statement", "statement"]);
    const ops = statements(parsed);
    assert.deepEqual(ops.map(({ op }) => op), ["EXEC", "SEND", "TASK"]);
    assert.equal(ops[0].op === "EXEC" ? ops[0].body : null, "length");
    assert.equal(ops[1].op === "SEND" ? ops[1].body?.raw : null, "3\nTop-level JSON array.");
    assert.deepEqual(ops[1].position, { line: 6, column: 0 });
});

test("{§tier-entrypoints}: every parser tier ignores outside text without changing body bytes or source positions", () => {
    for (const newline of ["\n", "\r\n"]) {
        const body = ["literal text", "```READ (not-executed.md)```", "3", ""].join(newline);
        const source = [
            "Prelude 🌱",
            PlurnkParser.frame("EDIT (note.md)", body),
            "3 — intermediate prose",
            PlurnkParser.frame("SEND", "Only this is a message."),
            task,
            "Trailing prose.",
        ].join(newline);
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseLog, PlurnkParser.parseClient]) {
            const parsed = parse(source);
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(parsed.items.map((item) => item.kind), ["statement", "statement", "statement"]);
            const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "SEND", "TASK"]);
            assert.equal(ops[0].op === "EDIT" ? ops[0].body : null, body);
            assert.deepEqual(ops[0].position, { line: 2, column: 0 });
        }
    }
});

test("{§turn-shape}: ignored text supplies neither an operation nor a task inventory", () => {
    const empty = PlurnkParser.parse("Only commentary.\nTASK completed.");
    assert.equal(statements(empty).length, 0);
    assert.deepEqual(empty.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), [PlurnkParser.NO_VALID_OPERATION]);
    const missing = PlurnkParser.parse("Prelude.\n````READ (note.md)````\nEverything is completed.");
    assert.deepEqual(statements(missing).map(({ op }) => op), ["READ"]);
    assert.deepEqual(missing.items.filter((item) => item.kind === "error"), []);
});

test("{§disposition-anywhere}: ignored prose neither hides an operation after TASK nor a duplicate TASK", () => {
    const parsed = PlurnkParser.parse(task + "\nSome prose.\n````READ (late.md)````\nMore prose.");
    assert.deepEqual(statements(parsed).map(({ op }) => op), ["TASK", "READ"]);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const duplicate = PlurnkParser.parse(task + "\nCommentary.\n" + task);
    assert.ok(duplicate.items.some((item) => item.kind === "error" && item.error.code === "invalid-turn-structure"));
    const log = PlurnkParser.parseLog(task + "\nCommentary.\n" + task + "\nAfterword.");
    assert.deepEqual(log.items.map((item) => item.kind), ["statement", "statement"]);
});

test("{§closer-fallback}: a shorter, longer, or missing closer all end the block after its literal body", () => {
    for (const closer of ["", "```", "`````"]) {
        const parsed = PlurnkParser.parse("Prelude.\n````EDIT (note.md)\nLiteral body.\n" + closer);
        assert.equal(parsed.unparsedTail, undefined, closer);
        assert.deepEqual(statements(parsed).map(({ op }) => op), ["EDIT"], closer);
        const edit = statements(parsed)[0];
        assert.equal(edit.op === "EDIT" ? edit.body : null, "Literal body.", closer);
    }
});
