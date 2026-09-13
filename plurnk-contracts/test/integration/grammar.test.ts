import test from "node:test";
import assert from "node:assert/strict";
import {
    PlurnkParser,
    PlurnkParseError,
    Validator,
    parsePath,
    type PlurnkOp,
    type Plan,
} from "../../src/index.ts";

type Op = PlurnkOp;

// {§fence-heading-in-body} — the executors these witnesses invoke, as the host would name them.
const EXECUTORS = ["sh", "bash", "node", "python3", "gitea", "brave", "search-api", "example", "plurnk", "crm", "c++", "jq"];
const section = (op: Op, slots = "", body?: string): string => PlurnkParser.frame(op + slots, body ?? null);

const sections = (...values: string[]): string => values.join("\n\n");
const inventory = (content: string, status: Plan[number]["status"] = "in_progress") =>
    JSON.stringify([{ content, status }]);

const errorsOf = (input: string) =>
    PlurnkParser.parseStatements(input, { executors: EXECUTORS }).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

const oneStatement = (input: string) => {
    const result = PlurnkParser.parseStatements(input, { executors: EXECUTORS });
    // hard errors only — a tolerated form may carry a warning-severity advisory ({§heading-inline-body})
    assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], input);
    assert.equal(result.unparsedTail, undefined, input);
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.equal(statements.length, 1, input);
    return statements[0]!.statement;
};

const firstError = (input: string): PlurnkParseError => {
    const error = errorsOf(input)[0];
    assert.ok(error, input);
    return error;
};

// {§parse-diagnostics} {§error-shape}
test("PlurnkParseError keeps diagnostic text separate from structured context", () => {
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

test("protocol operations parse as executable fences", () => {
    const cases: Array<[Op, string, string | undefined]> = [
        ["TASK", "", "inspect, act, report"],
        ["TASK", " <5>", "[]"],
        ["FIND", " (known:///**) <1,20> [{\"pattern\": \"Paris*\"}]", undefined],
        ["READ", " (README.md)", undefined],
        ["EDIT", " (notes.md) <2>", "replacement"],
        ["COPY", " (notes.md) (archive.md) <0>", undefined],
        ["MOVE", " (notes.md) (archive.md)", undefined],
        ["KILL", " (log:///**) <@aB3dE> [{\"pattern\": \"~topic\"}]", undefined],
        ["KILL", " (log:///**) <17,-1>", undefined],
        ["SEND", " (worker://child)", "progress"],
        ["EXEC", " (node/./) <60,5>", "console.log(1)"],
        ["BARE", "", "What is the capital of Germany?"],
        ["WORK", " (worker://child)", "do the work"],
        ["FORK", " (worker://child)", "recheck the work"],
        ["KILL", " (worker://child)", undefined],
    ];

    for (const [op, slots, body] of cases) {
        const statement = oneStatement(section(op, slots, body));
        assert.equal(statement.op, op, op);
        assert.equal(Object.hasOwn(statement, "delimiter"), false, op);
    }
});

test("{§send-directed-scope}: directed SEND preserves numeric timing without changing its body or disposition", () => {
    for (const [scope, components] of [["<60>", [60]], ["<0,60>", [0, 60]]] as const) {
        const statement = oneStatement(section("SEND", ` (worker://reviewer) ${scope} <!-- recurring check -->`, "Check for updates."));
        assert.equal(statement.op, "SEND");
        if (statement.op !== "SEND") return;
        assert.equal(Object.hasOwn(statement, "status"), false);
        assert.deepEqual(statement.lineMarker?.marks, components);
        assert.equal(statement.aside, "recurring check");
        assert.deepEqual(statement.body, { raw: "Check for updates.", json: null });
    }
    assert.ok(errorsOf(section("SEND", " <0,60>", "No recipient.")).length > 0);
});

test("trailing operation asides are durable, single-line, and follow every modifier", () => {
    const statement = oneStatement([
        "```gitea (list_issues) <!-- Lists issues (details: worker:///_plurnk/tools/gitea/list_issues.md) -->",
        "{\"owner\":\"plurnk\",\"repo\":\"plurnk-service\"}",
        "```",
    ].join("\n"));
    assert.equal(
        statement.aside,
        "Lists issues (details: worker:///_plurnk/tools/gitea/list_issues.md)",
    );
    assert.equal(oneStatement("```READ (README.md)```").aside, null);
    assert.equal(oneStatement("```READ (README.md) <!-- -->```").aside, "");

    for (const input of [
        "```EXEC <!-- Lists issues --> [gitea] (list_issues)\n{}\n```",
        "```gitea (list_issues) <!-- Lists\nissues\n-->\n{}\n```",
        "```gitea (list_issues) <!-- Lists issues\n{}```",
    ]) {
        assert.ok(errorsOf(input).length > 0 || PlurnkParser.parseStatements(input).unparsedTail !== undefined, input);
    }
});

test("balanced parentheses are ordinary target content", () => {
    const statement = oneStatement(section(
        "FIND",
        " (https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)) [{\"pattern\": \"/spouse|wife|married|Zhannetta|Lotnik/i\"}]",
    ));
    if (statement.op !== "FIND") assert.fail("expected FIND");
    assert.equal(statement.target?.raw, "https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)");
    assert.equal(statement.matcher?.dialect, "regex");
});

test("unmatched target parentheses require escaped or percent-encoded spelling", () => {
    assert.ok(errorsOf("```READ (https://example.test/a)b)```").length > 0);

    const unclosed = PlurnkParser.parseStatements("```READ (https://example.test/a(b");
    assert.equal(unclosed.items.length, 0);
    assert.match(unclosed.unparsedTail?.reason ?? "", /target slot of `READ`.*add `\)`/);

    for (const encoded of ["a%28b", "a%29b"]) {
        assert.equal(oneStatement(section("READ", ` (https://example.test/${encoded})`)).op, "READ");
    }
});

test("an unfinished metadata modifier names only its structural repair", () => {
    const secret = "Bearer secret-that-must-not-echo";
    const parsed = PlurnkParser.parseStatements(
        `\`\`\`READ (https://example.test/data) [{"Authorization": "${secret}"`,
    );
    assert.equal(parsed.items.length, 0);
    assert.equal(
        parsed.unparsedTail?.reason,
        "metadata modifier of `READ` opened at line 1 but never closed - add `]`",
    );
    assert.equal(parsed.unparsedTail?.reason.includes(secret), false);
});

test("target escapes preserve literal and percent-encoded URI spelling", () => {
    const statement = oneStatement(("```READ (https://example.test/x?literal=\\)&encoded=%29#preview\\()```"));
    if (statement.op !== "READ") assert.fail("expected READ");
    assert.equal(statement.target?.raw, "https://example.test/x?literal=)&encoded=%29#preview(");
    if (statement.target?.kind !== "url") assert.fail("expected URL target");
    assert.equal(statement.target.query, "literal=)&encoded=%29");
    assert.equal(statement.target.fragment, "preview(");
});

test("COPY and MOVE destinations use the target escape layer", () => {
    const statement = oneStatement(("```COPY (worker:///draft) (https://example.test/archive?literal=\\)&encoded=%29)```"));
    if (statement.op !== "COPY" || statement.destination.target.kind !== "url") assert.fail("expected COPY URL destination");
    assert.equal(statement.destination.target.raw, "https://example.test/archive?literal=)&encoded=%29");
    assert.equal(statement.destination.target.query, "literal=)&encoded=%29");
});

test("a COPY destination path excludes the whitespace before its scope", () => {
    const statement = oneStatement("```COPY (prompt://alice/1/1) (worker://alice/prompts.md) <-1>```");
    if (statement.op !== "COPY") assert.fail("expected COPY");
    assert.equal(statement.destination.target.raw, "worker://alice/prompts.md");
    assert.equal(statement.destination.target.kind === "url" ? statement.destination.target.hostname : null, "alice");
    assert.deepEqual(statement.destination.lineMarker, { marks: [-1] });
});

// {§transfer-resource-selections}
test("COPY and MOVE bind a terminal scope to the immediately preceding operand", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        const statement = oneStatement(section(op, " (worker:///src.md) <2,3> (worker:///slice.md) <0>"));
        if (statement.op !== op) assert.fail(`expected ${op}`);
        assert.deepEqual(statement.source.lineMarker, { marks: [2, 3] });
        assert.deepEqual(statement.destination.lineMarker, { marks: [0] });

        const result = PlurnkParser.parseStatements(section(op, " (worker:///src.md) (worker:///slice.md) <0>:"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1);
    }
});

test("{§error-shape} invalid EXEC scopes name the supplied scope and timing constraint", () => {
    for (const slots of [" (sh/curl submit) <30s>", " (crm/crm_query) <crm:///1/6/1>", " (pm/pm_search_issues) <poll>"]) {
        const result = PlurnkParser.parseStatements(section("EXEC", slots, "{}"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1, slots);
        assert.equal(errors[0]?.error.source, "lexer");
        assert.equal(errors[0]?.error.message, `invalid EXEC scope ${JSON.stringify(slots.slice(slots.indexOf("<")))}; use minutes, e.g. \`<5,1>\``, slots);
    }
    // Slot spacing does not change the meaning of an invalid scope.
    const glued = PlurnkParser.parseStatements(section("READ", " (notes.md)<foo>"));
    const gluedErrors = glued.items.filter((item) => item.kind === "error");
    assert.ok(gluedErrors.length >= 1);
    assert.match(gluedErrors[0]?.error.message ?? "", /invalid READ scope "<foo>"/);
});

test("{§error-shape} malformed FIND scopes get one relevant correction and preserve later operations", () => {
    for (const scope of ["<matchLocation,1,16>", "<result range>", "<match locations>"]) {
        const result = PlurnkParser.parseStatements(sections(
            section("FIND", ` (😀/src/*.ts) ${scope}`, "/groupBy/"),
            section("TASK", "", inventory("continue")),
        ));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.error.message, `invalid FIND scope ${JSON.stringify(scope)}; use numeric result positions, e.g. \`<1,16>\``);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["TASK"]);
        assert.equal(result.unparsedTail, undefined);
    }
});

