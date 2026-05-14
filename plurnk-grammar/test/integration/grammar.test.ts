import test from "node:test";
import assert from "node:assert/strict";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { plurnkLexer } from "../../src/generated/plurnkLexer.ts";
import { plurnkParser } from "../../src/generated/plurnkParser.ts";

const parse = (input: string) => {
    const lexer = new plurnkLexer(CharStream.fromString(input));
    const parser = new plurnkParser(new CommonTokenStream(lexer));
    return parser.document();
};

test("ex 3 — simple EDIT with body", () => {
    const tree = parse("<<EDIT(known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("ex 4 — bare READ, empty body", () => {
    const tree = parse("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ");
    assert.equal(tree.statement().length, 1);
});

test("ex 12 — EDIT with empty body (clear)", () => {
    const tree = parse("<<EDIT(known://countries/france/capital)::EDIT");
    assert.equal(tree.statement().length, 1);
});

test("ex 17 — SEND with signal, no path", () => {
    const tree = parse("<<SEND[102]:decomposed prompt; plan initialized:SEND");
    assert.equal(tree.statement().length, 1);
});

test("ex 6 — EDIT with signal, path, and body", () => {
    const tree = parse("<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("ex 8 — EDIT with single-line marker", () => {
    const tree = parse("<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("ex 21 — FIND with range pagination, empty body", () => {
    const tree = parse("<<FIND(known://**)<1-20>::FIND");
    assert.equal(tree.statement().length, 1);
});

test("body containing literal OP keyword (no false-match)", () => {
    const tree = parse("<<EDIT(p):the EDIT command takes a path:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("body starting with bare paren (modifier-like content)", () => {
    const tree = parse("<<EDIT(p):() abc:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("body containing internal colons (predicate falsifies)", () => {
    const tree = parse("<<EDIT(p):key:value:more:stuff:EDIT");
    assert.equal(tree.statement().length, 1);
});

test("ex 31 — nested EDIT via suffix discipline", () => {
    const input = "<<EDITouter(known://demo):quoted: <<EDIT(known://inner):hello world:EDIT:EDITouter";
    const tree = parse(input);
    assert.equal(tree.statement().length, 1);
});
