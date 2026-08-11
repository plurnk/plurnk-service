import test from "node:test";
import { strict as assert } from "node:assert";
import { calculateCostUsdDecimal, normalizeUsage } from "./usage.ts";

test("normalizeUsage recovers additive hidden reasoning from an exact total", () => {
    const usage = normalizeUsage({
        prompt_tokens: 19,
        completion_tokens: 285,
        total_tokens: 1165,
    });
    assert.deepEqual(usage, {
        inputTokens: 19,
        outputTokens: 1146,
        totalTokens: 1165,
        outputTokenDetails: { textTokens: 285, reasoningTokens: 861 },
    });
});

test("normalizeUsage preserves OpenAI output totals while itemizing reasoning", () => {
    const usage = normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 100,
        total_tokens: 110,
        completion_tokens_details: { reasoning_tokens: 40 },
    });
    assert.deepEqual(usage, {
        inputTokens: 10,
        outputTokens: 100,
        totalTokens: 110,
        outputTokenDetails: { textTokens: 60, reasoningTokens: 40 },
    });
});

test("normalizeUsage recognizes xAI reasoning as additive from the total identity", () => {
    const usage = normalizeUsage({
        prompt_tokens: 143,
        completion_tokens: 1,
        total_tokens: 441,
        prompt_tokens_details: { cached_tokens: 128 },
        completion_tokens_details: { reasoning_tokens: 297 },
    });
    assert.deepEqual(usage, {
        inputTokens: 143,
        outputTokens: 298,
        totalTokens: 441,
        inputTokenDetails: { cacheReadTokens: 128 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 297 },
    });
});

test("normalizeUsage maps cache-read spellings without inventing uncached tokens", () => {
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        prompt_tokens_details: { cached_tokens: 30 },
    })?.inputTokenDetails, { cacheReadTokens: 30 });
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        cached_tokens: 12,
    })?.inputTokenDetails, { cacheReadTokens: 12 });
});

test("#157: normalizeUsage maps DeepSeek cache hit and miss counts", () => {
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 50,
        prompt_cache_hit_tokens: 30,
        prompt_cache_miss_tokens: 20,
        completion_tokens: 10,
        total_tokens: 60,
    }), {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 30 },
    });
});

test("normalizeUsage derives only exact totals", () => {
    assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20 }), {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
    });
    assert.deepEqual(normalizeUsage({ prompt_tokens: 10, total_tokens: 30 }), {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
    });
});

test("normalizeUsage preserves unknown usage as absence", () => {
    assert.equal(normalizeUsage(null), undefined);
    assert.equal(normalizeUsage(undefined), undefined);
});

test("normalizeUsage never apportions tokens from reasoning or content length", () => {
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 1000,
        total_tokens: 1100,
    }), {
        inputTokens: 100,
        outputTokens: 1000,
        totalTokens: 1100,
    });
});

test("calculateCostUsdDecimal bills all output, including reasoning, at the output rate", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 100,
        outputTokens: 250,
        totalTokens: 350,
        outputTokenDetails: { textTokens: 50, reasoningTokens: 200 },
    }, { input: 1, output: 10 }), "0.0026");
});

test("calculateCostUsdDecimal applies distinct cache-read and cache-write rates", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 1000,
        outputTokens: 0,
        totalTokens: 1000,
        inputTokenDetails: {
            noCacheTokens: 500,
            cacheReadTokens: 400,
            cacheWriteTokens: 100,
        },
    }, { input: 5, output: 99, cacheRead: 1, cacheWrite: 8 }), "0.0037");
});

test("calculateCostUsdDecimal returns unknown when a differently-priced category is absent", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 1000,
        outputTokens: 0,
        totalTokens: 1000,
    }, { input: 5, output: 99, cacheRead: 1 }), null);
});

test("calculateCostUsdDecimal preserves Models.dev decimals without floating-point artifacts", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 1000,
        outputTokens: 150,
        totalTokens: 1150,
        inputTokenDetails: { cacheReadTokens: 400 },
        outputTokenDetails: { textTokens: 100, reasoningTokens: 50 },
    }, { input: 0.14, output: 0.28, cacheRead: 0.0028 }), "0.00012712");
});
