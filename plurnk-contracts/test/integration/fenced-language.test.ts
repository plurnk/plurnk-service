import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, TurnDisposition, type Plan } from "../../src/index.ts";

const ops = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const frame = PlurnkParser.frame;
const task = (content: string, status: Plan[number]["status"] = "in_progress") =>
    frame("TASK", JSON.stringify([{ content, status }]));

// {§canonical-statement}
test("independent fenced operations retain exact bodies and typed fields", () => {
    const input = [
        frame("EDIT (worker:///note.md) <1,-1>", "alpha\nbeta"),
        frame("READ (worker:///note.md)", null),
        task("Waiting for the read result."),
    ].join("\n");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    assert.equal(parsed.unparsedTail, undefined);
    const statements = ops(parsed);
    assert.deepEqual(statements.map(({ op }) => op), ["EDIT", "READ", "TASK"]);
    assert.equal(statements[0].op === "EDIT" ? statements[0].body : null, "alpha\nbeta");
    assert.equal(statements[1].op === "READ" ? statements[1].body : "wrong op", null);
    assert.deepEqual(statements[2].op === "TASK" ? statements[2].body : null, [
        { content: "Waiting for the read result.", status: "in_progress" },
    ]);
});

// {§section-boundary}
test("framing removes its own newline, not body whitespace or interstatement padding", () => {
    const input = frame("EDIT (notes.md)", "alpha\n") + "\n\n" + task("done", "completed");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, "alpha\n");
});

// {§fence-boundary}
test("a quoted turn remains one exact literal body", () => {
    const body = [frame("SEND", "Paris."), task("Answered.", "completed")].join("\n");
    const parsed = PlurnkParser.parse([frame("EDIT (quoted.md)", body), task("Stored it.")].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.equal(ops(parsed).length, 2);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, body);
});

// {§tier-entrypoints}
test("parseLog retains consecutive turns with independently chosen fence lengths", () => {
    const source = "```SEND\nOne.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```\n\n`````SEND\nTwo.\n`````\n`````TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n`````";
    const parsed = PlurnkParser.parseLog(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["SEND", "TASK", "SEND", "TASK"]);
    assert.deepEqual(ops(parsed).flatMap((op) => op.op === "SEND" ? [op.body?.raw] : []), ["One.", "Two."]);
});

// {§disposition-ends-turn}
test("operations after a disposition are recognized, dropped and diagnosed once", () => {
    for (const status of ["pending", "in_progress", "waiting", "completed", "failed"] as const) {
        for (const precedingRead of [false, true]) {
            const input = [
                ...(precedingRead ? [frame("READ (early.md)", null)] : []),
                task("Answer.", status),
                frame("KILL (log:///3/3/1/READ)", null),
                frame("READ (notes.md)", null),
                frame("SEND (worker://reviewer)", "Check this."),
            ].join("\n");
            const parsed = PlurnkParser.parse(input);
            assert.equal(parsed.unparsedTail, undefined);
            const diagnostics = errors(parsed);
            assert.deepEqual(diagnostics.map(({ code }) => code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION]);
            assert.equal(diagnostics[0].message, "`TASK` ended the turn; 3 operations after its body were not admitted (KILL ×1, READ ×1, SEND ×1). Other operations precede TASK.");
            assert.equal(diagnostics[0].line, precedingRead ? 5 : 4);
            assert.deepEqual(ops(parsed).map(({ op }) => op), [...(precedingRead ? ["READ"] : []), "TASK"]);
            const send = ops(parsed).at(-1);
            assert.ok(send !== undefined && TurnDisposition.is(send));
            assert.deepEqual(send.body, [{ content: "Answer.", status }]);
        }
    }
});

// {§fence-boundary} {§disposition-ends-turn}
test("literal examples inside a SEND do not count as trailing operations", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse([frame("SEND", body), task("Explained.", "completed"), frame("KILL (log:///1/2/3/READ)", null)].join("\n"));
    assert.deepEqual(errors(parsed).map(({ code }) => code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION]);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["SEND", "TASK"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
});

// {§tier-entrypoints}
test("saved turns end at each disposition and retain operations in execution order", () => {
    const turn = [frame("KILL (log:///1/1/1/READ)", null), task("Continue.")].join("\n");
    const parsed = PlurnkParser.parseLog(turn + "\n" + turn);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["KILL", "TASK", "KILL", "TASK"]);
    const unfinished = PlurnkParser.parseLog(turn + "\n" + frame("READ (unfinished.md)", null));
    assert.ok(errors(unfinished).length > 0 || unfinished.unparsedTail !== undefined);
});

test("client-only operations use the same fences", () => {
    const parsed = PlurnkParser.parseClient(frame("LOOK (worker:///note.md) <1,20>", "~recent thoughts"));
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    assert.equal(parsed.items.find((item) => item.kind === "statement")?.statement.op, "LOOK");
});

test("prose without executable fences is not a program", () => {
    const parsed = PlurnkParser.parse("PLAN: consider the request\nSEND 200: done");
    assert.equal(ops(parsed).length, 0);
    assert.ok(errors(parsed).length > 0);
});
