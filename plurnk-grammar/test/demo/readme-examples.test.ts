/**
 * Regression corpus: every canonical example from README.md.
 *
 * Each test parses one example and asserts it produces exactly one statement
 * with no errors. Any future grammar change that breaks one of these will fail
 * here, loudly. The examples are kept verbatim from the README so the source of
 * truth lives in one place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const expectOneClean = (input: string) => {
    const result = PlurnkParser.parse(input);
    const statements = result.items.filter((i) => i.kind === "statement");
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(statements.length, 1, `expected 1 statement, got ${statements.length}`);
    assert.equal(errors.length, 0, `expected 0 errors, got ${errors.length}: ${errors.map((e) => e.kind === "error" ? e.error.message : "").join(" | ")}`);
    assert.equal(result.unparsedTail, undefined, "expected no unparsedTail");
};

test("ex 01: FIND xml files containing the admin user role", () => {
    expectOneClean("<<FIND(config/**/*.xml)://user[@role='admin']:FIND");
});

test("ex 02: READ hello in every language", () => {
    expectOneClean("<<READ(lang/??.json):$.greeting:READ");
});

test("ex 03: EDIT — write a known entry", () => {
    expectOneClean("<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT");
});

test("ex 04: READ an entry in full", () => {
    expectOneClean("<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ");
});

test("ex 05: READ lines 426–465 of a long article", () => {
    expectOneClean("<<READ(https://en.wikipedia.org/wiki/Donald_Rumsfeld)<426-465>::READ");
});

test("ex 06: EDIT — create unknown entry with tags", () => {
    expectOneClean("<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT");
});

test("ex 07: EDIT — multi-line plan", () => {
    expectOneClean(`<<EDIT[plan,france,task](known://plan):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT`);
});

test("ex 08: EDIT — mark a plan step complete (single-line replace)", () => {
    expectOneClean("<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT");
});

test("ex 09: EDIT — replace a range of lines", () => {
    expectOneClean(`<<EDIT(known://countries/france/capital)<4-5>:
The capital of France is Paris, on the river Seine.
Paris has been the continuous capital of France since 987 CE.
:EDIT`);
});

test("ex 10: EDIT — append content (<-1>)", () => {
    expectOneClean("<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT");
});

test("ex 11: EDIT — prepend content (<0>)", () => {
    expectOneClean("<<EDIT(known://countries/france/capital)<0>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT");
});

test("ex 12: EDIT — clear entry contents (empty body)", () => {
    expectOneClean("<<EDIT(known://countries/france/capital)::EDIT");
});

test("ex 13: FOLD — collapse every distilled fetch-log row", () => {
    expectOneClean("<<FOLD(log://1/*/*/get)::FOLD");
});

test("ex 14: OPEN — restore collapsed log rows by tag filter", () => {
    expectOneClean("<<OPEN[france](log://**)::OPEN");
});

test("ex 15: MOVE — rename a draft entry", () => {
    expectOneClean("<<MOVE(known://draft):known://final/answer:MOVE");
});

test("ex 16: EXEC — shell command in project root", () => {
    expectOneClean("<<EXEC(./):node --test:EXEC");
});

test("ex 17: SEND — continue the loop (102)", () => {
    expectOneClean("<<SEND[102]:decomposed prompt; plan initialized:SEND");
});

test("ex 18: SEND — deliver final answer (200)", () => {
    expectOneClean("<<SEND[200]:Paris:SEND");
});

test("ex 19: FIND — case-insensitive regex body", () => {
    expectOneClean("<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND");
});

test("ex 20: FIND — glob body matching content prefix", () => {
    expectOneClean("<<FIND(known://countries/**):Paris*:FIND");
});

test("ex 21: FIND — pagination via <1-20>", () => {
    expectOneClean("<<FIND(known://**)<1-20>::FIND");
});

test("ex 22: READ — first five lines of local file (bare path)", () => {
    expectOneClean("<<READ(./README.md)<1-5>::READ");
});

test("ex 23: COPY — draft to dated archive", () => {
    expectOneClean("<<COPY(known://draft):known://archive/2026-05-14/draft:COPY");
});

test("ex 24: EXEC — inline node script (multi-line)", () => {
    expectOneClean(`<<EXEC[node](./):
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
console.log(sum);
:EXEC`);
});

test("ex 25: OPEN — combined filters (tag + body)", () => {
    expectOneClean("<<OPEN[france](log://**):Paris*:OPEN");
});

test("ex 26: FOLD — paginated collapse", () => {
    expectOneClean("<<FOLD(log://**/get)<101-200>::FOLD");
});

test("ex 27: SEND — structured JSON answer", () => {
    expectOneClean(`<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND`);
});

test("ex 28: SEND — client error with JSON body", () => {
    expectOneClean(`<<SEND[400]:{"reason":"unrecognized OP","got":"FOOBAR","expected":["FIND","READ","EDIT","COPY","MOVE","OPEN","FOLD","SEND","EXEC"]}:SEND`);
});

test("ex 29: SEND — server error with explicit recipient", () => {
    expectOneClean(`<<SEND[503](log://errors):{"reason":"git unavailable","command":"git status"}:SEND`);
});

test("ex 30: SEND — informational message at named agent", () => {
    expectOneClean("<<SEND[102](agent://supervisor):decomposition complete; awaiting clearance:SEND");
});

test("ex 31: nested EDIT via suffix discipline", () => {
    expectOneClean(`<<EDITouter(known://demo):
The following is a quoted plurnk operation, preserved verbatim:
<<EDIT(known://inner):hello world:EDIT
:EDITouter`);
});