test("{§error-shape} invalid text and wait scopes do not borrow another operation's contract", () => {
    for (const op of ["READ", "EDIT", "COPY", "MOVE", "KILL"] as const) {
        const error = firstError(section(op, " (a.md) <line number>"));
        assert.equal(error.message, `invalid ${op} scope "<line number>"; use numeric coordinates or \`@hash\` line anchors`);
    }
    assert.equal(firstError(section("TASK", " <30s>")).message, "invalid TASK scope \"<30s>\"; use minutes, e.g. `<5,1>`");
    for (const op of ["BARE", "WORK", "FORK"] as const) {
        assert.equal(firstError(section(op, " <result range>")).message,
            `invalid ${op} scope "<result range>"; this operation takes no scope`);
    }
    assert.equal(firstError(section("FIND", " (src/*.ts) <result range>", undefined)).message,
        "invalid FIND scope \"<result range>\"; use numeric result positions, e.g. `<1,16>`");
});

test("{§error-shape} scope excerpts stop at a delimiter, line ending, or bounded length", () => {
    for (const [input, excerpt] of [
        ["<result range> <!-- unrelated -->", "<result range>"],
        ["<result range\nprivate body", "<result range"],
        ["<result range\r\nprivate body", "<result range"],
        ["<result range", "<result range"],
        [`<${"x".repeat(100)}>`, `<${"x".repeat(63)}…`],
    ]) {
        assert.equal(firstError("```FIND (src/*.ts) " + input + "\n```").message,
            `invalid FIND scope ${JSON.stringify(excerpt)}; use numeric result positions, e.g. \`<1,16>\``);
    }
});

test("COPY and MOVE require exactly two singular path operands", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        const statement = oneStatement(section(op, " (brief.md) (drafts/brief.md)"));
        if (statement.op !== op) assert.fail(`expected ${op}`);
        assert.equal(statement.source.target.raw, "brief.md");
        assert.equal(statement.destination.target.raw, "drafts/brief.md");

        assert.ok(errorsOf(section(op, " (brief.md)", "drafts/brief.md")).length >= 1, `${op} rejects a destination body`);
        assert.ok(errorsOf(section(op, " (brief.md) (drafts/brief.md) (extra.md)")).length >= 1, `${op} rejects a third path`);
    }

    const read = PlurnkParser.parseStatements(section("READ", " (brief.md) (drafts/brief.md)"));
    const readErrors = read.items.filter((item) => item.kind === "error");
    assert.equal(readErrors[0]?.error.message, "a heading takes exactly one `(path)` slot; a pattern belongs in the heading as `[{\"pattern\": \"…\"}]`");
});

