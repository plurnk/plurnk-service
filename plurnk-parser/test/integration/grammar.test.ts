import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "../../src/PlurnkParser.ts";
import { parsePath } from "../../src/index.ts";
import { PlurnkParseError, Validator, isExecution, writtenOp, type ParseResult } from "@plurnk/plurnk-contracts";
import { readdirSync, readFileSync } from "node:fs";

describe("grammar", () => {
const EXECUTORS = ["sh", "bash", "js", "python3", "gitea", "brave", "search-api", "example", "plurnk", "crm", "c++"];
const section = (op: string, slots = "", body?: string): string => PlurnkParser.frame(op + slots, body ?? null);

const sections = (...values: string[]): string => values.join("\n\n");

const errorsOf = (input: string) =>
    PlurnkParser.parseStatements(input, { executors: EXECUTORS }).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

const oneStatement = (input: string) => {
    const result = PlurnkParser.parseStatements(input, { executors: EXECUTORS });
    // hard errors only — a tolerated form may carry a warning-severity advisory ({§slot-order})
    assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], input);
    assert.equal(result.unparsedTail, undefined, input);
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.equal(statements.length, 1, input);
    return statements[0].statement;
};

const firstError = (input: string): PlurnkParseError => {
    const error = errorsOf(input)[0];
    assert.ok(error, input);
    return error;
};

// {§matcher-prefix-claims} — a matcher the parser cannot read rides its admitted statement with its diagnostic.
const refusedMatcher = (input: string): { message: string; recovery: string } => {
    const statement = oneStatement(input);
    const matcher = statement.op === "COPY" || statement.op === "MOVE" ? statement.source.matcher : "matcher" in statement ? statement.matcher : null;
    if (matcher === null || matcher === undefined || matcher.dialect !== "unreadable") assert.fail(`${input} carries no refused matcher`);
    return { message: matcher.message, recovery: matcher.recovery };
};

// {§parse-recovery} {§parse-recovery}
test("{§operation-fences} PlurnkParseError keeps diagnostic text separate from structured context", () => {
    const error = new PlurnkParseError(3, 7, "lexer", "unrecognized character '-' in signal");
    assert.equal(error.message, "unrecognized character '-' in signal");
    assert.deepEqual(error.toJSON(), {
        line: 3,
        column: 7,
        source: "lexer",
        severity: "error",
        message: "unrecognized character '-' in signal",
    });
});

test("{§operation-fences} protocol operations parse as executable fences", () => {
    const cases: Array<[string, string, string | undefined]> = [
        ["WAIT", "", "inspect, act, report"],
        ["WAIT", " <5>", "[]"],
        ["FIND", " (workspace:///**) <1,20> @Paris*", undefined],
        ["READ", " (README.md)", undefined],
        ["EDIT", " (notes.md) <2>", "replacement"],
        ["COPY", " (notes.md) (archive.md) <0>", undefined],
        ["MOVE", " (notes.md) (archive.md)", undefined],
        ["KILL", " (log:///**) <@aB3dE> ~topic", undefined],
        ["KILL", " (log:///**) <17,-1>", undefined],
        ["SEND", " (session://child)", "progress"],
        ["sh", " (node/./) <60,5>", "console.log(1)"],
        ["BARE", "", "What is the capital of Germany?"],
        ["WORK", " (session://child)", "do the work"],
        ["FORK", " (session://child)", "recheck the work"],
        ["KILL", " (session://child)", undefined],
    ];

    for (const [op, slots, body] of cases) {
        const statement = oneStatement(section(op, slots, body));
        assert.equal(writtenOp(statement), op, op);
        assert.equal(Object.hasOwn(statement, "delimiter"), false, op);
    }
});

test("{§op-shapes}: directed SEND carries a numeric scope to its owner without changing its body or disposition", () => {
    for (const [scope, components] of [["<60>", [60]], ["<0,60>", [0, 60]]] as const) {
        const statement = oneStatement(section("SEND", ` (sink://receiver) ${scope} <!-- recipient options -->`, "Check for updates."));
        assert.equal(statement.op, "SEND");
        if (statement.op !== "SEND") return;
        assert.equal(Object.hasOwn(statement, "status"), false);
        assert.deepEqual(statement.lineMarker?.marks, components);
        assert.equal(statement.aside, "recipient options");
        assert.deepEqual(statement.body, { raw: "Check for updates.", json: null });
    }
    assert.ok(errorsOf(section("SEND", " <0,60>", "No recipient.")).length > 0);
});

test("{§operation-fences} trailing operation asides are durable, single-line, and follow every modifier", () => {
    const statement = oneStatement([
        "````gitea (list_issues) <!-- Lists issues (details: workspace:///_plurnk/tools/gitea/list_issues.json) -->",
        "{\"owner\":\"plurnk\",\"repo\":\"plurnk-service\"}",
        "````",
    ].join("\n"));
    assert.equal(
        statement.aside,
        "Lists issues (details: workspace:///_plurnk/tools/gitea/list_issues.json)",
    );
    assert.equal(oneStatement("````READ (README.md)````").aside, null);
    assert.equal(oneStatement("````READ (README.md) <!-- -->````").aside, "");

    for (const input of [
        "````sh <!-- Lists issues --> [gitea] (list_issues)\n{}\n````",
        "````gitea (list_issues) <!-- Lists\nissues\n-->\n{}\n````",
        "````gitea (list_issues) <!-- Lists issues\n{}````",
    ]) {
        assert.ok(errorsOf(input).length > 0 || PlurnkParser.parseStatements(input).unparsedTail !== undefined, input);
    }
});

test("{§operation-fences} balanced parentheses are ordinary target content", () => {
    const statement = oneStatement(section(
        "FIND",
        " (https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)) /spouse|wife|married|Zhannetta|Lotnik/i",
    ));
    if (statement.op !== "FIND") assert.fail("expected FIND");
    assert.equal(statement.target?.raw, "https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)");
    assert.equal(statement.matcher?.dialect, "regex");
});

test("{§operation-fences} unmatched target parentheses require escaped or percent-encoded spelling", () => {
    assert.ok(errorsOf("````READ (https://example.test/a)b)````").length > 0);

    const unclosed = PlurnkParser.parseStatements("````READ (https://example.test/a(b");
    assert.equal(unclosed.items.length, 0);
    assert.match(unclosed.unparsedTail?.reason ?? "", /target slot of `READ`.*add `\)`/);

    for (const encoded of ["a%28b", "a%29b"]) {
        assert.equal(oneStatement(section("READ", ` (https://example.test/${encoded})`)).op, "READ");
    }
});

test("{§operation-fences} an unfinished metadata modifier names only its structural repair", () => {
    const secret = "Bearer secret-that-must-not-echo";
    const parsed = PlurnkParser.parseStatements(
        `\`\`\`\`READ (https://example.test/data) [{"Authorization": "${secret}"`,
    );
    assert.equal(parsed.items.length, 0);
    assert.equal(
        parsed.unparsedTail?.reason,
        "metadata modifier of `READ` opened at line 1 but never closed - add `]`",
    );
    assert.equal(parsed.unparsedTail?.reason.includes(secret), false);
});

test("{§operation-fences} target escapes preserve literal and percent-encoded URI spelling", () => {
    const statement = oneStatement(("````READ (https://example.test/x?literal=\\)&encoded=%29#preview\\()````"));
    if (statement.op !== "READ") assert.fail("expected READ");
    assert.equal(statement.target?.raw, "https://example.test/x?literal=)&encoded=%29#preview(");
    if (statement.target?.kind !== "url") assert.fail("expected URL target");
    assert.equal(statement.target.query, "literal=)&encoded=%29");
    assert.equal(statement.target.fragment, "preview(");
});

test("{§operation-fences} COPY and MOVE destinations use the target escape layer", () => {
    const statement = oneStatement(("````COPY (workspace:///draft) (https://example.test/archive?literal=\\)&encoded=%29)````"));
    if (statement.op !== "COPY" || statement.destination.target.kind !== "url") assert.fail("expected COPY URL destination");
    assert.equal(statement.destination.target.raw, "https://example.test/archive?literal=)&encoded=%29");
    assert.equal(statement.destination.target.query, "literal=)&encoded=%29");
});

test("{§op-shapes} a COPY destination path excludes the whitespace before its scope", () => {
    const statement = oneStatement("````COPY (log:///1/2/1/SEND) (session://alice/prompts.md) <-1>````");
    if (statement.op !== "COPY") assert.fail("expected COPY");
    assert.equal(statement.destination.target.raw, "session://alice/prompts.md");
    assert.equal(statement.destination.target.kind === "url" ? statement.destination.target.hostname : null, "alice");
    assert.deepEqual(statement.destination.lineMarker, { marks: [-1] });
});

// {§op-shapes}
test("{§operation-fences} COPY and MOVE bind a terminal scope to the immediately preceding operand", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        const statement = oneStatement(section(op, " (workspace:///src.md) <2,3> (workspace:///slice.md) <0>"));
        if (statement.op !== op) assert.fail(`expected ${op}`);
        assert.deepEqual(statement.source.lineMarker, { marks: [2, 3] });
        assert.deepEqual(statement.destination.lineMarker, { marks: [0] });

        const result = PlurnkParser.parseStatements(section(op, " (workspace:///src.md) (workspace:///slice.md) <0>:"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1);
    }
});

test("{§parse-recovery} invalid execution scopes name the supplied scope and timing constraint", () => {
    for (const slots of [" (sh/curl submit) <30s>", " (crm/crm_query) <crm:///1/6/1>", " (pm/pm_search_issues) <poll>"]) {
        const result = PlurnkParser.parseStatements(section("sh", slots, "{}"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1, slots);
        assert.equal(errors[0]?.error.source, "lexer");
        assert.equal(errors[0]?.error.message, `invalid sh scope ${JSON.stringify(slots.slice(slots.indexOf("<")))}; use minutes, e.g. \`<5,1>\``, slots);
    }
    // Slot spacing does not change the meaning of an invalid scope.
    const glued = PlurnkParser.parseStatements(section("READ", " (notes.md)<foo>"));
    const gluedErrors = glued.items.filter((item) => item.kind === "error");
    assert.ok(gluedErrors.length >= 1);
    assert.match(gluedErrors[0]?.error.message ?? "", /invalid READ scope "<foo>"/);
});

test("{§parse-recovery} malformed FIND scopes get one relevant correction and preserve later operations", () => {
    for (const scope of ["<matchLocation,1,16>", "<result range>", "<match locations>"]) {
        const result = PlurnkParser.parseStatements(sections(
            section("FIND", ` (😀/src/*.ts) ${scope}`, "/groupBy/"),
            section("WAIT", "", "continue"),
        ));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.error.message, `invalid FIND scope ${JSON.stringify(scope)}; use numeric result positions, e.g. \`<1,16>\``);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["WAIT"]);
        assert.equal(result.unparsedTail, undefined);
    }
});

test("{§parse-recovery} {§parse-recovery} scope diagnostics do not borrow another operation's contract", () => {
    for (const op of ["READ", "EDIT", "COPY", "MOVE", "KILL"] as const) {
        const error = firstError(section(op, " (a.md) <line number>"));
        assert.equal(error.message, `invalid ${op} scope "<line number>"; use numeric coordinates or \`@hash\` line anchors`);
    }
    // {§diagnostic-observation} — a hash written without its `@` is said as read, never rewritten into the anchor it might be.
    assert.equal(firstError(section("EDIT", " (sympy/utilities/iterables.py) <@WFYC2,tXN17>", "x")).message,
        "invalid EDIT scope \"<@WFYC2,tXN17>\"; use numeric coordinates or `@hash` line anchors");
    assert.equal(firstError(section("SEND", " (session://peer) <later>")).message,
        "invalid SEND scope \"<later>\"; use a numeric scope supported by the recipient");
    // {§slot-order} — an operation that takes no scope drops it and runs, with one advisory naming its slots.
    for (const op of ["BARE", "WORK", "FORK"] as const) {
        const result = PlurnkParser.parse(section(op, " <result range>"));
        assert.deepEqual(result.items.map((item) => item.kind === "error" ? `${item.error.severity}: ${item.error.message}` : item.kind === "statement" ? item.statement.op : item.kind),
            [op, `warning: \`${op}\` takes a target only; the scope \`<result range>\` was ignored.`]);
    }
    const wait = PlurnkParser.parse(section("WAIT", " <result range>"));
    assert.deepEqual(wait.items.map((item) => item.kind === "error" ? `${item.error.severity}: ${item.error.message}` : item.kind === "statement" ? item.statement.op : item.kind),
        ["WAIT", "warning: Ignored WAIT duration <result range>."]);
    assert.equal(firstError(section("FIND", " (src/*.ts) <result range>", undefined)).message,
        "invalid FIND scope \"<result range>\"; use numeric result positions, e.g. `<1,16>`");
});

test("{§parse-recovery} {§parse-recovery} scope excerpts stop at a delimiter, line ending, or bounded length", () => {
    for (const [input, excerpt] of [
        ["<result range> <!-- unrelated -->", "<result range>"],
        ["<result range\nprivate body", "<result range"],
        ["<result range\r\nprivate body", "<result range"],
        ["<result range", "<result range"],
        [`<${"x".repeat(100)}>`, `<${"x".repeat(63)}…`],
    ]) {
        assert.equal(firstError("````FIND (src/*.ts) " + input + "\n````").message,
            `invalid FIND scope ${JSON.stringify(excerpt)}; use numeric result positions, e.g. \`<1,16>\``);
    }
});

