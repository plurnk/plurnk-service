import test from "node:test";
import assert from "node:assert/strict";
import { parse, PlurnkParseError } from "../../src/index.ts";

const statementsOf = (input: string) =>
    parse(input).items.filter((i) => i.kind === "statement");

const errorsOf = (input: string) =>
    parse(input).items.filter((i) => i.kind === "error").map((i) => i.error);

const textsOf = (input: string) =>
    parse(input).items.filter((i) => i.kind === "text").map((i) => i.text);

// -------------------------------------------------------------------------
// Single-statement parses
// -------------------------------------------------------------------------

test("ex 3 — simple EDIT with body", () => {
    assert.equal(statementsOf("<<EDIT(known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT").length, 1);
});

test("ex 4 — bare READ, empty body", () => {
    assert.equal(statementsOf("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ").length, 1);
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

test("ex 31 — nested EDIT via suffix discipline", () => {
    const input = "<<EDITouter(known://demo):quoted: <<EDIT(known://inner):hello world:EDIT:EDITouter";
    assert.equal(statementsOf(input).length, 1);
});

// -------------------------------------------------------------------------
// Multi-statement parses
// -------------------------------------------------------------------------

test("two statements in sequence", () => {
    const input = "<<EDIT(p)::EDIT<<READ(q)::READ";
    const result = parse(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
});

test("interstatement whitespace captured as text", () => {
    const input = "<<EDIT(p)::EDIT\n\n<<READ(q)::READ";
    const result = parse(input);
    const texts = result.items.filter((i) => i.kind === "text");
    assert.ok(texts.length >= 1);
    assert.ok(texts.some((t) => t.kind === "text" && t.text.includes("\n")));
});

test("interstatement prose captured as text", () => {
    const input = "Let me first check the path.\n<<READ(p)::READ\nNow editing it.\n<<EDIT(p):body:EDIT";
    const result = parse(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    const texts = textsOf(input);
    assert.ok(texts.some((t) => t.includes("Let me first check")));
    assert.ok(texts.some((t) => t.includes("Now editing")));
});

test("stray <<FOOBAR (unrecognized OP) is captured as text, not an error", () => {
    const input = "<<EDIT(p)::EDIT<<FOOBAR not a real op<<READ(q)::READ";
    const result = parse(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 2);
    const texts = textsOf(input);
    assert.ok(texts.some((t) => t.includes("<<FOOBAR")));
});

// -------------------------------------------------------------------------
// Per-statement error recovery
// -------------------------------------------------------------------------

test("three valid statements in sequence parse independently", () => {
    const input = "<<EDIT(p1):one:EDIT\n<<EDIT(p2):two:EDIT\n<<EDIT(p3):three:EDIT";
    const result = parse(input);
    assert.equal(result.items.filter((i) => i.kind === "statement").length, 3);
});

test("malformed path (unclosed paren) produces error, not silent swallowing", () => {
    // Statement 2's path is missing its `)`. With tightened PATH_INNER,
    // the lexer rejects `<<` inside path content and produces an error
    // instead of greedily consuming statement 3.
    const input = "<<EDIT(p1):one:EDIT<<EDIT(broken<<EDIT(p3):three:EDIT";
    const result = parse(input);
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length >= 1, "expected at least one error from malformed path");
});

test("error carries line, column, and source", () => {
    // Malformed: missing close.
    const input = "<<EDIT(p):body without close";
    const result = parse(input);
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
    const result = parse("<<EDIT(p):body never closed");
    assert.ok(result.unparsedTail, "expected unparsedTail to be set");
});

test("clean parse has no unparsedTail", () => {
    const result = parse("<<EDIT(p):body:EDIT");
    assert.equal(result.unparsedTail, undefined);
});

// -------------------------------------------------------------------------
// Domain AST shape
// -------------------------------------------------------------------------

test("AST: minimal EDIT extracts op, suffix, body", () => {
    const result = parse("<<EDIT(p):hello:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    const s = item.statement;
    assert.equal(s.op, "EDIT");
    assert.equal(s.suffix, "");
    assert.equal(s.path, "p");
    assert.equal(s.body, "hello");
    assert.equal(s.signal, null);
    assert.equal(s.lineMarker, null);
});

test("AST: suffix is extracted on nested outer", () => {
    const result = parse("<<EDITouter(p):body:EDITouter");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.op, "EDIT");
    assert.equal(item.statement.suffix, "outer");
});

test("AST: signal CSV splits on comma", () => {
    const result = parse("<<EDIT[france,geography](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.signal, ["france", "geography"]);
});

test("AST: SEND signal is coerced to a number", () => {
    const result = parse("<<SEND[200]:Paris:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, 200);
});

test("AST: EXEC signal is coerced to a string", () => {
    const result = parse("<<EXEC[node](./):console.log(1):EXEC");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EXEC") return;
    assert.equal(item.statement.signal, "node");
});

test("AST: SEND with no signal slot yields signal=null", () => {
    const result = parse("<<SEND:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "SEND") return;
    assert.equal(item.statement.signal, null);
});

test("AST: empty signal on tag-bearing OP yields empty array", () => {
    const result = parse("<<EDIT[](p):body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "EDIT") return;
    assert.deepEqual(item.statement.signal, []);
});

test("AST: FIND signal is tag filter (string[])", () => {
    const result = parse("<<FIND[urgent,critical](known://**):pattern:FIND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "FIND") return;
    assert.deepEqual(item.statement.signal, ["urgent", "critical"]);
});

test("AST: COPY signal is tags-to-apply (string[])", () => {
    const result = parse("<<COPY[archive,2026](known://draft):known://archive/draft:COPY");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "COPY") return;
    assert.deepEqual(item.statement.signal, ["archive", "2026"]);
});

test("visitor error: SEND with non-numeric signal", () => {
    const result = parse("<<SEND[abc]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("visitor error: SEND with multiple signal values", () => {
    const result = parse("<<SEND[200,extra]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("visitor error: EXEC with multiple signal values", () => {
    const result = parse("<<EXEC[node,extra](./):cmd:EXEC");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("visitor error: SEND with empty signal []", () => {
    const result = parse("<<SEND[]:msg:SEND");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(errors.length, 1);
    if (errors[0].kind !== "error") return;
    assert.equal(errors[0].error.source, "visitor");
});

test("AST: line marker single position", () => {
    const result = parse("<<EDIT(p)<5>:line:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { first: 5, last: null });
});

test("AST: line marker positive range", () => {
    const result = parse("<<EDIT(p)<4-7>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { first: 4, last: 7 });
});

test("AST: line marker append sentinel", () => {
    const result = parse("<<EDIT(p)<-1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { first: -1, last: null });
});

test("AST: line marker negative range like <0--5>", () => {
    const result = parse("<<EDIT(p)<0--5>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { first: 0, last: -5 });
});

test("AST: line marker range with negative start <-3--1>", () => {
    const result = parse("<<EDIT(p)<-3--1>:body:EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.deepEqual(item.statement.lineMarker, { first: -3, last: -1 });
});

test("AST: empty body is null, not empty string", () => {
    const result = parse("<<EDIT(p)::EDIT");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.body, null);
});

test("AST: missing path is null", () => {
    const result = parse("<<SEND[200]:msg:SEND");
    const item = result.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;
    assert.equal(item.statement.path, null);
});

test("AST: position points to opening << column", () => {
    const result = parse("\n\n  <<EDIT(p):body:EDIT");
    const item = result.items.find((i) => i.kind === "statement");
    assert.ok(item);
    if (item?.kind !== "statement") return;
    assert.equal(item.statement.position.line, 3);
    assert.equal(item.statement.position.column, 2);
});

test("AST: discriminated union narrows correctly per op", () => {
    const result = parse("<<EDIT(p):body:EDIT<<READ(q)::READ");
    const statements = result.items.filter((i) => i.kind === "statement");
    assert.equal(statements.length, 2);
    if (statements[0].kind !== "statement" || statements[1].kind !== "statement") return;
    assert.equal(statements[0].statement.op, "EDIT");
    assert.equal(statements[1].statement.op, "READ");
});
