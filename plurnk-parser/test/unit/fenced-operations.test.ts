import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { Validator, isExecution, writtenOp } from "@plurnk/plurnk-contracts";

// Registered tags are lowercase ({§executor-runtime-declaration}); the fence may spell them in any case.
const EXECUTORS = ["sh", "bash", "js", "gitea", "constructor", "tostring", "valueof"];
const statements = (source: string) => {
    const result = PlurnkParser.parseStatements(source, { executors: EXECUTORS });
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

test("{§executor-runtime-declaration} fenced operations: empty single-line and multiline blocks have the same semantics", () => {
    const [inline, multiline] = statements("````READ (example.txt) <1,16>````\n````READ (example.txt) <1,16>\n````");
    assert.deepEqual({ ...inline, position: null }, { ...multiline, position: null });
    assert.equal(inline.op, "READ");
});

test("{§executor-runtime-declaration} fenced operations: executor and MCP names lower to the execution shape", () => {
    const [shell, mcp] = statements('````bash\necho "Hello world";\n````\n````gitea (issue_list)\n{"issue_id":42}\n````');
    assert.equal(isExecution(shell), true);
    assert.equal(isExecution(mcp), true);
    if (!isExecution(shell) || !isExecution(mcp)) return;
    assert.equal(shell.runtime, "bash");
    assert.equal(shell.body, 'echo "Hello world";');
    assert.equal(mcp.runtime, "gitea");
    assert.equal(mcp.target?.raw, "issue_list");
    assert.equal(mcp.body, '{"issue_id":42}');
});

test("{§executor-runtime-declaration} fenced operations: native keywords take precedence over executor names", () => {
    const [find, edit] = statements('````FIND (src/**) [{"pattern": "~retry"}]````\n````EDIT (example.txt) <@abcde>\napples\n````');
    assert.equal(find.op, "FIND");
    assert.equal(edit.op, "EDIT");
    if (edit.op !== "EDIT") return;
    assert.deepEqual(edit.lineMarker?.marks, ["@abcde"]);
    assert.equal(edit.body, "apples");
});

test("{§executor-runtime-declaration} fenced operations: inner programs and different-length fences remain exact literal body text", () => {
    const body = '## A heading\n```sh\necho hello\n```\n`````\n### EDIT_ (unchanged<1,2>)\n';
    const [edit] = statements(PlurnkParser.frame("EDIT (README.md) <1,-1>", body));
    assert.equal(edit.op, "EDIT");
    assert.equal(edit.body, body);
});

test("{§executor-runtime-declaration} fenced operations: shorter and longer runs stay literal for independently chosen fence counts", () => {
    for (const count of [4, 5, 8, 16, 33]) {
        const fence = "`".repeat(count);
        for (const newline of ["\n", "\r\n"]) {
            const body = [1, 2, 3, 4, 5, 8, 16, 33, 64]
                .flatMap((inner) => inner === count ? [] : ["`".repeat(inner) + "sh", "echo literal", "`".repeat(inner)])
                .concat(fence + "not-a-closer", "a same-width named example", fence)
                .join(newline);
            const [edit] = statements(`${fence}EDIT (notes.md)${newline}${body}${newline}${fence}\t `);
            assert.equal(edit.op, "EDIT");
            assert.equal(edit.body, body, `fence count ${count}`);
        }
    }
});

test("{§executor-runtime-declaration} fenced operations: a longer backtick run closes a heading or body; an unfinished slot still loses the boundary", () => {
    for (const count of [4, 5, 7]) {
        const fence = "`".repeat(count);
        for (const extra of [1, 4]) {
            const longer = "`".repeat(count + extra);
            const closed = PlurnkParser.parseStatements(`${fence}READ (notes.md)${longer}`, { executors: EXECUTORS });
            assert.equal(closed.unparsedTail, undefined);
            assert.deepEqual(closed.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ"]);
            for (const header of ["READ (notes.md", "sh [broken"]) {
                // The longer run closes the heading; the unfinished slot is one bounded error.
                const result = PlurnkParser.parseStatements(`${fence}${header}${longer}`, { executors: EXECUTORS });
                assert.equal(result.unparsedTail, undefined, header);
                assert.deepEqual(result.items.filter((item) => item.kind === "statement"), [], header);
                assert.equal(result.items.filter((item) => item.kind === "error" && item.error.severity === "error").length, 1, header);
            }
            const inline = PlurnkParser.parseStatements(`${fence}EDIT (notes.md) text${longer}`, { executors: EXECUTORS });
            assert.equal(inline.items.some((item) => item.kind === "statement" && item.statement.op === "EDIT" && item.statement.body === "text"), true);
            const below = PlurnkParser.parseStatements(`${fence}EDIT (notes.md)\ntext\n${longer}`, { executors: EXECUTORS });
            assert.equal(below.items.some((item) => item.kind === "statement" && item.statement.op === "EDIT" && item.statement.body === "text"), true);
        }
    }
});

test("{§executor-runtime-declaration} fenced operations: a longer run after an inline body closes the block and what follows is prose", () => {
    const result = PlurnkParser.parseStatements("````EDIT (notes.md) text`````\ncontinued\n````");
    assert.equal(result.unparsedTail, undefined);
    const admitted = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].op, "EDIT");
    assert.equal(admitted[0].body, "text");
    const diagnostics = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, "warning");
    assert.match(diagnostics[0].message, /body text was on the OP line/);
});

