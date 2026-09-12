import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import type { ClientStatement, ParseResult } from "../../src/types.ts";

const task = PlurnkParser.frame("TASK", '[{"content":"Explain the example.","status":"completed"}]');
const unlabeled = (body: string, ticks = 4, newline = "\n") => `${"`".repeat(ticks)}${newline}${body}${newline}${"`".repeat(ticks)}`;
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseLog],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§interstitial-fence}: ${name} reads unlabeled fences outside a block as prose, never as a message`, () => {
        const bodies = [
            "Do not route this text.",
            "<!-- literal, not aside -->",
            "plain words about the example",
        ];
        const source = ["Do not execute these examples:", ...bodies.map((body) => unlabeled(body)), task].join("\n\n");
        const result = parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        assert.deepEqual(statements(result).map(({ op }) => op), ["TASK"]);
    });

    test(`{§interstitial-fence}: ${name} reads a code-block tag outside a block as prose and inside a body as body`, () => {
        const outside = parse("````ts\nconst x = 1;\n````\n" + task);
        assert.deepEqual(errors(outside).map(({ severity, line }) => ({ severity, line })), [{ severity: "warning", line: 1 }], "one advisory says the tag opened nothing");
        assert.match(errors(outside)[0].message, /`ts` is not an operation or a known executor here/u);
        assert.deepEqual(statements(outside).map(({ op }) => op), ["TASK"]);
        const body = "````ts\nconst x = 1;\n````";
        const inside = parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.deepEqual(errors(inside), []);
        const ops = statements(inside);
        assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "TASK"]);
        assert.equal(ops[0].op === "EDIT" ? ops[0].body : null, body);
    });
}

test("{§bare-heading-advisory}: an operation heading outside any fence is prose with one warning naming the fence form", () => {
    for (const bare of ["READ (notes.md)", "TASK", "FIND (src/**) [{\"pattern\":\"/x/\"}]"]) {
        const result = PlurnkParser.parse("Prelude.\n" + bare + "\n" + task);
        assert.deepEqual(statements(result).map(({ op }) => op), ["TASK"], bare);
        const advisories = errors(result);
        assert.equal(advisories.length, 1, bare);
        assert.equal(advisories[0].severity, "warning");
        assert.match(advisories[0].message, /outside any fence, so it is prose and nothing ran; an operation opens with ````/u);
        assert.equal(advisories[0].line, 2);
    }
});

test("{§bare-heading-advisory}: headings inside bodies and inside blocks never draw the advisory", () => {
    const body = "READ (notes.md)\nTASK";
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND", body) + "\n" + task);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["SEND", "TASK"]);
});

test("{§interstitial-fence}: displaced headings inside an unlabeled fence are prose, and each draws the advisory once", () => {
    const source = unlabeled("KILL (worker:///notes.md)") + "\n" + task;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(statements(result).map(({ op }) => op), ["TASK"]);
    assert.deepEqual(errors(result).map(({ severity, line }) => ({ severity, line })), [{ severity: "warning", line: 2 }]);
});

test("{§interstitial-fence}: explicit SEND keeps its aside, target, and literal body", () => {
    const aside = "reply";
    const body = "````KILL (worker:///notes.md)````\n<!-- body comment -->";
    const source = `${PlurnkParser.frame(`SEND <!-- ${aside} -->`, body)}\n${task}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(errors(result), []);
    const ops = statements(result);
    assert.deepEqual(ops.map(({ op }) => op), ["SEND", "TASK"]);
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
        assert.ok(ops[0].op === "SEND" || ops[0].op === "EDIT" || ops[0].op === "EXEC");
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
