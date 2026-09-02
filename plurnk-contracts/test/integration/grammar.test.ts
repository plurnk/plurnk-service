import test from "node:test";
import assert from "node:assert/strict";
import {
    PlurnkParser,
    PlurnkParseError,
    Validator,
    parsePath,
} from "../../src/index.ts";

type Op = "PLAN" | "FIND" | "READ" | "EDIT" | "COPY" | "MOVE" | "OPEN" | "FOLD"
    | "SEND" | "EXEC" | "BARE" | "WORK" | "FORK" | "KILL";

const section = (op: Op, slots = "", body?: string, delimiter = "0"): string => {
    const level = op === "PLAN" ? "#" : "##";
    const heading = `${level} ${op}${delimiter}${slots}`;
    return body === undefined ? heading : `${heading}\n${body}`;
};

const sections = (...values: string[]): string => values.join("\n\n");

const errorsOf = (input: string) =>
    PlurnkParser.parseStatements(input).items.flatMap((item) => item.kind === "error" ? [item.error] : []);

const oneStatement = (input: string) => {
    const result = PlurnkParser.parseStatements(input);
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

test("protocol operations parse as Markdown sections", () => {
    const cases: Array<[Op, string, string | undefined]> = [
        ["PLAN", "", "inspect, act, report"],
        ["FIND", " (known:///**) <1,20>", "Paris*"],
        ["READ", " (README.md)", undefined],
        ["EDIT", " (notes.md) <2>", "replacement"],
        ["COPY", " (notes.md) (archive.md) <0>", undefined],
        ["MOVE", " (notes.md) (archive.md)", undefined],
        ["KILL", " (log:///**) <@aB3dE>", "~topic"],
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
        assert.equal(statement.delimiter, "0", op);
    }
});

test("trailing operation annotations are durable, single-line, and follow every modifier", () => {
    const statement = oneStatement([
        "## EXEC0 [gitea] (list_issues) <!-- Lists issues (details: worker://~/_plurnk/tools/gitea/list_issues.md) -->",
        '{"owner":"plurnk","repo":"plurnk-service"}',
    ].join("\n"));
    assert.equal(
        statement.annotation,
        "Lists issues (details: worker://~/_plurnk/tools/gitea/list_issues.md)",
    );
    assert.equal(oneStatement("## READ0 (README.md)").annotation, null);
    assert.equal(oneStatement("## READ0 (README.md) <!-- -->").annotation, "");

    for (const input of [
        "## EXEC0 <!-- Lists issues --> [gitea] (list_issues)\n{}",
        "## EXEC0 [gitea] (list_issues) <!-- Lists\nissues -->\n{}",
        "## EXEC0 [gitea] (list_issues) <!-- Lists issues\n{}",
    ]) {
        assert.ok(errorsOf(input).length > 0 || PlurnkParser.parseStatements(input).unparsedTail !== undefined, input);
    }
});

test("balanced parentheses are ordinary target content", () => {
    const statement = oneStatement(section(
        "FIND",
        " (https://en.wikipedia.org/wiki/Igor_Smirnov_(politician))",
        "/spouse|wife|married|Zhannetta|Lotnik/i",
    ));
    if (statement.op !== "FIND") assert.fail("expected FIND");
    assert.equal(statement.target?.raw, "https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)");
});

test("unmatched target parentheses require escaped or percent-encoded spelling", () => {
    assert.ok(errorsOf("## READ0 (https://example.test/a)b)").length > 0);

    const unclosed = PlurnkParser.parseStatements("## READ0 (https://example.test/a(b");
    assert.equal(unclosed.items.length, 0);
    assert.match(unclosed.unparsedTail?.reason ?? "", /target slot of `## READ0`.*add `\)`/);

    for (const encoded of ["a%28b", "a%29b"]) {
        assert.equal(oneStatement(section("READ", ` (https://example.test/${encoded})`)).op, "READ");
    }
});

test("an unfinished metadata modifier names only its structural repair", () => {
    const secret = "Bearer secret-that-must-not-echo";
    const parsed = PlurnkParser.parseStatements(
        `## READ0 (https://example.test/data) {Authorization: ${secret}`,
    );
    assert.equal(parsed.items.length, 0);
    assert.equal(
        parsed.unparsedTail?.reason,
        "metadata modifier of `## READ0` opened at line 1 but never closed - add `}`",
    );
    assert.equal(parsed.unparsedTail?.reason.includes(secret), false);
});

test("target escapes preserve literal and percent-encoded URI spelling", () => {
    const statement = oneStatement(String.raw`## READ0 (https://example.test/x?literal=\)&encoded=%29#preview\()`);
    if (statement.op !== "READ") assert.fail("expected READ");
    assert.equal(statement.target?.raw, "https://example.test/x?literal=)&encoded=%29#preview(");
    if (statement.target?.kind !== "url") assert.fail("expected URL target");
    assert.equal(statement.target.query, "literal=)&encoded=%29");
    assert.equal(statement.target.fragment, "preview(");
});

test("COPY and MOVE destinations use the target escape layer", () => {
    const statement = oneStatement(String.raw`## COPY0 (worker:///draft) (https://example.test/archive?literal=\)&encoded=%29)`);
    if (statement.op !== "COPY" || statement.destination.target.kind !== "url") assert.fail("expected COPY URL destination");
    assert.equal(statement.destination.target.raw, "https://example.test/archive?literal=)&encoded=%29");
    assert.equal(statement.destination.target.query, "literal=)&encoded=%29");
});

test("a COPY destination path excludes the whitespace before its scope", () => {
    const statement = oneStatement("## COPY0 (prompt:///1/1) (worker://~/prompts.md) <-1>");
    if (statement.op !== "COPY") assert.fail("expected COPY");
    assert.equal(statement.destination.target.raw, "worker://~/prompts.md");
    assert.equal(statement.destination.target.kind === "url" ? statement.destination.target.hostname : null, "~");
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

test("a scope slot with non-scope content names the scope shapes, not a missing space (#386)", () => {
    for (const slots of [" (sh/curl submit) <30s>", " (crm/crm_query) <crm:///1/6/1>", " (pm/pm_search_issues) <poll>"]) {
        const result = PlurnkParser.parseStatements(section("EXEC", slots, "{}"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1, slots);
        assert.equal(errors[0]?.error.source, "lexer");
        assert.match(errors[0]?.error.message ?? "", /unrecognized scope '<[^']*' in operation heading - a scope is numeric/, slots);
        assert.match(errors[0]?.error.message ?? "", /EXEC's `<timeout,poll>` are minutes, e\.g\. `<5>` or `<5,1>`/, slots);
    }
    // A < glued to the previous slot is a spacing error and keeps the spacing message.
    const glued = PlurnkParser.parseStatements(section("READ", " (notes.md)<foo>"));
    const gluedErrors = glued.items.filter((item) => item.kind === "error");
    assert.ok(gluedErrors.length >= 1);
    assert.match(gluedErrors[0]?.error.message ?? "", /expected a space before/);
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
    assert.equal(readErrors[0]?.error.message, "a heading takes exactly one `(path)` slot; a pattern belongs in the body beneath the heading");
});

test("a `(target)` on BARE names the body as the prompt", () => {
    const expected = "unexpected `(` after BARE - BARE takes no `(path)`; the prompt is the body: `## BARE0` then the prompt on the line below";
    for (const slots of [" (What day is it?)", " (prompt:///1/1) <!-- Calculate 1+1 -->"]) {
        const result = PlurnkParser.parseStatements(section("BARE", slots, "1 + 1 = 2"));
        assert.equal(result.items.some((item) => item.kind === "statement" && item.statement.op === "BARE"), false, slots);
        const errors = result.items.filter((item) => item.kind === "error");
        assert.ok(errors.length >= 1, slots);
        assert.equal(errors[0]?.error.source, "parser", slots);
        assert.equal(errors[0]?.error.message, expected, slots);
    }
    // A fence does not hide a heading ({§delimiter-discipline}); the same receipt reaches it.
    const fenced = PlurnkParser.parseStatements(sections(section("SEND", " (NEXT)", "```plaintext\n## BARE0 (What day is it?)\n```")));
    assert.ok(fenced.items.some((item) => item.kind === "error" && item.error.message === expected), "the fenced BARE heading gets the same receipt");
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
    const plan = oneStatement(section("PLAN", ""));
    if (plan.op !== "PLAN") assert.fail("expected PLAN");
    assert.deepEqual(plan.body, []);
});

// {§plan-slotless}: bracketed inline JSON is structurally a signal modifier;
// it must never be admitted as an empty semantic Plan.
test("PLAN rejects modifiers without inferring what their content meant", () => {
    const inlineArray = '# PLAN0 [{"content":"keep this","status":"memory"}]';
    const result = PlurnkParser.parseStatements(inlineArray);
    const errors = result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.deepEqual(errors.map(({ message, source, severity }) => ({ message, source, severity })), [{
        message: "unrecognized character '[' after PLAN - PLAN takes no modifiers; the Plan body starts on the next line",
        source: "lexer",
        severity: "error",
    }]);
    assert.equal(
        result.items.some((item) => item.kind === "statement" && item.statement.op === "PLAN"),
        false,
        "the rejected modifier cannot become an empty durable Plan",
    );

    const all = firstError("# PLAN0 (notes.md) <1>\n[]");
    assert.equal(all.message, "PLAN does not accept (path) and <scope>.");
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
    assert.equal(result.items.filter((item) => item.kind === "text").length, 0);
});

test("an unfinished modifier establishes an unparsed-tail trust boundary", () => {
    const result = PlurnkParser.parseStatements(sections(
        section("EDIT", " (first.md)", "one"),
        "## EDIT0 (broken",
        section("EDIT", " (third.md)", "three"),
    ));
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.equal(statements.length, 1);
    assert.equal(statements[0] && "target" in statements[0].statement ? statements[0].statement.target?.raw : undefined, "first.md");
    assert.deepEqual(result.unparsedTail?.from, { line: 4, column: 0 });
    assert.match(result.unparsedTail?.reason ?? "", /target slot of `## EDIT0`/);
});

test("clean section EOF is a body boundary, while open slots are not", () => {
    assert.equal(PlurnkParser.parseStatements(section("EDIT", " (p)", "body")).unparsedTail, undefined);
    assert.ok(PlurnkParser.parseStatements("## EDIT0 (p) {meta").unparsedTail);
    assert.ok(PlurnkParser.parseStatements("## EDIT0 (path").unparsedTail);
});

test("turn-shape diagnostics name the heading contract", () => {
    // {§turn-shape} — PLAN is optional: operations without one raise no PLAN diagnostic.
    const planless = PlurnkParser.parse(section("READ", " (x)"));
    const planlessErrors = planless.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);
    assert.deepEqual(planlessErrors, [PlurnkParser.MISSING_SEND], "only the missing terminal SEND is diagnosed");

    const missingSend = PlurnkParser.parse(section("PLAN", "", "inspect"));
    const sendError = missingSend.items.find((item) => item.kind === "error");
    assert.equal(sendError?.kind, "error");
    if (sendError?.kind === "error") {
        assert.equal(sendError.error.message, PlurnkParser.MISSING_SEND);
    }
});

test("model turns recover an omitted terminal SEND; a PLAN-less turn stands as written", () => {
    const planless = PlurnkParser.parse(sections(
        section("READ", " (worker:///notes.md)"),
        section("SEND", " (NEXT)", "continue"),
    ));
    assert.equal(planless.unparsedTail, undefined);
    const planlessStatements = planless.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(planlessStatements.map(({ op }) => op), ["READ", "SEND"], "no PLAN is synthesized");
    assert.equal(planless.items.some((item) => item.kind === "error"), false, "no PLAN diagnostic");

    const missingSend = PlurnkParser.parse(sections(
        section("PLAN", "", "inspect"),
        section("READ", " (worker:///notes.md)"),
    ));
    assert.equal(missingSend.unparsedTail, undefined);
    const missingSendStatements = missingSend.items.flatMap((item) =>
        item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(missingSendStatements.map(({ op }) => op), ["PLAN", "READ", "SEND"]);
    const recoveredSend = missingSendStatements.at(-1);
    assert.equal(recoveredSend?.op, "SEND");
    if (recoveredSend?.op === "SEND") {
        assert.equal(recoveredSend.status, 102);
        assert.equal(recoveredSend.body, null);
    }
    assert.match(
        missingSend.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []).join("\n"),
        /No valid terminal SEND was parsed/u,
    );
});

test("a paired outer plurnk fence is document framing, not turn content", () => {
    const result = PlurnkParser.parse([
        "```plurnk",
        section("PLAN", "", "inspect"),
        "",
        section("READ", " (notes.md)"),
        "",
        section("SEND", " (TERM)", "done"),
        "```",
        "",
    ].join("\n"));

    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["PLAN", "READ", "SEND"]);
    assert.deepEqual(statements[0]?.position, { line: 2, column: 0 });
    const last = statements.at(-1);
    assert.equal(last?.op, "SEND");
    if (last?.op === "SEND") assert.equal(last.body?.raw, "done");
});

test("EOF terminates an outer plurnk fence after a complete turn", () => {
    const result = PlurnkParser.parse([
        "```plurnk",
        section("PLAN", "", "inspect"),
        "",
        section("SEND", " (TERM)", "done"),
    ].join("\n"));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["PLAN", "SEND"],
    );
});

test("EOF fence tolerance does not admit an incomplete or post-SEND turn", () => {
    const incomplete = PlurnkParser.parse([
        "```plurnk",
        section("PLAN", "", "inspect"),
    ].join("\n"));
    assert.ok(incomplete.items.some((item) => item.kind === "error") || incomplete.unparsedTail !== undefined);

    const trailing = PlurnkParser.parse([
        "```plurnk",
        section("PLAN", "", "inspect"),
        "",
        section("SEND", " (TERM)", "done"),
        "",
        section("READ", " (late.md)"),
    ].join("\n"));
    assert.ok(trailing.items.some((item) => item.kind === "error") || trailing.unparsedTail !== undefined);
});

test("a disposition SEND terminates the turn", () => {
    const result = PlurnkParser.parse(sections(
        section("PLAN", "", "inspect"),
        section("SEND", " (TERM)", "done"),
        section("READ", " (late.md)"),
    ));
    const error = result.items.find((item) => item.kind === "error");
    assert.equal(error?.kind, "error");
    if (error?.kind === "error") assert.equal(error.error.message, "`## SEND0 (NEXT|WAIT|TERM|FAIL)` ends the turn - nothing may follow it");
});

test("202 remains a terminal wait disposition", () => {
    const result = PlurnkParser.parse(sections(
        section("PLAN", "", "wait"),
        section("SEND", " (WAIT)", "waiting"),
    ));
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
});

test("AST extracts delimiter, target, raw body, and position", () => {
    const statement = oneStatement("## EDITouter (p)\nhello");
    assert.equal(statement.op, "EDIT");
    assert.equal(statement.delimiter, "outer");
    assert.deepEqual(statement.target, { kind: "local", raw: "p" });
    assert.equal(statement.body, "hello");
    assert.equal(statement.lineMarker, null);
    assert.deepEqual(statement.position, { line: 1, column: 0 });
});
test("slot permutations produce equivalent AST values", () => {
    const variants = [
        "## FIND0 (p) <2>\nm",
        "## FIND0 <2> (p)\nm",
    ];
    for (const input of variants) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p");
        assert.deepEqual(statement.lineMarker, { marks: [2] });
    }

    // {§send-label} — a recipient in the path slot is a mid-turn message with no disposition.
    const recipient = oneStatement("## SEND0 (agent://named)\nmessage");
    if (recipient.op !== "SEND") assert.fail("expected SEND");
    assert.equal(recipient.status, null);
    assert.equal(recipient.target?.kind, "url");
});

test("modifier delimiters make horizontal spacing optional", () => {
    for (const input of [
        "## FIND0(p)<2>\nm",
        "## FIND0\t(p)\t<2>\nm",
        "## FIND0  (p) \t<2>\nm",
        "## FIND0<2>(p)\nm",
    ]) {
        const statement = oneStatement(input);
        if (statement.op !== "FIND") assert.fail("expected FIND");
        assert.equal(statement.target?.raw, "p", input);
        assert.deepEqual(statement.lineMarker, { marks: [2] }, input);
    }

    const send = oneStatement("## SEND0(worker://child)\ndone");
    if (send.op !== "SEND") assert.fail("expected SEND");
    assert.equal(send.status, null);
    assert.equal(send.target?.raw, "worker://child");
});

test("scheme metadata is an opaque ordered modifier outside the target", () => {
    const statement = oneStatement(
        "## READ0 (https://api.example/me) {Authorization: Bearer TOKEN} {Accept: application/json} <1,4>",
    );
    assert.equal(statement.op, "READ");
    assert.equal(statement.target?.raw, "https://api.example/me");
    assert.deepEqual(statement.metadata, [
        "Authorization: Bearer TOKEN",
        "Accept: application/json",
    ]);
    assert.deepEqual(statement.lineMarker, { marks: [1, 4] });
});

test("duplicate slots are rejected", () => {
    for (const input of [
        "## FIND0 [+b] (p)\nm",
        "## FIND0 (p1) (p2)\nm",
        "## FIND0 <1> <2> (p)\nm",
    ]) {
        assert.ok(errorsOf(input).length >= 1, input);
    }
});

// {§heading-inline-body}
test("body text on the heading line runs as the body and raises one advisory naming the rule", () => {
    const turn = "# PLAN0\nfind it\n\n## FIND0 (Engine.ts) /resolveWorkerPrimary/\n\n## SEND0 (NEXT)\nnext";
    const result = PlurnkParser.parse(turn);
    const find = result.items.find((item) => item.kind === "statement" && item.statement.op === "FIND");
    assert.equal(find?.kind, "statement", "the inline matcher still dispatches as FIND");
    if (find?.kind !== "statement") return;
    assert.deepEqual((find.statement as { body?: { dialect: string; raw: string } }).body?.raw, "/resolveWorkerPrimary/", "the matcher is the body");
    const advisory = result.items.find((item) => item.kind === "error" && item.error.severity === "warning");
    assert.equal(advisory?.kind, "error", "one advisory follows");
    if (advisory?.kind !== "error") return;
    assert.match(advisory.error.message, /body text was on the OP line and was taken as the body/);
    assert.match(advisory.error.message, /body content goes immediately beneath the OP heading line/);
    assert.equal(advisory.error.line, 4, "the advisory points at the heading");
    const canonical = PlurnkParser.parse("# PLAN0\nfind it\n\n## FIND0 (Engine.ts)\n/resolveWorkerPrimary/\n\n## SEND0 (NEXT)\nnext");
    assert.ok(!canonical.items.some((item) => item.kind === "error" && item.error.severity === "warning"), "the canonical two-line form raises nothing");
});

test("a matcher before its heading modifiers receives the local structural correction", () => {
    const malformed = "## FIND0 /require|ABS_MODULE_PATH|module_load/ (**/*.go) <1,-1>";
    const result = PlurnkParser.parseStatements(malformed);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(
        errors[0]?.error.message,
        "Regex matcher has trailing text after its closing `/`; operation modifiers precede the line ending, and the matcher occupies the next line.",
    );
    assert.doesNotMatch(errors[0]?.error.message ?? "", /ABS_MODULE_PATH|\*\*\/\*\.go/u, "the receipt does not echo the submitted matcher or target");
});

// {§misplaced-annotation-advisory}
test("a READ or FIND whose body is only an HTML comment takes it as the annotation and says so", () => {
    for (const op of ["READ", "FIND"] as const) {
        const turn = sections(
            section("PLAN", "", "edit"),
            section(op, " (Engine.ts) <520,530>", "<!-- Read context around the two matches. -->"),
            section("SEND", " (NEXT)", "next"),
        );
        const result = PlurnkParser.parse(turn);
        const statement = result.items.find((item) => item.kind === "statement" && item.statement.op === op);
        assert.equal(statement?.kind, "statement", `${op} still dispatches as ${op}`);
        if (statement?.kind !== "statement") return;
        assert.equal(statement.statement.annotation, "Read context around the two matches.", "the comment became the annotation");
        assert.equal("body" in statement.statement ? statement.statement.body : undefined, null, "no matcher was manufactured from the comment");
        const warning = result.items.find((item) => item.kind === "error" && item.error.severity === "warning");
        assert.equal(warning?.kind, "error", "one advisory follows the statement");
        if (warning?.kind !== "error") return;
        assert.equal(
            warning.error.message,
            `The ${op} body contained only an HTML comment; it was applied as the operation annotation.`,
        );
    }
    // a heading annotation wins; a body with any other content remains a matcher
    const kept = PlurnkParser.parse(sections(section("PLAN", "", "x"), section("READ", " (Engine.ts) <!-- heading -->", "<!-- body -->"), section("SEND", " (NEXT)", "n")));
    const read = kept.items.find((item) => item.kind === "statement" && item.statement.op === "READ");
    assert.equal(read?.kind === "statement" ? read.statement.annotation : null, "heading");
    const matcher = PlurnkParser.parse(sections(section("PLAN", "", "x"), section("READ", " (Engine.ts)", "resolveWorkerPrimary"), section("SEND", " (NEXT)", "n")));
    assert.ok(matcher.items.some((item) => item.kind === "statement" && item.statement.op === "FIND"), "a real matcher body still redirects to FIND");
    assert.ok(!matcher.items.some((item) => item.kind === "error" && item.error.severity === "warning"), "no advisory for a real matcher");
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

// {§combined-anchor-line-redirect}
test("a combined anchor and displayed line number gets one canonical correction", () => {
    for (const input of [
        section("EDIT", " (p) <@aZ09b:42,@0Aa9Z:43>", "body"),
        section("EDIT", " (p) <@aZ09b 42,@0Aa9Z 43>", "body"),
        section("COPY", " (p) (q) <@aZ09b 42,@0Aa9Z 43>"),
    ]) {
        const errors = errorsOf(input);
        assert.equal(errors.length, 1, input);
        assert.equal(
            errors[0]?.message,
            "a scope position accepts one line coordinate; use the `@hash` anchor without its displayed line number",
            input,
        );
    }
});

test("SEND terminal scope is retained while mid SEND rejects it; EXEC admits timeout and poll", () => {
    const terminal = oneStatement(section("SEND", " (NEXT) <30>", "polling"));
    if (terminal.op !== "SEND") assert.fail("expected SEND");
    assert.deepEqual(terminal.lineMarker, { marks: [30] });
    const appended = oneStatement(section("SEND", " (NEXT) <-1>", "standing by"));
    if (appended.op !== "SEND") assert.fail("expected SEND");
    assert.deepEqual(appended.lineMarker, { marks: [-1] });
    const exec = oneStatement("## EXEC0 [node] (./) <60,5>\ncommand");
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
test("matcher dialects project to typed bodies", () => {
    for (const [body, dialect] of [
        ["/foo|bar/i", "regex"],
        ["//user[@role='admin']", "xpath"],
        ["$.greeting", "jsonpath"],
        ["Paris*", "glob"],
        ["~distributed consensus algorithms", "semantic"],
        ["&<createCoder", "graph"],
        ["&>createCoder", "graph"],
        ["&createCoder", "graph"],
    ] as const) {
        const statement = oneStatement(section("FIND", " (source/**)", body));
        if (statement.op !== "FIND") assert.fail(body);
        assert.equal(statement.body?.dialect, dialect, body);
        assert.equal(statement.body?.raw, body, body);
    }
});

test("matcher admission rejects multiline bodies before dialect classification", () => {
    const renderedRead = [
        "@et6xE 2286:\t// Set debug flag from environment if not already set",
        "@alreh 2287:\tif (!requireDebug) {",
        "@84fBk 2288:\t\trequireDebug = true;",
    ].join("\n");

    for (const op of ["FIND", "READ", "KILL"] as const) {
        const result = PlurnkParser.parseStatements(section(op, " (source.ts)", renderedRead));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, op);
        assert.equal(errors[0]?.error.source, "visitor", op);
        assert.equal(errors[0]?.error.message, "Matcher body has 3 lines; expected 1.", op);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, op);
    }
});

test("graph claims ampersand and validates its complete single-line shape", () => {
    for (const body of ["&", "&<", "&>", "&two symbols"] as const) {
        const result = PlurnkParser.parseStatements(section("FIND", " (source/**)", body));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, body);
        assert.equal(errors[0]?.error.source, "visitor", body);
        assert.equal(
            errors[0]?.error.message,
            "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
            body,
        );
        assert.equal(result.items.some((item) => item.kind === "statement"), false, body);
    }
});

test("at-sign matcher text remains in the fallback glob dialect", () => {
    for (const body of [
        "@createCoder",
        "@et6xE 2286:const value = true;",
        "@(createCoder|deleteCoder)",
    ] as const) {
        const statement = oneStatement(section("FIND", " (source/**)", body));
        if (statement.op !== "FIND") assert.fail(body);
        assert.equal(statement.body?.dialect, "glob", body);
        assert.equal(statement.body?.raw, body, body);
    }
});

test("a body-leading at-sign does not hide an independently missing terminal SEND", () => {
    const result = PlurnkParser.parse([
        "# PLAN0",
        "[{\"content\":\"Read users.\",\"status\":\"in_progress\"}]",
        "## READ0 (data/users.json) <1,-1>",
        "@data/users.json",
    ].join("\n"));
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "parser");
    assert.equal(errors[0]?.error.message, PlurnkParser.MISSING_SEND);
});

test("regex bodies retain pattern, flags, escaped delimiters, and character classes", () => {
    const regex = oneStatement(section("FIND", " (log://x)", "/foo|bar/i"));
    if (regex.op !== "FIND" || regex.body?.dialect !== "regex") assert.fail("expected regex");
    assert.equal(regex.body.pattern, "foo|bar");
    assert.equal(regex.body.flags, "i");
    assert.equal(new RegExp(regex.body.pattern, regex.body.flags).test("FOO"), true);

    for (const [body, pattern] of [["/a\\/b/i", "a\\/b"], ["/[/]/", "[/]"]] as const) {
        const statement = oneStatement(section("FIND", " (log://x)", body));
        if (statement.op !== "FIND" || statement.body?.dialect !== "regex") assert.fail(body);
        const matcher = statement.body;
        assert.equal(matcher.pattern, pattern);
        assert.doesNotThrow(() => new RegExp(matcher.pattern, matcher.flags));
    }
});

test("declared matcher prefixes fail as their declared dialect instead of falling back", () => {
    for (const [body, message] of [
        ["/unclosed-regex", /has no closing `\/`/],
        ["/(abc/", /not a valid `\/pattern\/flags` regex/],
        ["/hello/i:", /Invalid flags/],
        ["//book[unterminated", /not a valid xpath selector/],
        ["// TODO: add error handling", /not a valid xpath selector/],
        ["$[(", /not a valid jsonpath/],
        ["$HOME", /not a valid jsonpath/],
        ["$.users[", /not a valid jsonpath/],
    ] as const) {
        const result = PlurnkParser.parseStatements(section("FIND", " (source)", body));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, body);
        assert.equal(errors[0]?.error.source, "visitor", body);
        assert.match(errors[0]!.error.message, message, body);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, body);
    }
});