test("{§executor-runtime-declaration} fenced operations: framing excludes only its own newlines, preserving CRLF and whitespace", () => {
    for (const body of ["a", " a ", "\na\n\n", "a\r\nb\r\n", "é 🦊\n  "]) {
        const [edit] = statements(`\`\`\`\`EDIT (example.txt) <1,-1>\r\n${body}\r\n\`\`\`\``);
        assert.equal(edit.op, "EDIT");
        if (edit.op !== "EDIT") return;
        assert.equal(edit.body, body);
    }
});

test("{§executor-runtime-declaration} fenced operations: transfer operands and opaque metadata keep their contracts", () => {
    const [copy, exec] = statements('````COPY (a) <@abcde> (b) <0>````\n````gitea (issue_list) [{"headers": {"x": "]"}}] <1,0.1> <!-- list issues -->\n{}\n````');
    assert.equal(copy.op, "COPY");
    assert.equal(isExecution(exec), true);
    if (copy.op !== "COPY" || !isExecution(exec)) return;
    assert.equal(copy.destination.target.raw, "b");
    assert.deepEqual(copy.destination.lineMarker?.marks, [0]);
    assert.deepEqual(exec.metadata, ['{"headers": {"x": "]"}}']);
    assert.equal(exec.aside, "list issues");
});

test("{§scheme-metadata-modifier}: targetless SEND retains message metadata and an opaque body", () => {
    const [send] = statements('````SEND [{"attachments":["report.pdf"]}] <!-- report -->\nHere is the report.\n````');
    assert.equal(send.op, "SEND");
    if (send.op !== "SEND") return;
    assert.equal(send.target, null);
    assert.equal(send.lineMarker, null);
    assert.deepEqual(send.metadata, ['{"attachments":["report.pdf"]}']);
    assert.equal(send.body?.raw, "Here is the report.");
    assert.equal(send.aside, "report");
});

test("{§executor-runtime-declaration} fenced operations: an unfinished block ends at an inner executor heading; a closed one keeps it as body", () => {
    const unfinished = PlurnkParser.parse('````READ (safe.txt)````\n````EDIT (victim.txt)\n```sh\necho literal\n```');
    assert.equal(unfinished.unparsedTail, undefined);
    assert.deepEqual(unfinished.items.filter((item) => item.kind === "statement").map((item) => writtenOp(item.statement)), ["READ", "EDIT", "sh"]);
    const closed = PlurnkParser.parse('````READ (safe.txt)````\n````EDIT (victim.txt)\n```sh\necho literal\n```\n````');
    assert.deepEqual(closed.items.filter((item) => item.kind === "statement").map((item) => writtenOp(item.statement)), ["READ", "EDIT"]);
    const edit = closed.items.find((item) => item.kind === "statement" && item.statement.op === "EDIT");
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, "```sh\necho literal\n```");
});