test("{§bare-statement} BARE accepts a prompt resource, inline input, or both", () => {
    for (const body of [undefined, "Compare the conclusions."]) {
        const statement = oneStatement(section("BARE", " (worker://alice/prompt.md) <!-- isolated review -->", body));
        if (statement.op !== "BARE") assert.fail("expected BARE");
        assert.equal(statement.target?.raw, "worker://alice/prompt.md");
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

    const body = "```BARE (prompt://alice/1/1)```";
    const fenced = PlurnkParser.parseStatements(section("TASK", "", body));
    assert.equal(fenced.items.some((item) => item.kind === "statement" && item.statement.op === "BARE"), false);
    const send = fenced.items.find((item) => item.kind === "statement")?.statement;
    assert.deepEqual(send?.op === "TASK" ? send.body : null, [{ content: body, status: "in_progress" }]);
});

test("resource-selection admission leaves angle brackets elsewhere in URLs untouched", () => {
    const global = parsePath("https://example.test/a<0>:");
    if (global?.kind !== "url") assert.fail("expected global URL admission");
    assert.equal(global.raw, "https://example.test/a<0>:");
    assert.equal(global.pathname, "/a%3C0%3E:");

    for (const [op, destination] of [
        ["COPY", "https://example.test/a%3Cdraft%3E/next"],
        ["MOVE", "https://example.test/a%3C0%3E:tail"],
        ["COPY", "https://example.test/a%3C0%3E:"],
    ] as const) {
        const statement = oneStatement(section(op, ` (worker:///src.md) (${destination})`));
        if (statement.op !== op) assert.fail(`expected ${op}`);
        assert.equal(statement.destination.target.raw, destination);
    }
});

test("empty sections normalize to their operation-owned empty values", () => {
    for (const [op, slots] of [
        ["FIND", " (a)"],
        ["READ", " (a)"],
        ["EDIT", " (a) <1>"],
        ["KILL", " (log:///1)"],
        ["SEND", " (worker://child)"],
        ["EXEC", ""],
        ["BARE", ""],
        ["WORK", " (worker://child)"],
        ["FORK", " (worker://child)"],
        ["KILL", " (a)"],
    ] as const) {
        const statement = oneStatement(section(op, slots));
        assert.equal("body" in statement ? statement.body : undefined, op === "BARE" || op === "WORK" || op === "FORK" ? "" : null, op);
    }
    for (const op of ["COPY", "MOVE"] as const) {
        const statement = oneStatement(section(op, " (a) (b)"));
        assert.equal("body" in statement, false, op);
    }
    const task = oneStatement(section("TASK"));
    assert.equal(task.op, "TASK");
    assert.deepEqual("body" in task ? task.body : null, []);
});

// {§plan-slotless}: bracketed inline JSON is structurally a signal modifier;
// it must never be admitted as an empty semantic Plan.
test("TASK takes a heading-line inventory block with one advisory ({§one-line-turn}) and still rejects a path slot", () => {
    const inlineArray = "```TASK [{\"content\":\"keep this\",\"status\":\"pending\"}]\n```";
    const result = PlurnkParser.parseStatements(inlineArray);
    const errors = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.deepEqual(errors.map(({ message, source, severity }) => ({ message, source, severity })), [{
        message: "TASK's inventory was read from the heading line; it belongs in the body.",
        source: "parser",
        severity: "warning",
    }]);
    const task = result.items.find((item) => item.kind === "statement" && item.statement.op === "TASK");
    assert.ok(task !== undefined && task.kind === "statement" && task.statement.op === "TASK");
    assert.deepEqual(task.statement.body, [{ content: "keep this", status: "pending" }], "the block is the inventory, not a modifier");

    const all = firstError("```TASK (notes.md) <1>\n[{\"content\":\"Continue the task.\",\"status\":\"in_progress\"}]\n```");
    assert.equal(all.message, "unexpected `(` (`(path)` slot opener); expected operation fence header, operation-heading line ending, closing fence, or body content");
});

// {§bare-statement}
test("same-lane sections compose and section whitespace is structural", () => {
    const result = PlurnkParser.parseStatements(sections(
        section("EDIT", " (a)", "one"),
        section("READ", " (b)"),
        section("EDIT", " (c)", "three"),
    ));
    assert.equal(result.items.filter((item) => item.kind === "statement").length, 3);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
    assert.equal(result.items.length, 3);
});

test("{§closer-fallback}: a heading whose target never closes is one bounded error and its siblings survive", () => {
    const result = PlurnkParser.parseStatements(section("EDIT", " (first.md)", "one") + "\n`````EDIT (broken\n" + section("EDIT", " (third.md)", "three"));
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.deepEqual(statements.map((item) => "target" in item.statement ? item.statement.target?.raw : null), ["first.md", "third.md"]);
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "error" && item.error.severity === "error").length, 1);
});
test("{§closer-fallback}: only an unfinished heading slot loses the boundary; a missing closer never does", () => {
    assert.equal(PlurnkParser.parseStatements(section("EDIT", " (p)", "body")).unparsedTail, undefined);
    assert.ok(PlurnkParser.parseStatements("```EDIT (path").unparsedTail);
    assert.ok(PlurnkParser.parseStatements('```EDIT (p) [{"meta"').unparsedTail);
    const open = PlurnkParser.parseStatements("```EDIT (p)\nbody");
    assert.equal(open.unparsedTail, undefined);
    assert.equal(open.items.some((item) => item.kind === "statement" && item.statement.op === "EDIT" && item.statement.body === "body"), true);
});
test("{§turn-shape}: TASK-less programs preserve authored positions without EOF diagnostics", () => {
    for (const { source, line } of [
        { source: "```sh\ncat <<'EOF'\nhello\nEOF\n```", line: 1 },
        { source: "\r\n```READ (notes.md)```", line: 2 },
        { source: "```EDIT (notes.md)\n🧪é\n```", line: 1 },
        { source: "```READ (notes.md) <1,2>```", line: 1 },
    ]) {
        const result = PlurnkParser.parse(source);
        assert.deepEqual(result.items.map(({ kind }) => kind), ["statement"], source);
        assert.equal(result.unparsedTail, undefined, source);
        const statement = result.items[0];
        assert.ok(statement.kind === "statement");
        assert.deepEqual(statement.statement.position, { line, column: 0 }, source);
    }
});
test("{§turn-shape}: a TASK-less program retains an independent scope recovery warning", () => {
    const result = PlurnkParser.parse("```READ (notes.md<1,2>)```");
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
// {§turn-shape} {§fence-boundary}
test("omitted TASK leaves literal nested programs intact", () => {
    const body = "```SEND\nquoted text\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
    const result = PlurnkParser.parse(sections(section("EDIT", " (quoted.md)", body)));
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["EDIT"]);
    assert.equal(statements[0]?.op === "EDIT" ? statements[0].body : null, body);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
});
test("a disposition inside EDIT is data and does not conclude a turn", () => {
    const result = PlurnkParser.parse(section("EDIT", " (example.md)", "```TASK\n[{\"content\":\"inspect\",\"status\":\"in_progress\"}]\n```"));
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["EDIT"]);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
});
test("model turns without TASK or SEND stand as written", () => {
    const planless = PlurnkParser.parse(sections(
        section("READ", " (worker:///notes.md)"),
        section("TASK", "", inventory("continue")),
    ));
    assert.equal(planless.unparsedTail, undefined);
    const planlessStatements = planless.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(planlessStatements.map(({ op }) => op), ["READ", "TASK"], "no PLAN is synthesized");
    assert.equal(planless.items.some((item) => item.kind === "error"), false, "no PLAN diagnostic");

    const missingTask = PlurnkParser.parse(sections(
        section("READ", " (worker:///notes.md)"),
    ));
    assert.equal(missingTask.unparsedTail, undefined);
    const missingTaskStatements = missingTask.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(missingTaskStatements.map(({ op }) => op), ["READ"]);
    assert.deepEqual(missingTask.items.filter((item) => item.kind === "error"), []);
});

