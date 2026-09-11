import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, Validator } from "../../src/index.ts";

const statements = (source: string) => {
    const result = PlurnkParser.parseStatements(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    return result.items.map((item) => {
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("expected statement");
        assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
        assert.equal("delimiter" in item.statement, false);
        return item.statement;
    });
};

test("fenced operations: empty single-line and multiline blocks have the same semantics", () => {
    const [inline, multiline] = statements("```READ (example.txt) <1,16>```\n```READ (example.txt) <1,16>\n```");
    assert.deepEqual({ ...inline, position: null }, { ...multiline, position: null });
    assert.equal(inline.op, "READ");
});

test("fenced operations: executor and MCP names lower to the existing EXEC shape", () => {
    const [shell, mcp] = statements('```bash\necho "Hello world";\n```\n```gitea (issue_list)\n{"issue_id":42}\n```');
    assert.equal(shell.op, "EXEC");
    assert.equal(mcp.op, "EXEC");
    if (shell.op !== "EXEC" || mcp.op !== "EXEC") return;
    assert.equal(shell.executor, "bash");
    assert.equal(shell.body, 'echo "Hello world";');
    assert.equal(mcp.executor, "gitea");
    assert.equal(mcp.target?.raw, "issue_list");
    assert.equal(mcp.body, '{"issue_id":42}');
});

test("fenced operations: native keywords take precedence over executor names", () => {
    const [find, edit] = statements("```FIND (src/**)\n~retry\n```\n```EDIT (example.txt) <@abcde>\napples\n```");
    assert.equal(find.op, "FIND");
    assert.equal(edit.op, "EDIT");
    if (edit.op !== "EDIT") return;
    assert.deepEqual(edit.lineMarker?.marks, ["@abcde"]);
    assert.equal(edit.body, "apples");
});

test("fenced operations: inner programs and different-length fences remain exact literal body text", () => {
    const body = '## A heading\n```sh\necho hello\n```\n`````\n### EDIT_ (unchanged<1,2>)\n';
    const [edit] = statements(`\`\`\`\`EDIT (README.md) <1,-1>\n${body}\n\`\`\`\``);
    assert.equal(edit.op, "EDIT");
    assert.equal(edit.body, body);
});

test("fenced operations: shorter and longer runs stay literal for independently chosen fence counts", () => {
    for (const count of [3, 4, 5, 8, 16, 33]) {
        const fence = "`".repeat(count);
        for (const newline of ["\n", "\r\n"]) {
            const body = [1, 2, 3, 4, 5, 8, 16, 33, 64]
                .filter((inner) => inner !== count)
                .flatMap((inner) => ["`".repeat(inner) + "sh", "echo literal", "`".repeat(inner)])
                .concat(fence + "not-a-closer", "a same-width named example", fence)
                .join(newline);
            const [edit] = statements(`${fence}EDIT (notes.md)${newline}${body}${newline}${fence}\t `);
            assert.equal(edit.op, "EDIT");
            assert.equal(edit.body, body, `fence count ${count}`);
        }
    }
});

test("fenced operations: a longer backtick run cannot supply a closing-fence suffix in any lexer mode", () => {
    for (const count of [3, 4, 7]) {
        const fence = "`".repeat(count);
        for (const extra of [1, 4]) {
            const longer = "`".repeat(count + extra);
            for (const header of ["READ (notes.md)", "READ (notes.md", "sh [broken", "EDIT (notes.md) text", "EDIT (notes.md)\ntext\n"]) {
                const source = `${fence}${header}${longer}`;
                const result = PlurnkParser.parseStatements(source);
                assert.deepEqual(result.unparsedTail?.from, { line: 1, column: 0 }, source);
                assert.deepEqual(result.items.filter((item) => item.kind === "statement"), [], source);
            }
        }
    }
});

test("fenced operations: inline-body recovery preserves a longer run until the exact closing fence", () => {
    const result = PlurnkParser.parseStatements("```EDIT (notes.md) text````\ncontinued\n```");
    assert.equal(result.unparsedTail, undefined);
    const admitted = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].op, "EDIT");
    assert.equal(admitted[0].body, "text````\ncontinued");
    const diagnostics = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "warning");
    assert.match(diagnostics[0].message, /body text was on the OP line/);
});

