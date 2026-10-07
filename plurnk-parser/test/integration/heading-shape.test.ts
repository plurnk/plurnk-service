import assert from "node:assert/strict";
import test from "node:test";
import { writtenOp } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

for (const path of ["notes.md", "log:///1/2/3", "log://worker/1/2/3"]) {
    for (const heading of [
        `KILL (${path}) <1>`, `KILL <1> (${path})`, `KILL → ${path} <1>`,
        `KILL (${path}<1>)`, `KILL (${path}) <!-- selected --> <1>`,
    ]) {
        test(`{§fence-pairing}: ${heading} is targeted with or without its closer`, () => {
            for (const width of [3, 4, 7]) {
                for (const newline of ["\n", "\r\n"]) {
                    for (const closed of [false, true]) {
                        const fence = "`".repeat(width);
                        const lines = [`${fence}${heading}`, ...(closed ? [fence] : []), `${fence}READ (after.md)`, fence];
                        const result = PlurnkParser.parse(lines.join(newline));
                        const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
                        const label = JSON.stringify({ heading, width, newline, closed });
                        assert.deepEqual(operations.map(writtenOp), ["KILL", "READ"], label);
                        assert.ok(operations[0].op === "KILL");
                        assert.ok(operations[1].op === "READ");
                        assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], label);
                        assert.equal(result.unparsedTail, undefined, label);
                        assert.equal(operations[0].target?.raw, path, label);
                        assert.deepEqual(operations[0].lineMarker, { marks: [1] }, label);
                        assert.equal(operations[0].body, null, label);
                        assert.equal(operations[1].target?.raw, "after.md", label);
                        assert.equal(operations[1].position.line, closed ? 3 : 2, label);
                    }
                }
            }
        });
    }
}

test("{§log-kill-distillation}: every accepted heading preserves the exact distillation and the following operation", () => {
    for (const path of ["log:///1/2/3", "log://worker/1/2/3"]) {
        for (const heading of [`KILL (${path}) <1>`, `KILL <1> (${path})`, `KILL → ${path} <1>`]) {
            const body = "Retained fact: 42.\n\nEvidence 🐜 stays here.";
            const result = PlurnkParser.parse(`\`\`\`${heading}\n${body}\n\`\`\`\n\`\`\`READ (after.md)\n\`\`\``);
            const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(operations.map(writtenOp), ["KILL", "READ"], heading);
            assert.ok(operations[0].op === "KILL");
            assert.equal(operations[0].body, body, heading);
            assert.equal(operations[0].target?.raw, path, heading);
            assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], heading);
        }
    }
});

test("{§heading-boundary-recovery}: a refused heading still leaves its sibling executable", () => {
    const result = PlurnkParser.parse("```KILL (http://[invalid) <1>\n```READ (after.md)\n```");
    const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(operations.map(writtenOp), ["READ"]);
    const errors = result.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error] : []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "invalid URI in path");
});

test("{§terminal-kill}: a parameterless KILL keeps operation examples literal", () => {
    const body = "Example:\n```READ (example.md)\n```\nThe answer continues.";
    for (const heading of ["KILL", "KILL <!-- final -->"]) {
        const result = PlurnkParser.parse(`\`\`\`${heading}\n${body}`);
        const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(operations.map(writtenOp), ["KILL"]);
        assert.ok(operations[0].op === "KILL");
        assert.equal(operations[0].body, body);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    }
});

for (const op of ["COPY", "MOVE"]) {
    test(`{§parse-recovery}: ${op} does not suggest a body as an alternative to an extra operand`, () => {
        const result = PlurnkParser.parse(`\`\`\`${op} (a) (b) (c)\n\`\`\`\n\`\`\`READ (after.md)\n\`\`\``);
        const errors = result.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error] : []);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].message, "unexpected `(` (`(path)` slot opener); expected operation fence header, operation-heading line ending, or closing fence");
        assert.match(errors[0].recovery ?? "", new RegExp(`${op} takes no body`));
        assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["READ"]);
    });
}

test("{§send-directed-scope}: an arrow target is a recipient before scope admission", () => {
    const result = PlurnkParser.parse("```SEND → sh:///abcd <10>\ninput\n```\n```READ (after.md)\n```");
    const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(operations.map(writtenOp), ["SEND", "READ"]);
    const send = operations[0];
    assert.ok(send.op === "SEND");
    assert.equal(send.target?.raw, "sh:///abcd");
    assert.deepEqual(send.lineMarker, { marks: [10] });
    assert.equal(send.body?.raw, "input");
    const warnings = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, "warning");
    assert.equal(
        warnings[0].message,
        "`→ sh:///abcd` is how the log shows an address; it was read as the target. Write the target in parentheses: `SEND (sh:///abcd) <10>`.",
    );
});