test("example is an executor name, not a transparent document wrapper", () => {
    const body = section("READ", " (notes.md)");
    const result = oneStatement(PlurnkParser.frame("example", body));
    assert.equal(result.op, "EXEC");
    assert.equal(result.op === "EXEC" ? result.executor : null, "example");
    assert.equal("body" in result ? result.body : null, body);
});
test("plurnk is an executor name, not a transparent document wrapper", () => {
    const body = section("READ", " (notes.md)") + "\n" + section("TASK", "", inventory("done", "completed"));
    const result = oneStatement(PlurnkParser.frame("plurnk", body));
    assert.equal(result.op === "EXEC" ? result.executor : null, "plurnk");
    assert.equal("body" in result ? result.body : null, body);
});
test("{§fence-heading-in-body}: a four-backtick TASK inside an undelimited executor block is the turn's TASK", () => {
    const result = PlurnkParser.parseStatements("`````plurnk\n" + section("TASK", "", inventory("done", "completed")), { executors: EXECUTORS });
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["EXEC", "TASK"]);
    const exec = result.items.find((item) => item.kind === "statement");
    assert.equal(exec?.kind === "statement" && exec.statement.op === "EXEC" ? exec.statement.body : "?", null, "the executor block ended at the heading with no body");
});
test("{§fence-closer}: a longer bare fence closes a shorter undelimited block and what follows is prose", () => {
    const result = PlurnkParser.parseStatements("```sh\n````\necho hello", { executors: EXECUTORS });
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["EXEC"]);
    const exec = result.items.find((item) => item.kind === "statement");
    assert.equal(exec?.kind === "statement" && exec.statement.op === "EXEC" ? exec.statement.body : "?", null);
});
test("{§disposition-anywhere}: an operation after TASK is admitted in authored order with no diagnostic", () => {
    const result = PlurnkParser.parse(sections(
        section("TASK", "", inventory("done", "completed")),
        section("READ", " (late.md)"),
    ));
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(ops.map(({ op }) => op), ["TASK", "READ"]);
    assert.deepEqual(ops[0]?.op === "TASK" ? ops[0].body : null, [{ content: "done", status: "completed" }]);
});

test("waiting inventory is a valid TASK body", () => {
    const result = PlurnkParser.parse(sections(
        section("TASK", "", inventory("waiting", "waiting")),
    ));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("AST extracts target, raw body, and position without framing state", () => {
    const statement = oneStatement("```EDIT (p)\nhello\n```");
    assert.equal(statement.op, "EDIT");
    assert.equal(Object.hasOwn(statement, "delimiter"), false);
    assert.deepEqual(statement.target, { kind: "local", raw: "p" });
    assert.equal(statement.body, "hello");
    assert.equal(statement.lineMarker, null);
    assert.deepEqual(statement.position, { line: 1, column: 0 });
});
test("slot permutations produce equivalent AST values", () => {
    const variants = [
        '```FIND (p) <2> [{"pattern": "m"}]```',
        '```FIND <2> (p) [{"pattern": "m"}]```',
    ];
    for (const input of variants) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p");
        assert.deepEqual(statement.lineMarker, { marks: [2] });
        assert.deepEqual(statement.matcher, { dialect: "glob", raw: "m" });
        assert.equal(statement.metadata, null, "a block carrying only the pattern leaves no metadata for the owner");
    }

    // {§turn-disposition} — a recipient in the path slot is a mid-turn message with no disposition.
    const recipient = oneStatement("```SEND (agent://named)\nmessage\n```");
    if (recipient.op !== "SEND") assert.fail("expected SEND");
    assert.equal(Object.hasOwn(recipient, "status"), false);
    assert.equal(recipient.target?.kind, "url");
});

test("modifier delimiters make horizontal spacing optional", () => {
    for (const input of [
        '```FIND(p)<2>[{"pattern": "m"}]```',
        '```FIND\t(p)\t<2>\t[{"pattern": "m"}]```',
        '```FIND  (p) \t<2> [{"pattern": "m"}]```',
        '```FIND<2>(p)[{"pattern": "m"}]```',
    ]) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p", input);
        assert.deepEqual(statement.lineMarker, { marks: [2] }, input);
        assert.deepEqual(statement.matcher, { dialect: "glob", raw: "m" }, input);
    }

    const send = oneStatement("```SEND(worker://child)\ndone\n```");
    if (send.op !== "SEND") assert.fail("expected SEND");
    assert.equal(Object.hasOwn(send, "status"), false);
    assert.equal(send.target?.raw, "worker://child");
});

test("scheme metadata is an opaque ordered modifier outside the target", () => {
    const statement = oneStatement(
        '```READ (https://api.example/me) [{"Authorization": "Bearer TOKEN"}] [{"Accept": "application/json"}] <1,4>```',
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
    for (const op of ["FIND", "READ", "EDIT", "KILL", "SEND", "EXEC"] as const) {
        const header = `${op === "EXEC" ? "node" : op} (known:///item) <1,4> [{"request": {"value": "]"}}] [{"mode": "quiet"}] <!-- inspect -->`;
        const statement = oneStatement(PlurnkParser.frame(header, op === "EDIT" ? "replacement" : null));
        assert.equal(statement.op, op);
        assert.equal(statement.target?.raw, "known:///item");
        assert.deepEqual(statement.lineMarker, { marks: [1, 4] });
        assert.deepEqual(statement.metadata, ['{"request": {"value": "]"}}', '{"mode": "quiet"}']);
        assert.equal(statement.aside, "inspect");
        const canonical = PlurnkParser.stringify([statement]);
        assert.equal(canonical, PlurnkParser.frame(header, op === "EDIT" ? "replacement" : null));
        assert.deepEqual(oneStatement(canonical), statement);
    }
});

test("{§transfer-resource-selections}: scope and metadata stay with their own COPY/MOVE operand", () => {
    for (const op of ["COPY", "MOVE"] as const) {
        for (const sourceScope of ["", " <@abcde,@f1234>"]) {
            for (const destinationScope of ["", " <0>"]) {
                const header = `${op} (known:///source#body)${sourceScope} [{"source": "one"}] [{"source": "two"}] (known:///destination#notes)${destinationScope} [{"destination": "one"}] <!-- transfer -->`;
                const statement = oneStatement(PlurnkParser.frame(header, null));
                if (statement.op !== "COPY" && statement.op !== "MOVE") assert.fail("expected transfer");
                assert.equal(statement.source.target.raw, "known:///source#body");
                assert.equal(statement.destination.target.raw, "known:///destination#notes");
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
        'SEND (worker://reviewer) <1> [{"mode": "one"}] <2>',
    ]) {
        const errors = errorsOf(PlurnkParser.frame(header, null));
        assert.ok(errors.some(({ severity }) => severity === "error"), header);
    }
});

test("{§scheme-metadata-modifier}: quoted brackets and escapes remain exact metadata content", () => {
    for (const metadata of [
        JSON.stringify({ args: ["]", "[", 'quote"]here', "\\]", "line\nbreak"] }),
        JSON.stringify({ request: { nested: { value: "]" } } }),
    ]) {
        const statement = oneStatement(`\`\`\`node (script.js) [${metadata}] [{"cwd": "sub"}]
stdin
\`\`\``);
        if (statement.op !== "EXEC") assert.fail("expected EXEC");
        assert.deepEqual(statement.metadata, [metadata, '{"cwd": "sub"}']);
        assert.equal(statement.body, "stdin");
    }
});

test("duplicate slots are rejected", () => {
    for (const input of [
        "```FIND [+b] (p)\nm\n```",
        "```FIND (p1) (p2)\nm\n```",
        "```FIND <1> <2> (p)\nm\n```",
    ]) {
        assert.ok(errorsOf(input).length >= 1, input);
    }
});

// {§heading-inline-body}
test("body text on the heading line runs as the body and raises one advisory naming the rule", () => {
    const turn = "\n```EDIT (Engine.ts) <3> replacement text\n```\n\n```TASK\n[{\"content\":\"next\",\"status\":\"in_progress\"}]\n```";
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
    const canonical = PlurnkParser.parse("\n```EDIT (Engine.ts) <3>\nreplacement text\n```\n\n```TASK\n[{\"content\":\"next\",\"status\":\"in_progress\"}]\n```");
    assert.ok(!canonical.items.some((item) => item.kind === "error" && item.error.severity === "warning"), "the canonical two-line form raises nothing");
});

// {§matcher-option}
test("{§naked-pattern}: a sigil matcher after the target lifts into pattern; a bare word beneath the heading stays an ignored body with one advisory", () => {
    for (const [op, body, dialect] of [["FIND", "/resolveWorkerPrimary/", "regex"], ["KILL", "~topic", "fts"]] as const) {
        const result = PlurnkParser.parse(sections(section(op, " (Engine.ts)", body), section("TASK", "", inventory("n"))));
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], op);
        const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(ops.map(({ op: name }) => name), [op, "TASK"]);
        const matcher = (ops[0] as { matcher?: { dialect?: string; raw?: string } | null }).matcher;
        assert.equal(matcher?.dialect, dialect, `${op}: the sigil names the dialect`);
        assert.equal(matcher?.raw, body);
    }
    const word = PlurnkParser.parse(sections(section("READ", " (Engine.ts)", "resolveWorkerPrimary"), section("TASK", "", inventory("n"))));
    const advisories = word.items.filter((item) => item.kind === "error");
    assert.equal(advisories.length, 1);
    assert.equal(advisories[0]!.kind === "error" ? advisories[0]!.error.severity : null, "warning");
    assert.match(advisories[0]!.kind === "error" ? advisories[0]!.error.message : "", /READ takes no body; the body was ignored/u);
    assert.deepEqual(word.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "TASK"]);
    // The inline-heading spelling is the grep spelling and lifts the same way.
    const inline = PlurnkParser.parse("\n```FIND (Engine.ts) /resolveWorkerPrimary/\n```\n\n```TASK\n[{\"content\":\"next\",\"status\":\"in_progress\"}]\n```");
    assert.deepEqual(inline.items.filter((item) => item.kind === "error"), []);
    const find = inline.items.find((item) => item.kind === "statement");
    assert.equal(find?.kind === "statement" ? (find.statement as { matcher?: { raw?: string } | null }).matcher?.raw : null, "/resolveWorkerPrimary/");
});

