import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, PlurnkParseError, parsePath, Validator } from "../../src/index.ts";

const statementsOf = (input: string) =>
    PlurnkParser.parseStatements(input).items.filter((i) => i.kind === "statement");

const errorsOf = (input: string) =>
    PlurnkParser.parseStatements(input).items.filter((i) => i.kind === "error").map((i) => i.error);

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

// -------------------------------------------------------------------------
// Single-statement parses
// -------------------------------------------------------------------------

test("ex 3 — simple EDIT with body", () => {
    assert.equal(statementsOf("<<EDIT(known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT").length, 1);
});

test("ex 4 — bare READ, empty body", () => {
    assert.equal(statementsOf("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ").length, 1);
});

test("balanced parentheses are ordinary URL target content", () => {
    const source = "<<FIND(https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)):/spouse|wife|married|Zhannetta|Lotnik/i:FIND";
    const result = PlurnkParser.parseStatements(source);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    if (item?.kind !== "statement" || item.statement.op !== "FIND") assert.fail("expected FIND");
    assert.equal(item.statement.target?.raw, "https://en.wikipedia.org/wiki/Igor_Smirnov_(politician)");
});

test("unescaped unmatched target parentheses require canonical spelling", () => {
    assert.ok(errorsOf("<<READ(https://example.test/a)b)::READ").length > 0);
    const unclosed = PlurnkParser.parseStatements("<<READ(https://example.test/a(b)::READ");
    assert.equal(unclosed.items.length, 0);
    assert.match(unclosed.unparsedTail?.reason ?? "", /target slot of `<<READ`.*add `\)`/);
    for (const encoded of ["a%28b", "a%29b"]) {
        const result = PlurnkParser.parseStatements(`<<READ(https://example.test/${encoded})::READ`);
        assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
        assert.equal(result.unparsedTail, undefined);
    }
});

