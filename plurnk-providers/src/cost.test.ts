import assert from "node:assert/strict";
import test from "node:test";
import {
    providerCostFor,
    providerCostUsd,
    validateAuthoritativeCharge,
} from "./cost.ts";
import type { ProviderUsage } from "./types.ts";

const usage: ProviderUsage = {
    prompt: 1,
    completion: 1,
    reasoning: 0,
    cached: 0,
    total: 2,
};

test("authoritative provider charge wins over a local estimate", () => {
    const provider = {
        calculateCost: () => 12,
        calculateCharge: () => ({ kind: "estimated", usd: "12", source: "catalog" } as const),
    };
    const charge = {
        kind: "authoritative",
        amount: { amount: "0.0000042", currency: "XMR" },
        usdEquivalent: "0.73",
        source: "settled upstream turn charge",
    } as const;
    assert.deepEqual(providerCostFor(provider, usage, charge), charge);
    assert.equal(providerCostUsd(charge), 0.73);
});

test("explicit free remains distinguishable from unknown", () => {
    const free = providerCostFor({
        calculateCost: () => 0,
        calculateCharge: () => ({ kind: "free", source: "local model" }),
    }, usage);
    const unknown = providerCostFor({ calculateCost: () => 0 }, usage);
    assert.deepEqual(free, { kind: "free", source: "local model" });
    assert.deepEqual(unknown, {
        kind: "unknown",
        reason: "legacy calculateCost returned zero without free-cost authority",
    });
    assert.equal(providerCostUsd(free), 0);
    assert.equal(providerCostUsd(unknown), null);
});

test("positive legacy cost remains an estimated USD compatibility result", () => {
    assert.deepEqual(providerCostFor({ calculateCost: () => 0.25 }, usage), {
        kind: "estimated",
        usd: "0.25",
        source: "legacy calculateCost",
    });
});

test("rejects malformed money instead of mining or coercing it", () => {
    assert.throws(() => validateAuthoritativeCharge({
        kind: "authoritative",
        amount: { amount: "1e3", currency: "usd" },
        usdEquivalent: "1000",
        source: "wire",
    }), /canonical non-negative decimal string/);
});