test("matcher validation is per section and does not consume siblings", () => {
    const result = PlurnkParser.parseStatements(sections(
        section("FIND", " (a.txt)", "/ok/i"),
        section("FIND", " (b.txt)", "/bad/i:"),
        section("KILL", " (log:///1/2/3)"),
    ));
    assert.equal(result.items.filter((item) => item.kind === "statement").length, 2);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 1);
});

test("ordinary matcher text remains glob and non-matcher bodies remain opaque", () => {
    const glob = oneStatement(section("FIND", " (known:///**)", ":<1,-1>:/hello/i:"));
    if (glob.op !== "FIND") assert.fail("expected FIND");
    assert.equal(glob.body?.dialect, "glob");

    const edit = oneStatement(section("EDIT", " (p)", "/this is literal EDIT content/x"));
    assert.equal(edit.op, "EDIT");
    assert.equal(edit.body, "/this is literal EDIT content/x");
});

test("semantic matcher accepts arbitrary text and a result-position scope", () => {
    const kill = oneStatement(section("KILL", " (log://**)", "~find anything about: !@#$%^ malformed (but valid as query)"));
    if (kill.op !== "KILL") assert.fail("expected KILL");
    assert.equal(kill.body?.dialect, "semantic");

    const find = oneStatement(section("FIND", " (known://**) <5>", "~graph algorithms"));
    if (find.op !== "FIND") assert.fail("expected FIND");
    assert.deepEqual(find.lineMarker, { marks: [5] });
    assert.equal(find.body?.dialect, "semantic");
});