test("{§executor-runtime-declaration} fenced operations: closed malformed blocks do not discard later valid operations", () => {
    const result = PlurnkParser.parse("````FIND (src/**) <~retry>\n````\n````READ (a.txt)````\n````NOTE\nInspect the results.\n````");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
    assert.deepEqual(result.items.filter((item) => item.kind === "statement").map((item) => item.statement.op), ["READ", "NOTE"]);
});

test("{§executor-runtime-declaration} fenced operations: a message may contain literal executable examples without dispatching them", () => {
    const result = PlurnkParser.parse("````SEND\nRun this yourself:\n```bash\necho hello\n```\n````\n````WAIT\n````");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.length, 2);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    assert.equal(item.statement.op, "SEND");
    if (item.statement.op !== "SEND") throw new Error("missing SEND");
    assert.equal(item.statement.body?.raw, 'Run this yourself:\n```bash\necho hello\n```');
});

test("{§executor-runtime-declaration} fenced operations: canonical serialization retains bodies, operands, and executor selection without suffix state", () => {
    const before = statements("````gitea (issue_list)\n{\"issue_id\":42}\n````\n````COPY (a) <@abcde> (b) <0>````\n````EDIT (README.md) <1,-1>\n```sh\necho hello\n```\n\n````");
    const rendered = PlurnkParser.stringify(before);
    const after = statements(rendered);
    const withoutPosition = (ops: typeof before) => ops.map((op) => ({ ...op, position: null }));
    assert.deepEqual(withoutPosition(after), withoutPosition(before));
    assert.ok(rendered.includes("````EDIT"));
});

test("{§executor-runtime-declaration} fenced operations: inherited JavaScript property names are ordinary executor names", () => {
    for (const name of ["constructor", "toString", "valueOf"]) {
        const [statement] = statements(`\`\`\`\`${name}\n{}\n\`\`\`\``);
        assert.equal(isExecution(statement), true);
        if (isExecution(statement)) assert.equal(statement.runtime, name.toLowerCase(), "the AST carries the canonical lowercase tag");
    }
});

test("{§executor-runtime-declaration} fenced operations: a closed malformed target or metadata stays local to its block", () => {
    for (const header of ["READ (broken", 'sh [{"cwd": "broken"', "READ (a) <oops>"]) {
        const result = PlurnkParser.parseStatements(header.startsWith("sh")
            ? `\`\`\`\`${header}\`\`\`\`\n\`\`\`\`READ (safe.md)\`\`\`\``
            : `\`\`\`\`${header}\n\`\`\`\`\n\`\`\`\`READ (safe.md)\`\`\`\``);
        assert.equal(result.unparsedTail, undefined, header);
        assert.ok(result.items.some((item) => item.kind === "error"), header);
        const admitted = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(admitted.map((statement) => "target" in statement ? statement.target?.raw : undefined), ["safe.md"], header);
    }
});

// One long line above its closer pairs as the same words on short lines do: rescanning it from each character would not.
test("{§quotation} fenced operations: a body line of any length above its closer pairs in one pass", () => {
    const words = "the survey went on without a break ".repeat(9_000);
    const parsed = (body: string): number => {
        const started = performance.now();
        const item = PlurnkParser.parse(PlurnkParser.frame("NOTE", body)).items[0];
        const elapsed = performance.now() - started;
        assert.ok(item?.kind === "statement" && item.statement.op === "NOTE");
        assert.equal(item.statement.body, body);
        return elapsed;
    };
    const lines = parsed(words.replaceAll("break ", "break\n"));
    const line = parsed(words);
    assert.ok(line < 10 * lines, `one ${words.length}-character line took ${line.toFixed(0)} ms; the same words on short lines, ${lines.toFixed(0)} ms`);
});