test("target escapes preserve literal and percent-encoded URI spelling", () => {
    const source = String.raw`<<READ(https://example.test/x?literal=\)&encoded=%29#preview\()::READ`;
    const result = PlurnkParser.parseStatements(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    const item = result.items.find((candidate) => candidate.kind === "statement");
    if (item?.kind !== "statement" || item.statement.op !== "READ") assert.fail("expected READ");
    assert.equal(item.statement.target?.raw, "https://example.test/x?literal=)&encoded=%29#preview(");
    if (item.statement.target?.kind !== "url") assert.fail("expected URL target");
    assert.equal(item.statement.target.query, "literal=)&encoded=%29");
    assert.equal(item.statement.target.fragment, "preview(");
});

test("COPY/MOVE destinations use the same target escape layer", () => {
    const result = PlurnkParser.parseStatements(
        String.raw`<<COPY(worker:///draft):https://example.test/archive?literal=\)&encoded=%29:COPY`,
    );
    const item = result.items.find((candidate) => candidate.kind === "statement");
    if (item?.kind !== "statement" || item.statement.op !== "COPY") assert.fail("expected COPY");
    const destination = item.statement.body?.target;
    if (destination?.kind !== "url") assert.fail("expected URL destination");
    assert.equal(destination.raw, "https://example.test/archive?literal=)&encoded=%29");
    assert.equal(destination.query, "literal=)&encoded=%29");
});

test("ex 12 — EDIT with empty body (clear)", () => {
    assert.equal(statementsOf("<<EDIT(known://countries/france/capital)::EDIT").length, 1);
});

test("ex 17 — SEND with signal, no path", () => {
    assert.equal(statementsOf("<<SEND[102]:decomposed prompt; plan initialized:SEND").length, 1);
});

test("ex 6 — EDIT with signal, path, and body", () => {
    assert.equal(statementsOf("<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT").length, 1);
});

test("ex 8 — EDIT with single-line marker", () => {
    assert.equal(statementsOf("<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT").length, 1);
});

test("ex 21 — FIND with range pagination, empty body", () => {
    assert.equal(statementsOf("<<FIND(known://**)<1-20>::FIND").length, 1);
});

test("body containing literal OP keyword (no false-match)", () => {
    assert.equal(statementsOf("<<EDIT(p):the EDIT command takes a path:EDIT").length, 1);
});

test("body starting with bare paren (modifier-like content)", () => {
    assert.equal(statementsOf("<<EDIT(p):() abc:EDIT").length, 1);
});

test("body containing internal colons (predicate falsifies)", () => {
    assert.equal(statementsOf("<<EDIT(p):key:value:more:stuff:EDIT").length, 1);
});

test("WORK and FORK require a non-empty prompt body", () => {
    for (const op of ["WORK", "FORK"]) {
        assert.ok(errorsOf(`<<${op}(worker://child):${op}`).length > 0);
        assert.ok(errorsOf(`<<${op}(worker://child)::${op}`).length > 0);
        assert.equal(statementsOf(`<<${op}(worker://child):Do the assigned work:${op}`).length, 1);
    }
});

// {§suffix-discipline} {§close-tag-match}
test("ex 31 — nested EDIT via suffix discipline", () => {
    const input = "<<EDITouter(known://demo):quoted: <<EDIT(known://inner):hello world:EDIT:EDITouter";
    assert.equal(statementsOf(input).length, 1);
});

test("suffix-delimiter nesting is one parser contract for every protocol operation body", async (t) => {
    const forms: ReadonlyArray<readonly [string, string]> = [
        ["FIND", "(worker:///x)"],
        ["EDIT", "(worker:///x)"],
        ["COPY", "(worker:///x)"],
        ["MOVE", "(worker:///x)"],
        ["OPEN", "(log:///1)"],
        ["FOLD", "(log:///1)"],
        ["SEND", "[400]"],
        ["EXEC", "[sh]"],
        ["WORK", "(worker://child)"],
        ["FORK", "(worker://child)"],
        ["KILL", "(worker:///x)"],
        ["PLAN", ""],
    ];
    for (const [op, slots] of forms) {
        await t.test(op, () => {
            const nested = `<<${op}:inner:${op}`;
            const result = PlurnkParser.parseStatements(`<<${op}1${slots}:quoted ${nested}:${op}1`);
            assert.equal(result.unparsedTail, undefined);
            assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
            const item = result.items.find((candidate) => candidate.kind === "statement");
            if (item?.kind !== "statement") assert.fail(`expected ${op} statement`);
            assert.equal(item.statement.op, op);
            assert.equal(item.statement.suffix, "1");
            const body = JSON.stringify(item.statement.body);
            assert.ok(body.includes(nested), `${op} body lost its nested operation`);
        });
    }
});

// -------------------------------------------------------------------------
// Multi-statement parses
// -------------------------------------------------------------------------

test("two statements in sequence", () => {
    const input = "<<EDIT(p)::EDIT<<READ(q)::READ";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("interstatement whitespace is hidden, not captured as text", () => {
    const input = "<<EDIT(p)::EDIT\n\n<<READ(q)::READ";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    // Pure inter-operation whitespace surfaces no text items.
    assert.equal(result.items.filter((i) => i.kind === "text").length, 0);
});

// -------------------------------------------------------------------------
// Per-statement error recovery
// -------------------------------------------------------------------------

test("three valid statements in sequence parse independently", () => {
    const input = "<<EDIT(p1):one:EDIT\n<<EDIT(p2):two:EDIT\n<<EDIT(p3):three:EDIT";
    const result = PlurnkParser.parseStatements(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 3);
});

test("malformed path (unclosed paren) produces a tail boundary, not silent swallowing", () => {
    // Statement 2's path is missing its `)`. The lexer retains that boundary
    // rather than greedily exposing statement 3 as another public statement.
    const input = "<<EDIT(p1):one:EDIT<<EDIT(broken<<EDIT(p3):three:EDIT";
    const result = PlurnkParser.parseStatements(input);
    assert.deepEqual(
        result.items.map((item) => item.kind === "statement" ? item.statement.target?.raw : item.kind),
        ["p1"],
        "only the complete statement before the broken target remains public",
    );
    assert.deepEqual(result.unparsedTail?.from, { line: 1, column: 19 });
    assert.match(result.unparsedTail?.reason ?? "", /target slot of `<<EDIT`.*add `\)`/);
});

test("error carries line, column, and source", () => {
    // Malformed: missing close.
    const input = "<<EDIT(p):body without close";
    const result = PlurnkParser.parseStatements(input);
    const errs = errorsOf(input);
    assert.ok(errs.length >= 1 || result.unparsedTail);
    if (errs.length >= 1) {
        const e = errs[0];
        assert.equal(typeof e.line, "number");
        assert.equal(typeof e.column, "number");
        assert.ok(e.source === "lexer" || e.source === "parser");
        assert.ok(e instanceof PlurnkParseError);
    }
});

test("boundary-destroying error produces unparsedTail", () => {
    // No close tag at all: lexer stuck in BODY mode at EOF.
    const result = PlurnkParser.parseStatements("<<EDIT(p):body never closed");
    assert.ok(result.unparsedTail, "expected unparsedTail to be set");
});

// {§unparsed-tail-boundary}
test("unparsedTail excludes recovered items at and beyond its trust boundary", async (t) => {
    const prefix = "<<EDIT(worker:///ok):yes:EDIT\n";
    const tails = [
        ["body", "<<EDIT(worker:///bad):unterminated", /body of `<<EDIT`/],
        ["target", "<<READ(worker:///bad", /target slot of `<<READ`/],
        ["signal", "<<SEND[x", /signal slot of `<<SEND`/],
    ] as const;

    for (const [name, tail, reason] of tails) {
        await t.test(name, () => {
            const result = PlurnkParser.parseClient(prefix + tail);
            assert.deepEqual(result.unparsedTail?.from, { line: 2, column: 0 });
            assert.match(result.unparsedTail?.reason ?? "", reason);
            assert.equal(result.items.length, 1, "only the trusted-prefix statement is public");
            const [item] = result.items;
            assert.equal(item.kind, "statement");
            if (item.kind === "statement") {
                assert.equal(item.statement.op, "EDIT");
                assert.deepEqual(item.statement.position, { line: 1, column: 0 });
            }
        });
    }
});

test("boundary loss does not synthesize a downstream turn-shape error", () => {
    const result = PlurnkParser.parse("<<PLAN:p:PLAN\n<<EDIT(worker:///bad):unterminated");
    assert.deepEqual(
        result.items.map((item) => item.kind === "statement" ? item.statement.op : item.kind),
        ["PLAN"],
    );
    assert.match(result.unparsedTail?.reason ?? "", /body of `<<EDIT`/);
});

test("clean parse has no unparsedTail", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):body:EDIT");
    assert.equal(result.unparsedTail, undefined);
});

test("bare text in parse() yields only the grammar error, no internal null-deref leak", () => {
    const result = PlurnkParser.parse("phoenix");
    const errors = result.items.filter((i) => i.kind === "error").map((i) => (i.kind === "error" ? i.error : null));
    // No internal JS crash (the phantom PLAN context's null OPEN terminal) escapes as an error item.
    for (const e of errors) {
        assert.doesNotMatch(e!.message, /getText|Cannot read properties/, `internal crash leaked: ${e!.message}`);
    }
    // Exactly the one legitimate grammar error, pointing the model at the fix (the turn-shape
    // imperative — bare text is a turn with no PLAN anchor).
    assert.equal(errors.length, 1, `expected 1 grammar error, got ${errors.length}`);
    assert.match(errors[0]!.message, /begin with `<<PLAN/);
});

test("a valid turn still parses clean; the phantom-skip guard does not eat real statements", () => {
    const result = PlurnkParser.parse("<<PLAN:think:PLAN <<SEND[200]:done:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const ops = result.items.filter((i) => i.kind === "statement").map((i) => (i.kind === "statement" ? i.statement.op : ""));
    assert.deepEqual(ops, ["PLAN", "SEND"]);
});

// -------------------------------------------------------------------------
// Error-message value-adds (we own syntax errors end to end)
// -------------------------------------------------------------------------

const errMsgs = (input: string) =>
    PlurnkParser.parse(input).items
        .filter((i) => i.kind === "error")
        .map((i) => (i.kind === "error" ? i.error : null));

// {§error-shape}
test("value-add: expected-token list is deduped (no `<<OPsuffix` repeated 10x)", () => {
    const msg = errMsgs("<<PLAN:t:PLAN <<READ(x)::READ")[0]!.message;
    assert.equal((msg.match(/<<OPsuffix/g) ?? []).length <= 1, true, msg);
});

// {§turn-shape}
test("value-add: PLAN-less turn gets the begin-with-PLAN imperative", () => {
    const errs = errMsgs("<<SEND[200]:done:SEND");
    assert.equal(errs.length, 1);
    assert.match(errs[0]!.message, /begin with `<<PLAN:…:PLAN`/);
});

test("value-add: SEND-less turn gets the end-with-SEND imperative", () => {
    const errs = errMsgs("<<PLAN:think:PLAN");
    assert.match(errs[errs.length - 1]!.message, /end with a terminal `<<SEND/);
});

test("value-add: a turn that derails mid-op does NOT get a misleading SEND imperative", () => {
    // The real fix is the unclosed target; the missing SEND is a parse artifact.
    const result = PlurnkParser.parse("<<PLAN:t:PLAN <<READ(:READ <<SEND[200]:d:SEND");
    const errs = result.items.filter((item) => item.kind === "error").map((item) => item.error);
    assert.equal(errs.some((e) => /end with a terminal/.test(e!.message)), false);
    assert.match(result.unparsedTail?.reason ?? "", /target slot of `<<READ`.*add `\)`/);
});

test("value-add: near-miss op swallowed as prose surfaces a warning, not an error", () => {
    const emission = "<<PLAN:t:PLAN <<CLOSE(log://x)::CLOSE <<SEND[200]:d:SEND";
    const r = PlurnkParser.parse(emission);
    const warn = r.items.find((i) => i.kind === "error" && i.error.severity === "warning");
    assert.ok(warn && warn.kind === "error", "expected a warning advisory");
    assert.match(warn.error.message, /`<<CLOSE`.*did you mean `<<FOLD`/);
    assert.deepEqual(
        { line: warn.error.line, column: warn.error.column },
        { line: 1, column: emission.indexOf("<<CLOSE") },
        "the advisory points at the actual near-miss after the preceding close tag",
    );
    const send = r.items.find((i) => i.kind === "statement" && i.statement.op === "SEND");
    assert.ok(send && send.kind === "statement");
    assert.deepEqual(
        send.statement.position,
        { line: 1, column: emission.indexOf("<<SEND") },
        "manual close-tag consumption cannot corrupt following token positions",
    );
    // It is a warning, not an error, and the turn still parsed.
    assert.equal(r.items.filter((i) => i.kind === "error" && i.error.severity === "error").length, 0);
    assert.equal(r.items.filter((i) => i.kind === "statement").length, 2);
});

// {§parser-position}
test("parser points count Unicode code points across native and advisory diagnostics", () => {
    const emission = "<<PLAN:😀é:PLAN 😀<<CLOSE:x:CLOSE <<EXEC[-1,300]:x:EXEC <<SEND[200]:d:SEND";
    const result = PlurnkParser.parse(emission);
    const warning = result.items.find(
        (item) => item.kind === "error" && item.error.severity === "warning" && item.error.message.includes("<<CLOSE"),
    );
    const lexerError = result.items.find(
        (item) => item.kind === "error" && item.error.source === "lexer",
    );
    assert.ok(warning && warning.kind === "error");
    assert.ok(lexerError && lexerError.kind === "error");

    const codePointColumn = (needle: string): number => Array.from(
        emission.slice(0, emission.indexOf(needle)),
    ).length;
    assert.notEqual(codePointColumn("<<CLOSE"), emission.indexOf("<<CLOSE"), "the specimen distinguishes code points from UTF-16 units");
    assert.deepEqual(
        { line: warning.error.line, column: warning.error.column },
        { line: 1, column: codePointColumn("<<CLOSE") },
    );
    assert.deepEqual(
        { line: lexerError.error.line, column: lexerError.error.column },
        { line: 1, column: codePointColumn("-1") },
    );
});

// {§parser-position}
test("parser points use LF and CRLF line boundaries while lone CR remains a code point", () => {
    const crlf = PlurnkParser.parseStatements("<<EDIT(a):x:EDIT\r\n<<READ(a)::READ");
    const cr = PlurnkParser.parseStatements("<<EDIT(a):x:EDIT\r<<READ(a)::READ");
    const positions = (result: ReturnType<typeof PlurnkParser.parseStatements>) => result.items
        .filter((item) => item.kind === "statement")
        .map((item) => item.statement.position);
    assert.deepEqual(positions(crlf), [{ line: 1, column: 0 }, { line: 2, column: 0 }]);
    assert.deepEqual(positions(cr), [{ line: 1, column: 0 }, { line: 1, column: 17 }]);
});

test("value-add: near-miss is immune to bodies — embedded `<<CLOSE` in an EDIT is not flagged", () => {
    const r = PlurnkParser.parse("<<PLAN:t:PLAN <<EDIT(x):close via <<CLOSE later:CLOSE done:EDIT <<SEND[200]:d:SEND");
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
});

test("value-add: a bare `<<DELETE` mention without heredoc close is NOT flagged (op-shape gate)", () => {
    const r = PlurnkParser.parse("<<PLAN:weighing <<DELETE vs KILL:PLAN <<KILL(x)::KILL <<SEND[200]:d:SEND");
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
});

// {§send-mid-reservation}
test("value-add: mid-turn termination (op after a disposition SEND) is lifted to the rule", () => {
    const errs = errMsgs("<<PLAN:p:PLAN\n<<SEND[200]:done:SEND\n<<EDIT(worker:///a):v:EDIT");
    // Shape-only diagnostics leave disposition policy to {§waitpid-dispositions}.
    assert.ok(errs.some((e) => /a disposition SEND ends the turn - nothing may follow it/.test(e!.message)));
    // Recovery reports the violated turn rule, not a token-level fallback.
    assert.equal(errs.some((e) => /unexpected open tag/.test(e!.message)), false);
});

test("value-add: two disposition SENDs get the termination rule (the second cannot follow the first)", () => {
    const errs = errMsgs("<<PLAN:p:PLAN\n<<SEND[102]:cont:SEND\n<<SEND[200]:done:SEND");
    assert.ok(errs.some((e) => /a disposition SEND ends the turn/.test(e!.message)));
});

// {§waitpid-dispositions} {§park-202-only}
test("202 is the wait disposition; ANTLR remains shape-tolerant while runtime owns disposition semantics", () => {
    // Terminal position: a turn ends on SEND[202] cleanly (the obligation-check is the engine's).
    const ok = PlurnkParser.parse("<<PLAN:p:PLAN\n<<SEND[202]:awaiting worker:SEND");
    assert.equal(ok.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(ok.unparsedTail, undefined);
    // Mid position: the mid-termination rule fires.
    const errs = errMsgs("<<PLAN:p:PLAN\n<<SEND[202]:fyi:SEND\n<<SEND[102]:cont:SEND");
    assert.ok(errs.some((e) => /a disposition SEND ends the turn/.test(e!.message)));
    // ANTLR admits the terminal SEND scope shape. The dispatcher rejects this
    // semantic combination and the generation rail never emits it.
    const tol = PlurnkParser.parse("<<PLAN:p:PLAN\n<<SEND[102]<60>:holding:SEND");
    assert.equal(tol.items.filter((i) => i.kind === "error").length, 0);
});

test("value-add: the mid-termination lift is suppressed when the turn derailed mid-op", () => {
    // The real fix is the unclosed signal, not a synthesized mid-termination.
    const result = PlurnkParser.parse("<<PLAN:p:PLAN\n<<SEND[200(x):d:SEND");
    const errs = result.items.filter((item) => item.kind === "error").map((item) => item.error);
    assert.equal(errs.some((e) => /ends the turn/.test(e!.message)), false);
    assert.match(result.unparsedTail?.reason ?? "", /signal slot of `<<SEND`.*add `\]`/);
});

test("value-add: a malformed signal collapses the per-character lexer cascade to one error", () => {
    const lex = errMsgs("<<PLAN:p:PLAN\n<<SEND[abc]:d:SEND").filter((e) => e!.source === "lexer");
    // Adjacent lexer failures with the same context collapse into one steer.
    assert.equal(lex.length, 1, lex.map((e) => e!.message).join(" | "));
    assert.match(lex[0]!.message, /expected integer for SEND\/KILL/);
});

// {§parse-diagnostics} {§error-shape}
test("each malformed statement surfaces only its first hard diagnostic", () => {
    const exec = errorsOf("<<EXEC[-1,300]:x:EXEC");
    assert.equal(exec.length, 1, exec.map(({ message }) => message).join(" | "));
    assert.match(exec[0]!.message, /timeout\/poll ride the `<scope>` slot/);

    const matcher = errorsOf("<<FIND(a.go)$fC:x:FIND");
    assert.equal(matcher.length, 1, matcher.map(({ message }) => message).join(" | "));
    assert.match(matcher[0]!.message, /matcher rides the `:body:` slot/);

    const independent = errorsOf("<<EXEC[-1,300]:x:EXEC\n<<FIND(a.go)$fC:x:FIND");
    assert.deepEqual(
        independent.map(({ line }) => line),
        [1, 2],
        independent.map(({ message }) => message).join(" | "),
    );
});

test("value-add: SPAWN/DELEGATE near-miss steers to `<<WORK`", () => {
    for (const word of ["SPAWN", "DELEGATE"]) {
        const r = PlurnkParser.parse(`<<PLAN:p:PLAN\n<<${word}(worker://x):go:${word}\n<<SEND[102]:c:SEND`);
        const warn = r.items.find((i) => i.kind === "error" && i.error.severity === "warning");
        assert.ok(warn && warn.kind === "error", `${word} should surface a near-miss`);
        assert.match(warn.error.message, /did you mean `<<WORK\(worker:\/\/name\)`/);
    }
});

test("value-add: FORK is an operation, never a near-miss", () => {
    const r = PlurnkParser.parse("<<PLAN:p:PLAN\n<<FORK(worker://x):retry:FORK\n<<SEND[102]:c:SEND");
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(r.items.filter((i) => i.kind === "statement" && i.statement.op === "FORK").length, 1);
});

// -------------------------------------------------------------------------
// Domain AST shape
// -------------------------------------------------------------------------

test("AST: minimal EDIT extracts op, suffix, body", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):hello:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    const s = item.statement;
    assert.equal(s.op, "EDIT");
    assert.equal(s.suffix, "");
    assert.equal(s.target?.kind, "local");
    assert.equal(s.target?.raw, "p");
    assert.equal(s.body, "hello");
    assert.equal(s.signal, null);
    assert.equal(s.lineMarker, null);
});