// {§read-find-normalization}
test("READ aggregate forms normalize to schema-valid FIND", () => {
    const cases = [
        { input: section("READ", " (worker:///page.md) <2,4>"), op: "READ", dialect: null, marks: [2, 4],  },
        { input: section("READ", " (worker:///page.md) <3,5>", "/header/i"), op: "FIND", dialect: "regex", marks: [3, 5], },
        { input: section("READ", " (src/**/*.ts) <2>"), op: "FIND", dialect: null, marks: [2],  },
        { input: section("READ", " (worker:///src/**/*.ts) <4,8>"), op: "FIND", dialect: null, marks: [4, 8],  },
        { input: section("READ", " (worker:///src/**/*.ts)", "TODO"), op: "FIND", dialect: "glob", marks: null,  },
    ] as const;

    for (const { input, op, dialect, marks } of cases) {
        const statement = oneStatement(input);
        assert.equal(statement.op, op, input);
        assert.deepEqual(statement.lineMarker?.marks ?? null, marks, input);
        assert.equal(statement.op === "FIND" ? statement.body?.dialect ?? null : null, dialect, input);
        const validation = Validator.validatePlurnkStatement(statement);
        assert.equal(validation.valid, true, `${input}: ${JSON.stringify(validation.errors)}`);
    }
});

