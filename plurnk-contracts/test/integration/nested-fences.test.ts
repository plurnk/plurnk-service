import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ClientStatement, type ParseResult } from "../../src/index.ts";

const task = PlurnkParser.frame("TASK", '[{"content":"Reported the result.","status":"completed"}]');
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const bodyText = (op: ClientStatement) => "body" in op && typeof op.body === "object" && op.body !== null && "raw" in op.body ? op.body.raw : "body" in op ? op.body : null;

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseLog],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§fence-boundary}: ${name} retains a complete report and its TASK without admitting quoted operations`, () => {
        const body = [
            "The process reversed the supplied bytes.",
            "````node {stdin=open}",
            'process.stdin.on("data", value => process.stdout.write(value));',
            "````",
            "The input was delivered with:",
            "````SEND (node:///ab3d5678) {eof=true}",
            "oranges",
            "````",
            "Observed stdout: segnaro. No further input is needed.",
        ].join("\n");
        const result = parse(`\`\`\`\`SEND\n${body}\n\`\`\`\`\n\n${task}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.deepEqual(ops.map(({ op }) => op), ["SEND", "TASK"]);
        assert.ok(ops[0].op === "SEND");
        assert.equal(ops[0].target, null);
        assert.equal(bodyText(ops[0]), body);
        assert.deepEqual(bodyText(ops[1]), [{ content: "Reported the result.", status: "completed" }]);
    });
}

test("{§fence-boundary}: nesting preserves exact bodies across widths, depths, newlines, and operation families", () => {
    for (const header of ["SEND", "EDIT (notes.md)", "sh", "BARE", "WORK", "FORK"]) {
        for (const width of [3, 4, 8]) {
            for (const depth of [1, 2, 8]) {
                for (const newline of ["\n", "\r\n"]) {
                    const fence = "`".repeat(width);
                    const body = [
                        `${fence}KILL (notes.md)${fence}`,
                        ...Array.from({ length: depth }, (_, index) => `${fence}unknown${index} {not valid metadata`),
                        "literal 🙂 content",
                        ...Array.from({ length: depth }, () => `${fence}\t `),
                        "  trailing content  ",
                        "",
                    ].join(newline);
                    const result = PlurnkParser.parse(`${fence}${header}${newline}${body}${newline}${fence}\n${task}`);
                    const context = `${header}, width=${width}, depth=${depth}, newline=${JSON.stringify(newline)}`;
                    assert.equal(result.unparsedTail, undefined, context);
                    assert.deepEqual(errors(result), [], context);
                    const ops = statements(result);
                    assert.deepEqual(ops.map(({ op }) => op), [header === "sh" ? "EXEC" : header.split(" ")[0], "TASK"], context);
                    assert.equal(bodyText(ops[0]), body, context);
                }
            }
        }
    }
});

test("{§fence-boundary}: shell heredoc Markdown and complete inline examples are not additional operations", () => {
    const body = "cat <<'EOF'\n````json\n{\"ok\":true}\n````\n````READ (notes.md)````\nEOF";
    const result = PlurnkParser.parse(`\`\`\`\`sh\n${body}\n\`\`\`\`\n${task}`);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["EXEC", "TASK"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§statement-rendering}: a wider canonical wrapper preserves arbitrary unfinished and unlabeled examples", () => {
    for (const body of ["````sh\nunfinished", "````not a closer", "````\nunlabeled\n````", "````js\n````sh\nunfinished twice"]) {
        const result = PlurnkParser.parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        assert.deepEqual(statements(result).map(({ op }) => op), ["EDIT", "TASK"]);
        assert.equal(bodyText(statements(result)[0]), body);
    }
});

test("{§unparsed-tail-boundary}: a nested closer cannot substitute for the missing outer closer", () => {
    const source = "````READ (safe.md)````\n````EDIT (notes.md)\n````sh\nnot executable\n````\n````TASK\n[]\n````";
    const result = PlurnkParser.parseStatements(source);
    assert.deepEqual(statements(result).map(({ op }) => op), ["READ"]);
    assert.deepEqual(result.unparsedTail, { from: { line: 2, column: 0 }, reason: "EDIT block opened at line 2 but was not closed with 4 backticks" });
    assert.deepEqual(errors(result), []);
});

test("{§fence-boundary}: a trailing longer run does not turn an inner opener into an inline block", () => {
    const body = "````sh example`````\nstill literal\n````\nend";
    const result = PlurnkParser.parse(`\`\`\`\`SEND\n${body}\n\`\`\`\`\n${task}`);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result), []);
    assert.equal(bodyText(statements(result)[0]), body);
});