test("AST: suffix is extracted on nested outer", () => {
    const result = PlurnkParser.parseStatements("<<EDITouter(p):body:EDITouter");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.op, "EDIT");
    assert.equal(item.statement.suffix, "outer");
});

test("AST: signal CSV splits on comma", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[france,geography](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.signal, ["france", "geography"]);
});

test("AST: SEND signal is coerced to a number", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, 200);
});

test("AST: EXEC signal is coerced to a string", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node](./):console.log(1):EXEC");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.signal, "node");
});

test("AST: SEND with no signal slot yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<SEND:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, null);
});

test("AST: empty signal on tag-bearing OP yields empty array", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EDIT") return;
    assert.deepEqual(item.statement.signal, []);
});

test("AST: FIND signal is tag filter (string[])", () => {
    const result = PlurnkParser.parseStatements("<<FIND[urgent,critical](known://**):pattern:FIND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["urgent", "critical"]);
});

test("AST: COPY signal is tags-to-apply (string[])", () => {
    const result = PlurnkParser.parseStatements("<<COPY[archive,2026](known://draft):known://archive/draft:COPY");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.deepEqual(item.statement.signal, ["archive", "2026"]);
});

test("lexer error: SEND with non-numeric signal", () => {
    const result = PlurnkParser.parseStatements("<<SEND[abc]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
    assert.match(errors[0].error.message, /expected integer for SEND/);
});

test("lexer error: SEND with multiple signal values", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200,extra]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
});

test("lexer error: EXEC with multiple signal values", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node,extra](./):cmd:EXEC");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "lexer");
    assert.match(errors[0].error.message, /expected executor for EXEC/);
});

test("permissive: SEND with empty signal [] yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<SEND[]:msg:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, null);
});

test("permissive: EXEC with empty signal [] yields signal=null", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[](./):cmd:EXEC");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.signal, null);
});

test("permissive: tag signal tolerates stray commas", () => {
    const result = PlurnkParser.parseStatements("<<FIND[,a,,b,](p):m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["a", "b"]);
});

test("permissive: tag signal accepts whitespace-separated tags", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a b c](p):m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["a", "b", "c"]);
});

// -------------------------------------------------------------------------
// Native-JS validation: URL and regex
// -------------------------------------------------------------------------

test("valid path (https URL) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://example.com/page)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid path (custom scheme) accepted", () => {
    const result = PlurnkParser.parseStatements("<<READ(known://entries/foo)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("bare relative target remains local", () => {
    const result = PlurnkParser.parseStatements("<<READ(./README.md)::READ");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("valid path (glob pattern under file://) accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/**/*.xml)::FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid path (unterminated IPv6 bracket) produces visitor error", () => {
    // WHATWG URL accepts many surprising things (spaces auto-encode, custom schemes
    // pass through, etc.), but it rejects malformed authority forms like an
    // unclosed IPv6 bracket — and similar URL-protocol violations.
    const result = PlurnkParser.parseStatements("<<READ(http://[bad):body:READ");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("valid regex body accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://errors):/timeout|deadline/i:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

// {§matcher-prefix-claims}
test("a `/`-leading body that never closes the literal is a visitor ERROR, not a silent glob", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):/unclosed-regex:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /regex matcher must use `\/pattern\/flags`; this matcher has no closing `\/`: `\/unclosed-regex`/);
    assert.equal(errors[0]!.error.source, "visitor");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 0);
});

test("an unclosed FIND body implicitly closes at the line boundary; the frame survives", () => {
    // {§implicit-close}: a forgotten `:FIND` followed by a new op on the next line
    // closes the body at the newline — the error is recoverable, the frame intact.
    const result = PlurnkParser.parseStatements(
        "<<PLAN:p:PLAN\n<<FIND(Engine.ts):/pattern/FIND\n<<SEND[102]:go:SEND",
    );
    const errors = result.items.filter((i) => i.kind === "error");
    const statements = result.items.filter((i) => i.kind === "statement");
    assert.equal(errors.length, 1, "one implicit-close error");
    assert.match(errors[0]!.error.message, /body was not closed before the end of its line/);
    assert.match(errors[0]!.error.message, /:FIND/);
    assert.equal(errors[0]!.error.source, "lexer");
    assert.ok(statements.some((i) => i.kind === "statement" && i.statement.op === "SEND"), "the SEND survives the broken FIND");
});

test("invalid regex pattern is a visitor ERROR, not a silent glob", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):/(abc/:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /is not a valid `\/pattern\/flags` regex/);
});