test("{§slot-order} COPY and MOVE require exactly two singular path operands", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        for (const [source, destination] of [["", ""], [" <2,3>", ""], ["", " <0>"], [" <2,3>", " <0>"]]) {
            const statement = oneStatement(section(op, ` (brief.md)${source} (drafts/brief.md)${destination}`));
            if (statement.op !== op) assert.fail(`expected ${op}`);
            assert.equal(statement.source.target.raw, "brief.md");
            assert.equal(statement.destination.target.raw, "drafts/brief.md");
            assert.deepEqual(statement.source.lineMarker?.marks ?? null, source ? [2, 3] : null);
            assert.deepEqual(statement.destination.lineMarker?.marks ?? null, destination ? [0] : null);
        }

        assert.ok(errorsOf(section(op, " (brief.md)", "drafts/brief.md")).length >= 1, `${op} rejects a destination body`);
        assert.ok(errorsOf(section(op, " (brief.md) (drafts/brief.md) (extra.md)")).length >= 1, `${op} rejects a third path`);
    }

    // {§slot-order} — on READ a second slot is a member, never a transfer operand.
    const reads = PlurnkParser.parseStatements(section("READ", " (brief.md) (drafts/brief.md)"));
    assert.deepEqual(reads.items.map((item) => {
        assert.equal(item.kind, "statement");
        assert.ok(item.kind === "statement" && item.statement.op === "READ");
        return item.statement.target?.raw;
    }), ["brief.md", "drafts/brief.md"]);
});

test("{§matcher-prefix-claims}: parentheses in bodies remain literal text, not operand slots", () => {
    const body = "(source.md) (destination.md) (extra.md)";
    for (const [op, slots] of [["NOTE", ""], ["EDIT", " (example.txt)"], ["SEND", ""], ["sh", ""]]) {
        const statement = oneStatement(section(op, slots, body));
        assert.ok("body" in statement && statement.body !== null);
        assert.equal(typeof statement.body === "string" ? statement.body : statement.body.raw, body);
    }
});

test("{§op-shapes} BARE accepts a prompt resource, inline input, or both", () => {
    for (const body of [undefined, "Compare the conclusions."]) {
        const statement = oneStatement(section("BARE", " (session://alice/prompt.md) <!-- isolated review -->", body));
        if (statement.op !== "BARE") assert.fail("expected BARE");
        assert.equal(statement.target?.raw, "session://alice/prompt.md");
        assert.equal(statement.body, body ?? "");
        assert.equal(statement.aside, "isolated review");
        assert.equal(statement.lineMarker, null);
    }
    const inline = oneStatement(section("BARE", "", "What is the capital of Germany?"));
    if (inline.op !== "BARE") assert.fail("expected BARE");
    assert.equal(inline.target, null);
    const metadata = oneStatement(section("BARE", ' (https://example.test/prompt) [{"Accept": "text/plain"}]'));
    if (metadata.op !== "BARE") assert.fail("expected BARE");
    assert.deepEqual(metadata.metadata, ['{"Accept": "text/plain"}']);

    const body = "````BARE (session://alice/prompt.md)````";
    const fenced = PlurnkParser.parseStatements(section("WAIT", "", body));
    assert.equal(fenced.items.some((item) => item.kind === "statement" && item.statement.op === "BARE"), false);
    const send = fenced.items.find((item) => item.kind === "statement")?.statement;
    assert.equal(send?.op === "WAIT" ? send.body : null, body);
});

test("{§operation-fences} resource-selection admission leaves angle brackets elsewhere in URLs untouched", () => {
    const global = parsePath("https://example.test/a<0>:");
    if (global?.kind !== "url") assert.fail("expected global URL admission");
    assert.equal(global.raw, "https://example.test/a<0>:");
    assert.equal(global.pathname, "/a%3C0%3E:");

    for (const [op, destination] of [
        ["COPY", "https://example.test/a%3Cdraft%3E/next"],
        ["MOVE", "https://example.test/a%3C0%3E:tail"],
        ["COPY", "https://example.test/a%3C0%3E:"],
    ] as const) {
        const statement = oneStatement(section(op, ` (workspace:///src.md) (${destination})`));
        if (statement.op !== op) assert.fail(`expected ${op}`);
        assert.equal(statement.destination.target.raw, destination);
    }
});

test("{§operation-fences} empty sections normalize to their operation-owned empty values", () => {
    for (const [op, slots] of [
        ["FIND", " (a)"],
        ["READ", " (a)"],
        ["EDIT", " (a) <1>"],
        ["KILL", " (log:///1)"],
        ["SEND", " (session://child)"],
        ["sh", ""],
        ["BARE", ""],
        ["WORK", " (session://child)"],
        ["FORK", " (session://child)"],
        ["KILL", " (a)"],
    ] as const) {
        const statement = oneStatement(section(op, slots));
        assert.equal("body" in statement ? statement.body : undefined, op === "BARE" || op === "WORK" || op === "FORK" ? "" : null, op);
    }
    for (const op of ["COPY", "MOVE"] as const) {
        const statement = oneStatement(section(op, " (a) (b)"));
        assert.equal("body" in statement, false, op);
    }
    const task = oneStatement(section("WAIT"));
    assert.equal(task.op, "WAIT");
    assert.equal("body" in task ? task.body : undefined, null);
});

test("{§slot-order} WAIT warns on invalid duration while NOTE still has no target operand", () => {
    const inlineArray = "````WAIT [{\"trace\":true}]\n````";
    const result = PlurnkParser.parseStatements(inlineArray);
    const errors = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.deepEqual(errors.map(({ message, severity }) => ({ message, severity })), [
        { message: 'Ignored WAIT duration [{"trace":true}].', severity: "warning" },
    ]);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    assert.ok(statements[0]?.op === "WAIT");
    assert.equal(statements[0].metadata, null);

    const all = firstError("````NOTE (notes.md) <1>\nContinue the task.\n````");
    assert.equal(all.message, "unexpected `(` (`(path)` slot opener); expected operation fence header, operation-heading line ending, closing fence, or body content");
});

// {§op-shapes}
test("{§operation-fences} same-lane sections compose and section whitespace is structural", () => {
    const result = PlurnkParser.parseStatements(sections(
        section("EDIT", " (a)", "one"),
        section("READ", " (b)"),
        section("EDIT", " (c)", "three"),
    ));
    assert.equal(result.items.filter((item) => item.kind === "statement").length, 3);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
    assert.equal(result.items.length, 3);
});

test("{§operation-fences}: a heading whose target never closes is one bounded error and its siblings survive", () => {
    const result = PlurnkParser.parseStatements(section("EDIT", " (first.md)", "one") + "\n`````EDIT (broken\n" + section("EDIT", " (third.md)", "three"));
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.deepEqual(statements.map((item) => "target" in item.statement ? item.statement.target?.raw : null), ["first.md", "third.md"]);
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "error" && item.error.severity === "error").length, 1);
});
test("{§operation-fences}: only an unfinished heading slot loses the boundary; a missing closer never does", () => {
    assert.equal(PlurnkParser.parseStatements(section("EDIT", " (p)", "body")).unparsedTail, undefined);
    assert.ok(PlurnkParser.parseStatements("````EDIT (path").unparsedTail);
    assert.ok(PlurnkParser.parseStatements('````EDIT (p) [{"meta"').unparsedTail);
    const open = PlurnkParser.parseStatements("````EDIT (p)\nbody");
    assert.equal(open.unparsedTail, undefined);
    assert.equal(open.items.some((item) => item.kind === "statement" && item.statement.op === "EDIT" && item.statement.body === "body"), true);
});
test("{§whitespace-contract}: WAIT-less programs preserve authored positions without EOF diagnostics", () => {
    for (const { source, line } of [
        { source: "````sh\ncat <<'EOF'\nhello\nEOF\n````", line: 1 },
        { source: "\r\n````READ (notes.md)````", line: 2 },
        { source: "````EDIT (notes.md)\n🧪é\n````", line: 1 },
        { source: "````READ (notes.md) <1,2>````", line: 1 },
    ]) {
        const result = PlurnkParser.parse(source);
        assert.deepEqual(result.items.map(({ kind }) => kind), ["statement"], source);
        assert.equal(result.unparsedTail, undefined, source);
        const statement = result.items[0];
        assert.ok(statement.kind === "statement");
        assert.deepEqual(statement.statement.position, { line, column: 0 }, source);
    }
});
test("{§whitespace-contract}: a WAIT-less program retains an independent scope recovery warning", () => {
    const result = PlurnkParser.parse("````READ (notes.md<1,2>)````");
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["READ"]);
    assert.ok(statements[0].op === "READ");
    assert.deepEqual(statements[0].lineMarker?.marks, [1, 2]);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [{
        severity: item.error.severity, message: item.error.message,
    }] : []), [{
        severity: "warning",
        message: "The scope was inside the target slot; it was applied as the operation scope.",
    }]);
});
// {§whitespace-contract} {§operation-fences}
test("{§operation-fences} omitted WAIT leaves literal nested programs intact", () => {
    const body = "````SEND\nquoted text\n````\n````WAIT\n````";
    const result = PlurnkParser.parse(sections(section("EDIT", " (quoted.md)", body)));
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["EDIT"]);
    assert.equal(statements[0]?.op === "EDIT" ? statements[0].body : null, body);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
});
test("{§operation-fences} a disposition inside EDIT is data and does not conclude a turn", () => {
    const result = PlurnkParser.parse(section("EDIT", " (example.md)", "````NOTE\ninspect\n````"));
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["EDIT"]);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
});
test("{§operation-fences} model turns without WAIT or SEND stand as written", () => {
    const waiting = PlurnkParser.parse(sections(
        section("READ", " (workspace:///notes.md)"),
        section("WAIT", "", "continue"),
    ));
    assert.equal(waiting.unparsedTail, undefined);
    const waitingStatements = waiting.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(waitingStatements.map(({ op }) => op), ["READ", "WAIT"], "nothing is synthesized");
    assert.equal(waiting.items.some((item) => item.kind === "error"), false, "no diagnostic");

    const unconcluded = PlurnkParser.parse(sections(
        section("READ", " (workspace:///notes.md)"),
    ));
    assert.equal(unconcluded.unparsedTail, undefined);
    const unconcludedStatements = unconcluded.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(unconcludedStatements.map(({ op }) => op), ["READ"]);
    assert.deepEqual(unconcluded.items.filter((item) => item.kind === "error"), []);
});

test("{§operation-fences} example is an executor name, not a transparent document wrapper", () => {
    const body = section("READ", " (notes.md)");
    const result = oneStatement(PlurnkParser.frame("example", body));
    assert.equal(isExecution(result), true);
    assert.equal(isExecution(result) ? result.runtime : null, "example");
    assert.equal("body" in result ? result.body : null, body);
});
test("{§operation-fences} plurnk is an executor name, not a transparent document wrapper", () => {
    const body = section("READ", " (notes.md)") + "\n" + section("WAIT", "", "done");
    const result = oneStatement(PlurnkParser.frame("plurnk", body));
    assert.equal(isExecution(result) ? result.runtime : null, "plurnk");
    assert.equal("body" in result ? result.body : null, body);
});
test("{§operation-fences}: a four-backtick WAIT inside an unclosed executor block is the turn's WAIT", () => {
    const result = PlurnkParser.parseStatements("`````plurnk\n" + section("WAIT", "", "done"), { executors: EXECUTORS });
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["plurnk", "WAIT"]);
    const exec = result.items.find((item) => item.kind === "statement");
    assert.equal(exec?.kind === "statement" && isExecution(exec.statement) ? exec.statement.body : "?", null, "the executor block ended at the heading with no body");
});
test("{§operation-fences}: a longer bare fence closes a shorter block and what follows is prose", () => {
    const result = PlurnkParser.parseStatements("````sh\n`````\necho hello", { executors: EXECUTORS });
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["sh"]);
    const exec = result.items.find((item) => item.kind === "statement");
    assert.equal(exec?.kind === "statement" && isExecution(exec.statement) ? exec.statement.body : "?", null);
});
test("{§op-shapes}: an operation after WAIT is admitted in authored order with no diagnostic", () => {
    const result = PlurnkParser.parse(sections(
        section("WAIT", "", "done"),
        section("READ", " (late.md)"),
    ));
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(ops.map(({ op }) => op), ["WAIT", "READ"]);
    assert.equal(ops[0]?.op === "WAIT" ? ops[0].body : null, "done");
});

test("{§operation-fences} WAIT has an optional literal body", () => {
    const result = PlurnkParser.parse(sections(
        section("WAIT", "", "waiting"),
    ));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("{§operation-fences} AST extracts target, raw body, and position without framing state", () => {
    const statement = oneStatement("````EDIT (p)\nhello\n````");
    assert.equal(statement.op, "EDIT");
    assert.equal(Object.hasOwn(statement, "delimiter"), false);
    assert.deepEqual(statement.target, { kind: "local", raw: "p" });
    assert.equal(statement.body, "hello");
    assert.equal(statement.lineMarker, null);
    assert.deepEqual(statement.position, { line: 1, column: 0 });
});
test("{§op-shapes} slot permutations produce equivalent AST values", () => {
    const variants = [
        "````FIND (p) <2> @m````",
        "````FIND <2> (p) @m````",
    ];
    for (const input of variants) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p");
        assert.deepEqual(statement.lineMarker, { marks: [2] });
        assert.deepEqual(statement.matcher, { dialect: "glob", raw: "@m" });
        assert.equal(statement.metadata, null);
    }

    // {§op-shapes} — a recipient in the path slot is a mid-turn message with no disposition.
    const recipient = oneStatement("````SEND (agent://named)\nmessage\n````");
    if (recipient.op !== "SEND") assert.fail("expected SEND");
    assert.equal(Object.hasOwn(recipient, "status"), false);
    assert.equal(recipient.target?.kind, "url");
});

test("{§operation-fences} modifier delimiters make horizontal spacing optional", () => {
    for (const input of [
        '````FIND(p)<2>[{"a": 1}]````',
        '````FIND\t(p)\t<2>\t[{"a": 1}]````',
        '````FIND  (p) \t<2> [{"a": 1}]````',
        '````FIND<2>(p)[{"a": 1}]````',
    ]) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p", input);
        assert.deepEqual(statement.lineMarker, { marks: [2] }, input);
        assert.deepEqual(statement.metadata, ['{"a": 1}'], input);
    }

    const send = oneStatement("````SEND(session://child)\ndone\n````");
    if (send.op !== "SEND") assert.fail("expected SEND");
    assert.equal(Object.hasOwn(send, "status"), false);
    assert.equal(send.target?.raw, "session://child");
});

