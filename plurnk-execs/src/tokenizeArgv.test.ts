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

test("does not expand variables, commands, or shell metacharacters", () => {
    assert.deepEqual(tokenizeArgv('commit -m "costs $5 and `cmd`"'), ["commit", "-m", "costs $5 and `cmd`"]);
    assert.deepEqual(tokenizeArgv("status; rm -rf /"), ["status;", "rm", "-rf", "/"]);
});

test("handles escapes and quoted empty arguments", () => {
    assert.deepEqual(tokenizeArgv("a\\ b"), ["a b"]);
    assert.deepEqual(tokenizeArgv('--title "a \\"quoted\\" title"'), ["--title", 'a "quoted" title']);
    assert.deepEqual(tokenizeArgv('commit --cleanup=""'), ["commit", "--cleanup="]);
});

test("rejects unterminated quoting", () => {
    assert.throws(() => tokenizeArgv('commit -m "unterminated'), /unterminated double quote/);
    assert.throws(() => tokenizeArgv("commit -m 'unterminated"), /unterminated single quote/);
    assert.throws(() => tokenizeArgv("status\\"), /trailing backslash/);
});