test("a stray colon in regex flags errors with the library detail", () => {
    // gemma's actual emission: a lying 204 told it "no matches" about a file with two;
    // it burned four matcher turns and delivered a confidently wrong conclusion.
    const result = PlurnkParser.parseStatements("<<FIND(f.txt):/hello/i::FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /is not a valid `\/pattern\/flags` regex - Invalid flags/);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 0);
});

test("the matcher claim is per-statement; siblings still build around the errored matcher", () => {
    const result = PlurnkParser.parseStatements("<<FIND(a.txt):/ok/i:FIND\n<<FIND(f.txt):/bad/i::FIND\n<<KILL(log:///1/2/3)::KILL");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 1);
});

test("a marker-shaped body prefix claims nothing and stays a glob", () => {
    // A scope marker in the body does not claim a matcher dialect.
    // Documented residual: we claim declared intent, we don't heuristic every fumble.
    const result = PlurnkParser.parseStatements("<<FIND(f.txt)::<1,-1>:/hello/i::FIND");
    const stmt = result.items.find((i) => i.kind === "statement");
    assert.ok(stmt && stmt.kind === "statement");
    if (stmt.kind !== "statement" || stmt.statement.op !== "FIND") return;
    assert.equal(stmt.statement.body?.dialect, "glob");
});

test("MatcherBody: a path-shaped slash expression is regex syntax, not a glob", () => {
    const result = PlurnkParser.parseStatements("<<FIND(host.conf):/etc/hosts:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /Invalid flags supplied to RegExp constructor 'hosts'/);
    assert.match(
        errors[0]!.error.message,
        /use only ECMAScript flags after the closing `\/`; escape a literal `\/` inside the pattern as `\\\/`/,
    );
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 0);
});

test("MatcherBody: invalid flags explain literal slash escaping", () => {
    const result = PlurnkParser.parseStatements(
        "<<FIND(evaluator/**):/func Asset|//go:embed|stdlib/runtime|bindata/i:FIND",
    );
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(
        errors[0]!.error.message,
        /use only ECMAScript flags after the closing `\/`; escape a literal `\/` inside the pattern as `\\\/`/,
    );
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 0);
});

test("valid xpath body (//user[@role='admin']) accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/x.xml)://user[@role='admin']:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid xpath body with complex predicate accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://book[price>10 and @lang='en']/title:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid xpath body (unterminated predicate) is a visitor ERROR, not a silent glob", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://book[unterminated:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /leads with `\/\/` but is not a valid xpath selector/);
});

test("a `//`-leading glob-intent body with stray operators errors because the prefix claims xpath", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://**/foo{bar}:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /is not a valid xpath selector/);
});

test("valid jsonpath body ($.greeting) accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(lang/en.json):$.greeting:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("valid jsonpath body with descendant and wildcard accepted", () => {
    const result = PlurnkParser.parseStatements("<<FIND(books.json):$..book[*].price:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

test("invalid jsonpath body (unclosed paren) is a visitor ERROR, not a silent glob", () => {
    const result = PlurnkParser.parseStatements("<<FIND(books.json):$[(:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /leads with `\$` but is not a valid jsonpath/);
});

test("RFC 9535 rejects non-path variables and unclosed selectors", () => {
    for (const body of ["$HOME", "$.users["]) {
        const result = PlurnkParser.parseStatements(`<<FIND(data.json):${body}:FIND`);
        const errors = result.items.filter((i) => i.kind === "error");
        assert.equal(errors.length, 1, `${body} must flag under RFC 9535`);
        assert.match(errors[0]!.error.message, /leads with `\$` but is not a valid jsonpath/);
    }
});

test("RFC 9535 bare filter form ($[?@.role==\"admin\"]) is accepted", () => {
    const result = PlurnkParser.parseStatements('<<FIND(users.json):$[?@.role=="admin"]:FIND');
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

// {§invented-closer-advisory}
test("invented closer: unparsedTail names the imposter tag", () => {
    const cut = "<<PLAN:p:PLAN\n<<WORK(worker://compare):Is 3 > 2? Return 'yes' or 'no':COMPARISON_TASK\nfabricated narration continues until the cap";
    const result = PlurnkParser.parse(cut);
    assert.ok(result.unparsedTail, "the unclosed WORK must surface as unparsedTail");
    assert.match(result.unparsedTail!.reason, /never closed - add `:WORK` to terminate/);
    assert.match(result.unparsedTail!.reason, /found `:COMPARISON_TASK`, which is body text - the closer echoes the op's name/);
});

test("invented closer: a never-closed body with NO imposter tag keeps the plain reason", () => {
    const cut = "<<PLAN:p:PLAN\n<<WORK(worker://compare):a task that just got cut off mid";
    const result = PlurnkParser.parse(cut);
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /never closed - add `:WORK` to terminate/);
    assert.doesNotMatch(result.unparsedTail!.reason, /which is body text/);
});

test("invented closer: Unicode offset conversion cannot scan a pre-op tag as body text", () => {
    const cut = `<<PLAN::PLAN ${"😀".repeat(10)}:BEFORE<<EDIT(x):body :INSIDE`;
    const result = PlurnkParser.parse(cut);
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail.reason, /found `:INSIDE`, which is body text/);
    assert.doesNotMatch(result.unparsedTail.reason, /found `:BEFORE`/);
});

test("invented closer scanning begins after every pre-body slot and target header", () => {
    const specimens = [
        "<<EDIT[a:HEADER](x):unterminated",
        "<<EDIT(worker:///:HEADER):unterminated",
        "<<EDIT<1-2>(https://example.test/data{X-Plurnk:HEADER})[curation]:unterminated",
    ];

    for (const source of specimens) {
        const result = PlurnkParser.parseStatements(source);
        assert.ok(result.unparsedTail, source);
        assert.match(result.unparsedTail.reason, /never closed - add `:EDIT` to terminate/, source);
        assert.doesNotMatch(result.unparsedTail.reason, /found `:HEADER`/, source);
    }
});

test("Unicode before BODY does not obscure the first genuine body lookalike", () => {
    const source = "<<EDIT[a:HEADER]\n(worker://😀/:TARGET)\n<1-2>\n:body 😀 :INSIDE";
    const result = PlurnkParser.parseStatements(source);
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail.reason, /found `:INSIDE`, which is body text/);
    assert.doesNotMatch(result.unparsedTail.reason, /found `:(?:HEADER|TARGET)`/);
});

test("a healthy closed body never enters invented-closer recovery", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(worker:///:HEADER):body :COMPARISON_TASK:EDIT");
    assert.equal(result.unparsedTail, undefined);
    assert.equal(result.items.filter((item) => item.kind === "statement").length, 1);
    assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
});

// {§plan-body-op-advisory}
test("plan-body advisory: op-shaped text in a parsed PLAN body warns", () => {
    // :PLAN is omitted, so the body reaches the later PLAN closer.
    const emission = "<<PLAN:Execute hostname.\n<<EXEC:hostname::EXEC\n<<SEND[102]:executing:SEND\n<<PLAN:Awaiting.:PLAN\n<<SEND[202]:waiting:SEND";
    const result = PlurnkParser.parse(emission);
    const warn = result.items.find((i) => i.kind === "error" && i.error.severity === "warning");
    assert.ok(warn && warn.kind === "error", "the swallow must surface a warning");
    assert.match(warn.error.message, /PLAN body contains op-shaped text \(`<<EXEC`\)/);
    assert.match(warn.error.message, /did you omit `:PLAN`\?/);
});

test("plan-body advisory: a clean plan mentioning an op BY NAME does not warn", () => {
    const result = PlurnkParser.parse("<<PLAN:Run hostname via EXEC, read stdout next turn.:PLAN\n<<EXEC:hostname::EXEC\n<<SEND[102]:executing:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

// {§misplaced-target-advisory}
const misplacedWarn = (op: string) => {
    const result = PlurnkParser.parse(`<<PLAN:do the thing:PLAN\n${op}\n<<SEND[200]:done:SEND`);
    return result.items.find((i) => i.kind === "error" && i.error.severity === "warning"
        && /has no `\(target\)`/.test(i.error.message));
};

test("misplaced-target advisory: path in [signal] with null target redirects to (…)", () => {
    for (const [op, echoed] of [
        ["<<EDIT[evaluator/functions.go]<38,61>:package x:EDIT", "EDIT(evaluator/functions.go)"],
        ["<<COPY[src/a.go]:x:COPY", "COPY(src/a.go)"],
        ["<<MOVE[old/notes.md]:x:MOVE", "MOVE(old/notes.md)"],
        ["<<EDIT[functions.go]:new body:EDIT", "EDIT(functions.go)"],
    ] as const) {
        const w = misplacedWarn(op);
        assert.ok(w && w.kind === "error", `expected a warning for ${op}`);
        assert.match(w.error.message, /that path sits in the `\[…\]` tag slot; a target goes in `\(…\)`/);
        assert.ok(w.error.message.includes(`Try \`${echoed}:…\``), `should echo ${echoed}, got: ${w.error.message}`);
    }
});

test("misplaced-target advisory: correct forms and unrelated mistakes stay quiet", () => {
    for (const op of [
        "<<EDIT[modules,kb](worker://plurnk/docs/log.md):x:EDIT", // tags + scheme target
        "<<EDIT(evaluator/functions.go)<38,61>:x:EDIT",           // bare path already in target
        "<<EDIT[tutorial,training](example.sh):x:EDIT",           // tags + bare target (canon ln 271)
        "<<EDIT[france,geography]:x:EDIT",                        // tags-only null target — a DIFFERENT slip
    ]) {
        assert.equal(misplacedWarn(op), undefined, `should not warn for ${op}`);
    }
});

test("misplaced-target advisory: a non-mutating op with a bracketed path does not warn", () => {
    // FIND/READ read-shaped ops are not in the mutating set; a null target there is not this mistake.
    assert.equal(misplacedWarn("<<FIND[functions.go]:x:FIND"), undefined);
});

// The parser preserves a null scope; core owns create-or-refuse. {§unscoped-edit-create-only}
test("unscoped EDIT parses through with a null lineMarker", () => {
    for (const src of [
        "<<EDIT(notes.md):a whole new body:EDIT",
        "<<EDIT[plan](worker:///plan.md):draft:EDIT",
        "<<EDIT(empty.md)::EDIT",
    ]) {
        const r = PlurnkParser.parseStatements(src);
        assert.equal(r.items.filter((i) => i.kind === "error").length, 0, `unscoped EDIT must not error: ${src}`);
        const st = r.items.find((i) => i.kind === "statement");
        assert.ok(st && st.kind === "statement" && st.statement.op === "EDIT", src);
        if (st?.kind === "statement") assert.equal((st.statement as any).lineMarker, null, `lineMarker must be null: ${src}`);
    }
});


test("glob body (no special prefix) skips regex validation", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**):Paris*:FIND");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("non-matcher OP body never triggers regex validation", () => {
    // EDIT body starting with '/' is content, not regex; should not be validated.
    const result = PlurnkParser.parseStatements("<<EDIT(p):/this looks like regex but is EDIT content/x:EDIT");
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 1);
});

// {§scope-marker-forms}
test("AST: line marker single position", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<5>:line:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [5] });
});

