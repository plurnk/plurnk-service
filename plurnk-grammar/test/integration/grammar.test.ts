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
    const tree = parse("<<EDIT(known://philosophy/existentialism/meaning)The meaning of life is 42EDIT");
    assert.ok(tree);
    const statements = tree.statement();
    assert.equal(statements.length, 1);
});

test("ex 4 — bare READ, no body", () => {
    const tree = parse("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)READ");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 12 — EDIT with empty body (clear)", () => {
    const tree = parse("<<EDIT(known://countries/france/capital)EDIT");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 17 — SEND with signal, no path", () => {
    const tree = parse("<<SEND[102]decomposed prompt; plan initializedSEND");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 6 — EDIT with signal, path, and body", () => {
    const tree = parse("<<EDIT[france,geography](unknown://countries/france/capital)What is the capital of France?EDIT");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 8 — EDIT with single-line marker", () => {
    const tree = parse("<<EDIT(known://plan)<2>- [x] Discover capital of FranceEDIT");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 21 — FIND with range pagination", () => {
    const tree = parse("<<FIND(known://**)<1-20>FIND");
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});

test("ex 31 — nested EDIT via suffix discipline", () => {
    const input = "<<EDITouter(known://demo)quoted: <<EDIT(known://inner)hello worldEDITEDITouter";
    const tree = parse(input);
    assert.ok(tree);
    assert.equal(tree.statement().length, 1);
});
