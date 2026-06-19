// Engine contract tests — one or more per SPEC.md anchor (§…). These exercise the native
// TS engine directly (no oracle); the oracle equivalence is §oracle_fidelity in test/e2e.

import test from "node:test";
import assert from "node:assert/strict";
import { validateGbnf } from "../../src/index.ts";

test("[§verdict_accept] a complete sentence is accepted", () => {
    assert.deepEqual(validateGbnf('root ::= "hi"', "hi"), { status: "accept" });
});

test("[§verdict_reject] the first unextendable code point is rejected with its position", () => {
    assert.deepEqual(validateGbnf('root ::= "hi"', "ho"), { status: "reject", pos: 1, char: "o" });
    assert.deepEqual(validateGbnf('root ::= "hi"', "xi"), { status: "reject", pos: 0, char: "x" });
});

test("[§verdict_incomplete] a valid prefix that cannot close is incomplete at end-of-input", () => {
    assert.deepEqual(validateGbnf('root ::= "hi"', "h"), { status: "incomplete", pos: 1 });
    assert.deepEqual(validateGbnf('root ::= "hi"', ""), { status: "incomplete", pos: 0 });
});

test("[§position_codepoint] positions count code points, not bytes", () => {
    // 'é' is two UTF-8 bytes; the reject must report code-point index 1, not byte 2.
    assert.deepEqual(validateGbnf('root ::= "é" "!"', "éx"), { status: "reject", pos: 1, char: "x" });
    assert.deepEqual(validateGbnf('root ::= "é" "!"', "é!"), { status: "accept" });
});

test("[§grammar_literals] quoted literals match exactly, with escapes", () => {
    assert.deepEqual(validateGbnf('root ::= "a\\nb"', "a\nb"), { status: "accept" });
    assert.deepEqual(validateGbnf('root ::= "\\x41"', "A"), { status: "accept" });
    assert.equal(validateGbnf('root ::= "ab"', "aX").status, "reject");
});

test("[§grammar_charclass] sets, ranges, negation, and any-char", () => {
    assert.equal(validateGbnf("root ::= [abc]", "b").status, "accept");
    assert.equal(validateGbnf("root ::= [abc]", "d").status, "reject");
    assert.equal(validateGbnf("root ::= [a-z]", "q").status, "accept");
    assert.equal(validateGbnf("root ::= [^x]", "y").status, "accept");
    assert.equal(validateGbnf("root ::= [^x]", "x").status, "reject");
    assert.equal(validateGbnf("root ::= .", "Z").status, "accept");
});

test("[§grammar_repetition] *, +, ?, and {m,n}", () => {
    assert.equal(validateGbnf('root ::= "a"*', "").status, "accept");
    assert.equal(validateGbnf('root ::= "a"*', "aaa").status, "accept");
    assert.equal(validateGbnf('root ::= "a"+', "").status, "incomplete");
    assert.equal(validateGbnf('root ::= "a"?', "a").status, "accept");
    assert.equal(validateGbnf('root ::= "a"{2,3}', "aa").status, "accept");
    assert.equal(validateGbnf('root ::= "a"{2,3}', "a").status, "incomplete");
    assert.deepEqual(validateGbnf('root ::= "a"{2,3}', "aaaa"), { status: "reject", pos: 3, char: "a" });
});

test("[§grammar_grouping] parenthesised groups and alternation", () => {
    assert.equal(validateGbnf('root ::= ("a" | "b") "c"', "ac").status, "accept");
    assert.equal(validateGbnf('root ::= ("a" | "b") "c"', "bc").status, "accept");
    assert.deepEqual(validateGbnf('root ::= ("a" | "b") "c"', "cc"), { status: "reject", pos: 0, char: "c" });
});

test("[§grammar_ruleref] references resolve and may recurse", () => {
    assert.equal(validateGbnf('root ::= a a\na ::= "x"', "xx").status, "accept");
    assert.equal(validateGbnf('root ::= "(" root ")" | "x"', "((x))").status, "accept");
});

test("[§grammar_comments] # comments and whitespace are skipped", () => {
    const grammar = "# leading comment\nroot ::= \"a\" # trailing comment\n";
    assert.equal(validateGbnf(grammar, "a").status, "accept");
});

test("[§grammar_root] start rule defaults to root and is overridable", () => {
    assert.equal(validateGbnf('start ::= "x"', "x", "start").status, "accept");
    assert.throws(() => validateGbnf('start ::= "x"', "x"), /no 'root' symbol/);
});

test("[§grammar_invalid] malformed grammars throw, never fall back to a verdict", () => {
    assert.throws(() => validateGbnf("root ::= undefinedRule", "x"), Error); // undefined rule ref
    assert.throws(() => validateGbnf('root ::= "unterminated', "x"), Error); // syntax error
    assert.throws(() => validateGbnf('root ::= root "x" | "y"', "y"), /left-recursive/); // left recursion
});