test("{§operation-fences} scheme metadata is an opaque ordered modifier outside the target", () => {
    const statement = oneStatement(
        '````READ (https://api.example/me) [{"Authorization": "Bearer TOKEN"}] [{"Accept": "application/json"}] <1,4>````',
    );
    assert.equal(statement.op, "READ");
    assert.equal(statement.target?.raw, "https://api.example/me");
    assert.deepEqual(statement.metadata, [
        '{"Authorization": "Bearer TOKEN"}',
        '{"Accept": "application/json"}',
    ]);
    assert.deepEqual(statement.lineMarker, { marks: [1, 4] });
});

test("{§slot-order}: target and scope precede opaque metadata in every scoped heading", () => {
    for (const op of ["FIND", "READ", "EDIT", "KILL", "SEND", "js"] as const) {
        const header = `${op} (workspace:///item) <1,4> [{"request": {"value": "]"}}] [{"mode": "quiet"}] <!-- inspect -->`;
        const statement = oneStatement(PlurnkParser.frame(header, op === "EDIT" ? "replacement" : null));
        if (isExecution(statement)) assert.equal(statement.runtime, op);
        else assert.equal(statement.op, op);
        assert.equal(statement.target?.raw, "workspace:///item");
        assert.deepEqual(statement.lineMarker, { marks: [1, 4] });
        assert.deepEqual(statement.metadata, ['{"request": {"value": "]"}}', '{"mode": "quiet"}']);
        assert.equal(statement.aside, "inspect");
        const canonical = PlurnkParser.stringify([statement]);
        assert.equal(canonical, PlurnkParser.frame(header, op === "EDIT" ? "replacement" : null));
        assert.deepEqual(oneStatement(canonical), statement);
    }
});

test("{§op-shapes}: scope and metadata stay with their own COPY/MOVE operand", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        for (const sourceScope of ["", " <@abcde,@f1234>"]) {
            for (const destinationScope of ["", " <0>"]) {
                const header = `${op} (workspace:///source#body)${sourceScope} [{"source": "one"}] [{"source": "two"}] (workspace:///destination#notes)${destinationScope} [{"destination": "one"}] <!-- transfer -->`;
                const statement = oneStatement(PlurnkParser.frame(header, null));
                if (statement.op !== "COPY" && statement.op !== "MOVE") assert.fail("expected transfer");
                assert.equal(statement.source.target.raw, "workspace:///source#body");
                assert.equal(statement.destination.target.raw, "workspace:///destination#notes");
                assert.deepEqual(statement.source.metadata, ['{"source": "one"}', '{"source": "two"}']);
                assert.deepEqual(statement.destination.metadata, ['{"destination": "one"}']);
                assert.deepEqual(statement.source.lineMarker, sourceScope ? { marks: ["@abcde", "@f1234"] } : null);
                assert.deepEqual(statement.destination.lineMarker, destinationScope ? { marks: [0] } : null);
                assert.equal(PlurnkParser.stringify([statement]), PlurnkParser.frame(header, null));
                assert.deepEqual(oneStatement(PlurnkParser.stringify([statement])), statement);
            }
        }
    }
});

test("{§slot-order}: a resource selection never silently accepts a second scope", () => {
    for (const header of [
        'READ (item) <1> [{"mode": "one"}] <2>',
        'COPY (source) <1> [{"mode": "one"}] <2> (destination)',
        'MOVE (source) (destination) <1> [{"mode": "one"}] <2>',
        'SEND (session://reviewer) <1> [{"mode": "one"}] <2>',
    ]) {
        const errors = errorsOf(PlurnkParser.frame(header, null));
        assert.ok(errors.some(({ severity }) => severity === "error"), header);
    }
});

test("{§slot-order}: quoted brackets and escapes remain exact metadata content", () => {
    for (const metadata of [
        JSON.stringify({ args: ["]", "[", 'quote"]here', "\\]", "line\nbreak"] }),
        JSON.stringify({ request: { nested: { value: "]" } } }),
    ]) {
        const statement = oneStatement(`\`\`\`\`js (script.js) [${metadata}] [{"cwd": "sub"}]
stdin
\`\`\`\``);
        if (!isExecution(statement)) assert.fail("expected an execution");
        assert.deepEqual(statement.metadata, [metadata, '{"cwd": "sub"}']);
        assert.equal(statement.body, "stdin");
    }
});

test("{§slot-order} duplicate slots are rejected", () => {
    for (const input of [
        "````FIND (p1) (p2)\nm\n````",
        "````FIND <1> <2> (p)\nm\n````",
    ]) {
        assert.ok(errorsOf(input).length >= 1, input);
    }
});

// {§slot-order}
test("{§slot-order} body text on the heading line runs as the body and raises one advisory naming the rule", () => {
    const turn = "\n````EDIT (Engine.ts) <3> replacement text\n````\n\n````NOTE\nnext\n````";
    const result = PlurnkParser.parse(turn);
    const edit = result.items.find((item) => item.kind === "statement" && item.statement.op === "EDIT");
    assert.equal(edit?.kind, "statement", "the inline body still dispatches as EDIT");
    if (edit?.kind !== "statement") return;
    assert.equal((edit.statement as { body?: string | null }).body, "replacement text", "the inline text is the body");
    const advisory = result.items.find((item) => item.kind === "error" && item.error.severity === "warning");
    assert.equal(advisory?.kind, "error", "one advisory follows");
    if (advisory?.kind !== "error") return;
    assert.match(advisory.error.message, /body text was on the OP line and was taken as the body/);
    assert.match(advisory.error.message, /body content goes immediately beneath the opening fence line/);
    assert.equal(advisory.error.line, 2, "the advisory points at the heading");
    const canonical = PlurnkParser.parse("\n````EDIT (Engine.ts) <3>\nreplacement text\n````\n\n````NOTE\nnext\n````");
    assert.ok(!canonical.items.some((item) => item.kind === "error" && item.error.severity === "warning"), "the canonical two-line form raises nothing");
});

test("{§parse-recovery}: a sigil matcher is selected only on the heading", () => {
    for (const [op, pattern, dialect] of [["FIND", "/resolveSessionPrimary/", "regex"], ["KILL", "~topic", "fts"]] as const) {
        const source = PlurnkParser.frame(op + " (Engine.ts) " + pattern, null);
        const result = PlurnkParser.parse(source);
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
        const statement = result.items.find((item) => item.kind === "statement");
        const matcher = statement?.kind === "statement" && "matcher" in statement.statement ? statement.statement.matcher : null;
        assert.equal(matcher?.dialect, dialect);
        assert.equal(matcher?.raw, pattern);
    }
});

test("{§parse-recovery} {§matcher-prefix-claims} a malformed regex pattern refuses its matcher with a bounded dialect message that echoes nothing", () => {
    const refused = refusedMatcher("````FIND (**/*.go) <1,-1> /require|ABS_MODULE_PATH|module_load/ trailing````");
    assert.equal(refused.message, "Regex matcher has trailing text after `/pattern/flags`.");
    assert.doesNotMatch(refused.message, /ABS_MODULE_PATH|\*\*\/\*\.go/u, "the receipt does not echo the submitted matcher or target");
    for (const pattern of ["/x/z", "/x/ii", "/(/i", "/"]) {
        const { message } = refusedMatcher(`\`\`\`\`FIND (src/**) ${pattern}\`\`\`\``);
        assert.doesNotMatch(message, /Regex matcher has trailing text/u, pattern);
        assert.match(message, /not a valid.*regex|no pattern follows/u, pattern);
    }
});

test("{§parse-recovery} a /pattern with no closing slash is the whole pattern with no flags, with one advisory; a bare / names what is missing", () => {
    const source = "````FIND (tests/staticfiles_tests/**) /get_script_prefix|SCRIPT_NAME\n````\n";
    const statement = oneStatement(source);
    if (statement.op !== "FIND" || statement.matcher?.dialect !== "regex") assert.fail("regex matcher expected");
    assert.equal(statement.matcher.pattern, "get_script_prefix|SCRIPT_NAME");
    assert.equal(statement.matcher.flags, "");
    const advisories = errorsOf(source);
    assert.deepEqual(advisories.map(({ severity }) => severity), ["warning"]);
    assert.match(advisories[0].message, /has no closing `\/`; it was read as the whole pattern with no flags/u);
    // A heading ending in a lone slash has nothing to read ({§matcher-prefix-claims}).
    const bare = refusedMatcher("````FIND (tests/staticfiles_tests/**) /\n````\n");
    assert.match(bare.message, /no pattern follows it/u);
    assert.doesNotMatch(bare.message, /no closing/u);
});

test("a pattern with flags parses; an invalid one refuses only its own matcher ({§matcher-prefix-claims})", () => {
    for (const flags of ["i", "", "giu"]) {
        const result = PlurnkParser.parse(sections(
            `\`\`\`\`FIND (**/*.ts) <1,-1> /disabled-rules|comment|lint\\s*\\(/${flags} <!-- locate entry points -->\`\`\`\``,
            section("READ", " (package.json)"),
            section("WAIT", "", "inspect"),
        ));
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], flags);
        const find = result.items.find((item) => item.kind === "statement" && item.statement.op === "FIND");
        assert.equal(find?.kind === "statement" && find.statement.op === "FIND" ? find.statement.matcher?.dialect : null, "regex", flags);
    }
    const result = PlurnkParser.parse(sections(
        "````FIND (**/*.ts) /(/i````",
        section("READ", " (package.json)"),
        section("WAIT", "", "inspect"),
    ));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["FIND", "READ", "WAIT"]);
    assert.equal(statements[0].op === "FIND" ? statements[0].matcher?.dialect : null, "unreadable");
});


test("{§operation-fences} scope spellings normalize to ordered numeric marks", () => {
    for (const [scope, marks] of [
        ["<5>", [5]],
        ["<4-7>", [4, 7]],
        ["<-1>", [-1]],
        ["<0--5>", [0, -5]],
        ["<-3--1>", [-3, -1]],
        ["<4,7>", [4, 7]],
        ["<1,-1>", [1, -1]],
        ["<1, -1>", [1, -1]],
        ["<-3,-1>", [-3, -1]],
    ] as const) {
        const statement = oneStatement(section("EDIT", ` (p) ${scope}`, "body"));
        if (statement.op !== "EDIT") assert.fail("expected EDIT");
        assert.deepEqual(statement.lineMarker, { marks }, scope);
    }
});

test("{§matcher-prefix-claims} text-coordinate operations admit Base62 anchors only in line positions", () => {
    const cases = [
        [section("READ", " (p) <@aZ09b>"), "READ", ["@aZ09b"]],
        [section("EDIT", " (p) <@aZ09b,@0Aa9Z>", "body"), "EDIT", ["@aZ09b", "@0Aa9Z"]],
    ] as const;
    for (const [source, op, marks] of cases) {
        const statement = oneStatement(source);
        assert.equal(statement.op, op);
        assert.deepEqual("lineMarker" in statement ? statement.lineMarker : undefined, { marks: [...marks] });
    }

    const copyDestination = oneStatement(section("COPY", " (p) <@aZ09b,5,@0Aa9Z,12> (q) <@aZ09b,@0Aa9Z>"));
    assert.equal(copyDestination.op, "COPY");
    assert.deepEqual(copyDestination.source.lineMarker, { marks: ["@aZ09b", 5, "@0Aa9Z", 12] });
    assert.deepEqual(copyDestination.destination.lineMarker, { marks: ["@aZ09b", "@0Aa9Z"] });

    const moveDestination = oneStatement(section("MOVE", " (p) <@aZ09b> (q) <@aZ09b,5,@0Aa9Z,12>"));
    assert.equal(moveDestination.op, "MOVE");
    assert.deepEqual(moveDestination.source.lineMarker, { marks: ["@aZ09b"] });
    assert.deepEqual(moveDestination.destination.lineMarker, { marks: ["@aZ09b", 5, "@0Aa9Z", 12] });

    for (const input of [
        section("FIND", " (p) <@aZ09b>"),
        section("sh", " (node) <@aZ09b>", "run"),
        section("READ", " (p) <@aZ09>"),
        section("EDIT", " (p) <@aZ09bQ>", "body"),
        section("COPY", " (p) <@aZ-9b> (q)"),
    ]) {
        assert.ok(errorsOf(input).length > 0, input);
    }
});

// {§parse-recovery}
test("{§operation-fences} the displayed row prefix copied whole — digits before the scope — reads as the anchor, with one advisory", () => {
    for (const [input, marks] of [
        [section("EDIT", " (p) 42<@aZ09b>", "body"), ["@aZ09b"]],
        [section("EDIT", " (p) 42<@aZ09b,@0Aa9Z>", "body"), ["@aZ09b", "@0Aa9Z"]],
        [section("COPY", " (p) (q) 42<@aZ09b>"), ["@aZ09b"]],
    ] as const) {
        const result = PlurnkParser.parseStatements(input);
        const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(ops.length, 1, input);
        const marker = ops[0].op === "COPY" ? ops[0].destination.lineMarker : (ops[0] as { lineMarker: { marks: unknown[] } | null }).lineMarker;
        assert.deepEqual(marker, { marks: [...marks] }, input);
        assert.equal((ops[0] as { matcher?: unknown }).matcher ?? null, null, `the digits are not a matcher: ${input}`);
        const advisories = result.items.filter((item) => item.kind === "error");
        assert.equal(advisories.length, 1, input);
        assert.equal(advisories[0].kind === "error" ? advisories[0].error.severity : null, "warning");
        assert.match(advisories[0].kind === "error" ? advisories[0].error.message : "", /was read as the scope `<@[0-9A-Za-z]{5}(?:,@[0-9A-Za-z]{5})?>`; a scope takes the anchor without its displayed line number/u);
    }
});

