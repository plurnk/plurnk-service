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
