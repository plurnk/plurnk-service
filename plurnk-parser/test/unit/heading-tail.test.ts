// {§operation-fences} {§fence-pairing} — a fence run and a known name make a heading whatever follows the name
// on its line, in the pairing exactly as in the lexer: a malformed heading is one bounded parse error, never an
// Error thrown out of a lexer predicate that takes the loop down (#996).
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { PlurnkParser } from "../../src/index.ts";

const parse = (input: string) => PlurnkParser.parseStatements(input, { executors: ["sh", "python3"] });
const ops = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? ["runtime" in item.statement ? item.statement.runtime : item.statement.op] : []);
const errors = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" ? [`${item.error.line}:${item.error.column} ${item.error.message}`] : []);
const recorded = (prefix: string) => {
    const dir = new URL("../fixtures/recorded/", import.meta.url);
    const name = readdirSync(dir).find((entry) => entry.startsWith(prefix));
    assert.ok(name, `a recorded fixture named ${prefix}*`);
    return readFileSync(new URL(name, dir), "utf8");
};
const STRAY = "1:7 unrecognized character '`' in operation header - expected `(path)`, `<scope>`, `[metadata]`, a line ending, or the closing fence";

test("{§operation-fences}: a known name followed directly by a backtick is a heading in error, and the operation after it still runs (#996)", () => {
    const input = "```NOTE`\nbody\n```\n```READ (x.txt)\n```\n";
    assert.deepEqual(errors(input), [STRAY]);
    assert.deepEqual(ops(input), ["READ"]);
});

test("{§fence-pairing}: every heading line the lexer opens, the pairing pairs — a closer at the name, a word after it, stray backticks, an executor (#996)", () => {
    for (const heading of ["```NOTE``` hello", "```READ``` takes a scope", "```READ`x`", "```sh`"]) {
        const input = `${heading}\nbody\n\`\`\`\n`;
        assert.doesNotThrow(() => parse(input), heading);
        assert.equal(parse(input).unparsedTail, undefined, heading);
    }
});

test("{§reasoning-operations}: the same heading in a reasoning emission is read, not thrown (#996)", () => {
    assert.doesNotThrow(() => PlurnkParser.parseReasoningOperations("```NOTE`\nbody\n```\n"));
});

test("{§operation-fences}: deepseek-flash's NOTE with a backtick glued to its name, as recorded on the 16k rung of #995 (#996)", () => {
    const input = recorded("deep16-run341-3cdd88d7-1-12");
    assert.deepEqual(errors(input), [STRAY]);
    assert.deepEqual(ops(input), ["KILL", "KILL"]);
});