test("{§op-shapes} WAIT retains a positive duration while execution keeps its distinct timing tuple", () => {
    const terminal = oneStatement(section("WAIT", " [30]", "polling"));
    if (terminal.op !== "WAIT") assert.fail("expected WAIT");
    assert.equal(terminal.seconds, 30);
    assert.equal(terminal.lineMarker, null);
    const appended = oneStatement(section("WAIT", "", "standing by"));
    if (appended.op !== "WAIT") assert.fail("expected WAIT");
    assert.equal(appended.lineMarker, null);
    assert.equal(appended.seconds, null);
    const exec = oneStatement("````js (./) <60,5>\ncommand\n````");
    if (!isExecution(exec)) assert.fail("expected an execution");
    assert.deepEqual(exec.lineMarker, { marks: [60, 5] });
});

test("{§operation-fences} unscoped EDIT remains syntax-valid for runtime create-or-refuse semantics", () => {
    for (const input of [
        section("EDIT", " (notes.md)", "whole body"),
        section("EDIT", " (workspace:///plan.md)", "draft"),
        section("EDIT", " (empty.md)"),
    ]) {
        const statement = oneStatement(input);
        if (statement.op !== "EDIT") assert.fail("expected EDIT");
        assert.equal(statement.lineMarker, null);
    }
});

test("{§operation-fences} ParsedPath distinguishes local paths and decomposes scheme URLs", () => {
    assert.deepEqual(parsePath("./README.md"), { kind: "local", raw: "./README.md" });
    assert.deepEqual(parsePath("config/**/*.xml"), { kind: "local", raw: "config/**/*.xml" });

    const https = parsePath("https://user:pass@sub.example.com:8080/foo/bar?q=1&q=2#frag");
    assert.deepEqual(https, {
        kind: "url",
        raw: "https://user:pass@sub.example.com:8080/foo/bar?q=1&q=2#frag",
        scheme: "https",
        username: "user",
        password: "pass",
        hostname: "sub.example.com",
        port: 8080,
        pathname: "/foo/bar",
        query: "q=1&q=2",
        fragment: "frag",
    });

    for (const [raw, scheme, pathname] of [
        ["workspace:///entries/foo/bar", "workspace", "/entries/foo/bar"],
        ["log:///1/turn/2/action/3/get", "log", "/1/turn/2/action/3/get"],
        ["file:///tmp/foo.txt", "file", "/tmp/foo.txt"],
        ["sh:///run-tests", "sh", "/run-tests"],
        ["wiki:///Paris", "wiki", "/Paris"],
    ] as const) {
        const parsed = parsePath(raw);
        if (parsed?.kind !== "url") assert.fail(raw);
        assert.equal(parsed.scheme, scheme);
        assert.equal(parsed.hostname, null);
        assert.equal(parsed.pathname, pathname);
    }

    const authority = parsePath("session://entries/foo");
    if (authority?.kind !== "url") assert.fail("expected URL");
    assert.equal(authority.hostname, "entries");
    assert.equal(authority.pathname, "/foo");

    const emptyAuthority = parsePath("wiki:///Paris?lang=fr#History");
    if (emptyAuthority?.kind !== "url") assert.fail("expected URL");
    assert.equal(emptyAuthority.query, "lang=fr");
    assert.equal(emptyAuthority.fragment, "History");
});

test("{§matcher-prefix-claims} malformed URL authority becomes one visitor error", () => {
    const result = PlurnkParser.parseStatements(section("READ", " (http://[bad)"));
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "visitor");
});

// {§matcher-prefix-claims}
// {§parse-recovery} — a sigil pattern on the heading line carries every matcher dialect.
const patterned = (op: Parameters<typeof section>[0], slots: string, pattern: string): string => section(op, `${slots} ${pattern}`);

test("{§operation-fences} matcher dialects project to typed matchers", () => {
    for (const [pattern, dialect] of [
        ["/foo|bar/i", "regex"],
        ["//user[@role='admin']", "xpath"],
        ["$.greeting", "jsonpath"],
        ["@Paris*", "glob"],
        ["~distributed consensus algorithms", "fts"],
        ["&<createCoder", "graph"],
        ["&>createCoder", "graph"],
        ["&createCoder", "graph"],
    ] as const) {
        const statement = oneStatement(patterned("FIND", " (source/**)", pattern));
        if (statement.op !== "FIND") assert.fail(pattern);
        assert.equal(statement.matcher?.dialect, dialect, pattern);
        assert.equal(statement.matcher?.raw, pattern, pattern);
        assert.equal(statement.body, null, pattern);
        assert.equal(statement.metadata, null, pattern);
    }
});

test("{§operation-fences} graph claims ampersand and validates its complete single-line shape", () => {
    for (const pattern of ["&", "&<", "&>", "&two symbols"] as const) {
        const { message } = refusedMatcher(patterned("FIND", " (source/**)", pattern));
        assert.equal(message, "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.", pattern);
    }
});

test("{§operation-fences} at-sign matcher text remains in the fallback glob dialect", () => {
    for (const pattern of [
        "@createCoder",
        "@et6xE 2286:const value = true;",
        "@(createCoder|deleteCoder)",
    ] as const) {
        const statement = oneStatement(patterned("FIND", " (source/**)", pattern));
        if (statement.op !== "FIND") assert.fail(pattern);
        assert.equal(statement.matcher?.dialect, "glob", pattern);
        assert.equal(statement.matcher?.raw, pattern, pattern);
    }
});

test("a READ with a pattern on an exact target stays a READ ({§read})", () => {
    const result = PlurnkParser.parse([
        "````READ (data/users.json) <1,-1> @data/users.json````",
    ].join("\n"));
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    assert.ok(statements[0].op === "READ");
    assert.equal(statements[0].matcher?.raw, "@data/users.json");
    assert.deepEqual(statements[0].lineMarker?.marks, [1, -1]);
});

test("{§operation-fences} regex patterns retain pattern, flags, escaped delimiters, and character classes", () => {
    const regex = oneStatement(patterned("FIND", " (log://x)", "/foo|bar/i"));
    if (regex.op !== "FIND" || regex.matcher?.dialect !== "regex") assert.fail("expected regex");
    assert.equal(regex.matcher.pattern, "foo|bar");
    assert.equal(regex.matcher.flags, "i");
    assert.equal(new RegExp(regex.matcher.pattern, regex.matcher.flags).test("FOO"), true);

    for (const [pattern, expected] of [["/a\\/b/i", "a\\/b"], ["/[/]/", "[/]"]] as const) {
        const statement = oneStatement(patterned("FIND", " (log://x)", pattern));
        if (statement.op !== "FIND" || statement.matcher?.dialect !== "regex") assert.fail(pattern);
        const matcher = statement.matcher;
        assert.equal(matcher.pattern, expected);
        assert.doesNotThrow(() => new RegExp(matcher.pattern, matcher.flags));
    }
});

test("declared matcher prefixes refuse as their declared dialect instead of falling back ({§matcher-prefix-claims})", () => {
    for (const [pattern, message] of [
        ["/", /no pattern follows/],
        ["/(abc/", /not a valid `\/pattern\/flags` regex/],
        ["/hello/i:", /Invalid flags/],
        ["//book[unterminated", /not a valid xpath selector/],
        ["// TODO: add error handling", /not a valid xpath selector/],
        ["$[(", /not a valid jsonpath/],
        ["$HOME", /not a valid jsonpath/],
        ["$.users[", /not a valid jsonpath/],
    ] as const) {
        const refused = refusedMatcher(patterned("FIND", " (source)", pattern));
        assert.match(refused.message, message, pattern);
    }
});

test("{§operation-fences} matcher validation is per section and does not consume siblings", () => {
    const result = PlurnkParser.parseStatements(sections(
        patterned("FIND", " (a.txt)", "/ok/i"),
        patterned("FIND", " (b.txt)", "/bad/i:"),
        section("KILL", " (log:///1/2/3)"),
    ));
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map((statement) => "matcher" in statement ? statement.matcher?.dialect ?? null : null), ["regex", "unreadable", null]);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("{§operation-fences} ordinary matcher text remains glob and EDIT bodies remain opaque", () => {
    const glob = oneStatement(patterned("FIND", " (workspace:///**)", "@:<1,-1>:/hello/i:"));
    if (glob.op !== "FIND") assert.fail("expected FIND");
    assert.equal(glob.matcher?.dialect, "glob");

    const edit = oneStatement(section("EDIT", " (p)", "/this is literal EDIT content/x"));
    assert.equal(edit.op, "EDIT");
    assert.equal(edit.body, "/this is literal EDIT content/x");
    assert.equal(edit.matcher, null);
});

test("an EDIT pattern is lifted beside its literal body ({§edit-pattern})", () => {
    const edit = oneStatement(patterned("EDIT", " (p) <3,9>", "/oldName/g") .replace("\n```", "\nnewName\n```"));
    if (edit.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(edit.matcher?.dialect, "regex");
    assert.equal(edit.body, "newName");
    assert.deepEqual(edit.lineMarker?.marks, [3, 9]);
    const bare = oneStatement(patterned("EDIT", " (p)", "/oldName/"));
    assert.equal(bare.op === "EDIT" ? bare.body : undefined, null, "an empty body with a pattern deletes the spans; the parser admits it");
});

test("{§op-shapes} full-text matcher accepts arbitrary text and a result-position scope", () => {
    const kill = oneStatement(patterned("KILL", " (log://**)", "~find anything about: !@#$%^ malformed (but valid as query)"));
    if (kill.op !== "KILL") assert.fail("expected KILL");
    assert.equal(kill.matcher?.dialect, "fts");
    assert.equal(kill.body, null);

    const find = oneStatement(patterned("FIND", " (workspace:///**) <5>", "~graph algorithms"));
    if (find.op !== "FIND") assert.fail("expected FIND");
    assert.deepEqual(find.lineMarker, { marks: [5] });
    assert.equal(find.matcher?.dialect, "fts");
});

// {§op-shapes} — a READ is never rewritten: a glob target stays a READ (the runtime fans it out).
test("{§operation-fences} READ of a glob target stays a schema-valid READ; a matcher keeps its op", () => {
    const cases = [
        { input: section("READ", " (workspace:///page.md) <2,4>"), op: "READ", dialect: null, marks: [2, 4] },
        { input: patterned("READ", " (workspace:///page.md) <3,5>", "/header/i"), op: "READ", dialect: "regex", marks: [3, 5] },
        { input: section("READ", " (src/**/*.ts) <2>"), op: "READ", dialect: null, marks: [2] },
        { input: section("READ", " (workspace:///src/**/*.ts) <4,8>"), op: "READ", dialect: null, marks: [4, 8] },
        { input: patterned("READ", " (workspace:///src/**/*.ts)", "@TODO"), op: "READ", dialect: "glob", marks: null },
    ] as const;

    for (const { input, op, dialect, marks } of cases) {
        const statement = oneStatement(input);
        assert.equal(statement.op, op, input);
        assert.deepEqual(statement.lineMarker?.marks ?? null, marks, input);
        assert.equal(statement.matcher?.dialect ?? null, dialect, input);
        const validation = Validator.validatePlurnkStatement(statement);
        assert.equal(validation.valid, true, `${input}: ${JSON.stringify(validation.errors)}`);
    }
});

test("READ matcher admission keeps its dialect diagnostic as the matcher's refusal ({§matcher-prefix-claims})", () => {
    const { message } = refusedMatcher(patterned("READ", " (page.html)", "// foo {bar}"));
    assert.match(message, /not a valid xpath selector/);
});

test("{§operation-fences} COPY and MOVE operands project path, metadata, fragment, and scope independently", () => {
    const copy = oneStatement(section(
        "COPY",
        ' (workspace:///draft#body) [{"source": "metadata"}] <2,4> (workspace:///archive#notes) [{"destination": "metadata"}] <1,3,1,3>',
    ));
    if (copy.op !== "COPY" || copy.destination.target.kind !== "url") assert.fail("expected COPY");
    assert.equal(copy.destination.target.fragment, "notes");
    assert.equal(copy.destination.target.raw, "workspace:///archive#notes");
    assert.deepEqual(copy.destination.metadata, ['{"destination": "metadata"}']);
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, 3, 1, 3] });
    assert.deepEqual(copy.source.metadata, ['{"source": "metadata"}']);
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 4] });

    const move = oneStatement(section("MOVE", " (workspace:///draft) (./out.txt)"));
    if (move.op !== "MOVE") assert.fail("expected MOVE");
    assert.deepEqual(move.source.target, parsePath("workspace:///draft"));
    assert.deepEqual(move.destination.target, { kind: "local", raw: "./out.txt" });
});

test("{§op-shapes} SEND projects JSON when valid and always preserves raw body", () => {
    const json = oneStatement(section("SEND", "", '{"answer":"Paris","confidence":0.95}'));
    if (json.op !== "SEND" || !json.body) assert.fail("expected SEND");
    assert.equal(json.body.raw, '{"answer":"Paris","confidence":0.95}');
    assert.deepEqual(json.body.json, { answer: "Paris", confidence: 0.95 });

    const text = oneStatement(section("SEND", "", "Paris"));
    if (text.op !== "SEND" || !text.body) assert.fail("expected SEND");
    assert.equal(text.body.raw, "Paris");
    assert.equal(text.body.json, null);
});