test("AST: line marker positive range", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<4-7>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [4, 7] });
});

test("AST: line marker append sentinel", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-1] });
});

test("AST: line marker negative range like <0--5>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<0--5>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [0, -5] });
});

test("AST: line marker range with negative start <-3--1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-3--1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-3, -1] });
});

test("AST: line marker comma-separated range <4,7>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<4,7>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [4, 7] });
});

test("AST: line marker comma-separated with negative end <1,-1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<1,-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [1, -1] });
});

test("AST: line marker comma+space tolerance <1, -1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<1, -1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [1, -1] });
});

test("AST: line marker comma-separated negative-to-negative <-3,-1>", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)<-3,-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [-3, -1] });
});

test("AST: empty body is null, not empty string", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p)::EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.body, null);
});

test("AST: missing path is null", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.target, null);
});

// -------------------------------------------------------------------------
// ParsedPath: local vs URL discrimination, URL component breakdown
// -------------------------------------------------------------------------

test("ParsedPath: bare path is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<READ(./README.md)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    assert.equal(p.kind, "local");
    assert.equal(p.raw, "./README.md");
});

test("ParsedPath: glob path is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<FIND(config/**/*.xml)::FIND");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    assert.equal(p.kind, "local");
    assert.equal(p.raw, "config/**/*.xml");
});

test("ParsedPath: https URL decomposed fully", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://user:pass@sub.example.com:8080/foo/bar?q=1&q=2#frag)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pass");
    assert.equal(p.hostname, "sub.example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/foo/bar");
    assert.equal(p.query, "q=1&q=2");
    assert.equal(p.fragment, "frag");
});

test("ParsedPath: worker:/// — empty authority, leading-slash pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(worker:///entries/foo/bar)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "worker");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/entries/foo/bar");
});

test("ParsedPath: log:/// — empty authority, full address in pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(log:///1/turn/2/action/3/get)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "log");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/1/turn/2/action/3/get");
});