test("READ matcher admission retains positioned dialect errors", () => {
    const result = PlurnkParser.parseStatements(section("READ", " (page.html)", "// foo {bar}"));
    assert.equal(result.items.some((item) => item.kind === "statement"), false);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "visitor");
    assert.match(errors[0]?.error.message ?? "", /not a valid xpath selector/);
});

test("COPY and MOVE operands project path, metadata, fragment, and scope independently", () => {
    const copy = oneStatement(section(
        "COPY",
        " (known:///draft#body) {source metadata} <2,4> (known:///archive#notes) {destination metadata} <1,3,1,3>",
    ));
    if (copy.op !== "COPY" || copy.destination.target.kind !== "url") assert.fail("expected COPY");
    assert.equal(copy.destination.target.fragment, "notes");
    assert.equal(copy.destination.target.raw, "known:///archive#notes");
    assert.deepEqual(copy.destination.metadata, ["destination metadata"]);
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, 3, 1, 3] });
    assert.deepEqual(copy.source.metadata, ["source metadata"]);
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 4] });

    const move = oneStatement(section("MOVE", " (worker:///draft) (./out.txt)"));
    if (move.op !== "MOVE") assert.fail("expected MOVE");
    assert.deepEqual(move.source.target, parsePath("worker:///draft"));
    assert.deepEqual(move.destination.target, { kind: "local", raw: "./out.txt" });
});