test("{§operation-fences} multiline EDIT and execution bodies remain character-perfect raw strings", () => {
    const edit = oneStatement(section("EDIT", " (workspace:///entry)", "line one\nline two"));
    const exec = oneStatement(section("sh", " (node/./)", "console.log(1+1)"));
    if (edit.op !== "EDIT" || !isExecution(exec)) assert.fail("expected EDIT and an execution");
    assert.equal(edit.body, "line one\nline two");
    assert.equal(exec.body, "console.log(1+1)");
});

test("{§parse-recovery} header diagnostics use PLURNK vocabulary and point to the malformed slot", () => {
    const executor = firstError("````sh (node) (./)\ncommand\n````");
    assert.match(executor.message, /sh accepts one `\(program\)` path at most once/);
    for (const runtime of ["python3", "brave", "search-api"]) {
        const error = firstError(`\`\`\`\`${runtime} (first) (second)\ninput\n\`\`\`\``);
        assert.equal(error.message, `${runtime} accepts one \`(program)\` path at most once`);
    }

    // {§parse-recovery} — a sigil matcher after the target on the heading line is the pattern.
    const inlineItems = PlurnkParser.parse("````FIND (data.json) $.role\n````").items;
    assert.deepEqual(inlineItems.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
    const lifted = inlineItems.find((item) => item.kind === "statement" && item.statement.op === "FIND");
    assert.equal(lifted?.kind === "statement" ? (lifted.statement as { matcher?: { dialect?: string } | null }).matcher?.dialect : null, "jsonpath");

    const target = PlurnkParser.parseStatements("````EDIT (path").unparsedTail;
    assert.match(target?.reason ?? "", /target slot of `EDIT`.*add `\)`/);

    const metadata = PlurnkParser.parseStatements('````EDIT (p) [{"meta"').unparsedTail;
    assert.match(metadata?.reason ?? "", /metadata modifier of `EDIT`.*add `\]`/);
});

test("{§operation-fences} diagnostics do not leak ANTLR implementation vocabulary", () => {
    const forbidden = /token recognition|mismatched|extraneous|expecting|no viable|RPAREN|LBRACKET|RBRACKET|LPAREN|BODY_TEXT|<EOF>|ATN/;
    for (const input of [
        "````EDIT (path````",
        "````EDIT [+tag````",
        "````EDIT (p)\nstray\n````",
        "````SEND [bad]\nmessage\n````",
    ]) {
        const result = PlurnkParser.parseStatements(input);
        for (const item of result.items) {
            if (item.kind === "error") assert.doesNotMatch(item.error.message, forbidden, item.error.message);
        }
        if (result.unparsedTail) assert.doesNotMatch(result.unparsedTail.reason, forbidden, result.unparsedTail.reason);
    }
});

test("{§operation-fences} body punctuation and Markdown remain opaque", () => {
    for (const input of [
        section("WAIT", "", "array[0] and a stray ] bracket"),
        section("WAIT", "", '{"expected":["a","b"],"got":[1,2]}'),
        section("WAIT", "", "]]]) }{[ <> mixed"),
        section("EDIT", " (a.md)", "x = arr[0] + (y) + {z}"),
        section("SEND", " (session://parent)", "result ] arr[0]"),
        section("WAIT", "", "# User heading\n\n- one\n- two"),
    ]) {
        assert.equal(["SEND", "EDIT", "WAIT", "WAIT"].includes(writtenOp(oneStatement(input))), true, input);
    }
});

test("{§op-shapes} {§op-shapes} parse accepts a WAIT-terminated turn, and another WAIT after it is one more park label", () => {
    const turn = sections(
        section("READ", " (workspace:///x)"),
        section("WAIT", "", "done"),
    );
    const result = PlurnkParser.parse(turn);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);

    const twoWaits = sections(turn, sections(
        section("WAIT", "", "done again"),
    ));
    const admitted = PlurnkParser.parse(twoWaits);
    assert.deepEqual(admitted.items.filter((item) => item.kind === "error"), []);
    assert.equal(admitted.unparsedTail, undefined);
    assert.deepEqual(
        admitted.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["READ", "WAIT", "WAIT"],
    );
});

test("{§operation-fences} parseStatements accepts direct consecutive turns and flattens them in order", () => {
    const input = sections(
        section("READ", " (workspace:///x)"),
        section("WAIT", "", "reading"),
        section("WAIT", "", "done"),
    );
    const result = PlurnkParser.parseStatements(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["READ", "WAIT", "WAIT"],
    );
});

test("{§operation-fences} statement sequences need no lifecycle delimiter or operation", () => {
    assert.deepEqual(PlurnkParser.parseStatements("").items, []);
    const result = PlurnkParser.parseStatements(section("READ", " (workspace:///x)"));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.items[0]?.kind === "statement" && result.items[0].statement.op, "READ");
});

test("{§slot-order} parser positions count Unicode code points and CRLF lines", () => {
    // Without a separating space the trailing text is still a malformed heading; with one it is
    // the inline body ({§slot-order}). Either way columns count code points.
    const unicode = PlurnkParser.parseStatements("````EDIT (🙂)X````");
    const error = unicode.items.find((item) => item.kind === "error");
    assert.equal(error?.kind, "error");
    if (error?.kind === "error") assert.deepEqual({ line: error.error.line, column: error.error.column }, { line: 1, column: 12 });
    const inlineEdit = oneStatement("````EDIT (🙂) X\n````");
    if (inlineEdit.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(inlineEdit.body, "X");

    const crlf = oneStatement("````EDIT (p)\nline one\r\nline two\n````");
    if (crlf.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(crlf.body, "line one\r\nline two");
});

// {§slot-order}
test("{§op-shapes} body text on the heading line is the first body line when it cannot open a slot", () => {
    const exec = oneStatement("````crm (crm_query) SELECT Id FROM Case\n````");
    if (!isExecution(exec)) assert.fail("expected an execution");
    assert.equal(exec.runtime, "crm");
    assert.equal(exec.target?.raw, "crm_query");
    assert.equal(exec.body, "SELECT Id FROM Case");

    const multi = oneStatement("````crm (crm_query)\n{\"soql\":\n \"SELECT Id FROM Case\"}\n````");
    if (!isExecution(multi)) assert.fail("expected an execution");
    assert.equal(multi.body, '{"soql":\n "SELECT Id FROM Case"}', "the inline start joins the following body lines");

    const send = oneStatement("````SEND Paris.\n````");
    if (send.op !== "SEND" || !send.body) assert.fail("expected SEND with body");
    assert.equal(send.body.raw, "Paris.");

    const withAside = oneStatement("````EDIT (src/a.ts) <4> <!-- where --> replacement\n````");
    if (withAside.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(withAside.aside, "where");
    assert.equal(withAside.body, "replacement");

    // Slot openers stay slots; tolerant ingestion does not require canonical spacing.
    const unspaced = oneStatement("````crm (crm_query)[{\"soql\": \"x\"}]````");
    if (!isExecution(unspaced)) assert.fail("expected an execution");
    assert.deepEqual(unspaced.metadata, ['{"soql": "x"}']);
    assert.equal(oneStatement("````READ (a.md) <1,3>````").op, "READ");
});

// {§op-shapes}
test("{§op-shapes} the fence name selects the execution while its modifiers retain their contracts", () => {
    const railed = oneStatement('````python3 (tools/report.py) [{"cwd": "build"}] <30>\ninput\n````');
    if (!isExecution(railed)) assert.fail("expected an execution");
    assert.equal(railed.runtime, "python3");
    assert.equal(railed.target?.raw, "tools/report.py");
    assert.deepEqual(railed.metadata, ['{"cwd": "build"}']);
    assert.deepEqual(railed.lineMarker, { marks: [30] });
    assert.equal(railed.body, "input");
    const bare = oneStatement("````sh\npwd\n````");
    if (!isExecution(bare)) assert.fail("expected an execution");
    assert.equal(bare.runtime, "sh", "the default shell is explicit: a bare form is the sh runtime");
    assert.equal(bare.target, null);
    const alone = oneStatement("````js\nconsole.log(1)\n````");
    if (!isExecution(alone)) assert.fail("expected an execution");
    assert.equal(alone.runtime, "js");
    assert.equal(alone.target, null);
    const plus = oneStatement("````c++ (main.cpp)````");
    if (!isExecution(plus)) assert.fail("expected an execution");
    assert.equal(plus.runtime, "c++");
    const unspaced = oneStatement("````js(script.js)\n.a\n````");
    if (!isExecution(unspaced)) assert.fail("expected an execution");
    assert.equal(unspaced.runtime, "js");
    assert.equal(unspaced.target?.raw, "script.js");
    // {§op-shapes} — a bracket after the program or leading an executor fence is metadata
    // for that executor; the fence name selects the executor.
    for (const [input, executor] of [
        ['````sh (tool.py) [{"cwd": "sub"}]\ninput\n````', "sh"],
        ['````python3 (tool.py) [{"cwd": "sub"}]\ninput\n````', "python3"],
        ['````python3 [{"cwd": "sub"}] (tool.py)\ninput\n````', "python3"],
    ] as const) {
        const execution = oneStatement(input);
        if (!isExecution(execution)) assert.fail("expected an execution");
        assert.equal(execution.runtime, executor, input);
        assert.equal(execution.target?.raw, "tool.py", input);
        assert.deepEqual(execution.metadata, ['{"cwd": "sub"}'], input);
        assert.equal(execution.body, "input", input);
    }
    const cwdOnly = oneStatement('````sh [{"cwd": "sub"}]\nmake test\n````');
    if (!isExecution(cwdOnly)) assert.fail("expected an execution");
    assert.equal(cwdOnly.runtime, "sh", "the default shell is explicit");
    assert.deepEqual(cwdOnly.metadata, ['{"cwd": "sub"}']);
    assert.equal(cwdOnly.body, "make test");
    const executorCwd = oneStatement('````js [{"cwd": "sub"}]\nconsole.log(process.cwd())\n````');
    if (!isExecution(executorCwd)) assert.fail("expected an execution");
    assert.deepEqual(executorCwd.metadata, ['{"cwd": "sub"}']);
    const read = oneStatement("````READ [python3] (tool.py)````");
    assert.equal(read.op, "READ");
    assert.equal(read.target?.raw, "tool.py");
    assert.deepEqual(read.metadata, ["python3"], "the resource owner validates opaque metadata, not the grammar");
});
});

describe("anchor-offset", () => {
const marksOf = (heading: string) => {
    const result = PlurnkParser.parse(heading.startsWith("````EDIT") ? `${heading}\nbody\n\`\`\`\`` : `${heading}\n\`\`\`\``);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], heading);
    const [statement] = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    return statement !== undefined && "lineMarker" in statement ? statement.lineMarker?.marks : undefined;
};

test("{§op-methods-op-dispatch} recorded offset scopes read as anchor-relative marks", () => {
    assert.deepEqual(marksOf("````EDIT (tests/test_laws.py) <@wtxRn,+1> <!-- register after Result -->"), ["@wtxRn", "@wtxRn+1"]);
    assert.deepEqual(marksOf("````EDIT (world.ts) <@QLTY4,@LVx89+1> <!-- drop duplicated set signature -->"), ["@QLTY4", "@LVx89+1"]);
    assert.deepEqual(marksOf("````EDIT (catalog.md) <@ormjQ+1>"), ["@ormjQ+1"]);
    assert.deepEqual(marksOf("````EDIT (catalog.md) <@ormjQ-2,@ormjQ>"), ["@ormjQ-2", "@ormjQ"]);
});

test("{§op-methods-op-dispatch} a bare +N requires a base", () => {
    for (const heading of ["````EDIT (a.md) <+1>"]) {
        const result = PlurnkParser.parse(`${heading}\nbody\n\`\`\`\``);
        assert.ok(result.items.some((item) => item.kind === "error" && item.error.severity === "error"), heading);
    }
    assert.deepEqual(marksOf("````READ (a.md) <1,-1>"), [1, -1], "a negative end is still the numeric end");
});
});

