import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, type DispositionStatement, isExecution, writtenOp } from "@plurnk/plurnk-contracts";

const ops = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const frame = PlurnkParser.frame;
const task = (content: string, op: DispositionStatement["op"] = "WAIT") => frame(op, content);

// {§canonical-statement}
test("{§section-boundary} independent fenced operations retain exact bodies and typed fields", () => {
    const input = [
        frame("EDIT (worker:///note.md) <1,-1>", "alpha\nbeta"),
        frame("READ (worker:///note.md)", null),
        task("Waiting for the read result."),
    ].join("\n");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    assert.equal(parsed.unparsedTail, undefined);
    const statements = ops(parsed);
    assert.deepEqual(statements.map(writtenOp), ["EDIT", "READ", "WAIT"]);
    assert.equal(statements[0].op === "EDIT" ? statements[0].body : null, "alpha\nbeta");
    assert.equal(statements[1].op === "READ" ? statements[1].body : "wrong op", null);
    assert.equal(statements[2].op === "WAIT" ? statements[2].body : null, "Waiting for the read result.");
});

// {§section-boundary}
test("{§fence-boundary} framing removes its own newline, not body whitespace or interstatement padding", () => {
    const input = frame("EDIT (notes.md)", "alpha\n") + "\n\n" + task("done");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, "alpha\n");
});

// {§fence-boundary}
test("{§fence-boundary} a quoted turn remains one exact literal body", () => {
    const body = [frame("SEND", "Paris."), task("Answered.")].join("\n");
    const parsed = PlurnkParser.parse([frame("EDIT (quoted.md)", body), task("Stored it.")].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.equal(ops(parsed).length, 2);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, body);
});

test("{§whitespace-contract}: exact closing fences bound bodies before ignored outside text", () => {
    for (const newline of ["\n", "\r\n"]) {
        for (const { source, names, bodies } of [
            { source: "````READ (note.md)````\nOutside.", names: ["READ"], bodies: [null] },
            { source: "````READ (first.md)````\n`````sh\necho 42\n`````\n\nOutside.", names: ["READ", "sh"], bodies: [null, "echo 42"] },
            { source: "```````READ (note.md)\n```````\nOutside.", names: ["READ"], bodies: [null] },
        ]) {
            const parsed = PlurnkParser.parse((source + "\n" + task("Done.")).replaceAll("\n", newline));
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(writtenOp), [...names, "WAIT"]);
            assert.deepEqual(ops(parsed).slice(0, -1).map((op) => isExecution(op) ? op.body : op.op === "SEND" ? op.body?.raw : null), bodies.map((body) => body?.replaceAll("\n", newline) ?? null));
        }
    }
});

test("{§balanced-fences}: complete same-width examples remain body", () => {
    for (const newline of ["\n", "\r\n"]) {
        const bare = PlurnkParser.parse("````SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n````\n".replaceAll("\n", newline) + task("Done."));
        assert.equal(bare.unparsedTail, undefined);
        assert.deepEqual(errors(bare), []);
        assert.deepEqual(ops(bare).map(writtenOp), ["SEND", "WAIT"]);
        const bareSend = ops(bare)[0];
        assert.equal(bareSend.op === "SEND" ? bareSend.body?.raw : null, "Code:\n```ts\nconst value = 42;\n```\nVerified.".replaceAll("\n", newline), "the complete nesting preserves the example and the following prose");
    }
});

test("{§whitespace-contract}: a text-only statement list is empty", () => {
    const parsed = PlurnkParser.parseStatements("Outside.");
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.unparsedTail, undefined);
});

// {§tier-entrypoints}
test("{§disposition-anywhere} parseStatements retains consecutive turns with independently chosen fence lengths", () => {
    const source = "````SEND\nOne.\n````\n````WAIT\n````\n\n`````SEND\nTwo.\n`````\n`````WAIT\n`````";
    const parsed = PlurnkParser.parseStatements(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "SEND", "WAIT"]);
    assert.deepEqual(ops(parsed).flatMap((op) => op.op === "SEND" ? [op.body?.raw] : []), ["One.", "Two."]);
});

// {§disposition-anywhere}
test("{§fence-boundary} operations after a disposition are admitted in authored order without a diagnostic", () => {
    for (const op of ["WAIT"] as const) {
        for (const precedingRead of [false, true]) {
            const input = [
                ...(precedingRead ? [frame("READ (early.md)", null)] : []),
                task("Answer.", op),
                frame("KILL (log:///3/3/1/READ)", null),
                frame("READ (notes.md)", null),
                frame("SEND (worker://reviewer)", "Check this."),
            ].join("\n");
            const parsed = PlurnkParser.parse(input);
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(writtenOp), [...(precedingRead ? ["READ"] : []), op, "KILL", "READ", "SEND"]);
            const disposition = ops(parsed).find(TurnDisposition.is);
            assert.ok(disposition !== undefined);
            assert.equal(disposition.body, "Answer.");
        }
    }
});

// {§fence-boundary} {§disposition-anywhere}
test("{§tier-entrypoints} literal examples inside a SEND stay literal while a KILL after WAIT is admitted", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse([frame("SEND", body), task("Explained."), frame("KILL (log:///1/2/3/READ)", null)].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "KILL"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
});

// {§tier-entrypoints}
test("{§tier-entrypoints} statement lists retain source order without inventing turn boundaries", () => {
    const turn = [frame("KILL (log:///1/1/1/READ)", null), task("Continue.")].join("\n");
    const parsed = PlurnkParser.parseStatements(turn + "\n" + turn);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["KILL", "WAIT", "KILL", "WAIT"]);
    const unfinished = PlurnkParser.parseStatements(turn + "\n" + frame("READ (unfinished.md)", null));
    assert.deepEqual(errors(unfinished), []);
    assert.deepEqual(ops(unfinished).map(writtenOp), ["KILL", "WAIT", "READ"]);
});

test("{§tier-entrypoints} prose without executable fences is not a program", () => {
    const parsed = PlurnkParser.parse("First consider the request.\nThen send the answer.");
    assert.equal(ops(parsed).length, 0);
    assert.ok(errors(parsed).length > 0);
});