test("ParsedPath: two-slash on an authority-less scheme parses the first segment as host", () => {
    const result = PlurnkParser.parseStatements("<<READ(known://entries/foo)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    if (p?.kind !== "url") return;
    assert.equal(p.hostname, "entries");
    assert.equal(p.pathname, "/foo");
});

test("ParsedPath: file:///… scheme parses, empty hostname", () => {
    const result = PlurnkParser.parseStatements("<<READ(file:///tmp/foo.txt)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

test("ParsedPath: absent query and fragment are null", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://example.com/foo)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") return;
    const p = item.statement.target;
    assert.ok(p);
    if (p.kind !== "url") return;
    assert.equal(p.query, null);
    assert.equal(p.fragment, null);
});

// -------------------------------------------------------------------------
// Uniform authority — `://` introduces an authority for every scheme; an
// authority-less reference uses the empty-authority form `scheme:///path`.
// Grammar admission is scheme-generic; runtime registration owns availability.
// -------------------------------------------------------------------------

test("ParsedPath cleavage: HTTPS retains authority decomposition", () => {
    const result = PlurnkParser.parseStatements("<<READ(https://user:pw@example.com:8080/api/data?q=1#frag)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pw");
    assert.equal(p.hostname, "example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/api/data");
    assert.equal(p.query, "q=1");
    assert.equal(p.fragment, "frag");
});

test("ParsedPath: sh:/// — empty authority, leading-slash pathname", () => {
    const result = PlurnkParser.parseStatements("<<READ(sh:///run-tests)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "sh");
    assert.equal(p.username, null);
    assert.equal(p.password, null);
    assert.equal(p.hostname, null);
    assert.equal(p.port, null);
    assert.equal(p.pathname, "/run-tests");
});

test("ParsedPath: wiki:/// — single-segment pathname under empty authority", () => {
    const result = PlurnkParser.parseStatements("<<READ(wiki:///Paris)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
});

test("ParsedPath: empty-authority scheme preserves query and fragment", () => {
    const result = PlurnkParser.parseStatements("<<READ(wiki:///Paris?lang=fr#History)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
    assert.equal(p.query, "lang=fr");
    assert.equal(p.fragment, "History");
});

test("ParsedPath: worker:/// nested path stays whole", () => {
    const result = PlurnkParser.parseStatements("<<READ(worker:///philosophy/existentialism/meaning)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "worker");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/philosophy/existentialism/meaning");
});

test("ParsedPath cleavage: file:// stays authority-bearing", () => {
    const result = PlurnkParser.parseStatements("<<READ(file:///tmp/foo.txt)::READ");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const p = item.statement.target;
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

// -------------------------------------------------------------------------
// Typed body: MatcherBody, ParsedPath (COPY/MOVE destination), SendBody
// -------------------------------------------------------------------------

test("MatcherBody: regex returns its dialect, pattern, and flags", () => {
    const result = PlurnkParser.parseStatements("<<FIND(log://x):/foo|bar/i:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    if (b.dialect !== "regex") return;
    assert.equal(b.pattern, "foo|bar");
    assert.equal(b.flags, "i");
    // Consumers reconstruct via `new RegExp(pattern, flags)` when they need the compiled object.
    const rx = new RegExp(b.pattern, b.flags);
    assert.equal(rx.test("foo"), true);
    assert.equal(rx.test("FOO"), true); // i flag works
});

test("MatcherBody: regex preserves escaped delimiters and character-class slashes", () => {
    for (const [source, pattern] of [
        ["<<FIND(log://x):/a\\/b/i:FIND", "a\\/b"],
        ["<<FIND(log://x):/[/]/:FIND", "[/]"],
    ]) {
        const item = PlurnkParser.parseStatements(source).items[0];
        if (item?.kind !== "statement" || item.statement.op !== "FIND") assert.fail("expected FIND");
        const body = item.statement.body;
        if (body?.dialect !== "regex") assert.fail("expected regex body");
        assert.equal(body.pattern, pattern);
        assert.doesNotThrow(() => new RegExp(body.pattern, body.flags));
    }
});

test("target: a regex-shaped hash spelling remains a local path", () => {
    const result = PlurnkParser.parseStatements("<<FIND(#draft.*#i)::FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const t = item.statement.target;
    assert.equal(t?.kind, "local");
    assert.equal(t?.raw, "#draft.*#i");
});

test("MatcherBody: xpath returns dialect + raw", () => {
    const result = PlurnkParser.parseStatements("<<FIND(doc.xml)://user[@role='admin']:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "xpath");
    assert.equal(b.raw, "//user[@role='admin']");
});

test("MatcherBody: jsonpath returns dialect + raw", () => {
    const result = PlurnkParser.parseStatements("<<FIND(lang/en.json):$.greeting:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "jsonpath");
    assert.equal(b.raw, "$.greeting");
});

test("MatcherBody: glob returns dialect + raw (no metacharacters)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://countries/**):Paris*:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "glob");
    assert.equal(b.raw, "Paris*");
});

test("MatcherBody: semantic returns dialect + raw (natural language query)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**):~distributed consensus algorithms:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
    assert.equal(b.raw, "~distributed consensus algorithms");
});

test("MatcherBody: semantic accepts a result-position scope", () => {
    const result = PlurnkParser.parseStatements("<<FIND(known://**)<5>:~graph algorithms:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.lineMarker, { marks: [5] });
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
    assert.equal(b.raw, "~graph algorithms");
});

test("MatcherBody: semantic accepts arbitrary text after tilde (no parse step)", () => {
    const result = PlurnkParser.parseStatements("<<OPEN:~find me anything about: !@#$%^ malformed (but valid as query):OPEN");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "OPEN") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "semantic");
});

test("OPEN and FOLD reject positional scope", () => {
    for (const op of ["OPEN", "FOLD"] as const) {
        const result = PlurnkParser.parseStatements(`<<${op}[memory](log:///**)<1,2>::${op}`);
        assert.equal(
            result.items.some((item) => item.kind === "statement"),
            false,
            `${op}<scope> must not recover into an executable statement`,
        );
        const error = result.items.find((item) => item.kind === "error");
        assert.equal(error?.kind, "error", `${op}<scope> must surface a parse failure`);
        if (error?.kind !== "error") continue;
        assert.equal(error.error.source, "parser");
        assert.match(error.error.message, /unexpected `<L>` line marker/);
    }
});

test("MatcherBody: graph inbound query (@<symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@<createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@<createCoder");
});

test("MatcherBody: graph outbound query (@>symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@>createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@>createCoder");
});

test("MatcherBody: graph neighborhood query (@symbol) dispatches graph", () => {
    const result = PlurnkParser.parseStatements("<<FIND(src/**):@createCoder:FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "graph");
    assert.equal(b.raw, "@createCoder");
});

test("a `//`-leading literal (code comment) errors because the prefix claims xpath", () => {
    // The XPath prefix claims the dialect, so invalid XPath cannot become a glob.
    const result = PlurnkParser.parseStatements("<<FIND(src/app.js):// TODO: add error handling:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /leads with `\/\/` but is not a valid xpath selector/);
});

test("a `//`-leading string with non-xpath syntax errors under the claim", () => {
    const result = PlurnkParser.parseStatements("<<FIND(file.txt):// foo {bar}:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /is not a valid xpath selector/);
});

test("MatcherBody: valid xpath still dispatches xpath even after disambiguation", () => {
    const result = PlurnkParser.parseStatements("<<FIND(page.html)://h1/text():FIND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.dialect, "xpath");
    assert.equal(b.raw, "//h1/text()");
});

test("READ statement coerces matcher bodies to FIND and validates against JSON Schema", () => {
    const regexResult = PlurnkParser.parseStatements("<<READ(page.html):/header/:READ");
    const regexSt = regexResult.items[0];
    assert.equal(regexSt?.kind, "statement");
    assert.equal(regexSt?.statement.op, "FIND");
    assert.equal((regexSt?.statement as any).coercedFromRead, true);
    assert.equal(regexSt?.statement.body?.dialect, "regex");
    const regexVal = Validator.validatePlurnkStatement(regexSt.statement);
    assert.equal(regexVal.valid, true, `regex coerced FIND AST must be schema-valid: ${JSON.stringify(regexVal.errors)}`);

    const globResult = PlurnkParser.parseStatements("<<READ(package.json):TODO:READ");
    const globSt = globResult.items[0];
    assert.equal(globSt?.kind, "statement");
    assert.equal(globSt?.statement.op, "FIND");
    assert.equal((globSt?.statement as any).coercedFromRead, true);
    assert.equal(globSt?.statement.body?.dialect, "glob");
    const globVal = Validator.validatePlurnkStatement(globSt.statement);
    assert.equal(globVal.valid, true, `glob coerced FIND AST must be schema-valid: ${JSON.stringify(globVal.errors)}`);

    const pathGlobResult = PlurnkParser.parseStatements("<<READ(src/**/*.ts):TODO:READ");
    const pathGlobSt = pathGlobResult.items[0];
    assert.equal(pathGlobSt?.kind, "statement");
    assert.equal(pathGlobSt?.statement.op, "FIND");
    assert.equal((pathGlobSt?.statement as any).coercedFromRead, true);
    assert.equal(pathGlobSt?.statement.body?.dialect, "glob");
    const pathGlobVal = Validator.validatePlurnkStatement(pathGlobSt.statement);
    assert.equal(pathGlobVal.valid, true, `path glob coerced FIND AST must be schema-valid: ${JSON.stringify(pathGlobVal.errors)}`);
});

test("COPY body carries a destination selection", () => {
    const result = PlurnkParser.parseStatements("<<COPY(known://draft):known://archive/2026-05-14/draft<12,5,12,5>:COPY");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.equal(item.statement.body?.target.kind, "url");
    assert.deepEqual(item.statement.body?.lineMarker, { marks: [12, 5, 12, 5] });
});

test("COPY destination selection keeps a channel fragment distinct from its scope", () => {
    const result = PlurnkParser.parseStatements(
        "<<COPY(known:///draft#body)<2,4>:known:///archive#notes<1,3,1,3>:COPY",
    );
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    const destination = item.statement.body;
    assert.equal(destination?.target.kind, "url");
    if (destination?.target.kind !== "url") return;
    assert.equal(destination.target.fragment, "notes");
    assert.equal(destination.target.raw, "known:///archive#notes");
    assert.deepEqual(destination.lineMarker, { marks: [1, 3, 1, 3] });
    assert.deepEqual(item.statement.lineMarker, { marks: [2, 4] });
});

test("COPY destination resolves into the same ParsedPath as a target slot", () => {
    const result = PlurnkParser.parseStatements("<<COPY(worker:///draft):worker:///archive/draft:COPY");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    const dest = item.statement.body?.target;
    assert.ok(dest);
    if (dest.kind !== "url") return;
    assert.equal(dest.scheme, "worker");
    assert.equal(dest.pathname, "/archive/draft");
    // A bare/local destination stays local, never throws.
    assert.deepEqual(parsePath("archive/2026/draft"), { kind: "local", raw: "archive/2026/draft" });
});

test("MOVE body carries a destination selection", () => {
    const result = PlurnkParser.parseStatements("<<MOVE(worker:///draft):worker:///final/answer:MOVE");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "MOVE") return;
    const b = item.statement.body?.target;
    assert.ok(b);
    if (b.kind !== "url") return;
    assert.equal(b.scheme, "worker");
    assert.equal(b.hostname, null);
    assert.equal(b.pathname, "/final/answer");
});

test("MOVE body with local destination is kind=local", () => {
    const result = PlurnkParser.parseStatements("<<MOVE(known://draft):./out.txt:MOVE");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "MOVE") return;
    const b = item.statement.body?.target;
    assert.ok(b);
    assert.equal(b.kind, "local");
    assert.equal(b.raw, "./out.txt");
});

test("SendBody: JSON-shaped body has parsed json", () => {
    const result = PlurnkParser.parseStatements(`<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND`);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.raw, `{"answer":"Paris","confidence":0.95}`);
    assert.deepEqual(b.json, { answer: "Paris", confidence: 0.95 });
});

test("SendBody: plain-text body has json=null but raw preserved", () => {
    const result = PlurnkParser.parseStatements("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    const b = item.statement.body;
    assert.ok(b);
    assert.equal(b.raw, "Paris");
    assert.equal(b.json, null);
});

test("EDIT body remains raw string", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(known://entry):line one\nline two:EDIT");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") return;
    assert.equal(item.statement.body, "line one\nline two");
});

test("EXEC body remains raw string", () => {
    const result = PlurnkParser.parseStatements("<<EXEC[node](./):console.log(1+1):EXEC");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.body, "console.log(1+1)");
});

// -------------------------------------------------------------------------
// Error message text — protocol vocabulary, no parser jargon
// -------------------------------------------------------------------------

const firstError = (input: string) => {
    const r = PlurnkParser.parseStatements(input);
    const e = r.items.find((i) => i.kind === "error");
    if (!e || e.kind !== "error") throw new Error("no error in result");
    return e.error;
};

test("unparsedTail: missing body closer uses protocol wording", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):body without close");
    assert.match(result.unparsedTail?.reason ?? "", /body of `<<EDIT`.*add `:EDIT` to terminate/);
    assert.doesNotMatch(result.unparsedTail?.reason ?? "", /CLOSE_TAG|EOF|<EOF>|RPAREN|LBRACKET/);
});

test("error message: << inside target says 'in target'", () => {
    const e = firstError("<<EDIT(<<broken):body:EDIT");
    assert.match(e.message, /unrecognized character '<<' in target/);
});

test("error message: << inside signal says 'in tag signal'", () => {
    const e = firstError("<<EDIT[<<broken](p):body:EDIT");
    assert.match(e.message, /unrecognized character '<<' in tag signal/);
});

test("error message: stray char in slot region names what's allowed", () => {
    const e = firstError("<<EDIT(p)X:body:EDIT");
    assert.match(e.message, /unrecognized character 'X' in slot region/);
    assert.match(e.message, /\[signal\].*\(target\).*<L>.*:body:/);
});

// {§signal-scope-redirect}
test("error message: mark-shaped EXEC signal redirects to <scope>", () => {
    for (const src of ["<<EXEC[-1,300]:make:EXEC", "<<EXEC[1,300]:make:EXEC", "<<EXEC[30,5]:make:EXEC"]) {
        const e = firstError(src);
        assert.match(e.message, /timeout\/poll ride the `<scope>` slot; try `EXEC<-1,300>`/, src);
    }
});

test("error message: a non-mark EXEC signal failure keeps the generic executor message", () => {
    const e = firstError("<<EXEC[!bad]:m:EXEC");
    assert.match(e.message, /expected executor for EXEC/);
    assert.doesNotMatch(e.message, /timeout\/poll/);
});

test("error message: the redirect is EXEC-scoped — SEND/KILL (SIGNAL_INT) do not get it", () => {
    // KILL has no <scope> slot; redirecting it would be wrong. SIGNAL_INT is left untouched.
    for (const src of ["<<SEND[1,300]:x:SEND", "<<KILL[1,300](p)::KILL"]) {
        const e = firstError(src);
        assert.match(e.message, /expected integer for SEND\/KILL/, src);
        assert.doesNotMatch(e.message, /timeout\/poll/, src);
    }
});

test("error message: the redirect's suggested spelling actually parses (EXEC<-1,300>)", () => {
    const result = PlurnkParser.parseStatements("<<EXEC(build.sh)<-1,300>:make:EXEC");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const stmt = result.items.find((i) => i.kind === "statement");
    assert.ok(stmt && stmt.kind === "statement" && stmt.statement.op === "EXEC");
    if (stmt?.kind === "statement") assert.deepEqual((stmt.statement as any).lineMarker?.marks, [-1, 300]);
});

// Slash is excluded because it can also be an unwrapped target. {§matcher-body-redirect}
test("error message: matcher-shaped char in the slot region redirects to :body:", () => {
    for (const src of [
        "<<FIND(data.json)$.role:FIND",
        "<<FIND(notes.md)~budget:FIND",
        "<<FIND(main.ts)@<handler:FIND",
    ]) {
        const e = firstError(src);
        assert.match(e.message, /a matcher rides the `:body:` slot; put it between the body fences/, src);
    }
});

test("error message: a non-matcher slot-region failure keeps the generic slot list", () => {
    // `/` (xpath) is excluded from the redirect - it collides with a forgotten `(path)` wrap - so
    // it, and any other stray char, falls through to the generic `[signal]/(target)/<L>/:body:` list.
    for (const src of ["<<FIND(a.go)//sel:FIND", "<<FIND(a.go)Xbody:FIND"]) {
        const e = firstError(src);
        assert.match(e.message, /\[signal\].*\(target\).*<L>.*:body:/, src);
        assert.doesNotMatch(e.message, /rides the `:body:`/, src);
    }
});

test("error message: a redirected matcher parses in the body", () => {
    const result = PlurnkParser.parseStatements("<<FIND(data.json):$.role:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const stmt = result.items.find((i) => i.kind === "statement");
    assert.ok(stmt && stmt.kind === "statement" && stmt.statement.op === "FIND");
});

test("error message: no ANTLR-y terminology leaks through", () => {
    const inputs = [
        "<<EDIT(p):body without close",
        "<<EDIT(p)X:body:EDIT",
        "<<EDIT(<<x):body:EDIT",
        "<<EDIT[<<x](p):body:EDIT",
    ];
    const forbidden = /token recognition|mismatched|extraneous|expecting|no viable|RPAREN|LBRACKET|RBRACKET|LPAREN|COLON|CLOSE_TAG|BODY_TEXT|<EOF>|ATN/;
    for (const input of inputs) {
        const r = PlurnkParser.parseStatements(input);
        for (const item of r.items) {
            if (item.kind !== "error") continue;
            assert.doesNotMatch(item.error.message, forbidden, `forbidden text in: ${item.error.message}`);
        }
    }
});

test("AST: position points to opening << column", () => {
    const result = PlurnkParser.parseStatements("\n\n  <<EDIT(p):body:EDIT");
    const item = result.items.find((i) => i.kind === "statement");
    assert.ok(item);
    if (item?.kind !== "statement") return;
    assert.equal(item.statement.position.line, 3);
    assert.equal(item.statement.position.column, 2);
});

test("AST: discriminated union narrows correctly per op", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(p):body:EDIT<<READ(q)::READ");
    const statements = result.items.filter((i) => i.kind === "statement");
    assert.equal(statements.length, 2);
    if (statements[0].kind !== "statement" || statements[1].kind !== "statement") return;
    assert.equal(statements[0].statement.op, "EDIT");
    assert.equal(statements[1].statement.op, "READ");
});

test("unparsedTail: mismatched close-tag suffix names the open tag", () => {
    const result = PlurnkParser.parseStatements("<<EDITouter(p):body:EDIT");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /`<<EDITouter`/);
    assert.match(result.unparsedTail!.reason, /add `:EDITouter`/);
});

test("unparsedTail: unclosed signal slot names what's missing", () => {
    const result = PlurnkParser.parseStatements("<<EDIT[tag");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /signal slot of `<<EDIT`/);
    assert.match(result.unparsedTail!.reason, /add `]`/);
});

test("unparsedTail: unclosed target slot names what's missing", () => {
    const result = PlurnkParser.parseStatements("<<EDIT(path");
    assert.ok(result.unparsedTail);
    assert.match(result.unparsedTail!.reason, /target slot of `<<EDIT`/);
    assert.match(result.unparsedTail!.reason, /add `\)`/);
});

test("error message: slot region errors enumerate the four slots", () => {
    const e = firstError("<<EDIT(p)X:body:EDIT");
    assert.match(e.message, /any order/);
});

test("slot order: canonical [signal](target)<scope> parses", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a,b](p)<1-5>:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: (target)[signal]<scope> accepted (reordered)", () => {
    const result = PlurnkParser.parseStatements("<<FIND(p)[a,b]<1-5>:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: <scope>(target)[signal] accepted (reordered)", () => {
    const result = PlurnkParser.parseStatements("<<FIND<1-5>(p)[a,b]:m:FIND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("not FIND"); return; }
    assert.deepEqual(item.statement.signal, ["a", "b"]);
    assert.equal(item.statement.target?.kind, "local");
    assert.equal(item.statement.lineMarker?.marks[0], 1);
});

test("slot order: all 6 permutations of 3-slot FIND yield equivalent ASTs", () => {
    const variants = [
        "<<FIND[t](p)<2>:m:FIND",
        "<<FIND[t]<2>(p):m:FIND",
        "<<FIND(p)[t]<2>:m:FIND",
        "<<FIND(p)<2>[t]:m:FIND",
        "<<FIND<2>[t](p):m:FIND",
        "<<FIND<2>(p)[t]:m:FIND",
    ];
    for (const input of variants) {
        const result = PlurnkParser.parseStatements(input);
        assert.equal(result.items.filter((i) => i.kind === "error").length, 0, `errors for: ${input}`);
        const item = result.items[0];
        if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail(`not FIND for: ${input}`); return; }
        assert.deepEqual(item.statement.signal, ["t"], `signal mismatch for: ${input}`);
        assert.equal(item.statement.target?.kind, "local", `path mismatch for: ${input}`);
        assert.equal(item.statement.lineMarker?.marks[0], 2, `L mismatch for: ${input}`);
    }
});

test("slot order: SEND with (path)[signal] reversed", () => {
    const result = PlurnkParser.parseStatements("<<SEND(agent://named)[200]:msg:SEND");
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("not SEND"); return; }
    assert.equal(item.statement.signal, 200);
    assert.equal(item.statement.target?.kind, "url");
});

test("slot order: duplicate signal slots rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND[a][b](p):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("slot order: duplicate path slots rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND(p1)(p2):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("slot order: duplicate line markers rejected", () => {
    const result = PlurnkParser.parseStatements("<<FIND<1><2>(p):m:FIND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1);
});

test("SEND: terminal scope parses independently of runtime semantics; EXEC accepts timeout/poll scope", () => {
    // The forgiving parser retains the scope. Runtime disposition validation
    // rejects a scoped 102; generation emits scopes only on 202.
    const r1 = PlurnkParser.parseStatements("<<SEND[102]<30>:polling:SEND");
    assert.equal(r1.items.filter((i) => i.kind === "error").length, 0, `SEND[102]<T> should parse: ${JSON.stringify(r1.items)}`);
    const park = r1.items.find((i) => i.kind === "statement");
    assert.ok(park?.kind === "statement" && park.statement.op === "SEND" && park.statement.lineMarker !== null, "SEND lineMarker should be populated");
    // The signed sentinel is still parsed structurally.
    const r3 = PlurnkParser.parseStatements("<<SEND[102]<-1>:standing by:SEND");
    assert.equal(r3.items.filter((i) => i.kind === "error").length, 0);
    // A MID (non-disposition) SEND takes no marker — parking is a terminal act.
    const r4 = PlurnkParser.parseStatements("<<SEND[400]<5>:x:SEND");
    assert.ok(r4.items.filter((i) => i.kind === "error").length >= 1, "mid SEND must not carry a park");
    const r2 = PlurnkParser.parseStatements("<<EXEC[node]<60,5>(./):cmd:EXEC");
    assert.equal(r2.items.filter((i) => i.kind === "error").length, 0, `EXEC <timeout,poll> should parse: ${JSON.stringify(r2.items)}`);
    const stmt = r2.items.find((i) => i.kind === "statement");
    assert.ok(stmt?.kind === "statement" && stmt.statement.op === "EXEC" && stmt.statement.lineMarker !== null, "EXEC lineMarker should be populated");
});

// -------------------------------------------------------------------------
// Degenerate / adversarial inputs: delimiter chars in opaque slots must not
// break the parser. Bodies are opaque (BODY mode), so brackets/braces/parens
// and JSON arrays are content; only a stray delimiter in the SIGNAL region is
// a (graceful) error, never a throw or hang.
// -------------------------------------------------------------------------

const cleanParse = (input: string) => {
    const r = PlurnkParser.parseStatements(input);
    return {
        stmts: r.items.filter((i) => i.kind === "statement").length,
        errs: r.items.filter((i) => i.kind === "error").length,
        tail: r.unparsedTail !== undefined,
    };
};

test("degenerate: stray right bracket in a SEND body is opaque content", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:array[0] and a stray ] bracket:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: JSON array in a SEND body parses clean", () => {
    assert.deepEqual(cleanParse(`<<SEND[400]:{"expected":["a","b"],"got":[1,2]}:SEND`), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: all-brackets / mixed delimiters in a body parse clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:]]]) }{[ <> mixed:SEND"), { stmts: 1, errs: 0, tail: false });
    assert.deepEqual(cleanParse("<<EDIT(a.md):x = arr[0] + (y) + {z}:EDIT"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: bracket body on a targeted (terminate-and-report) SEND parses clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200](worker://parent):result ] arr[0]:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: bracket immediately before the close tag parses clean", () => {
    assert.deepEqual(cleanParse("<<SEND[200]:value]:SEND"), { stmts: 1, errs: 0, tail: false });
});

test("degenerate: stray bracket in the SIGNAL region errors gracefully (no throw)", () => {
    const r = cleanParse("<<SEND[200]]:body:SEND");
    assert.equal(r.stmts, 0);
    assert.ok(r.errs >= 1, "expected a graceful parse error, not a clean parse");
});

// -------------------------------------------------------------------------
// parseLog — multi-turn logs (Plurnk Script): each turn WRAPPED in <<TURN…:…:TURN
// -------------------------------------------------------------------------

// wrap a bare sandwich in the TURN enclosure
const turn = (sandwich: string) => `<<TURN:${sandwich}:TURN`;
const logResult = (input: string) => {
    const r = PlurnkParser.parseLog(input);
    return {
        stmts: r.items.filter((i) => i.kind === "statement").length,
        errs: r.items.filter((i) => i.kind === "error").length,
        tail: r.unparsedTail !== undefined,
    };
};
const logInvalid = (input: string) => {
    const r = PlurnkParser.parseLog(input);
    return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
};

test("parseLog: a multi-turn log of <<TURN>-wrapped turns parses clean and flattens in order", () => {
    const log =
        turn("<<PLAN:find it:PLAN <<READ(worker:///x)::READ <<SEND[102]:reading:SEND") + "\n" +
        turn("<<PLAN:answer:PLAN <<SEND[200]:done:SEND");
    assert.deepEqual(logResult(log), { stmts: 5, errs: 0, tail: false }); // PLAN READ SEND | PLAN SEND
});

test("parseLog: a single wrapped turn is a valid log", () => {
    assert.deepEqual(logResult(turn("<<PLAN:p:PLAN <<SEND[200]:done:SEND")), { stmts: 2, errs: 0, tail: false });
});

test("parseLog: TEXT inside a wrapped turn is preserved without language semantics", () => {
    const result = PlurnkParser.parseLog(
        turn("thinking <<PLAN:p:PLAN consider <<READ(worker:///x)::READ <<SEND[200]:done:SEND"),
    );
    assert.equal(result.items.filter((item) => item.kind === "error").length, 0);
    assert.deepEqual(
        result.items.filter((item) => item.kind === "text").map(({ text }) => text),
        ["thinking", "consider"],
    );
});

test("parseLog: a BARE (unwrapped) turn is NOT a valid log — TURN wrapping is required", () => {
    assert.ok(logInvalid("<<PLAN:p:PLAN <<SEND[200]:done:SEND"), "log requires <<TURN wrapping");
});

test("parseLog: a wrapped turn missing its inner PLAN is invalid (sandwich is law)", () => {
    assert.ok(logInvalid(turn("<<READ(worker:///x)::READ <<SEND[200]:done:SEND")), "no PLAN inside the TURN");
});

test("parseLog: a wrapped turn missing its terminal SEND is invalid", () => {
    assert.ok(logInvalid(turn("<<PLAN:p:PLAN <<READ(worker:///x)::READ")), "no terminal SEND inside the TURN");
});

test("parseLog: an unclosed <<TURN is invalid", () => {
    assert.ok(logInvalid("<<TURN:<<PLAN:p:PLAN <<SEND[200]:done:SEND"), "TURN never closed");
});

test("parseLog: empty input is not a valid log (needs at least one wrapped turn)", () => {
    assert.ok(logInvalid(""), "a log needs >=1 turn");
});

test("parse: rejects a <<TURN>-wrapped turn (wrapping is parseLog's path, not parse's)", () => {
    const r = PlurnkParser.parse(turn("<<PLAN:p:PLAN <<SEND[200]:done:SEND"));
    assert.ok(r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined);
});

// -------------------------------------------------------------------------
// parse() is strictly ONE PLAN-anchored turn — no mid-PLAN, no multi-turn
// -------------------------------------------------------------------------

const parseInvalid = (input: string) => {
    const r = PlurnkParser.parse(input);
    return r.items.some((i) => i.kind === "error") || r.unparsedTail !== undefined;
};

test("parse: rejects multi-turn input (that is parseLog's job)", () => {
    assert.ok(parseInvalid("<<PLAN:a:PLAN\n<<SEND[200]:x:SEND\n<<PLAN:b:PLAN\n<<SEND[200]:y:SEND"));
});

test("parse: rejects a mid-batch PLAN (PLAN is the anchor, never a mid-op)", () => {
    assert.ok(parseInvalid("<<PLAN:a:PLAN\n<<PLAN:b:PLAN\n<<SEND[200]:done:SEND"));
});

test("parse: the canonical single sandwich is valid", () => {
    const r = PlurnkParser.parse("<<PLAN:p:PLAN\n<<READ(worker:///x)::READ\n<<SEND[200]:done:SEND");
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
    assert.equal(r.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// TURN close-tag hardening (caught in self-review): suffix + non-ident follow
// -------------------------------------------------------------------------

test("parseLog: a :TURN-prefixed word in a turn's prose does not false-close", () => {
    assert.equal(logResult(turn("<<PLAN:p:PLAN mentioning :TURNING here <<SEND[200]:done:SEND")).errs, 0);
});

test("parseLog: TURN suffix discipline — only the matching :TURN<suffix> closes", () => {
    assert.equal(logResult("<<TURN1:<<PLAN:p:PLAN <<SEND[200]:x:SEND:TURN1").errs, 0);   // matched suffix closes
    assert.ok(logInvalid("<<TURN1:<<PLAN:p:PLAN <<SEND[200]:x:SEND:TURN2"));             // mismatch => unclosed
});

test("parseLog: :TURN inside an inner op body is opaque content, not a close", () => {
    assert.equal(logResult(turn("<<PLAN:p:PLAN <<SEND[200]:done :TURN literally:SEND")).errs, 0);
});

// -------------------------------------------------------------------------
// {§parser-architecture} Narrow single-colon empty-body toleration closes only at a boundary.
// -------------------------------------------------------------------------

const ssCount = (s: string) => PlurnkParser.parseStatements(s).items.filter((i) => i.kind === "statement").length;
const ssClean = (s: string) => {
    const r = PlurnkParser.parseStatements(s);
    return !r.items.some((i) => i.kind === "error") && !r.unparsedTail;
};

test("single-colon body-less operations close at newline", () => {
    const r = PlurnkParser.parseStatements("<<READ(known://x/a):READ\n<<READ(known://x/b):READ");
    assert.equal(r.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(r.items.filter((i) => i.kind === "error").length, 0);
});

test("single-colon body-less closes at EOF and before the next operation", () => {
    assert.ok(ssClean("<<READ(t):READ"));                     // EOF boundary
    assert.equal(ssCount("<<READ(t):READ"), 1);
    assert.equal(ssCount("<<READ(a):READ<<FIND(b):FIND"), 2); // glued, next << boundary
    assert.equal(ssCount("<<READ(a)<4,5>:READ <<READ(b)<3,9>:READ"), 2, "ordinary inter-op space does not merge adjacent READs");
});

// {§close-tag-match}
test("canonical ::OP empty body still works", () => {
    assert.equal(ssCount("<<READ(a)::READ\n<<READ(b)::READ"), 2);
});

test("a body starting with the op keyword is not mis-closed after a non-boundary follow", () => {
    const r = PlurnkParser.parseStatements("<<EDIT(t):EDIT this line:EDIT");
    const it = r.items[0];
    assert.ok(it.kind === "statement" && it.statement.body === "EDIT this line");
});

test("a body equal to the op keyword is expressible via a suffix", () => {
    const r = PlurnkParser.parseStatements("<<FIND1(t):FIND:FIND1");
    const it = r.items[0];
    assert.ok(it.kind === "statement" && (it.statement.body as any)?.raw === "FIND");
});