describe("bare-option-object", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
const RECEIPT = (tag: string) => `\`${tag}\` took a bare option object; the taught form is \`[{…}]\`.`;
const MATCHER_ADVISORY = "`{…}` was read as the matcher.";

test("{§slot-order}: SEND reads one JSON object after the target as its option block, the body beneath intact", () => {
    const result = PlurnkParser.parse("````SEND (js:///40968898) {\"eof\": true}\noranges\n````\n");
    const [send] = statements(result);
    assert.equal(send?.op, "SEND");
    if (send?.op !== "SEND") return;
    assert.deepEqual(send.metadata, ["{\"eof\": true}"], "the block is the array form's inner text");
    assert.equal(send.body?.raw, "oranges", "the body is what stood beneath the heading");
    assert.deepEqual(warnings(result), [RECEIPT("SEND")], "one receipt, and no inline-body advisory");
    assert.deepEqual(errors(result), []);
    assert.equal(PlurnkParser.heading(send), "SEND (js:///40968898) [{\"eof\": true}]", "consumers see the taught shape");
});

test("{§slot-order}: BARE and WORK lift the same way as SEND", () => {
    const bare = PlurnkParser.parse("````BARE (workspace:///question.md) {\"model\": \"dumbox\"}\nAnswer briefly.\n````\n");
    const [ask] = statements(bare);
    assert.equal(ask?.op, "BARE");
    if (ask?.op !== "BARE") return;
    assert.deepEqual([ask.metadata, ask.body], [["{\"model\": \"dumbox\"}"], "Answer briefly."]);
    assert.deepEqual(warnings(bare), [RECEIPT("BARE")]);
    const work = PlurnkParser.parse("````WORK (session://child) {\"model\": \"dumbox\"}\nDo the thing.\n````\n");
    const [spawn] = statements(work);
    assert.equal(spawn?.op, "WORK");
    if (spawn?.op !== "WORK") return;
    assert.deepEqual([spawn.metadata, spawn.body], [["{\"model\": \"dumbox\"}"], "Do the thing."]);
    assert.deepEqual(warnings(work), [RECEIPT("WORK")]);
});

test("{§slot-order}: a heading that already carries a block keeps the object as inline body, and braces that are not JSON stay body", () => {
    const carried = PlurnkParser.parse("````SEND (session://peer) [{\"a\": 1}] {\"b\": 2}\nbody\n````\n");
    const [send] = statements(carried);
    assert.equal(send?.op, "SEND");
    if (send?.op !== "SEND") return;
    assert.deepEqual(send.metadata, ["{\"a\": 1}"], "the carried block stands alone");
    assert.equal(send.body?.raw, "{\"b\": 2}\nbody", "the second object is body, as it always was");
    assert.match(warnings(carried).join("\n"), /body text was on the OP line/, "the inline-body advisory, not the receipt");
    const notJson = PlurnkParser.parse("````SEND (session://peer) {nope\nbody\n````\n");
    const [plain] = statements(notJson);
    assert.equal(plain?.op === "SEND" ? plain.body?.raw : null, "{nope\nbody");
    assert.match(warnings(notJson).join("\n"), /body text was on the OP line/);
});

test("{§slot-order} {§diagnostic-observation}: on FIND and READ the object is the matcher, and the advisory says so", () => {
    for (const heading of ["FIND (src/**) {\"debug\": true}", "READ (notes.md) {\"debug\": true}"]) {
        const result = PlurnkParser.parse(`\`\`\`\`${heading}\n\`\`\`\`\n`);
        const [statement] = statements(result);
        assert.ok(statement !== undefined && "matcher" in statement, heading);
        if (!(statement !== undefined && "matcher" in statement)) return;
        assert.equal(statement.matcher?.raw, "{\"debug\": true}", heading);
        assert.equal(statement.metadata, null, heading);
        assert.deepEqual(warnings(result), [MATCHER_ADVISORY], heading);
    }
});
});

describe("executor-heading", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const body = '{"query":"unchanged"}';

for (const tier of ["parse", "parseStatements"] as const) {
    for (const heading of [
        "fresh (lookup)", "FrEsH(lookup)", 'fresh [{"lifetime":"30s"}] (lookup)',
        'fresh (lookup) [{"lifetime":"30s"}]', "fresh <1> (lookup)", "fresh (lookup) <1>",
        'fresh [{"lifetime":"30s"}]', "fresh <1>", "fresh (lookup) <!-- query -->",
    ]) test(`{§fence-pairing}: ${tier} reads ${heading} independently of registration`, () => {
        for (const width of [3, 4, 6]) {
            const fence = "`".repeat(width);
            const source = `${fence}${heading}\n${body}\n${fence}`;
            const unknown = PlurnkParser[tier](source);
            const known = PlurnkParser[tier](source, { executors: ["fresh"] });
            assert.deepEqual(unknown, known, source);
            assert.deepEqual(errors(unknown), [], source);
            const [statement] = statements(unknown);
            assert.ok(statement !== undefined && isExecution(statement), source);
            assert.equal(statement.runtime, "fresh");
            assert.equal(statement.body, body);
            assert.deepEqual(statements(PlurnkParser[tier](PlurnkParser.stringify([statement]))), [statement], "canonical rendering retains every slot and body");
        }
    });

    test(`{§fence-pairing}: ${tier} keeps unknown slotless fences and quoted invocations inert`, () => {
        const call = PlurnkParser.frame("fresh (lookup)", body);
        for (const source of [
            PlurnkParser.frame("fresh", body), PlurnkParser.frame("fresh <!-- example -->", body),
            PlurnkParser.frame("python", "print(1)"), PlurnkParser.frame("markdown", call),
            `~~~~\n${call}\n~~~~`, `\t${call.replaceAll("\n", "\n\t")}`,
            `    ${call.replaceAll("\n", "\n    ")}`, `> ${call.replaceAll("\n", "\n> ")}`,
        ]) assert.deepEqual(statements(PlurnkParser[tier](source)), [], source);
        const known = statements(PlurnkParser[tier](PlurnkParser.frame("fresh", body), { executors: ["fresh"] }));
        assert.deepEqual(known.map(writtenOp), ["fresh"], "the supplied vocabulary permits slotless invocation");
        for (const op of ["SEND", "NOTE", "EDIT (workspace:///example.md) <1>"]) {
            const outer = statements(PlurnkParser[tier](PlurnkParser.frame(op, call)));
            assert.equal(outer.length, 1);
            assert.ok("body" in outer[0]);
            const literal = outer[0].body;
            assert.equal(typeof literal === "string" ? literal : literal?.raw, call, op);
        }
    });

    test(`{§fence-pairing}: ${tier} leaves slot validation and native precedence with the grammar`, () => {
        const native = statements(PlurnkParser[tier](PlurnkParser.frame("READ (x)", null), { executors: ["READ"] }));
        assert.deepEqual(native.map(writtenOp), ["READ"]);
        const malformed = PlurnkParser[tier](PlurnkParser.frame("fresh (a) (b)", body));
        assert.deepEqual(statements(malformed), []);
        assert.ok(errors(malformed).some((error) => error.message === "fresh accepts one `(program)` path at most once"));
        const unclosed = PlurnkParser[tier](PlurnkParser.frame("NOTE", "retained") + "\n\n```fresh (lookup");
        assert.deepEqual(statements(unclosed).map(writtenOp), ["NOTE"]);
        assert.equal(unclosed.unparsedTail?.from.line, 5);
    });
}

test("{§fence-pairing}: unknown invocations retain inline chains, split headings, and missing-closer recovery", () => {
    for (const source of [
        "```fresh (lookup)``` ```READ (x)```",
        "```fresh (lookup)\n``` ```READ (x)```",
        "```fresh (lookup)\n{}\n```READ (x)\n```",
        "```\nfresh (lookup)\n{}\n```\n```READ (x)\n```",
    ]) assert.deepEqual(statements(PlurnkParser.parse(source)).map(writtenOp), ["fresh", "READ"], source);
});

test("{§fence-pairing} {§op-shapes}: explicit invocation slots cannot admit executors from reasoning", () => {
    const read = PlurnkParser.frame("READ (secret)", null);
    assert.deepEqual(PlurnkParser.parseReasoningOperations(PlurnkParser.frame("fresh (lookup)", read)), []);
    assert.deepEqual(PlurnkParser.parseReasoningOperations(PlurnkParser.frame("fresh [{}]", body)), []);
});

test("{§slot-order}: every executor's heading object is body, never inferred metadata", () => {
    for (const runtime of ["sh", "fresh"]) for (const executors of [[], [runtime]]) {
        const parsed = PlurnkParser.parse(`\`\`\`${runtime} (lookup) ${body}\nsecond line\n\`\`\``, { executors });
        const [statement] = statements(parsed);
        assert.ok(statement !== undefined && isExecution(statement));
        assert.equal(statement.metadata, null);
        assert.equal(statement.body, `${body}\nsecond line`);
        assert.deepEqual(errors(parsed).map(({ message }) => message), [
            `\`${runtime}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`,
        ]);
    }
});
});

describe("heading-inline-body", () => {
const TEXTS = { word: "then more", sigil: "/x/", object: '{"a": 1}' } as const;
type Kind = keyof typeof TEXTS;
const fence = "```";
const PLACES = {
    open: (heading: string, text: string) => `${fence}${heading} ${text}\n${fence}`,
    after: (heading: string, text: string) => `${fence}${heading}${fence} ${text}`,
    inside: (heading: string, text: string) => `${fence}${heading} ${text}${fence}`,
    below: (heading: string, text: string) => `${fence}${heading}\n${text}\n${fence}`,
} as const;

type Reading = { matcher?: string; body?: string; metadata?: string[]; advisory?: string; annotation?: string };
type Read = (kind: Kind, text: string, inline: boolean) => Reading;

const inlineBody = (name: string) => `\`${name}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`;
// {§diagnostic-observation} — every source here opens on line 1: unread text stands beside the heading or on line 2.
const ignored = (name: string, inline: boolean) => `${name} takes no body; ${inline ? "the text after its heading on line 1" : "line 2"} was not used.`;
const objectMatcher = "`{…}` was read as the matcher.";
const optionObject = (name: string) => `\`${name}\` took a bare option object; the taught form is \`[{…}]\`.`;

// Selectors belong to the heading; retrieval annotations become separate NOTEs.
const matcherOp = (name: string): Read => (kind, text, inline) => inline
    ? { matcher: text, ...(kind === "object" ? { advisory: objectMatcher } : {}) }
    : name === "READ" || name === "FIND" ? { annotation: text } : { advisory: ignored(name, false) };
// Heading text is the body's first line, named; text beneath is the body.
const bodied = (name: string): Read => (_kind, text, inline) => ({ body: text, ...(inline ? { advisory: inlineBody(name) } : {}) });
// One JSON object on the heading line is the option block; any other heading text is the body.
const optioned = (name: string, empty: string | undefined): Read => (kind, text, inline) => inline && kind === "object"
    ? { metadata: [text], advisory: optionObject(name), ...(empty === undefined ? {} : { body: empty }) }
    : bodied(name)(kind, text, inline);

const SHAPES: readonly (readonly [heading: string, op: string, read: Read])[] = [
    ["FIND (a.md)", "FIND", matcherOp("FIND")],
    ["READ (a.md)", "READ", matcherOp("READ")],
    ["KILL (a.md)", "KILL", matcherOp("This KILL")],
    ["KILL (log:///1/2/3)", "KILL", (kind, text, inline) => inline ? matcherOp("KILL")(kind, text, inline) : { body: text }],
    ["EDIT (a.md) <1>", "EDIT", (kind, text, inline) => inline && kind === "sigil" ? { matcher: text } : bodied("EDIT")(kind, text, inline)],
    ["COPY (a.md) (b.md)", "COPY", (_kind, _text, inline) => ({ advisory: ignored("COPY", inline) })],
    ["MOVE (a.md) (b.md)", "MOVE", (_kind, _text, inline) => ({ advisory: ignored("MOVE", inline) })],
    ["SEND", "SEND", optioned("SEND", undefined)],
    ["SEND (session://x)", "SEND", optioned("SEND", undefined)],
    // BARE, WORK and FORK take an option block only after their target.
    ["BARE", "BARE", bodied("BARE")],
    ["BARE (p.md)", "BARE", optioned("BARE", "")],
    ["WORK", "WORK", bodied("WORK")],
    ["WORK (session://x)", "WORK", optioned("WORK", "")],
    ["FORK", "FORK", bodied("FORK")],
    ["FORK (session://x)", "FORK", optioned("FORK", "")],
    ["sh", "sh", bodied("sh")],
    ["NOTE", "NOTE", bodied("NOTE")],
    ["WAIT", "WAIT", bodied("WAIT")],
    ["SEND [200]", "SEND", (kind, text, inline) => ({ ...bodied("SEND")(kind, text, inline), metadata: ["200"] })],
];

const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh"] });
const nameOf = (statement: object): string => "op" in statement ? String(statement.op) : (statement as { runtime: string }).runtime;
const reading = (statement: Record<string, unknown>): Reading => {
    const body = statement.body as string | { raw: string } | null | undefined;
    const matcher = statement.matcher as { raw: string } | null | undefined;
    const metadata = statement.metadata as string[] | null | undefined;
    return {
        ...(matcher ? { matcher: matcher.raw } : {}),
        ...(body === null || body === undefined ? {} : { body: typeof body === "string" ? body : body.raw }),
        ...(metadata ? { metadata } : {}),
    };
};

for (const [heading, op, read] of SHAPES) {
    test(`{§slot-order} ${heading}: heading text is read by the operation's shape, wherever it is written`, () => {
        for (const [kind, text] of Object.entries(TEXTS) as [Kind, string][]) {
            for (const [place, write] of Object.entries(PLACES)) {
                const source = write(heading, text);
                const label = `${place} ${kind}: ${source}`;
                const result = parse(source);
                assert.equal(result.unparsedTail, undefined, label);
                assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error").map((item) => item.kind === "error" && item.error.message), [], label);
                const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement as unknown as Record<string, unknown>] : []);
                const { advisory, annotation, ...expected } = read(kind, text, place !== "below");
                const expectedOps = annotation === undefined ? [op] : ["NOTE", op];
                assert.deepEqual(statements.map(nameOf), expectedOps, `${label} — the operation is never lost`);
                if (annotation !== undefined) assert.deepEqual(reading(statements[0]), { body: annotation });
                assert.deepEqual(reading(statements.at(-1)!), expected, label);
                assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), advisory === undefined ? [] : [advisory], `${label} — a reading other than the canonical one is named once`);

                const tail = `\n\n${fence}READ (z.md)\n${fence}`;
                const followed = parse(`${source}${tail}`);
                const following = followed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
                assert.deepEqual(following.map(nameOf), [...expectedOps, "READ"], `${label} — the operation after it still runs`);

                const canonical = PlurnkParser.stringify(statements as never[]);
                const again = parse(canonical);
                assert.deepEqual(again.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), advisory === objectMatcher ? [objectMatcher] : [], `${label} — the canonical form ${canonical} reads clean`);
                assert.deepEqual(again.items.flatMap((item) => item.kind === "statement" ? [reading(item.statement as unknown as Record<string, unknown>)] : []), statements.map(reading), `${label} — and reads the same`);
            }
        }
    });
}
});

