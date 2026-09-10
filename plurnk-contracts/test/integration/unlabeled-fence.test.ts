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
    test(`{§unlabeled-fence-send}: ${name} treats displaced headers as literal SEND content without warnings`, () => {
        const bodies = [
            "KILL (worker:///notes.md)",
            "SEND (worker://elsewhere/)\nDo not route this text.",
            'TASK\n[{"content":"Not a disposition.","status":"failed"}]',
            "sh\nexit 1",
            'gitea (delete_repo)\n{"id":42}',
            "LOOK (worker:///notes.md)",
            "<!-- literal, not annotation -->",
            "READ (broken target",
        ];
        const source = ["Do not execute these examples:", ...bodies.map((body) => unlabeled(body)), task].join("\n\n");
        const result = parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.deepEqual(ops.map(({ op }) => op), [...bodies.map(() => "SEND"), "TASK"]);
        for (const [index, body] of bodies.entries()) {
            const send = ops[index];
            assert.equal(send.op, "SEND");
            if (send.op !== "SEND") assert.fail("expected SEND");
            assert.equal(send.body?.raw, body);
            assert.equal(send.target, null);
            assert.equal(send.annotation, null);
            assert.equal(send.metadata, null);
            assert.equal(send.lineMarker, null);
        }
        assert.deepEqual(ops[0].position, { line: 3, column: 0 });
    });

    test(`{§unlabeled-fence-send}: ${name} preserves optional header annotations without promoting their text or body`, () => {
        const annotation = 'SEND (worker://elsewhere/) <1,-1> {key=value}; KILL is only text — 💬';
        const body = '```KILL (worker:///notes.md)```\n<!-- body comment -->\nTASK\n[]';
        for (const ticks of [3, 4, 8]) {
            for (const space of ["", " ", "\t"]) {
                for (const newline of ["\n", "\r\n"]) {
                    const fence = "`".repeat(ticks);
                    const suffix = `${space}<!-- ${annotation} -->${newline}${body}${newline}${fence}${newline}${task}`;
                    const implicit = parse(`${fence}${suffix}`);
                    const explicit = parse(`${fence}SEND${suffix}`);
                    assert.equal(implicit.unparsedTail, undefined);
                    assert.deepEqual(errors(implicit), []);
                    assert.deepEqual(implicit.items, explicit.items);
                    const ops = statements(implicit);
                    assert.deepEqual(ops.map(({ op }) => op), ["SEND", "TASK"]);
                    const send = ops[0];
                    assert.ok(send.op === "SEND");
                    assert.equal(send.annotation, annotation);
                    assert.equal(send.body?.raw, body);
                    assert.equal(send.target, null);
                    assert.equal(send.metadata, null);
                    assert.equal(send.lineMarker, null);
                }
            }
        }
    });
}

