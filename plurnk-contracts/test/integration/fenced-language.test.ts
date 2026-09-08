import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, TurnDisposition } from "../../src/index.ts";

const ops = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const frame = PlurnkParser.frame;

// {§canonical-statement}
test("independent fenced operations retain exact bodies and typed fields", () => {
    const input = [
        frame("PLAN", '[{"content":"Update the note, then read it.","status":"in_progress"}]'),
        frame("EDIT (worker:///note.md) <1,-1>", "alpha\nbeta"),
        frame("READ (worker:///note.md)", null),
        frame("NEXT", "Waiting for the read result."),
    ].join("\n");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    assert.equal(parsed.unparsedTail, undefined);
    const statements = ops(parsed);
    assert.deepEqual(statements.map(({ op }) => op), ["PLAN", "EDIT", "READ", "NEXT"]);
    assert.deepEqual(statements[0].op === "PLAN" ? statements[0].body : null, [
        { content: "Update the note, then read it.", status: "in_progress" },
    ]);
    assert.equal(statements[1].op === "EDIT" ? statements[1].body : null, "alpha\nbeta");
    assert.equal(statements[2].op === "READ" ? statements[2].body : "wrong op", null);
    assert.equal(statements[3].op === "NEXT" ? statements[3].body?.raw : null, "Waiting for the read result.");
});

// {§section-boundary}
test("framing removes its own newline, not body whitespace or interstatement padding", () => {
    const input = frame("EDIT (notes.md)", "alpha\n") + "\n\n" + frame("DONE", "done");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, "alpha\n");
});

// {§fence-boundary}
test("a quoted turn remains one exact literal body", () => {
    const body = [frame("PLAN", "[]"), frame("DONE", "Paris.")].join("\n");
    const parsed = PlurnkParser.parse([frame("PLAN", "[]"), frame("EDIT (quoted.md)", body), frame("NEXT", "Stored it.")].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.equal(ops(parsed).length, 3);
    const edit = ops(parsed)[1];
    assert.equal(edit.op === "EDIT" ? edit.body : null, body);
});

// {§tier-entrypoints}
test("parseLog retains consecutive turns with independently chosen fence lengths", () => {
    const source = "```PLAN\n[]\n```\n```DONE\nOne.\n```\n````PLAN\n[]\n````\n`````DONE\nTwo.\n`````";
    const parsed = PlurnkParser.parseLog(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["PLAN", "DONE", "PLAN", "DONE"]);
    assert.deepEqual(ops(parsed).filter(TurnDisposition.is).map((op) => op.body?.raw), ["One.", "Two."]);
});

// {§disposition-ends-turn}
test("operations after a disposition are recognized, dropped and diagnosed once", () => {
    for (const label of ["NEXT", "WAIT", "DONE", "FAIL"]) {
        for (const plan of [false, true]) {
            const input = [
                ...(plan ? [frame("PLAN", "[]")] : []),
                frame(label, "Answer."),
                frame("KILL (log:///3/3/1/READ)", null),
                frame("READ (notes.md)", null),
                frame("SEND (worker://reviewer)", "Check this."),
            ].join("\n");
            const parsed = PlurnkParser.parse(input);
            assert.equal(parsed.unparsedTail, undefined);
            const diagnostics = errors(parsed);
            assert.deepEqual(diagnostics.map(({ code }) => code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION]);
            assert.equal(diagnostics[0].message, "The disposition `" + label + "` ended the turn; 3 operations after its body were not admitted (KILL ×1, READ ×1, SEND ×1). Every OP, including KILL, precedes NEXT, WAIT, DONE, or FAIL.");
            assert.equal(diagnostics[0].line, plan ? 7 : 4);
            assert.deepEqual(ops(parsed).map(({ op }) => op), [...(plan ? ["PLAN"] : []), label]);
            const send = ops(parsed).at(-1);
            assert.equal(send !== undefined && TurnDisposition.is(send) ? send.body?.raw : null, "Answer.");
        }
    }
});

// {§fence-boundary} {§disposition-ends-turn}
test("literal examples inside a SEND do not count as trailing operations", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse(frame("DONE", body) + "\n" + frame("KILL (log:///1/2/3/READ)", null));
    assert.deepEqual(errors(parsed).map(({ code }) => code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION]);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["DONE"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "DONE" ? send.body?.raw : null, body);
});

// {§tier-entrypoints}
test("saved turns retain post-disposition operations before the next PLAN", () => {
    const turn = [frame("PLAN", "[]"), frame("NEXT", "Continue."), frame("KILL (log:///1/1/1/READ)", null)].join("\n");
    const parsed = PlurnkParser.parseLog(turn + "\n" + turn);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["PLAN", "NEXT", "KILL", "PLAN", "NEXT", "KILL"]);
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