test("SEND projects JSON when valid and always preserves raw body", () => {
    const json = oneStatement(section("SEND", " (TERM)", '{"answer":"Paris","confidence":0.95}'));
    if (json.op !== "SEND" || !json.body) assert.fail("expected SEND");
    assert.equal(json.body.raw, '{"answer":"Paris","confidence":0.95}');
    assert.deepEqual(json.body.json, { answer: "Paris", confidence: 0.95 });

    const text = oneStatement(section("SEND", " (TERM)", "Paris"));
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
    const executor = firstError("## EXEC0 (node) (./)\ncommand");
    assert.match(executor.message, /`## EXEC0` accepts one `\(program\)` path at most once/);

    // {§heading-inline-body} — a matcher after the target on the heading line is the body now.
    const inline = oneStatement("## FIND0 (data.json) $.role");
    if (inline.op !== "FIND") assert.fail("expected FIND");
    assert.deepEqual(inline.body, { dialect: "jsonpath", raw: "$.role" });

    const target = PlurnkParser.parseStatements("## EDIT0 (path").unparsedTail;
    assert.match(target?.reason ?? "", /target slot of `## EDIT0`.*add `\)`/);

    const metadata = PlurnkParser.parseStatements("## EDIT0 (p) {meta").unparsedTail;
    assert.match(metadata?.reason ?? "", /metadata modifier of `## EDIT0`.*add `\}`/);
});

