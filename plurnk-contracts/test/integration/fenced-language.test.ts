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

test("{§whitespace-contract}: exact closing fences bound bodies before ignored outside text", () => {
    for (const newline of ["\n", "\r\n"]) {
        for (const { source, names, bodies } of [
            { source: "```READ (note.md)```\nOutside.", names: ["READ"], bodies: [null] },
            { source: "```READ (first.md)```\n````sh\necho 42\n````\n\nOutside.", names: ["READ", "EXEC"], bodies: [null, "echo 42"] },
            { source: "```````READ (note.md)\n```````\nOutside.", names: ["READ"], bodies: [null] },
        ]) {
            const parsed = PlurnkParser.parse((source + "\n" + task("Done.", "completed")).replaceAll("\n", newline));
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(({ op }) => op), [...names, "TASK"]);
            assert.deepEqual(ops(parsed).slice(0, -1).map((op) => op.op === "EXEC" ? op.body : op.op === "SEND" ? op.body?.raw : null), bodies.map((body) => body?.replaceAll("\n", newline) ?? null));
        }
    }
});

test("{§fence-closer}: a same-width bare fence closes its SEND, and the numeric delimiter keeps it as body", () => {
    for (const newline of ["\n", "\r\n"]) {
        const bare = PlurnkParser.parse("```SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n```\n".replaceAll("\n", newline) + task("Done.", "completed"));
        assert.equal(bare.unparsedTail, undefined);
        assert.deepEqual(errors(bare), []);
        assert.deepEqual(ops(bare).map(({ op }) => op), ["SEND", "TASK"]);
        const bareSend = ops(bare)[0];
        assert.equal(bareSend.op === "SEND" ? bareSend.body?.raw : null, "Code:\n```ts\nconst value = 42;".replaceAll("\n", newline), "the first same-width bare fence is the closer");
        const delimited = PlurnkParser.parse("```42SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n```42\n".replaceAll("\n", newline) + task("Done.", "completed"));
        assert.deepEqual(errors(delimited), []);
        const delimitedSend = ops(delimited)[0];
        assert.equal(delimitedSend.op === "SEND" ? delimitedSend.body?.raw : null, "Code:\n```ts\nconst value = 42;\n```\nVerified.".replaceAll("\n", newline));
    }
});

test("{§whitespace-contract}: a text-only statement list is empty", () => {
    const parsed = PlurnkParser.parseStatements("Outside.");
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.unparsedTail, undefined);
});

// {§tier-entrypoints}
test("parseLog retains consecutive turns with independently chosen fence lengths", () => {
    const source = "```SEND\nOne.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```\n\n`````SEND\nTwo.\n`````\n`````TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n`````";
    const parsed = PlurnkParser.parseLog(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["SEND", "TASK", "SEND", "TASK"]);
    assert.deepEqual(ops(parsed).flatMap((op) => op.op === "SEND" ? [op.body?.raw] : []), ["One.", "Two."]);
});

// {§disposition-anywhere}
test("operations after a disposition are admitted in authored order without a diagnostic", () => {
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
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(({ op }) => op), [...(precedingRead ? ["READ"] : []), "TASK", "KILL", "READ", "SEND"]);
            const disposition = ops(parsed).find(TurnDisposition.is);
            assert.ok(disposition !== undefined);
            assert.deepEqual(disposition.body, [{ content: "Answer.", status }]);
        }
    }
});

// {§fence-boundary} {§disposition-anywhere}
test("literal examples inside a SEND stay literal while a KILL after TASK is admitted", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse([frame("SEND", body), task("Explained.", "completed"), frame("KILL (log:///1/2/3/READ)", null)].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(({ op }) => op), ["SEND", "TASK", "KILL"]);
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
