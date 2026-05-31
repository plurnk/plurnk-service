import test from "node:test";
import { strict as assert } from "node:assert";
import { normalizeUsage, computeCost } from "./usage.ts";

// — normalizeUsage —

test("normalizeUsage: Gemini-style — reasoning recovered from total gap", () => {
    // Real Gemini OAI-compat shape: no details, reasoning hidden in total.
    const u = normalizeUsage({ prompt_tokens: 19, completion_tokens: 285, total_tokens: 1165 });
    assert.deepEqual(u, { prompt: 19, completion: 285, reasoning: 861, cached: 0, total: 1165 });
    assert.equal(u.prompt + u.completion + u.reasoning, u.total); // invariant
});

test("normalizeUsage: OpenAI-style — reasoning split out of completion_tokens", () => {
    // completion_tokens includes reasoning; total = prompt + completion.
    const u = normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 100,
        total_tokens: 110,
        completion_tokens_details: { reasoning_tokens: 40 },
    });
    assert.deepEqual(u, { prompt: 10, completion: 60, reasoning: 40, cached: 0, total: 110 });
    assert.equal(u.completion + u.reasoning, 100); // billable output unchanged
});

test("normalizeUsage: cached read from prompt_tokens_details (OpenAI nesting)", () => {
    const u = normalizeUsage({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 30 } });
    assert.equal(u.cached, 30);
});

test("normalizeUsage: top-level cached_tokens still honored", () => {
    const u = normalizeUsage({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, cached_tokens: 12 });
    assert.equal(u.cached, 12);
});

test("normalizeUsage: no reasoning — plain prompt+completion", () => {
    const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    assert.deepEqual(u, { prompt: 10, completion: 20, reasoning: 0, cached: 0, total: 30 });
});

test("normalizeUsage: missing total is reconstructed, never negative reasoning", () => {
    const u = normalizeUsage({ prompt_tokens: 10, completion_tokens: 20 });
    assert.deepEqual(u, { prompt: 10, completion: 20, reasoning: 0, cached: 0, total: 30 });
});

test("normalizeUsage: absent usage → all zeros", () => {
    assert.deepEqual(normalizeUsage(null), { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 });
    assert.deepEqual(normalizeUsage(undefined), { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 });
});

// — computeCost —

test("computeCost: bills reasoning at the output rate", () => {
    // 100 input, 0 cached, 50 completion + 200 reasoning = 250 output.
    const usage = { prompt: 100, completion: 50, reasoning: 200, cached: 0, total: 350 };
    // input 1 pico/tok, output 10 pico/tok → 100*1 + 250*10 = 2600
    assert.equal(computeCost(usage, { input: 1, output: 10, cached: 0 }), 2600);
});

test("computeCost: cached prompt billed at the cache rate, remainder at input", () => {
    const usage = { prompt: 1000, completion: 0, reasoning: 0, cached: 400, total: 1000 };
    // 600 non-cached @5 + 400 cached @1 = 3000 + 400 = 3400
    assert.equal(computeCost(usage, { input: 5, output: 99, cached: 1 }), 3400);
});

test("computeCost: zero rates → 0", () => {
    const usage = { prompt: 9, completion: 9, reasoning: 9, cached: 9, total: 27 };
    assert.equal(computeCost(usage, { input: 0, output: 0, cached: 0 }), 0);
});
