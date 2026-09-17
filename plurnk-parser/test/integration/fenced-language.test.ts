import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";
import { TurnDisposition, type DispositionStatement } from "@plurnk/plurnk-contracts";
import { isExecution } from "@plurnk/plurnk-contracts";
import { writtenOp } from "@plurnk/plurnk-contracts";

const ops = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const frame = PlurnkParser.frame;
const task = (content: string, op: DispositionStatement["op"] = "WAIT") => frame(op, content);

for (const entrypoint of ["parse", "parseStatements", "parseClient"] as const) {
    test(`{§executor-js-spelling}: ${entrypoint} canonicalizes js without shadowing a registered executor`, () => {
        for (const { executors, tag, runtime } of [
            { executors: ["node"], tag: "js", runtime: "node" },
            { executors: ["Node"], tag: "JS", runtime: "Node" },
            { executors: ["node", "js"], tag: "js", runtime: "js" },
            { executors: ["js", "node"], tag: "js", runtime: "js" },
            { executors: ["js"], tag: "JS", runtime: "js" },
            { executors: [], tag: "js", runtime: null },
        ]) {
            const body = "console.log(42);";
            const source = frame(tag, body) + "\n" + task("Inspect the result.");
            const parsed = PlurnkParser[entrypoint](source, { executors });
            const diagnostics = parsed.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
            assert.deepEqual(diagnostics.map((error) => ({ severity: error.severity, message: error.message })), runtime === null ? [{
                severity: "warning",
                message: "`js` is not an operation or a known executor here; the block was read as prose and nothing ran.",
            }] : []);
            assert.equal(parsed.unparsedTail, undefined);
            const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(statements.map(writtenOp), runtime === null ? ["WAIT"] : [runtime, "WAIT"]);
            if (runtime === null) continue;
            const execution = statements[0];
            assert.ok(isExecution(execution));
            assert.equal(execution.body, body);
            assert.equal(PlurnkParser.stringify([execution]), frame(runtime, body), "serialization uses the canonical executor");
        }
    });
}

test("{§executor-js-spelling}: a nested js example remains a literal message body", () => {
    const body = frame("js", "console.log(42);");
    const parsed = PlurnkParser.parse(frame("SEND", body) + "\n" + task("Explained."), { executors: ["node"] });
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
});

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
    assert.deepEqual(statements.map(writtenOp), ["EDIT", "READ", "WAIT"]);
    assert.equal(statements[0].op === "EDIT" ? statements[0].body : null, "alpha\nbeta");
    assert.equal(statements[1].op === "READ" ? statements[1].body : "wrong op", null);
    assert.equal(statements[2].op === "WAIT" ? statements[2].body : null, "Waiting for the read result.");
});

// {§section-boundary}
test("framing removes its own newline, not body whitespace or interstatement padding", () => {
    const input = frame("EDIT (notes.md)", "alpha\n") + "\n\n" + task("done");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, "alpha\n");
});

// {§fence-boundary}
test("a quoted turn remains one exact literal body", () => {
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
            { source: "```READ (note.md)```\nOutside.", names: ["READ"], bodies: [null] },
            { source: "```READ (first.md)```\n````sh\necho 42\n````\n\nOutside.", names: ["READ", "sh"], bodies: [null, "echo 42"] },
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

test("{§fence-closer}: a same-width bare fence closes its SEND, and the numeric delimiter keeps it as body", () => {
    for (const newline of ["\n", "\r\n"]) {
        const bare = PlurnkParser.parse("```SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n```\n".replaceAll("\n", newline) + task("Done."));
        assert.equal(bare.unparsedTail, undefined);
        assert.deepEqual(errors(bare), []);
        assert.deepEqual(ops(bare).map(writtenOp), ["SEND", "WAIT"]);
        const bareSend = ops(bare)[0];
        assert.equal(bareSend.op === "SEND" ? bareSend.body?.raw : null, "Code:\n```ts\nconst value = 42;".replaceAll("\n", newline), "the first same-width bare fence is the closer");
        const delimited = PlurnkParser.parse("```42SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n```42\n".replaceAll("\n", newline) + task("Done."));
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
test("parseStatements retains consecutive turns with independently chosen fence lengths", () => {
    const source = "```SEND\nOne.\n```\n```WAIT\n```\n\n`````SEND\nTwo.\n`````\n`````WAIT\n`````";
    const parsed = PlurnkParser.parseStatements(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "SEND", "WAIT"]);
    assert.deepEqual(ops(parsed).flatMap((op) => op.op === "SEND" ? [op.body?.raw] : []), ["One.", "Two."]);
});

// {§disposition-anywhere}
test("operations after a disposition are admitted in authored order without a diagnostic", () => {
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
test("literal examples inside a SEND stay literal while a KILL after WAIT is admitted", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse([frame("SEND", body), task("Explained."), frame("KILL (log:///1/2/3/READ)", null)].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "KILL"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
});

// {§tier-entrypoints}
test("statement lists retain source order without inventing turn boundaries", () => {
    const turn = [frame("KILL (log:///1/1/1/READ)", null), task("Continue.")].join("\n");
    const parsed = PlurnkParser.parseStatements(turn + "\n" + turn);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["KILL", "WAIT", "KILL", "WAIT"]);
    const unfinished = PlurnkParser.parseStatements(turn + "\n" + frame("READ (unfinished.md)", null));
    assert.deepEqual(errors(unfinished), []);
    assert.deepEqual(ops(unfinished).map(writtenOp), ["KILL", "WAIT", "READ"]);
});

test("former terminal names are not reserved operations", () => {
    for (const name of ["DONE", "FAIL"]) {
        const parsed = PlurnkParser.parse(frame(name, "Not an operation.") + "\n\n" + frame("SEND", "The answer."));
        assert.deepEqual(ops(parsed).map(writtenOp), ["SEND"]);
        assert.deepEqual(errors(parsed).map(({ severity }) => severity), ["warning"]);
        assert.match(errors(parsed)[0].message, /not an operation or a known executor/);
    }
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