test("diagnostics do not leak ANTLR implementation vocabulary", () => {
    const forbidden = /token recognition|mismatched|extraneous|expecting|no viable|RPAREN|LBRACKET|RBRACKET|LPAREN|BODY_TEXT|<EOF>|ATN/;
    for (const input of [
        "## EDIT0 (path",
        "## EDIT0 [+tag",
        "## EDIT0 (p) stray",
        "## SEND0 [bad]\nmessage",
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
        section("SEND", " (TERM)", "array[0] and a stray ] bracket"),
        section("SEND", " (FAIL)", '{"expected":["a","b"],"got":[1,2]}'),
        section("SEND", " (TERM)", "]]]) }{[ <> mixed"),
        section("EDIT", " (a.md)", "x = arr[0] + (y) + {z}"),
        section("SEND", " (worker://parent)", "result ] arr[0]"),
        section("SEND", " (TERM)", "# User heading\n\n- one\n- two"),
    ]) {
        assert.equal(oneStatement(input).op === "SEND" || oneStatement(input).op === "EDIT", true, input);
    }
});

test("parse accepts one PLAN-anchored turn and rejects another PLAN after its terminal SEND", () => {
    const turn = sections(
        section("PLAN", "", "inspect"),
        section("READ", " (worker:///x)"),
        section("SEND", " (TERM)", "done"),
    );
    const result = PlurnkParser.parse(turn);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);

    const twoTurns = sections(turn, sections(
        section("PLAN", "", "again"),
        section("SEND", " (TERM)", "done again"),
    ));
    const invalid = PlurnkParser.parse(twoTurns);
    assert.ok(invalid.items.some((item) => item.kind === "error") || invalid.unparsedTail !== undefined);
});

