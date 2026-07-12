import test from "node:test";
import { strict as assert } from "node:assert";
import { tokenizeArgv } from "./tokenizeArgv.ts";

test("splits plain words", () => {
    assert.deepEqual(tokenizeArgv("status --short"), ["status", "--short"]);
    assert.deepEqual(tokenizeArgv("  log   -n  5 "), ["log", "-n", "5"]);
});

test("preserves quoted multi-word args", () => {
    assert.deepEqual(tokenizeArgv('commit -m "fix: the bug"'), ["commit", "-m", "fix: the bug"]);
    assert.deepEqual(tokenizeArgv("commit -m 'single quoted msg'"), ["commit", "-m", "single quoted msg"]);
});

test("does NOT expand $ or backticks (the whole point vs shelling)", () => {
    assert.deepEqual(tokenizeArgv('commit -m "costs $5 and `cmd`"'), ["commit", "-m", "costs $5 and `cmd`"]);
    assert.deepEqual(tokenizeArgv("commit -m '$HOME stays literal'"), ["commit", "-m", "$HOME stays literal"]);
});

test("does NOT interpret shell metacharacters — passed as literal args", () => {
    assert.deepEqual(tokenizeArgv("log | head"), ["log", "|", "head"]);
    assert.deepEqual(tokenizeArgv("status; rm -rf /"), ["status;", "rm", "-rf", "/"]);
});

test("backslash escapes and escaped quotes inside double quotes", () => {
    assert.deepEqual(tokenizeArgv('a\\ b'), ["a b"]);
    assert.deepEqual(tokenizeArgv('--title "a \\"quoted\\" title"'), ["--title", 'a "quoted" title']);
});

test("empty input → no args", () => {
    assert.deepEqual(tokenizeArgv(""), []);
    assert.deepEqual(tokenizeArgv("   "), []);
});

test("unterminated quotes throw", () => {
    assert.throws(() => tokenizeArgv('commit -m "unterminated'), /unterminated double quote/);
    assert.throws(() => tokenizeArgv("commit -m 'unterminated"), /unterminated single quote/);
});