describe("heading-shape", () => {
for (const path of ["notes.md", "log:///1/2/3", "log://session/1/2/3"]) {
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

test("{§log-kill-scope}: every accepted heading preserves the exact distillation and the following operation", () => {
    for (const path of ["log:///1/2/3", "log://session/1/2/3"]) {
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

test("{§matcher-prefix-claims}: a refused heading still leaves its sibling executable", () => {
    const result = PlurnkParser.parse("```KILL (http://[invalid) <1>\n```READ (after.md)\n```");
    const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(operations.map(writtenOp), ["READ"]);
    const errors = result.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error] : []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "invalid URI in path");
});

test("{§operation-fences}: a reply's wider fence keeps operation examples literal", () => {
    const body = "Example:\n```READ (example.md)\n```\nThe answer continues.";
    for (const heading of ["SEND [200]", "SEND [200] <!-- final -->"]) {
        const result = PlurnkParser.parse(PlurnkParser.frame(heading, body));
        const operations = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(operations.map(writtenOp), ["SEND"]);
        assert.ok(operations[0].op === "SEND");
        assert.equal(operations[0].body?.raw, body);
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

test("{§op-shapes}: an arrow target is a recipient before scope admission", () => {
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
});

describe("heading-slot-order", () => {
const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] });
const errors = (input: string) => parse(input).items.filter((item) => item.kind === "error");
const same = (nearMiss: string, canonical: string) => {
    const strip = (input: string) => parse(input).items.map((item) => item.kind === "statement" ? { ...item.statement, position: undefined } : item);
    assert.deepEqual(errors(nearMiss), [], nearMiss);
    assert.deepEqual(strip(nearMiss), strip(canonical), nearMiss);
};

test("{§fence-pairing} an aside before the remaining slots reads as if written after them", () => {
    same("````READ (workspace:///pantry/alpha.md) <!-- verify content --> <1,-1>\n````", "````READ (workspace:///pantry/alpha.md) <1,-1> <!-- verify content -->\n````");
    same("````FIND (workspace:///pantry/**) <!-- re-confirm pantry state --> <1,-1>\n````", "````FIND (workspace:///pantry/**) <1,-1> <!-- re-confirm pantry state -->\n````");
    same("````sh <-1,2> <!-- full suite --> [{\"cwd\": \"tests\"}]\npytest -q\n````", "````sh <-1,2> [{\"cwd\": \"tests\"}] <!-- full suite -->\npytest -q\n````");
});

test("{§fence-pairing} zero-width characters on a heading line are skipped", () => {
    same("````READ (fastapi/applications.py) <1564,1640> <!-- app.get signature -->\u200d````", "````READ (fastapi/applications.py) <1564,1640> <!-- app.get signature -->````");
});

test("{§fence-pairing} a backtick-quoted sigil matcher is that matcher; quoted plain text stays refused", () => {
    same("````FIND (tests/test_x.py) <1,-1> `^def test_`\n````", "````FIND (tests/test_x.py) <1,-1> ^def test_\n````");
    same("````EDIT (world.ts) `^        reset\\(\\) \\{$`\n        reset() {\n````", "````EDIT (world.ts) ^        reset\\(\\) \\{$\n        reset() {\n````");
    assert.ok(errors("````READ (a.md) `plain`\n````").length > 0);
});

test("{§fence-pairing} an aside followed by a target or a non-JSON block keeps its place and stays refused", () => {
    assert.ok(errors("````sh <!-- Lists issues --> [gitea] (list_issues)\n{}\n````").length > 0);
    assert.ok(errors("````READ (a.md) <!-- why --> (b.md)\n````").length > 0);
});
});

describe("lifecycle-verbs", () => {
const frame = (op: string, body = "") => PlurnkParser.frame(op, body);
const operations = (source: string) => {
    const result = PlurnkParser.parse(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    return result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

test("{§op-shapes} lifecycle verbs have literal bodies and retain tolerant disposition placement", () => {
    for (const op of ["WAIT"]) {
        const body = "A conclusion, not a JSON task inventory.";
        const parsed = operations([frame(op, body), frame("NOTE", "Keep this determination."), frame("READ (notes.md)")].join("\n\n"));
        assert.deepEqual(parsed.map((statement) => statement.op), [op, "NOTE", "READ"]);
        assert.equal("body" in parsed[0] ? parsed[0].body : undefined, body);
        assert.equal("body" in parsed[1] ? parsed[1].body : undefined, "Keep this determination.");
    }
});

test("{§op-shapes} #713: NOTE-only turns continue without a synthetic lifecycle declaration", () => {
    const parsed = operations(frame("NOTE", "The test failed before our change."));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].op, "NOTE");
    assert.equal(PlurnkParser.stringify(parsed), frame("NOTE", "The test failed before our change."));
});

test("{§op-shapes}: reasoning notes preserve literal nested examples", () => {
    const reasoning = [
        "I should remember the observation.",
        frame("NOTE", "The first probe ruled out the network."),
        frame("EDIT (not-a-real-write)", "Never execute a reasoned edit."),
        frame("SEND", frame("NOTE", "This is a quoted example, not a note.")),
        frame("NOTE", "Try the local parser next."),
    ].join("\n\n");
    const notes = PlurnkParser.parseReasoningOperations(reasoning);
    assert.deepEqual(notes.map((note) => note.body), [
        "The first probe ruled out the network.",
        "Try the local parser next.",
    ]);
    assert.ok(notes.every((note) => note.op === "NOTE"));
});

test("{§op-shapes}: enclosing code fences protect quoted NOTE examples", () => {
    const example = frame("NOTE", "This is quoted, not retained memory.");
    for (const enclosing of ["```", "`````", "`````text", "`````sh", "~~~", "~~~markdown"]) {
        const closer = enclosing.match(/^[`~]+/)![0];
        const quoted = `${enclosing}\n${example}\n${closer}`;
        assert.deepEqual(PlurnkParser.parseReasoningOperations(quoted), [], enclosing);
    }
    const source = [
        `\`\`\`\`\`text\n${example}\n\`\`\`\`\``,
        frame("NOTE", "This is the actual determination."),
    ].join("\n\n");
    assert.deepEqual(PlurnkParser.parseReasoningOperations(source).map(({ body }) => body), ["This is the actual determination."]);
    assert.deepEqual(PlurnkParser.parseReasoningOperations(example.split("\n").map((line) => `> ${line}`).join("\n")), []);
});
});

describe("log-heading-notation", () => {
const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh", "python3"] });
const statements = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const errors = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
const heading = (input: string) => PlurnkParser.heading(statements(input)[0]);
// {§parse-recovery} — a refusal with the working form it carries.
const refusal = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [`${item.error.message} ${item.error.recovery}`] : []);

test("{§parse-recovery} `READ → path <scope>` reads the arrow's path as the target and writes the parenthesized line", () => {
    const input = "```READ → sh:///verify-pytest#stdout <1,50>\n```";
    assert.equal(heading(input), "READ (sh:///verify-pytest#stdout) <1,50>");
    assert.deepEqual(errors(input), []);
    assert.deepEqual(warnings(input), ["`→ sh:///verify-pytest#stdout` is how the log shows an address; it was read as the target. Write the target in parentheses: `READ (sh:///verify-pytest#stdout) <1,50>`."]);
});

test("{§parse-recovery} the arrow keeps the pattern and aside after it (recorded FIND), and serves every targeted operation", () => {
    const find = "```FIND → tests/test_ext_autodoc.py /def do_autodoc/ <!-- copy the canonical harness -->\n```";
    assert.equal(heading(find), "FIND (tests/test_ext_autodoc.py) /def do_autodoc/ <!-- copy the canonical harness -->");
    assert.equal(heading("```WAIT → sh:///1d114c27\n```"), "WAIT (sh:///1d114c27)");
    assert.equal(heading("```python3 → repro_redirect.py <!-- run the reproduction script -->\n```"), "python3 (repro_redirect.py) <!-- run the reproduction script -->");
    const kill = statements("```KILL → log:///1/2/3/READ\n```")[0];
    assert.equal(kill.op === "KILL" ? kill.target?.raw : null, "log:///1/2/3/READ", "a targeted KILL, never a deliverable reading `→ …`");
    const copy = "```COPY → a.md → b.md\n```";
    assert.equal(heading(copy), "COPY (a.md) (b.md)");
    assert.equal(warnings(copy).length, 1, "one corrected line for both operands");
});

test("{§parse-recovery} an EDIT's `→ path <anchors> · N` keeps its body whole and drops the charge (recorded glm heading)", () => {
    const input = "``````EDIT → docs/topics/forms/formsets.txt <@hASJm,@PKoTc> · 289\nThe replacement line.\n``````";
    const [edit] = statements(input);
    assert.equal(edit?.op === "EDIT" ? edit.body : null, "The replacement line.");
    assert.equal(heading(input), "EDIT (docs/topics/forms/formsets.txt) <@hASJm,@PKoTc>");
    assert.ok(warnings(input).includes("`· 289` is the token charge the log shows on a heading; it is not part of an operation and was ignored."));
});

test("{§parse-recovery} the token charge is dropped wherever it stands, never read as a glob (recorded orox and qflash headings)", () => {
    for (const [input, canonical, charge] of [
        ["```FIND (tests/urls/**) /Http404/ · 120\n```", "FIND (tests/urls/**) /Http404/", "· 120"],
        ["```READ (sympy/printing/ccode.py) <1,24> <!-- imports --> · 320 tokens\n```", "READ (sympy/printing/ccode.py) <1,24> <!-- imports -->", "· 320 tokens"],
        ["```FIND → tests/delete/settings.py · 60\n```", "FIND (tests/delete/settings.py)", "· 60"],
        ["```READ (a.py) · 50\n```", "READ (a.py)", "· 50"],
    ] as const) {
        assert.equal(heading(input), canonical, input);
        assert.ok(warnings(input).includes(`\`${charge}\` is the token charge the log shows on a heading; it is not part of an operation and was ignored.`), input);
        assert.deepEqual(errors(input), [], input);
    }
    const [note] = statements("``````NOTE · 89\nKept.\n``````");
    assert.equal(note?.op === "NOTE" ? note.body : null, "Kept.", "a charge on a NOTE heading never joins its body");
    const scoped = "```READ → testing/test_assertion.py · <333,350>\n```";
    assert.equal(heading(scoped), "READ (testing/test_assertion.py) <333,350>");
    assert.ok(warnings(scoped).includes("`·` is how the log separates a heading from its token charge; it is not part of an operation and was ignored."));
});

test("{§parse-recovery} ` · words` after the slots or a closed regex is the aside (recorded qflash FIND)", () => {
    const input = "```FIND (sympy/simplify/powsimp.py) /Neg|-\\*\\*|coeff is_Symbol and b\\.is_positive|splitting|extract/i · sign-handling in powsimp\n```";
    const [find] = statements(input);
    assert.equal(find?.aside, "sign-handling in powsimp");
    assert.equal(find?.op === "FIND" ? find.matcher?.raw : null, "/Neg|-\\*\\*|coeff is_Symbol and b\\.is_positive|splitting|extract/i");
    assert.deepEqual(warnings(input), ["`· sign-handling in powsimp` was read as the aside; a note on an operation is written `<!-- sign-handling in powsimp -->`."]);
    assert.equal(statements("```READ (a.py) · first lines\n```")[0]?.aside, "first lines");
});

test("{§parse-recovery} a middle-dot note before a comment is stray text: the comment is the aside (recorded deepseek FIND, #1005)", () => {
    const input = "```FIND (src/_pytest/assertion/util.py) <84,180> \u00B7 no <!-- read the seq/diff helpers -->\n```";
    const [find] = statements(input);
    assert.equal(find?.aside, "read the seq/diff helpers", "the comment wins; nothing nests");
    assert.deepEqual(find?.op === "FIND" ? find.lineMarker : null, { marks: [84, 180] });
    assert.equal(heading(input), "FIND (src/_pytest/assertion/util.py) <84,180> <!-- read the seq/diff helpers -->");
    assert.deepEqual(warnings(input), ["`\u00B7 no` was ignored; the aside is `<!-- read the seq/diff helpers -->`."]);
    assert.equal(statements("```READ (a.py) \u00B7 first lines\n```")[0]?.aside, "first lines", "a dot note with no comment is still the aside");
});

test("{§parse-recovery} {§diagnostic-observation} a target written without parentheses is refused with the operation's working form (recorded headings)", () => {
    assert.deepEqual(errors("```READ sphinx/ext/autodoc/__init__.py <682,695>\n```"), [
        "`READ` has no target: `sphinx/ext/autodoc/__init__.py` stands where the target goes.",
        PlurnkParser.NO_VALID_OPERATION,
    ]);
    // {§parse-recovery} — the recovery is the operation's working form, never the input rewritten.
    assert.deepEqual(refusal("```READ sphinx/ext/autodoc/__init__.py <682,695>\n```"),
        ["`READ` has no target: `sphinx/ext/autodoc/__init__.py` stands where the target goes. `READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line."]);
    assert.deepEqual(refusal("```FIND tests/migrations/test_writer.py /gettext_lazy|^import|^from/\n```"),
        ["`FIND` has no target: `tests/migrations/test_writer.py` stands where the target goes. `FIND (path or glob) <first,last>? pattern? <!-- aside -->?` on the opening fence line."]);
    assert.deepEqual(refusal("```EDIT a.py <1,4>\nnew\n```"),
        ["`EDIT` has no target: `a.py` stands where the target goes. `EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence."]);
    const [send] = statements("```SEND The answer is 42.\n```");
    assert.equal(send?.op === "SEND" ? send.body?.raw : null, "The answer is 42.", "a targetless SEND's heading text stays its message");
});

test("{§parse-recovery} an EDIT's bare `@hash` or `@start,@end` is its scope, never body (recorded rtx5070 headings)", () => {
    const one = "```EDIT (sympy/utilities/iterables.py) @ZLWyt\n    yield ms\n```";
    const [edit] = statements(one);
    assert.deepEqual(edit?.op === "EDIT" ? edit.lineMarker : null, { marks: ["@ZLWyt"] });
    assert.equal(edit?.op === "EDIT" ? edit.body : null, "    yield ms");
    assert.deepEqual(warnings(one), ["`@ZLWyt` was read as the scope `<@ZLWyt>`; a scope is written in angle brackets."]);
    const range = statements("```EDIT (src/_pytest/assertion/util.py) @xaVKr,@YZ8So <!-- widen -->\nbody\n```")[0];
    assert.deepEqual(range?.op === "EDIT" ? range.lineMarker : null, { marks: ["@xaVKr", "@YZ8So"] });
    assert.equal(range?.aside, "widen");
    const read = statements("```READ (tests/test_mock.py) @patch\n```")[0];
    assert.equal(read?.op === "READ" ? read.matcher?.raw : null, "@patch", "on READ it stays the literal search");
    assert.deepEqual(refusal("```EDIT (requests/sessions.py) <91> @HecMB\nx\n```"),
        ["A resource selection takes one scope, and `<91>` and `<@HecMB>` both stand here. One scope per selection, such as `<12,40>` or `<@abcde,+5>`."]);
});

test("{§slot-order} {§diagnostic-observation} two scopes on one resource are refused with the scope's working form, never a reading of the pair", () => {
    assert.deepEqual(refusal("```READ (doc/usage.rst) <@wC8Pt> <-1>\n```"),
        ["A resource selection takes one scope, and `<@wC8Pt>` and `<-1>` both stand here. One scope per selection, such as `<12,40>` or `<@abcde,+5>`."]);
    assert.deepEqual(refusal("```READ (sklearn/model_selection/_split.py) <105,106> <1066,1300>\n```"),
        ["A resource selection takes one scope, and `<105,106>` and `<1066,1300>` both stand here. One scope per selection, such as `<12,40>` or `<@abcde,+5>`."]);
});
});

describe("optional-task", () => {
for (const [source, expected] of [
    ["````READ (notes.md)````", ["READ"]],
    ["````SEND\nProgress update.\n````", ["SEND"]],
    ["````EDIT (notes.md)\n```WAIT\nLiteral example.\n```\n````", ["EDIT"]],
    ["````READ (notes.md)````\n\n````KILL (log:///**/READ) <17,-1>````", ["READ", "KILL"]],
] as const) {
    test(`{§whitespace-contract} omitted WAIT preserves only authored operations: ${expected.join(",")}`, () => {
        const result = PlurnkParser.parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error] : []), []);
        const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map(({ op }) => op), expected);
        assert.ok(statements.every(({ position }) => position.line > 0));
    });
}

test("{§whitespace-contract} omitted WAIT does not hide a sibling's refused matcher ({§matcher-prefix-claims})", () => {
    const result = PlurnkParser.parse("````READ (notes.md)````\n\n````FIND (*) /broken/ trailing````");
    assert.equal(result.unparsedTail, undefined);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["READ", "FIND"]);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), []);
    const find = statements[1];
    assert.equal(find.op === "FIND" && find.matcher?.dialect === "unreadable" ? find.matcher.message : null,
        "Regex matcher has trailing text after `/pattern/flags`.");
});
});