test("parseLog accepts direct consecutive turns and flattens them in order", () => {
    const input = sections(
        section("PLAN", "", "find it"),
        section("READ", " (worker:///x)"),
        section("SEND", " (NEXT)", "reading"),
        section("PLAN", "", "answer"),
        section("SEND", " (TERM)", "done"),
    );
    const result = PlurnkParser.parseLog(input);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(
        result.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
        ["PLAN", "READ", "SEND", "PLAN", "SEND"],
    );
});

test("parseLog requires at least one complete turn", () => {
    for (const input of [
        "",
        section("READ", " (worker:///x)"),
        section("PLAN", "", "incomplete"),
    ]) {
        const result = PlurnkParser.parseLog(input);
        assert.ok(result.items.some((item) => item.kind === "error") || result.unparsedTail !== undefined, input);
    }
});

test("parser positions count Unicode code points and CRLF lines", () => {
    // Without a separating space the trailing text is still a malformed heading; with one it is
    // the inline body ({§heading-inline-body}). Either way columns count code points.
    const unicode = PlurnkParser.parseStatements("## EDIT0 (🙂)X");
    const error = unicode.items.find((item) => item.kind === "error");
    assert.equal(error?.kind, "error");
    if (error?.kind === "error") assert.deepEqual({ line: error.error.line, column: error.error.column }, { line: 1, column: 12 });
    const inlineEdit = oneStatement("## EDIT0 (🙂) X");
    if (inlineEdit.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(inlineEdit.body, "X");

    const crlf = oneStatement("## EDIT0 (p)\r\nline one\r\nline two");
    if (crlf.op !== "EDIT") assert.fail("expected EDIT");
    assert.equal(crlf.body, "line one\r\nline two");
});

// {§heading-inline-body}
test("body text on the heading line is the first body line when it cannot open a slot", () => {
    const exec = oneStatement("## EXEC0 [crm] (crm_query) SELECT Id FROM Case");
    if (exec.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(exec.executor, "crm");
    assert.equal(exec.target?.raw, "crm_query");
    assert.equal(exec.body, "SELECT Id FROM Case");

    const multi = oneStatement('## EXEC0 [crm] (crm_query)\n{"soql":\n "SELECT Id FROM Case"}');
    if (multi.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(multi.body, '{"soql":\n "SELECT Id FROM Case"}', "the inline start joins the following body lines");

    const send = oneStatement("## SEND0 (TERM) Paris.");
    if (send.op !== "SEND" || !send.body) assert.fail("expected SEND with body");
    assert.equal(send.body.raw, "Paris.");

    const annotated = oneStatement("## FIND0 (src/**) <!-- where --> /createCoder/i");
    if (annotated.op !== "FIND") assert.fail("expected FIND");
    assert.equal(annotated.annotation, "where");
    assert.equal(annotated.body?.raw, "/createCoder/i");

    // Slot openers stay slots; tolerant ingestion does not require canonical spacing.
    const unspaced = oneStatement('## EXEC0 [crm] (crm_query){"soql": "x"}');
    if (unspaced.op !== "EXEC") assert.fail("expected EXEC");
    assert.deepEqual(unspaced.metadata, ['"soql": "x"']);
    assert.equal(oneStatement("## READ0 (a.md) <1,3>").op, "READ");
});

// {§exec-executor-slot}
test("the executor slot rides an EXEC heading alone, before the program path", () => {
    const railed = oneStatement("## EXEC0 [python3] (tools/report.py) {cwd=build} <30>\ninput");
    if (railed.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(railed.executor, "python3");
    assert.equal(railed.target?.raw, "tools/report.py");
    assert.deepEqual(railed.metadata, ["cwd=build"]);
    assert.deepEqual(railed.lineMarker, { marks: [30] });
    assert.equal(railed.body, "input");
    const bare = oneStatement("## EXEC0\npwd");
    if (bare.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(bare.executor, null);
    assert.equal(bare.target, null);
    const alone = oneStatement("## EXEC0 [node]\nconsole.log(1)");
    if (alone.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(alone.executor, "node");
    assert.equal(alone.target, null);
    const plus = oneStatement("## EXEC0 [c++] (main.cpp)\n");
    if (plus.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(plus.executor, "c++");
    const unspaced = oneStatement("## EXEC0[jq](data.json)\n.a");
    if (unspaced.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(unspaced.executor, "jq");
    assert.equal(unspaced.target?.raw, "data.json");
    assert.match(firstError("## EXEC0 (tool.py) [python3]\ninput").message, /misplaced `\[executor\]` - it leads an EXEC heading, once/);
    assert.match(firstError("## EXEC0 [python3] [node] (tool.py)\ninput").message, /misplaced `\[executor\]` - it leads an EXEC heading, once/);
    assert.match(firstError("## EXEC0 [python 3] (tool.py)\ninput").message, /malformed `\[executor\]` on EXEC/);
    const cwdOnly = oneStatement("## EXEC0 {cwd=sub}\nmake test");
    if (cwdOnly.op !== "EXEC") assert.fail("expected EXEC");
    assert.equal(cwdOnly.executor, null);
    assert.deepEqual(cwdOnly.metadata, ["cwd=sub"]);
    assert.equal(cwdOnly.body, "make test");
    const executorCwd = oneStatement("## EXEC0 [node] {cwd=sub}\nconsole.log(process.cwd())");
    if (executorCwd.op !== "EXEC") assert.fail("expected EXEC");
    assert.deepEqual(executorCwd.metadata, ["cwd=sub"]);
    assert.match(firstError("## READ0 [python3] (tool.py)").message, /`\[executor\]` belongs to EXEC only .*; READ takes `\(path\)`/);
});
