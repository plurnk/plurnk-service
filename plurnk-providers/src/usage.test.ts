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

test("normalizeUsage: xAI/Grok-style — reasoning is ADDITIVE, not subtracted from completion (#28)", () => {
    // Real grok-4.3 shape: completion_tokens is visible-only; reasoning_tokens is
    // detailed but ADDITIVE — total = prompt + completion + reasoning.
    const u = normalizeUsage({
        prompt_tokens: 143,
        completion_tokens: 1,
        total_tokens: 441,
        prompt_tokens_details: { cached_tokens: 128 },
        completion_tokens_details: { reasoning_tokens: 297 },
    });
    assert.deepEqual(u, { prompt: 143, completion: 1, reasoning: 297, cached: 128, total: 441 });
    assert.equal(u.completion, 1); // visible output preserved, NOT zeroed by the subtraction
    assert.equal(u.completion + u.reasoning, 298); // billable output = visible + reasoning
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

// -- Fireworks-style: reasoning shipped as TEXT, folded into completion, not itemized (#425) --

test("normalizeUsage: fireworks folds reasoning into completion -- re-split by text proportion, sum preserved (#425)", () => {
    // total = prompt + completion (no gap), reasoning_tokens absent, but 750 vs 250
    // chars of reasoning vs content came back. Split completion 75/25; cost base held.
    const u = normalizeUsage(
        { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100 },
        "r".repeat(750),
        "c".repeat(250),
    );
    assert.deepEqual(u, { prompt: 100, completion: 250, reasoning: 750, cached: 0, total: 1100 });
    assert.equal(u.completion + u.reasoning, 1000); // billable output byte-identical
    assert.equal(u.prompt + u.completion + u.reasoning, u.total); // invariant
});

test("normalizeUsage: pure-reasoning turn (empty content) attributes all completion to reasoning (#425)", () => {
    // The run52 runaway shape: 0 visible content, the whole budget spent reasoning.
    const u = normalizeUsage(
        { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 },
        "t".repeat(9000),
        "",
    );
    assert.deepEqual(u, { prompt: 100, completion: 0, reasoning: 500, cached: 0, total: 600 });
});

test("normalizeUsage: text args never perturb the itemized (reasoning_tokens) path", () => {
    // OpenAI o-series reports reasoning_tokens -> that split wins, text is ignored.
    const u = normalizeUsage(
        { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110, completion_tokens_details: { reasoning_tokens: 40 } },
        "r".repeat(999), "c".repeat(1),
    );
    assert.deepEqual(u, { prompt: 10, completion: 60, reasoning: 40, cached: 0, total: 110 });
});

test("normalizeUsage: text args never perturb the Gemini gap path (gap already yields reasoning)", () => {
    // A real total gap means reasoning is itemized-by-subtraction; do not re-split.
    const u = normalizeUsage(
        { prompt_tokens: 19, completion_tokens: 285, total_tokens: 1165 },
        "r".repeat(500), "c".repeat(500),
    );
    assert.equal(u.reasoning, 861); // from the gap, NOT a text re-split
    assert.equal(u.completion, 285);
});

test("normalizeUsage: no total reported -> re-split skipped, reasoning stays 0 (cannot split an unknown base)", () => {
    const u = normalizeUsage(
        { prompt_tokens: 10, completion_tokens: 20 },
        "r".repeat(500), "c".repeat(500),
    );
    assert.deepEqual(u, { prompt: 10, completion: 20, reasoning: 0, cached: 0, total: 30 });
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
