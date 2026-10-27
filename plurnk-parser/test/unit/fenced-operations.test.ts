import assert from "node:assert/strict";
import test, { describe } from "node:test";
import * as Contracts from "@plurnk/plurnk-contracts";
import { Validator, isExecution, writtenOp } from "@plurnk/plurnk-contracts";
import * as Parser from "../../src/index.ts";
import { PlurnkParser } from "../../src/index.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("fenced-operations", () => {
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

test("{§executor-discovery} fenced operations: empty single-line and multiline blocks have the same semantics", () => {
    const [inline, multiline] = statements("````READ (example.txt) <1,16>````\n````READ (example.txt) <1,16>\n````");
    assert.deepEqual({ ...inline, position: null }, { ...multiline, position: null });
    assert.equal(inline.op, "READ");
});

test("{§executor-discovery} fenced operations: executor and MCP names lower to the execution shape", () => {
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

test("{§executor-discovery} fenced operations: native keywords take precedence over executor names", () => {
    const [find, edit] = statements("````FIND (src/**) ~retry````\n````EDIT (example.txt) <@abcde>\napples\n````");
    assert.equal(find.op, "FIND");
    assert.equal(edit.op, "EDIT");
    if (edit.op !== "EDIT") return;
    assert.deepEqual(edit.lineMarker?.marks, ["@abcde"]);
    assert.equal(edit.body, "apples");
});

test("{§executor-discovery} fenced operations: inner programs and different-length fences remain exact literal body text", () => {
    const body = '## A heading\n```sh\necho hello\n```\n`````\n### EDIT_ (unchanged<1,2>)\n';
    const [edit] = statements(PlurnkParser.frame("EDIT (README.md) <1,-1>", body));
    assert.equal(edit.op, "EDIT");
    assert.equal(edit.body, body);
});

test("{§executor-discovery} fenced operations: shorter and longer runs stay literal for independently chosen fence counts", () => {
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

test("{§executor-discovery} fenced operations: a longer backtick run closes a heading or body; an unfinished slot still loses the boundary", () => {
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

test("{§executor-discovery} fenced operations: a longer run after an inline body closes the block and what follows is prose", () => {
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

test("{§executor-discovery} fenced operations: framing excludes only its own newlines, preserving CRLF and whitespace", () => {
    for (const body of ["a", " a ", "\na\n\n", "a\r\nb\r\n", "é 🦊\n  "]) {
        const [edit] = statements(`\`\`\`\`EDIT (example.txt) <1,-1>\r\n${body}\r\n\`\`\`\``);
        assert.equal(edit.op, "EDIT");
        if (edit.op !== "EDIT") return;
        assert.equal(edit.body, body);
    }
});

test("{§executor-discovery} fenced operations: transfer operands and opaque metadata keep their contracts", () => {
    const [copy, exec] = statements('````COPY (a) <@abcde> (b) <0>````\n````gitea (issue_list) [{"headers": {"x": "]"}}] <1,0.1> <!-- list issues -->\n{}\n````');
    assert.equal(copy.op, "COPY");
    assert.equal(isExecution(exec), true);
    if (copy.op !== "COPY" || !isExecution(exec)) return;
    assert.equal(copy.destination.target.raw, "b");
    assert.deepEqual(copy.destination.lineMarker?.marks, [0]);
    assert.deepEqual(exec.metadata, ['{"headers": {"x": "]"}}']);
    assert.equal(exec.aside, "list issues");
});

test("{§slot-order}: targetless SEND retains message metadata and an opaque body", () => {
    const [send] = statements('````SEND [{"attachments":["report.pdf"]}] <!-- report -->\nHere is the report.\n````');
    assert.equal(send.op, "SEND");
    if (send.op !== "SEND") return;
    assert.equal(send.target, null);
    assert.equal(send.lineMarker, null);
    assert.deepEqual(send.metadata, ['{"attachments":["report.pdf"]}']);
    assert.equal(send.body?.raw, "Here is the report.");
    assert.equal(send.aside, "report");
});

test("{§executor-discovery} fenced operations: an unfinished block ends at an inner executor heading; a closed one keeps it as body", () => {
    const unfinished = PlurnkParser.parse('````READ (safe.txt)````\n````EDIT (victim.txt)\n```sh\necho literal\n```');
    assert.equal(unfinished.unparsedTail, undefined);
    assert.deepEqual(unfinished.items.filter((item) => item.kind === "statement").map((item) => writtenOp(item.statement)), ["READ", "EDIT", "sh"]);
    const closed = PlurnkParser.parse('````READ (safe.txt)````\n````EDIT (victim.txt)\n```sh\necho literal\n```\n````');
    assert.deepEqual(closed.items.filter((item) => item.kind === "statement").map((item) => writtenOp(item.statement)), ["READ", "EDIT"]);
    const edit = closed.items.find((item) => item.kind === "statement" && item.statement.op === "EDIT");
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, "```sh\necho literal\n```");
});

test("{§executor-discovery} fenced operations: closed malformed blocks do not discard later valid operations", () => {
    const result = PlurnkParser.parse("````FIND (src/**) <~retry>\n````\n````READ (a.txt)````\n````NOTE\nInspect the results.\n````");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
    assert.deepEqual(result.items.filter((item) => item.kind === "statement").map((item) => item.statement.op), ["READ", "NOTE"]);
});

test("{§executor-discovery} fenced operations: a message may contain literal executable examples without dispatching them", () => {
    const result = PlurnkParser.parse("````SEND\nRun this yourself:\n```bash\necho hello\n```\n````\n````WAIT\n````");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.length, 2);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    assert.equal(item.statement.op, "SEND");
    if (item.statement.op !== "SEND") throw new Error("missing SEND");
    assert.equal(item.statement.body?.raw, 'Run this yourself:\n```bash\necho hello\n```');
});

test("{§executor-discovery} fenced operations: canonical serialization retains bodies, operands, and executor selection without suffix state", () => {
    const before = statements("````gitea (issue_list)\n{\"issue_id\":42}\n````\n````COPY (a) <@abcde> (b) <0>````\n````EDIT (README.md) <1,-1>\n```sh\necho hello\n```\n\n````");
    const rendered = PlurnkParser.stringify(before);
    const after = statements(rendered);
    const withoutPosition = (ops: typeof before) => ops.map((op) => ({ ...op, position: null }));
    assert.deepEqual(withoutPosition(after), withoutPosition(before));
    assert.ok(rendered.includes("````EDIT"));
});

test("{§executor-discovery} fenced operations: inherited JavaScript property names are ordinary executor names", () => {
    for (const name of ["constructor", "toString", "valueOf"]) {
        const [statement] = statements(`\`\`\`\`${name}\n{}\n\`\`\`\``);
        assert.equal(isExecution(statement), true);
        if (isExecution(statement)) assert.equal(statement.runtime, name.toLowerCase(), "the AST carries the canonical lowercase tag");
    }
});

test("{§executor-discovery} fenced operations: a closed malformed target or metadata stays local to its block", () => {
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
test("{§fence-pairing} fenced operations: a body line of any length above its closer pairs in one pass", () => {
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
});

describe("boundary", () => {
test("{§whitespace-contract} {§parser-build}: the parser package exports exactly the parser surface", () => {
    assert.deepEqual(Object.keys(Parser).toSorted(), ["PlurnkParser", "parsePath"]);
});

test("{§parser-build}: contracts exports no parser and depends on no parser runtime", () => {
    assert.equal("PlurnkParser" in Contracts, false, "PlurnkParser is not a contracts export");
    assert.equal("parsePath" in Contracts, false, "parsePath is not a contracts export");
    const manifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/package.json")), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    for (const runtime of ["antlr4ng", "xpath", "json-p3"]) {
        assert.equal(Object.hasOwn(manifest.dependencies ?? {}, runtime), false, `${runtime} is not a contracts dependency`);
    }
    assert.equal(Object.hasOwn(manifest.devDependencies ?? {}, "antlr-ng"), false, "the grammar compiler left contracts too");
});
});

describe("heading-tail", () => {
const parse = (input: string) => PlurnkParser.parseStatements(input, { executors: ["sh", "python3"] });
const ops = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? ["runtime" in item.statement ? item.statement.runtime : item.statement.op] : []);
const errors = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" ? [`${item.error.line}:${item.error.column} ${item.error.message}`] : []);
const recorded = (prefix: string) => {
    const dir = new URL("../fixtures/recorded/", import.meta.url);
    const name = readdirSync(dir).find((entry) => entry.startsWith(prefix));
    assert.ok(name, `a recorded fixture named ${prefix}*`);
    return readFileSync(new URL(name, dir), "utf8");
};
const STRAY = "1:7 unrecognized character '`' in operation header - expected `(path)`, `<scope>`, `[metadata]`, a line ending, or the closing fence";

test("{§operation-fences}: a known name followed directly by a backtick is a heading in error, and the operation after it still runs (#996)", () => {
    const input = "```NOTE`\nbody\n```\n```READ (x.txt)\n```\n";
    assert.deepEqual(errors(input), [STRAY]);
    assert.deepEqual(ops(input), ["READ"]);
});

test("{§fence-pairing}: every heading line the lexer opens, the pairing pairs — a closer at the name, a word after it, stray backticks, an executor (#996)", () => {
    for (const heading of ["```NOTE``` hello", "```READ``` takes a scope", "```READ`x`", "```sh`"]) {
        const input = `${heading}\nbody\n\`\`\`\n`;
        assert.doesNotThrow(() => parse(input), heading);
        assert.equal(parse(input).unparsedTail, undefined, heading);
    }
});

test("{§op-shapes}: the same heading in a reasoning emission is read, not thrown (#996)", () => {
    assert.doesNotThrow(() => PlurnkParser.parseReasoningOperations("```NOTE`\nbody\n```\n"));
});

test("{§operation-fences}: deepseek-flash's NOTE with a backtick glued to its name, as recorded on the 16k rung of #995 (#996)", () => {
    const input = recorded("deep16-run341-3cdd88d7-1-12");
    assert.deepEqual(errors(input), [STRAY]);
    assert.deepEqual(ops(input), ["KILL", "KILL"]);
});
});

describe("kill-distillation", () => {
const statements = (source: string) => PlurnkParser.parse(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const advisories = (source: string) => PlurnkParser.parse(source).items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);

test("{§log-kill-scope} a log KILL keeps its body as the distillation of what it retires", () => {
    const source = "```KILL (log:///1/[1-7]/*/{NOTE,READ}) <!-- retires the rows; the body stays as a NOTE -->\nwcs.py: _array_converter short-circuits empty input; fix the return path.\n```\n";
    const [kill] = statements(source);
    assert.equal(kill?.op, "KILL");
    if (kill?.op !== "KILL") return;
    assert.equal(kill.target?.kind === "url" ? kill.target.scheme : null, "log");
    assert.equal(kill.body, "wcs.py: _array_converter short-circuits empty input; fix the return path.");
    assert.equal(kill.aside, "retires the rows; the body stays as a NOTE");
    assert.equal(kill.matcher, null, "a distillation is never read as a matcher");
    assert.deepEqual(advisories(source), [], "no advisory: the body is admitted");
});

test("{§log-kill-scope} a scoped log KILL keeps its scope and its distillation", () => {
    const [kill] = statements("```KILL (log:///1/[8-9]/*/READ) <17,-1> <!-- keeps lines 1–16 of each -->\nLines 17+ were the unrelated fixtures.\n```\n");
    assert.equal(kill?.op, "KILL");
    if (kill?.op !== "KILL") return;
    assert.deepEqual(kill.lineMarker, { marks: [17, -1] });
    assert.equal(kill.body, "Lines 17+ were the unrelated fixtures.");
});

test("{§log-kill-scope} a naked pattern and a distillation ride one log KILL", () => {
    const [withPattern] = statements("```KILL (log:///1/**) ~stale\nThe stale reads said nothing new.\n```\n");
    assert.equal(withPattern?.op, "KILL");
    if (withPattern?.op !== "KILL") return;
    assert.equal(withPattern.matcher?.raw, "~stale");
    assert.equal(withPattern.body, "The stale reads said nothing new.");
    const [inline] = statements("```KILL (log:///1/**) ~stale\n```\n");
    assert.equal(inline?.op === "KILL" ? inline.matcher?.raw : null, "~stale", "a sigil on the heading line is the matcher");
    assert.equal(inline?.op === "KILL" ? inline.body : "?", null);
});

test("{§op-shapes} {§log-kill-scope} a bodyless KILL's advisory names only that invocation", () => {
    for (const heading of ["KILL (sh:///ab3d5678)", "KILL (notes.md)", "KILL (notes.md) <1>"]) {
        const source = PlurnkParser.frame(heading, "stop it");
        const [kill] = statements(source);
        assert.equal(kill?.op === "KILL" ? kill.body : "?", null, heading);
        assert.deepEqual(advisories(source), ["This KILL takes no body; line 2 was not used."], heading);
    }
    for (const heading of ["KILL (log:///1/2/3)", "KILL (log://alice/1/2/3)"]) {
        const source = PlurnkParser.frame(heading, "Retained information.");
        const [kill] = statements(source);
        assert.equal(kill?.op === "KILL" ? kill.body : "?", "Retained information.", heading);
        assert.deepEqual(advisories(source), [], heading);
    }
});
});