test("a malformed regex pattern receives a bounded dialect error that echoes nothing", () => {
    const errors = errorsOf('```FIND (**/*.go) <1,-1> [{"pattern": "/require|ABS_MODULE_PATH|module_load/ trailing"}]```');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, "Regex matcher has trailing text after `/pattern/flags`.");
    assert.doesNotMatch(errors[0]?.message ?? "", /ABS_MODULE_PATH|\*\*\/\*\.go/u, "the receipt does not echo the submitted matcher or target");
    for (const pattern of ["/x/z", "/x/ii", "/(/i", "/unclosed"]) {
        const error = firstError(`\`\`\`FIND (src/**) [{"pattern": ${JSON.stringify(pattern)}}]\`\`\``);
        assert.equal(error.severity, "error");
        assert.doesNotMatch(error.message, /Regex matcher has trailing text/u, pattern);
        assert.match(error.message, /not a valid.*regex|no closing/u, pattern);
    }
});

test("a pattern with flags parses; an invalid one drops only its own statement", () => {
    for (const flags of ["i", "", "giu"]) {
        const result = PlurnkParser.parse(sections(
            `\`\`\`FIND (**/*.ts) <1,-1> [{"pattern": "/disabled-rules|comment|lint\\\\s*\\\\(/${flags}"}] <!-- locate entry points -->\`\`\``,
            section("READ", " (package.json)"),
            section("TASK", "", inventory("inspect")),
        ));
        assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], flags);
        const find = result.items.find((item) => item.kind === "statement" && item.statement.op === "FIND");
        assert.equal(find?.kind === "statement" && find.statement.op === "FIND" ? find.statement.matcher?.dialect : null, "regex", flags);
    }
    const result = PlurnkParser.parse(sections(
        '```FIND (**/*.ts) [{"pattern": "/(/i"}]```',
        section("READ", " (package.json)"),
        section("TASK", "", inventory("inspect")),
    ));
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "TASK"]);
});

// {§misplaced-aside-advisory}
test("a READ or FIND whose body is only an HTML comment takes it as the aside and says so", () => {
    for (const op of ["READ", "FIND"] as const) {
        const turn = sections(
            section(op, " (Engine.ts) <520,530>", "<!-- Read context around the two matches. -->"),
            section("TASK", "", inventory("next")),
        );
        const result = PlurnkParser.parse(turn);
        const statement = result.items.find((item) => item.kind === "statement" && item.statement.op === op);
        assert.equal(statement?.kind, "statement", `${op} still dispatches as ${op}`);
        if (statement?.kind !== "statement") return;
        assert.equal(statement.statement.aside, "Read context around the two matches.", "the comment became the aside");
        assert.equal("body" in statement.statement ? statement.statement.body : undefined, null, "no matcher was manufactured from the comment");
        const warning = result.items.find((item) => item.kind === "error" && item.error.severity === "warning");
        assert.equal(warning?.kind, "error", "one advisory follows the statement");
        if (warning?.kind !== "error") return;
        assert.equal(
            warning.error.message,
            `The ${op} body contained only an HTML comment; it was applied as the operation aside.`,
        );
    }
    // a heading aside wins; a body with any other content is ignored with an advisory ({§matcher-option})
    const kept = PlurnkParser.parse(sections(section("READ", " (Engine.ts) <!-- heading -->", "<!-- body -->"), section("TASK", "", inventory("n"))));
    const read = kept.items.find((item) => item.kind === "statement" && item.statement.op === "READ");
    assert.equal(read?.kind === "statement" ? read.statement.aside : null, "heading");
    const ignored = PlurnkParser.parse(sections(section("READ", " (Engine.ts)", "resolveWorkerPrimary"), section("TASK", "", inventory("n"))));
    assert.ok(ignored.items.some((item) => item.kind === "error" && item.error.severity === "warning" && /READ takes no body/u.test(item.error.message)), "a body that is not a comment is ignored with an advisory");
    assert.ok(ignored.items.some((item) => item.kind === "statement" && item.statement.op === "READ"), "the READ still parses");
});

test("scope spellings normalize to ordered numeric marks", () => {
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

test("text-coordinate operations admit Base62 anchors only in line positions", () => {
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
        section("EXEC", " (node) <@aZ09b>", "run"),
        section("READ", " (p) <@aZ09>"),
        section("EDIT", " (p) <@aZ09bQ>", "body"),
        section("COPY", " (p) <@aZ-9b> (q)"),
    ]) {
        assert.ok(errorsOf(input).length > 0, input);
    }
});

