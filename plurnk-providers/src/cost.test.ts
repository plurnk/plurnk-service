import assert from "node:assert/strict";
import test from "node:test";
import {
    addDecimals,
    estimateProviderCost,
    providerCostUsd,
    resolveProviderCost,
    sumProviderCostsUsd,
    validateChargedCost,
} from "./cost.ts";
import type { ProviderUsage } from "./types.ts";

const usage: ProviderUsage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
};

test("direct charged evidence wins over a Models.dev estimate", () => {
    const charged = {
        kind: "charged",
        amount: { amount: "0.0000042", currency: "XMR" },
        usdEquivalent: "0.73",
        source: "settled upstream request charge",
    } as const;
    const estimated = estimateProviderCost(usage, { input: 1, output: 1 }, "Models.dev");
    assert.deepEqual(resolveProviderCost(charged, estimated), charged);
    assert.equal(providerCostUsd(charged), "0.73");
});

test("an exact zero estimate remains distinguishable from unknown cost", () => {
    const zero = estimateProviderCost(usage, { input: 0, output: 0 }, "Models.dev");
    const unknown = estimateProviderCost(usage, null, "Models.dev");
    assert.deepEqual(zero, {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "Models.dev",
    });
    assert.deepEqual(unknown, {
        kind: "unknown",
        reason: "Models.dev has no complete rate for this model",
    });
    assert.equal(providerCostUsd(zero), "0");
    assert.equal(providerCostUsd(unknown), null);
});

test("a distinct cache rate requires the applicable token category", () => {
    assert.deepEqual(
        estimateProviderCost(usage, { input: 1, output: 1, cacheRead: 0.1 }, "Models.dev"),
        {
            kind: "unknown",
            reason: "the provider response omitted a token category with a distinct Models.dev rate",
        },
    );
});

test("decimal aggregation is exact and becomes unknown if any request is unknown", () => {
    assert.equal(addDecimals(["0.1", "0.02", "3"]), "3.12");
    assert.equal(sumProviderCostsUsd([
        {
            kind: "charged",
            amount: { amount: "0.1", currency: "USD" },
            source: "provider",
        },
        {
            kind: "estimated",
            amount: { amount: "0.02", currency: "USD" },
            source: "Models.dev",
        },
    ]), "0.12");
    assert.equal(sumProviderCostsUsd([
        { kind: "unknown", reason: "no evidence" },
    ]), null);
});

test("malformed charged money is rejected instead of coerced", () => {
    assert.throws(() => validateChargedCost({
        kind: "charged",
        amount: { amount: "1e3", currency: "usd" },
        usdEquivalent: "1000",
        source: "wire",
    }), /canonical non-negative decimal string/);
});
