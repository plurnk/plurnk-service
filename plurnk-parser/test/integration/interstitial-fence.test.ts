import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import type { ClientStatement, ParseResult } from "@plurnk/plurnk-contracts";
import { isExecution } from "@plurnk/plurnk-contracts";

const task = PlurnkParser.frame("WAIT", '[{"content":"Explain the example.","status":"completed"}]');
const unlabeled = (body: string, ticks = 4, newline = "\n") => `${"`".repeat(ticks)}${newline}${body}${newline}${"`".repeat(ticks)}`;
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseStatements],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§quotation}: ${name} reads unlabeled fences outside a block as literal text, never as executable contents`, () => {
        const bodies = [
            "Do not route this text.",
            "<!-- literal, not aside -->",
            "plain words about the example",
        ];
        const source = ["Do not execute these examples:", ...bodies.map((body) => unlabeled(body)), task].join("\n\n");
        const result = parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        assert.deepEqual(statements(result).map(({ op }) => op), ["WAIT"]);
    });

    test(`{§interstitial-fence}: ${name} reads a code-block tag outside a block as prose and inside a body as body`, () => {
        const outside = parse("````ts\nconst x = 1;\n````\n" + task);
        assert.deepEqual(errors(outside), [], "the tag opened nothing, silently");
        assert.deepEqual(statements(outside).map(({ op }) => op), ["WAIT"]);
        const body = "````ts\nconst x = 1;\n````";
        const inside = parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.deepEqual(errors(inside), []);
        const ops = statements(inside);
        assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "WAIT"]);
        assert.equal(ops[0].op === "EDIT" ? ops[0].body : null, body);
    });
}

test("{§response-text}: an unfenced heading is not response text, and says it did not run ({§unfenced-operation})", () => {
    for (const bare of ["READ (notes.md)", "WAIT for it", "FIND (src/**) [{\"pattern\":\"/x/\"}]"]) {
        const result = PlurnkParser.parse("Prelude.\n" + bare + "\n" + task);
        assert.deepEqual(statements(result).map(({ op }) => op), ["WAIT"], bare);
        assert.deepEqual(errors(result).map(({ line, column, severity, message }) => [line, column, severity, message]),
            [[2, 0, "warning", `\`${bare.split(/[ (]/u)[0]}\` has no fence, so it did not run.`]]);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Prelude.\n"], "the unfenced line is not response text");
    }
    // {§naked-operation} — the bare name alone is not unfenced prose: it opens, up to the next heading.
    const naked = PlurnkParser.parse("Prelude.\nWAIT\n" + task);
    assert.deepEqual(statements(naked).map(({ op }) => op), ["WAIT", "WAIT"]);
    assert.deepEqual(errors(naked).map(({ line, column, severity, message }) => [line, column, severity, message]),
        [[2, 0, "warning", "`WAIT` opened with no fence; the taught form is three backticks."]]);
    assert.deepEqual(naked.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Prelude.\n"]);
});

test("{§response-text}: headings inside bodies remain body content", () => {
    const body = "READ (notes.md)\nTASK";
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND", body) + "\n" + task);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["SEND", "WAIT"]);
});

test("{§quotation}: a heading inside an unlabeled fence is quoted data: nothing runs, and the receipt names the forgotten tag", () => {
    const source = unlabeled("KILL (worker:///notes.md)") + "\n" + task;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(statements(result).map(({ op }) => op), ["WAIT"]);
    assert.deepEqual(errors(result).map(({ severity, message }) => [severity, message]), [["warning", "`KILL` inside an unlabeled fence did not run; the tag is the operation."]]);
});

test("{§interstitial-fence}: explicit SEND keeps its aside, target, and literal body", () => {
    const aside = "reply";
    const body = "````KILL (worker:///notes.md)````\n<!-- body comment -->";
    const source = `${PlurnkParser.frame(`SEND <!-- ${aside} -->`, body)}\n${task}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(errors(result), []);
    const ops = statements(result);
    assert.deepEqual(ops.map(({ op }) => op), ["SEND", "WAIT"]);
    const send = ops[0];
    assert.ok(send.op === "SEND");
    assert.equal(send.aside, aside);
    assert.equal(send.body?.raw, body);
    assert.equal(send.target, null);
});

test("{§fence-boundary}: unlabeled fences already inside a body remain ordinary body content", () => {
    const body = unlabeled("KILL (worker:///notes.md)");
    for (const header of ["SEND", "EDIT (worker:///example.md)", "sh"]) {
        const result = PlurnkParser.parseStatements(PlurnkParser.frame(header, body));
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.equal(ops.length, 1);
        assert.ok(ops[0].op === "SEND" || ops[0].op === "EDIT" || isExecution(ops[0]));
        const actual = ops[0].body;
        assert.equal(typeof actual === "object" && actual !== null && "raw" in actual ? actual.raw : actual, body);
    }
});

test("{§closer-fallback}: an unlabeled fence after an unclosed block is that block's closer, not a message", () => {
    for (const tail of ["````", "````\nprose after", "````\nbody\n````"]) {
        const source = "````READ (worker:///notes.md)\n" + tail;
        const result = PlurnkParser.parseStatements(source);
        assert.equal(result.unparsedTail, undefined, tail);
        assert.deepEqual(statements(result).map(({ op }) => op), ["READ"], tail);
    }
});

test("{§executor-case}: an executor tag in any case opens the registered executor with its registered spelling", () => {
    const upper = PlurnkParser.parseStatements("````SH\necho hi\n````\n", { executors: ["sh", "python3"] });
    const ops = upper.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(ops.length, 1);
    assert.equal(isExecution(ops[0]!), true);
    assert.equal(isExecution(ops[0]!) ? ops[0]!.runtime : null, "sh", "the AST carries the registered spelling");
    const mixed = PlurnkParser.parseStatements("````Python3 (script.py)\nprint(1)\n````\n", { executors: ["sh", "python3"] });
    const py = mixed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(py[0] !== undefined && isExecution(py[0]) ? py[0].runtime : null, "python3");
    const unknown = PlurnkParser.parseStatements("````Python\nprint(1)\n````\n", { executors: ["sh", "python3"] });
    assert.equal(unknown.items.some((item) => item.kind === "statement"), false, "an unregistered name in any case is still prose");
});