// {§combined-anchor-tolerance}
test("a combined anchor and displayed line number reads as the anchor, with one advisory per position", () => {
    for (const input of [
        section("EDIT", " (p) <@aZ09b:42,@0Aa9Z:43>", "body"),
        section("EDIT", " (p) <@aZ09b 42,@0Aa9Z 43>", "body"),
        section("COPY", " (p) (q) <@aZ09b 42,@0Aa9Z 43>"),
    ]) {
        const result = PlurnkParser.parseStatements(input);
        const ops = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(ops.length, 1, input);
        const marker = ops[0]!.op === "COPY" ? ops[0]!.destination.lineMarker : (ops[0] as { lineMarker: { marks: unknown[] } | null }).lineMarker;
        assert.deepEqual(marker, { marks: ["@aZ09b", "@0Aa9Z"] }, input);
        const advisories = result.items.filter((item) => item.kind === "error");
        assert.equal(advisories.length, 2, input);
        for (const advisory of advisories) {
            assert.equal(advisory.kind === "error" ? advisory.error.severity : null, "warning");
            assert.match(advisory.kind === "error" ? advisory.error.message : "", /was read as the anchor `@[0-9A-Za-z]{5}`; a scope position takes the anchor without its displayed line number/u);
        }
    }
});

test("TASK wait scope and EXEC timeout/poll are retained", () => {
    const terminal = oneStatement(section("TASK", " <30>", "polling"));
    if (terminal.op !== "TASK") assert.fail("expected TASK");
    assert.deepEqual(terminal.lineMarker, { marks: [30] });
    const appended = oneStatement(section("TASK", " <-1>", "standing by"));
    if (appended.op !== "TASK") assert.fail("expected TASK");
    assert.deepEqual(appended.lineMarker, { marks: [-1] });
    const exec = oneStatement("```node (./) <60,5>\ncommand\n```");
    if (exec.op !== "EXEC") assert.fail("expected EXEC");
    assert.deepEqual(exec.lineMarker, { marks: [60, 5] });
});

test("unscoped EDIT remains syntax-valid for runtime create-or-refuse semantics", () => {
    for (const input of [
        section("EDIT", " (notes.md)", "whole body"),
        section("EDIT", " (worker:///plan.md)", "draft"),
        section("EDIT", " (empty.md)"),
    ]) {
        const statement = oneStatement(input);
        if (statement.op !== "EDIT") assert.fail("expected EDIT");
        assert.equal(statement.lineMarker, null);
    }
});

test("ParsedPath distinguishes local paths and decomposes scheme URLs", () => {
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
        ["worker:///entries/foo/bar", "worker", "/entries/foo/bar"],
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

    const authority = parsePath("known://entries/foo");
    if (authority?.kind !== "url") assert.fail("expected URL");
    assert.equal(authority.hostname, "entries");
    assert.equal(authority.pathname, "/foo");

    const emptyAuthority = parsePath("wiki:///Paris?lang=fr#History");
    if (emptyAuthority?.kind !== "url") assert.fail("expected URL");
    assert.equal(emptyAuthority.query, "lang=fr");
    assert.equal(emptyAuthority.fragment, "History");
});

test("malformed URL authority becomes one visitor error", () => {
    const result = PlurnkParser.parseStatements(section("READ", " (http://[bad)"));
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "visitor");
});

// {§matcher-prefix-claims}
// {§matcher-option} — the pattern option carries every matcher dialect exactly as the body once did.
const patterned = (op: Parameters<typeof section>[0], slots: string, pattern: string): string => section(op, `${slots} [{"pattern": ${JSON.stringify(pattern)}}]`);

test("matcher dialects project to typed matchers", () => {
    for (const [pattern, dialect] of [
        ["/foo|bar/i", "regex"],
        ["//user[@role='admin']", "xpath"],
        ["$.greeting", "jsonpath"],
        ["Paris*", "glob"],
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

test("matcher admission rejects multiline patterns before dialect classification", () => {
    const renderedRead = [
        "@et6xE 2286:\t// Set debug flag from environment if not already set",
        "@alreh 2287:\tif (!requireDebug) {",
        "@84fBk 2288:\t\trequireDebug = true;",
    ].join("\n");

    for (const op of ["FIND", "READ", "KILL"] as const) {
        const result = PlurnkParser.parseStatements(patterned(op, " (source.ts)", renderedRead));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, op);
        assert.equal(errors[0]?.error.source, "visitor", op);
        assert.equal(errors[0]?.error.message, "Matcher has 3 lines; expected 1.", op);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, op);
    }
});

test("a pattern that is not a string is the language's own diagnostic", () => {
    for (const block of ['{"pattern": 7}', '{"pattern": null}', '{"pattern": ["a"]}']) {
        const result = PlurnkParser.parseStatements(section("FIND", ` (source/**) [${block}]`));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, block);
        assert.match(errors[0]!.error.message, /"pattern" must be a string matcher/u, block);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, block);
    }
});

test("a block the language cannot read lifts nothing and stays for the owner", () => {
    for (const heading of [
        ' (source/**) [{"pattern": "x"} trailing]',
        ' (source/**) [{"pattern": "x"}] [{"pattern": "y"}]',
        ' (source/**) ["not an object"]',
    ]) {
        const statement = oneStatement(section("FIND", heading));
        if (statement.op !== "FIND") assert.fail(heading);
        assert.equal(statement.matcher, null, heading);
        assert.notEqual(statement.metadata, null, heading);
    }
});

test("other option keys beside the pattern stay with the owner, verbatim", () => {
    const statement = oneStatement(section("READ", ' (https://api.example/me) [{"pattern": "/token/i", "Accept": "application/json"}]'));
    if (statement.op !== "READ") assert.fail("expected READ");
    assert.deepEqual(statement.matcher, { dialect: "regex", raw: "/token/i", pattern: "token", flags: "i" });
    assert.deepEqual(statement.metadata, ['{"pattern": "/token/i", "Accept": "application/json"}']);
});

test("graph claims ampersand and validates its complete single-line shape", () => {
    for (const pattern of ["&", "&<", "&>", "&two symbols"] as const) {
        const result = PlurnkParser.parseStatements(patterned("FIND", " (source/**)", pattern));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, pattern);
        assert.equal(errors[0]?.error.source, "visitor", pattern);
        assert.equal(
            errors[0]?.error.message,
            "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
            pattern,
        );
        assert.equal(result.items.some((item) => item.kind === "statement"), false, pattern);
    }
});