describe("retrieval-annotations", () => {
const bodies = ["Check the configured timeout.", "/timeout/", "$.timeout", "//timeout", "~timeout", "&timeout", "<!-- inspect defaults -->", "First thought.\nSecond thought."];

for (const op of ["READ", "FIND"]) {
    for (const body of bodies) {
        test(`{§op-shapes}: ${op} preserves ${JSON.stringify(body)} as memory, never as selection`, () => {
            const source = PlurnkParser.frame(`${op} (config.ts)`, body);
            const parsed = PlurnkParser.parse(source);
            assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
            const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", op]);
            assert.equal("body" in statements[0] ? statements[0].body : undefined, body);
            assert.equal("body" in statements[1] ? statements[1].body : undefined, null);
            assert.equal("matcher" in statements[1] ? statements[1].matcher : undefined, null);
            assert.equal(statements[1].aside, null);
            const canonical = PlurnkParser.stringify(statements);
            assert.equal(canonical, `${PlurnkParser.frame("NOTE", body)}\n\n${PlurnkParser.frame(`${op} (config.ts)`, null)}`);
            const again = PlurnkParser.parse(canonical);
            assert.deepEqual(again.items.filter((item) => item.kind === "error"), []);
            const reasoning = PlurnkParser.parseReasoningOperations(source);
            assert.deepEqual(reasoning.map((statement) => statement.op), ["NOTE", op]);
            assert.equal(reasoning[0].body, body);
        });
    }
    test(`{§op-shapes}: ${op} keeps header selection independent of its annotation`, () => {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (config.ts) /timeout/ <!-- inspect -->`, "/not-a-selector/"));
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal("body" in statements[0] ? statements[0].body : undefined, "/not-a-selector/");
        assert.equal("matcher" in statements[1] ? statements[1].matcher?.raw : undefined, "/timeout/");
        assert.equal(statements[1].aside, "inspect");
    });
}

test("{§op-shapes}: grouped READs retain one annotation; quoted operations stay literal", () => {
    const body = PlurnkParser.frame("EDIT (unwanted.ts)", "never execute this quotation");
    const parsed = PlurnkParser.parse(PlurnkParser.frame("READ (a.ts) (b.ts)", body));
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "READ", "READ"]);
    assert.equal("body" in statements[0] ? statements[0].body : undefined, body);
});
});

describe("scope-on-scopeless", () => {
const recorded = (prefix: string) => {
    const dir = new URL("../fixtures/recorded/", import.meta.url);
    const name = readdirSync(dir).find((entry) => entry.startsWith(prefix));
    assert.ok(name, `a recorded fixture named ${prefix}*`);
    return readFileSync(new URL(name, dir), "utf8");
};
const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh", "python3"] });
const statements = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const diagnostics = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" ? [`${item.error.severity}: ${item.error.message}`] : []);

test("{§slot-order} zai run426: `WORK (session://…) <1,-1>` runs the WORK with its whole task and names the ignored scope (recorded)", () => {
    const text = recorded("zai-run426-");
    const executed = statements(text);
    const work = executed.find((statement) => statement.op === "WORK");
    assert.ok(work, "the WORK ran");
    assert.equal(work.op === "WORK" ? work.target?.raw : null, "session://deprecation-implementer");
    assert.equal(work.lineMarker, null);
    assert.ok((work.op === "WORK" ? work.body : "").length > 200, "the child's complete task is the body");
    const line = text.split("\n").findIndex((entry) => entry.startsWith("```WORK (session://deprecation-implementer) <1,-1>")) + 1;
    assert.ok(line > 0);
    assert.ok(diagnostics(text).includes("warning: `WORK` takes a target only; the scope `<1,-1>` was ignored."), diagnostics(text).join("\n"));
    assert.ok(!diagnostics(text).some((entry) => entry.startsWith("error:")), "no hard diagnostic, no dead turn");
});

test("{§slot-order} FORK, BARE, NOTE and a recipientless SEND drop a scope in any position; a recipient SEND keeps its scope", () => {
    for (const [input, op, message] of [
        ["```FORK (session://x) <@abcde,@fghij>\nTask.\n```", "FORK", "`FORK` takes a target only; the scope `<@abcde,@fghij>` was ignored."],
        ["```BARE <3> <!-- why -->\nPrompt.\n```", "BARE", "`BARE` takes a target only; the scope `<3>` was ignored."],
        ["```WORK <1,-1> (session://x)\nTask.\n```", "WORK", "`WORK` takes a target only; the scope `<1,-1>` was ignored."],
        ["```NOTE <3>\nRemember.\n```", "NOTE", "`NOTE` takes no target or scope; the scope `<3>` was ignored."],
        ["```SEND <3>\nhi\n```", "SEND", "`SEND` without a recipient takes no scope; the scope `<3>` was ignored."],
    ] as const) {
        const [statement] = statements(input);
        assert.equal(statement?.op, op, input);
        assert.equal(statement !== undefined && "lineMarker" in statement ? statement.lineMarker : "missing", null, input);
        assert.deepEqual(diagnostics(input), [`warning: ${message}`], input);
    }
    const [send] = statements("```SEND (session://a) <3>\nhi\n```");
    assert.deepEqual(send?.op === "SEND" ? send.lineMarker : null, { marks: [3] }, "{§op-shapes}: a recipient SEND carries its scope to the recipient");
    assert.equal(statements("```BARE <!-- aside -->\nPrompt.\n```")[0]?.aside, "aside", "an aside is not a scope");
});
});

describe("well-formed-bodies", () => {
const json = (runtime: string, body: string): boolean => {
    if (runtime !== "gitea") return true;
    try { JSON.parse(body); return true; } catch { return false; }
};
const bodies = (source: string, wellFormed?: typeof json) => PlurnkParser.parse(source, { executors: ["gitea"], ...(wellFormed === undefined ? {} : { wellFormed }) }).items
    .flatMap((item) => {
        if (item.kind !== "statement" || !("body" in item.statement)) return [];
        const { body } = item.statement;
        return [typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? null];
    });

// An MCP call, then prose that later shows a bare block of its own.
const SOURCE = [
    "So I can invoke:", "", "```gitea (list_issues)", "{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"}", "```", "",
    "But I need owner/repo first.", "", "```", "git remote -v", "```", "", "Let me check.",
].join("\n");

test("{§fence-pairing}: a JSON-bodied call ends at its own closer when the longer reading is not JSON", () => {
    assert.deepEqual(bodies(SOURCE, json), ["{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"}"]);
});

test("{§fence-pairing}: a trailing aside is the writer's, and does not make a JSON body malformed", () => {
    const source = SOURCE.replace("\"plurnk-service\"}", "\"plurnk-service\"} <!-- open issues -->");
    assert.deepEqual(bodies(source, json), ["{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"} <!-- open issues -->"]);
});

test("{§fence-pairing}: a runtime with no declared media type keeps the fence-only reading", () => {
    const [body] = bodies(SOURCE);
    assert.ok(body!.includes("git remote -v"), "without a check the call keeps its nested reading");
});

test("{§slot-order}: an executor's heading object is input for both a JSON tool and a shell", () => {
    const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh", "gitea"] }).items;
    const statement = (source: string) => parse(source).flatMap((item) => item.kind === "statement" ? [item.statement as { metadata: readonly string[] | null; body: unknown }] : [])[0];
    const warnings = (source: string) => parse(source).flatMap((item) => item.kind === "error" ? [item.error.message] : []);
    const mcp = "```gitea (list_issues) {\"owner\":\"plurnk\"}\n```";
    assert.deepEqual([statement(mcp).metadata, statement(mcp).body], [null, "{\"owner\":\"plurnk\"}"], "an MCP tool's heading object is its arguments body");
    assert.deepEqual(warnings(mcp), ["`gitea` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line."]);
    const shell = "```sh {\"cwd\":\"/tmp\"}\nls\n```";
    assert.deepEqual([statement(shell).metadata, statement(shell).body], [null, "{\"cwd\":\"/tmp\"}\nls"], "unbracketed input is not promoted to authority-bearing metadata");
    assert.deepEqual(warnings(shell), ["`sh` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line."]);
    const bracketed = "```sh [{\"stdin\":\"open\"}]\ncat\n```";
    assert.deepEqual([statement(bracketed).metadata, statement(bracketed).body], [["{\"stdin\":\"open\"}"], "cat"]);
    assert.deepEqual(warnings(bracketed), []);
});
});

describe("wrapped-examples", () => {
const ops = (text: string) => PlurnkParser.parse(text, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyOf = (statement: unknown): string => {
    const body = (statement as { body?: unknown }).body;
    return typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? "";
};

const wrapped = (op: string, example: string): string => "````\n```" + op + "\n" + example + "```\n````";
const REPLY_BODY = [
    "# Operations",
    "",
    "**NOTE** — working memory.",
    wrapped("NOTE <!-- plan -->", "Survey, then state the request.\n"),
    "",
    "**EDIT** — replace text by pattern.",
    wrapped("EDIT (notes.md) /draft/i", "final\n"),
    "",
    "**KILL** — retire log items.",
    wrapped("KILL (log:///1/[1-7]/*/{READ,emission})", ""),
    "",
    "Nothing above was executed.",
].join("\n");
const PLAN = "```NOTE <!-- plan -->\nExplain without running anything.\n```\n\n";

test("{§fence-pairing}: a reply narrower than the fences wrapping its examples still holds them", () => {
    // The outer fence is three wide and the wrappers four, closed as the author closed it: with a wrapper's width.
    const statements = ops(PLAN + "```SEND [200]\n" + REPLY_BODY + "\n````");
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "SEND"]);
    assert.equal(bodyOf(statements[1]), REPLY_BODY);
});

test("{§operation-fences}: the canonical wider outer fence reads the same reply identically", () => {
    const statements = ops(PLAN + "`````SEND [200]\n" + REPLY_BODY + "\n`````");
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "SEND"]);
    assert.equal(bodyOf(statements[1]), REPLY_BODY);
});

test("{§fence-pairing}: an example quoted at the reply's own width still ends the reply and runs", () => {
    const statements = ops("```SEND [200]\nUse this form:\n```\n```READ (a.md) <1,5>\n```\n```\nThat is all.\n```");
    assert.deepEqual(statements.map((statement) => statement.op), ["SEND", "READ"]);
    assert.equal(bodyOf(statements[0]), "Use this form:");
});
});