test("fenced operations: framing excludes only its own newlines, preserving CRLF and whitespace", () => {
    for (const body of ["a", " a ", "\na\n\n", "a\r\nb\r\n", "é 🦊\n  "]) {
        const [edit] = statements(`\`\`\`EDIT (example.txt) <1,-1>\r\n${body}\r\n\`\`\``);
        assert.equal(edit.op, "EDIT");
        if (edit.op !== "EDIT") return;
        assert.equal(edit.body, body);
    }
});

test("fenced operations: transfer operands and opaque metadata keep their contracts", () => {
    const [copy, exec] = statements('```COPY (a) <@abcde> (b) <0>```\n```gitea (issue_list) [{"headers": {"x": "]"}}] <1,0.1> <!-- list issues -->\n{}\n```');
    assert.equal(copy.op, "COPY");
    assert.equal(exec.op, "EXEC");
    if (copy.op !== "COPY" || exec.op !== "EXEC") return;
    assert.equal(copy.destination.target.raw, "b");
    assert.deepEqual(copy.destination.lineMarker?.marks, [0]);
    assert.deepEqual(exec.metadata, ['{"headers": {"x": "]"}}']);
    assert.equal(exec.annotation, "list issues");
});

test("fenced operations: an unfinished block never admits its contents as an executable statement", () => {
    const result = PlurnkParser.parse('```READ (safe.txt)```\n````EDIT (victim.txt)\n```sh\necho not-an-operation\n```');
    assert.equal(result.unparsedTail?.from.line, 2);
    assert.match(result.unparsedTail?.reason ?? "", /4 backticks/);
    assert.deepEqual(result.items.filter((item) => item.kind === "statement").map((item) => item.statement.op), ["READ"]);
});

test("fenced operations: closed malformed blocks do not discard later valid operations", () => {
    const result = PlurnkParser.parse("```FIND (src/**) <~retry>\n```\n```READ (a.txt)```\n```TASK\n[{\"content\":\"Inspect the results.\",\"status\":\"in_progress\"}]\n```");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
    assert.deepEqual(result.items.filter((item) => item.kind === "statement").map((item) => item.statement.op), ["READ", "TASK"]);
});

test("fenced operations: a message may contain literal executable examples without dispatching them", () => {
    const result = PlurnkParser.parse("````SEND\nRun this yourself:\n```bash\necho hello\n```\n````\n````TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n````");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.length, 2);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    assert.equal(item.statement.op, "SEND");
    if (item.statement.op !== "SEND") throw new Error("missing SEND");
    assert.equal(item.statement.body?.raw, 'Run this yourself:\n```bash\necho hello\n```');
});

test("fenced operations: canonical serialization retains bodies, operands, and executor selection without suffix state", () => {
    const before = statements("```gitea (issue_list)\n{\"issue_id\":42}\n```\n```COPY (a) <@abcde> (b) <0>```\n````EDIT (README.md) <1,-1>\n```sh\necho hello\n```\n\n````");
    const rendered = PlurnkParser.stringify(before);
    const after = statements(rendered);
    const withoutPosition = (ops: typeof before) => ops.map((op) => ({ ...op, position: null }));
    assert.deepEqual(withoutPosition(after), withoutPosition(before));
    assert.ok(rendered.includes("````EDIT"));
});

test("fenced operations: inherited JavaScript property names are ordinary executor names", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
        const [statement] = statements(`\`\`\`${name}\n{}\n\`\`\``);
        assert.equal(statement.op, "EXEC");
        if (statement.op === "EXEC") assert.equal(statement.executor, name);
    }
});

test("fenced operations: a closed malformed target or metadata stays local to its block", () => {
    for (const header of ["READ (broken", 'sh [{"cwd": "broken"', "READ (a) <oops>"]) {
        const result = PlurnkParser.parseStatements(header.startsWith("sh")
            ? `\`\`\`${header}\`\`\`\n\`\`\`READ (safe.md)\`\`\``
            : `\`\`\`${header}\n\`\`\`\n\`\`\`READ (safe.md)\`\`\``);
        assert.equal(result.unparsedTail, undefined, header);
        assert.ok(result.items.some((item) => item.kind === "error"), header);
        const admitted = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(admitted.map((statement) => "target" in statement ? statement.target?.raw : undefined), ["safe.md"], header);
    }
});