test("at-sign matcher text remains in the fallback glob dialect", () => {
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

test("a READ with a pattern on an exact target stays a READ ({§read-pattern})", () => {
    const result = PlurnkParser.parse([
        '```READ (data/users.json) <1,-1> [{"pattern": "@data/users.json"}]```',
    ].join("\n"));
    const errors = result.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    assert.ok(statements[0].op === "READ");
    assert.equal(statements[0].matcher?.raw, "@data/users.json");
    assert.deepEqual(statements[0].lineMarker?.marks, [1, -1]);
});

test("regex patterns retain pattern, flags, escaped delimiters, and character classes", () => {
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

test("declared matcher prefixes fail as their declared dialect instead of falling back", () => {
    for (const [pattern, message] of [
        ["/unclosed-regex", /has no closing `\/`/],
        ["/(abc/", /not a valid `\/pattern\/flags` regex/],
        ["/hello/i:", /Invalid flags/],
        ["//book[unterminated", /not a valid xpath selector/],
        ["// TODO: add error handling", /not a valid xpath selector/],
        ["$[(", /not a valid jsonpath/],
        ["$HOME", /not a valid jsonpath/],
        ["$.users[", /not a valid jsonpath/],
    ] as const) {
        const result = PlurnkParser.parseStatements(patterned("FIND", " (source)", pattern));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, pattern);
        assert.equal(errors[0]?.error.source, "visitor", pattern);
        assert.match(errors[0]!.error.message, message, pattern);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, pattern);
    }
});

test("matcher validation is per section and does not consume siblings", () => {
    const result = PlurnkParser.parseStatements(sections(
        patterned("FIND", " (a.txt)", "/ok/i"),
        patterned("FIND", " (b.txt)", "/bad/i:"),
        section("KILL", " (log:///1/2/3)"),
    ));
    assert.equal(result.items.filter((item) => item.kind === "statement").length, 2);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
});

test("ordinary matcher text remains glob and EDIT bodies remain opaque", () => {
    const glob = oneStatement(patterned("FIND", " (known:///**)", ":<1,-1>:/hello/i:"));
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
    const bare = oneStatement(patterned("EDIT", " (p)", "oldName"));
    assert.equal(bare.op === "EDIT" ? bare.body : undefined, null, "an empty body with a pattern deletes the spans; the parser admits it");
});

test("semantic matcher accepts arbitrary text and a result-position scope", () => {
    const kill = oneStatement(patterned("KILL", " (log://**)", "~find anything about: !@#$%^ malformed (but valid as query)"));
    if (kill.op !== "KILL") assert.fail("expected KILL");
    assert.equal(kill.matcher?.dialect, "fts");
    assert.equal(kill.body, null);

    const find = oneStatement(patterned("FIND", " (known://**) <5>", "~graph algorithms"));
    if (find.op !== "FIND") assert.fail("expected FIND");
    assert.deepEqual(find.lineMarker, { marks: [5] });
    assert.equal(find.matcher?.dialect, "fts");
});

// {§read-find-normalization} — a READ is never rewritten: a glob target stays a READ (the runtime fans it out).
test("READ of a glob target stays a schema-valid READ; a matcher keeps its op", () => {
    const cases = [
        { input: section("READ", " (worker:///page.md) <2,4>"), op: "READ", dialect: null, marks: [2, 4] },
        { input: patterned("READ", " (worker:///page.md) <3,5>", "/header/i"), op: "READ", dialect: "regex", marks: [3, 5] },
        { input: section("READ", " (src/**/*.ts) <2>"), op: "READ", dialect: null, marks: [2] },
        { input: section("READ", " (worker:///src/**/*.ts) <4,8>"), op: "READ", dialect: null, marks: [4, 8] },
        { input: patterned("READ", " (worker:///src/**/*.ts)", "TODO"), op: "READ", dialect: "glob", marks: null },
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

test("READ matcher admission retains positioned dialect errors", () => {
    const result = PlurnkParser.parseStatements(patterned("READ", " (page.html)", "// foo {bar}"));
    assert.equal(result.items.some((item) => item.kind === "statement"), false);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "visitor");
    assert.match(errors[0]?.error.message ?? "", /not a valid xpath selector/);
});

test("COPY and MOVE operands project path, metadata, fragment, and scope independently", () => {
    const copy = oneStatement(section(
        "COPY",
        ' (known:///draft#body) [{"source": "metadata"}] <2,4> (known:///archive#notes) [{"destination": "metadata"}] <1,3,1,3>',
    ));
    if (copy.op !== "COPY" || copy.destination.target.kind !== "url") assert.fail("expected COPY");
    assert.equal(copy.destination.target.fragment, "notes");
    assert.equal(copy.destination.target.raw, "known:///archive#notes");
    assert.deepEqual(copy.destination.metadata, ['{"destination": "metadata"}']);
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, 3, 1, 3] });
    assert.deepEqual(copy.source.metadata, ['{"source": "metadata"}']);
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 4] });

    const move = oneStatement(section("MOVE", " (worker:///draft) (./out.txt)"));
    if (move.op !== "MOVE") assert.fail("expected MOVE");
    assert.deepEqual(move.source.target, parsePath("worker:///draft"));
    assert.deepEqual(move.destination.target, { kind: "local", raw: "./out.txt" });
});

test("SEND projects JSON when valid and always preserves raw body", () => {
    const json = oneStatement(section("SEND", "", '{"answer":"Paris","confidence":0.95}'));
    if (json.op !== "SEND" || !json.body) assert.fail("expected SEND");
    assert.equal(json.body.raw, '{"answer":"Paris","confidence":0.95}');
    assert.deepEqual(json.body.json, { answer: "Paris", confidence: 0.95 });

    const text = oneStatement(section("SEND", "", "Paris"));
    if (text.op !== "SEND" || !text.body) assert.fail("expected SEND");
    assert.equal(text.body.raw, "Paris");
    assert.equal(text.body.json, null);
});

test("multiline EDIT and EXEC bodies remain character-perfect raw strings", () => {
    const edit = oneStatement(section("EDIT", " (known://entry)", "line one\nline two"));
    const exec = oneStatement(section("EXEC", " (node/./)", "console.log(1+1)"));
    if (edit.op !== "EDIT" || exec.op !== "EXEC") assert.fail("expected EDIT and EXEC");
    assert.equal(edit.body, "line one\nline two");
    assert.equal(exec.body, "console.log(1+1)");
});

test("header diagnostics use PLURNK vocabulary and point to the malformed slot", () => {
    const executor = firstError("```EXEC (node) (./)\ncommand\n```");
    assert.match(executor.message, /sh accepts one `\(program\)` path at most once/);
    for (const runtime of ["python3", "brave", "search-api"]) {
        const error = firstError(`\`\`\`${runtime} (first) (second)\ninput\n\`\`\``);
        assert.equal(error.message, `${runtime} accepts one \`(program)\` path at most once`);
    }

    // {§naked-pattern} — a sigil matcher after the target on the heading line is the pattern.
    const inlineItems = PlurnkParser.parse("```FIND (data.json) $.role\n```").items;
    assert.deepEqual(inlineItems.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
    const lifted = inlineItems.find((item) => item.kind === "statement" && item.statement.op === "FIND");
    assert.equal(lifted?.kind === "statement" ? (lifted.statement as { matcher?: { dialect?: string } | null }).matcher?.dialect : null, "jsonpath");

    const target = PlurnkParser.parseStatements("```EDIT (path").unparsedTail;
    assert.match(target?.reason ?? "", /target slot of `EDIT`.*add `\)`/);

    const metadata = PlurnkParser.parseStatements('```EDIT (p) [{"meta"').unparsedTail;
    assert.match(metadata?.reason ?? "", /metadata modifier of `EDIT`.*add `\]`/);
});

test("diagnostics do not leak ANTLR implementation vocabulary", () => {
    const forbidden = /token recognition|mismatched|extraneous|expecting|no viable|RPAREN|LBRACKET|RBRACKET|LPAREN|BODY_TEXT|<EOF>|ATN/;
    for (const input of [
        "```EDIT (path```",
        "```EDIT [+tag```",
        "```EDIT (p)\nstray\n```",
        "```SEND [bad]\nmessage\n```",
    ]) {
        const result = PlurnkParser.parseStatements(input);
        for (const item of result.items) {
            if (item.kind === "error") assert.doesNotMatch(item.error.message, forbidden, item.error.message);
        }
        if (result.unparsedTail) assert.doesNotMatch(result.unparsedTail.reason, forbidden, result.unparsedTail.reason);
    }
});

test("body punctuation and Markdown remain opaque", () => {
    for (const input of [
        section("TASK", "", "array[0] and a stray ] bracket"),
        section("TASK", "", '{"expected":["a","b"],"got":[1,2]}'),
        section("TASK", "", "]]]) }{[ <> mixed"),
        section("EDIT", " (a.md)", "x = arr[0] + (y) + {z}"),
        section("SEND", " (worker://parent)", "result ] arr[0]"),
        section("TASK", "", "# User heading\n\n- one\n- two"),
    ]) {
        assert.equal(["SEND", "EDIT", "TASK", "TASK"].includes(oneStatement(input).op), true, input);
    }
});

test("parse accepts one TASK-terminated turn and rejects another TASK in that turn", () => {
    const turn = sections(
        section("READ", " (worker:///x)"),
        section("TASK", "", inventory("done", "completed")),
    );
    const result = PlurnkParser.parse(turn);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);

    const twoTurns = sections(turn, sections(
        section("TASK", "", inventory("done again", "completed")),
    ));
    const invalid = PlurnkParser.parse(twoTurns);
    assert.ok(invalid.items.some((item) => item.kind === "error") || invalid.unparsedTail !== undefined);
});