test("{§unlabeled-fence-send}: empty annotated replies use ordinary SEND closure and source coordinates", () => {
    for (const ending of ["````", "\n````", "\r\n````"]) {
        const result = PlurnkParser.parseStatements(`Prelude.\n\n\`\`\`\` <!-- reply -->${ending}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.equal(ops.length, 1);
        const send = ops[0];
        assert.ok(send.op === "SEND");
        assert.equal(send.annotation, "reply");
        assert.equal(send.body, null);
        assert.deepEqual(send.position, { line: 3, column: 0 });
    }
});

test("{§unlabeled-fence-send}: malformed annotations retain ordinary SEND diagnostics", () => {
    for (const header of ["<!-- not closed", "<!-- split\ncomment -->", "<!-- first --> <!-- second -->", "<!-- reply --> (worker://elsewhere/)"]) {
        const suffix = ` ${header}\nMessage.\n\`\`\`\`\n${task}`;
        const implicit = PlurnkParser.parseStatements(`\`\`\`\`${suffix}`);
        const explicit = PlurnkParser.parseStatements(`\`\`\`\`SEND${suffix}`);
        assert.ok(errors(explicit).length > 0, header);
        assert.deepEqual(errors(implicit).map(({ code, message }) => ({ code, message })), errors(explicit).map(({ code, message }) => ({ code, message })), header);
        assert.deepEqual(statements(implicit).map(({ op }) => op), ["TASK"], header);
    }
});

for (const [outer, inner] of [[4, 3], [3, 4], [8, 3], [8, 9]]) {
    test(`{§unlabeled-fence-send}: ${outer}-tick SEND protects ${inner}-tick executable examples`, () => {
        const nested = "`".repeat(inner);
        const body = `${nested}KILL (worker:///notes.md)${nested}\n${nested}sh\nexit 1\n${nested}`;
        const source = unlabeled(body, outer) + "\n" + PlurnkParser.frame("READ (worker:///notes.md)", null);
        const result = PlurnkParser.parseStatements(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.deepEqual(ops.map(({ op }) => op), ["SEND", "READ"]);
        assert.equal(ops[0].op === "SEND" ? ops[0].body?.raw : undefined, body);
    });
}

test("{§unlabeled-fence-send}: implicit and explicit SEND preserve the same literal body bytes", () => {
    for (const newline of ["\n", "\r\n"]) {
        for (const body of ["", "\n", "  indented 🙂\n\ntrailing \t", '{"answer":42}', "a\\nb", "<!-- example -->"]) {
            const source = `\`\`\`\` \t${newline}${body}${newline}\`\`\`\` \t`;
            const implicit = PlurnkParser.parseStatements(source);
            const explicit = PlurnkParser.parseStatements(`\`\`\`\`SEND${newline}${body}${newline}\`\`\`\``);
            assert.equal(implicit.unparsedTail, undefined);
            assert.deepEqual(implicit.items, explicit.items, JSON.stringify({ body, newline }));
            assert.deepEqual(errors(implicit), []);
            assert.equal(statements(implicit)[0]?.op, "SEND");
        }
    }
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

test("{§unparsed-tail-boundary}: unfinished unlabeled fences do not yield partial messages or inner operations", () => {
    for (const tail of ["````", "````\nKILL (worker:///notes.md)", "````\n```KILL (worker:///notes.md)```", "````\nbody\n`````", "````\nbody\n```", "````\nbody\n```` trailing text"]) {
        const source = PlurnkParser.frame("READ (worker:///notes.md)", null) + "\n" + tail;
        const result = PlurnkParser.parseStatements(source);
        assert.deepEqual(statements(result).map(({ op }) => op), ["READ"], tail);
        assert.deepEqual(errors(result), [], tail);
        assert.deepEqual(result.unparsedTail, {
            from: { line: 2, column: 0 },
            reason: "SEND block opened at line 2 but was not closed with 4 backticks",
        }, tail);
    }
});

test("{§unlabeled-fence-send}: named malformed headers are not messages", () => {
    const result = PlurnkParser.parse(PlurnkParser.frame("READ [+diff] (notes.md)", null) + "\n" + task);
    assert.deepEqual(statements(result).map(({ op }) => op), ["TASK"]);
    assert.deepEqual(errors(result).map(({ message }) => message), ["unexpected bracket modifier; the fence name selects the executor"]);
});

test("{§turn-shape}: an implicit SEND neither supplies TASK nor bypasses its final position", () => {
    const source = unlabeled("TASK\nThis is a literal example.");
    const missing = PlurnkParser.parse(source);
    assert.deepEqual(statements(missing).map(({ op }) => op), ["SEND", "TASK"]);
    assert.deepEqual(errors(missing).map(({ code }) => code), [PlurnkParser.MISSING_DISPOSITION]);
    const disposition = statements(missing)[1];
    assert.ok(disposition.op === "TASK");
    assert.deepEqual(disposition.body, []);
    const late = PlurnkParser.parse(task + "\n" + source);
    assert.deepEqual(statements(late).map(({ op }) => op), ["TASK"]);
    assert.deepEqual(errors(late).map(({ code }) => code), [PlurnkParser.OPERATIONS_AFTER_DISPOSITION]);
    assert.ok(errors(PlurnkParser.parseLog(source)).length > 0, "a saved turn still requires its disposition");
});