test("parseLog accepts direct consecutive turns and flattens them in order", () => {
    const input = sections(
        section("READ", " (worker:///x)"),
        section("TASK", "", inventory("reading")),
        section("TASK", "", inventory("done", "completed")),
    );
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["READ", "TASK", "TASK"],
    );
});

test("parseLog requires at least one complete turn", () => {
    for (const input of [
        "",
        section("READ", " (worker:///x)"),
    ]) {
        const result = PlurnkParser.parseLog(input);
        assert.ok(result.items.some((item) => item.kind === "error") || result.unparsedTail !== undefined, input);
    }
});

test("parser positions count Unicode code points and CRLF lines", () => {
    // Without a separating space the trailing text is still a malformed heading; with one it is
    // the inline body ({§heading-inline-body}). Either way columns count code points.
    const unicode = PlurnkParser.parseStatements("```EDIT (🙂)X```");
    const error = unicode.items.find((item) => item.kind === "error");
    assert.equal(error?.kind, "error");
    if (error?.kind === "error") assert.deepEqual({ line: error.error.line, column: error.error.column }, { line: 1, column: 11 });
    const inlineEdit = oneStatement("```EDIT (🙂) X\n```");
    if (inlineEdit.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(inlineEdit.body, "X");

    const crlf = oneStatement("```EDIT (p)\nline one\r\nline two\n```");
    if (crlf.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(crlf.body, "line one\r\nline two");
});

// {§heading-inline-body}
test("body text on the heading line is the first body line when it cannot open a slot", () => {
    const exec = oneStatement("```crm (crm_query) SELECT Id FROM Case\n```");
    if (exec.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(exec.executor, "crm");
    assert.equal(exec.target?.raw, "crm_query");
    assert.equal(exec.body, "SELECT Id FROM Case");

    const multi = oneStatement("```crm (crm_query)\n{\"soql\":\n \"SELECT Id FROM Case\"}\n```");
    if (multi.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(multi.body, '{"soql":\n "SELECT Id FROM Case"}', "the inline start joins the following body lines");

    const send = oneStatement("```SEND Paris.\n```");
    if (send.op !== "SEND" || !send.body) assert.fail("expected SEND with body");
    assert.equal(send.body.raw, "Paris.");

    const withAside = oneStatement("```EDIT (src/a.ts) <4> <!-- where --> replacement\n```");
    if (withAside.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(withAside.aside, "where");
    assert.equal(withAside.body, "replacement");

    // Slot openers stay slots; tolerant ingestion does not require canonical spacing.
    const unspaced = oneStatement("```crm (crm_query)[{\"soql\": \"x\"}]```");
    if (unspaced.op !== "EXEC") assert.fail("expected EXEC");
    assert.deepEqual(unspaced.metadata, ['{"soql": "x"}']);
    assert.equal(oneStatement("```READ (a.md) <1,3>```").op, "READ");
});

// {§exec-executor-slot}
test("the fence name selects EXEC while its modifiers retain their contracts", () => {
    const railed = oneStatement('```python3 (tools/report.py) [{"cwd": "build"}] <30>\ninput\n```');
    if (railed.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(railed.executor, "python3");
    assert.equal(railed.target?.raw, "tools/report.py");
    assert.deepEqual(railed.metadata, ['{"cwd": "build"}']);
    assert.deepEqual(railed.lineMarker, { marks: [30] });
    assert.equal(railed.body, "input");
    const bare = oneStatement("```EXEC\npwd\n```");
    if (bare.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(bare.executor, null);
    assert.equal(bare.target, null);
    const alone = oneStatement("```node\nconsole.log(1)\n```");
    if (alone.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(alone.executor, "node");
    assert.equal(alone.target, null);
    const plus = oneStatement("```c++ (main.cpp)```");
    if (plus.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(plus.executor, "c++");
    const unspaced = oneStatement("```jq(data.json)\n.a\n```");
    if (unspaced.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(unspaced.executor, "jq");
    assert.equal(unspaced.target?.raw, "data.json");
    // {§legacy-bracket-slot} — a bracket after the program or leading an executor fence is metadata
    // for that executor, never a selector: the fence name still selects the executor.
    for (const [input, executor, metadata] of [
        ["```EXEC (tool.py) [python3]\ninput\n```", null, "python3"],
        ["```python3 (tool.py) [node]\ninput\n```", "python3", "node"],
        ["```python3 [node] (tool.py)\ninput\n```", "python3", "node"],
    ] as const) {
        const legacy = oneStatement(input);
        if (legacy.op !== "EXEC") assert.fail("expected EXEC");
        assert.equal(legacy.executor, executor, input);
        assert.equal(legacy.target?.raw, "tool.py", input);
        assert.deepEqual(legacy.metadata, [metadata], input);
        assert.equal(legacy.body, "input", input);
    }
    const cwdOnly = oneStatement('```EXEC [{"cwd": "sub"}]\nmake test\n```');
    if (cwdOnly.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(cwdOnly.executor, null);
    assert.deepEqual(cwdOnly.metadata, ['{"cwd": "sub"}']);
    assert.equal(cwdOnly.body, "make test");
    const executorCwd = oneStatement('```node [{"cwd": "sub"}]\nconsole.log(process.cwd())\n```');
    if (executorCwd.op !== "EXEC") assert.fail("expected EXEC");
    assert.deepEqual(executorCwd.metadata, ['{"cwd": "sub"}']);
    assert.match(firstError("```READ [python3] (tool.py)```").message, /unexpected bracket modifier; the fence name selects the executor/);
});
