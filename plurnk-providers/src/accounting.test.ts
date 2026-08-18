import assert from "node:assert/strict";
import test from "node:test";
import {
    aggregateProviderAccounting,
    plurnkCostNormalizer,
    providerCostNormalizer,
} from "./accounting.ts";

const evidence = ({ providerMetadata, usage, charge }: {
    providerMetadata?: unknown;
    usage?: unknown;
    charge?: unknown;
}) => ({
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
    ...(usage === undefined ? {} : { usage }),
    ...(charge === undefined ? {} : { charge }),
    response: { id: "response-1" },
});

test("xAI response ticks normalize to a directly charged request", () => {
    const normalize = providerCostNormalizer("@ai-sdk/xai");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { cost_in_usd_ticks: 15_493_500 } })), {
        kind: "charged",
        amount: { amount: "15493500", currency: "USDTICK" },
        usdEquivalent: "0.00154935",
        source: "xAI response usage.cost_in_usd_ticks",
    });
});

test("OpenRouter response cost normalizes without rate reconstruction", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ providerMetadata: { openrouter: { usage: { cost: 3.2e-7 } } } })), {
        kind: "charged",
        amount: { amount: "0.00000032", currency: "USD" },
        source: "OpenRouter response usage.cost",
    });
});

test("DeepInfra's documented response estimate remains estimated", () => {
    const normalize = providerCostNormalizer("@ai-sdk/deepinfra");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { estimated_cost: 5.04e-5 } })), {
        kind: "estimated",
        amount: { amount: "0.0000504", currency: "USD" },
        source: "DeepInfra response usage.estimated_cost",
    });
});

test("first-party charged evidence is validated at its adapter boundary", () => {
    const charged = {
        kind: "charged",
        amount: { amount: "0.01", currency: "USD" },
        source: "plurnk endpoint",
    } as const;
    assert.deepEqual(plurnkCostNormalizer(evidence({ charge: charged })), charged);
    assert.equal(plurnkCostNormalizer(evidence({})), undefined);
});

test("response cost normalization is an explicit adapter capability", () => {
    assert.equal(providerCostNormalizer("@ai-sdk/anthropic"), undefined);
    assert.equal(providerCostNormalizer("@ai-sdk/xai")!(evidence({ usage: {} })), undefined);
    assert.throws(
        () => providerCostNormalizer("@ai-sdk/xai")!(evidence({ usage: { cost_in_usd_ticks: "1" } })),
        /cost_in_usd_ticks must be numeric/,
    );
});

test("aggregateProviderAccounting preserves request order and only sums known fields", () => {
    const accounting = aggregateProviderAccounting([
        {
            provider: "provider:a",
            model: "m",
            outcome: "error",
            status: 429,
            cost: { kind: "unknown", reason: "no response accounting" },
        },
        {
            provider: "provider:b",
            model: "m",
            outcome: "response",
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            cost: {
                kind: "charged",
                amount: { amount: "0.25", currency: "USD" },
                source: "provider b",
            },
        },
    ]);
    assert.deepEqual(accounting.requests.map(({ provider }) => provider), ["provider:a", "provider:b"]);
    assert.deepEqual(accounting.usage, {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
    }, "a response-less failure is skipped, never allowed to erase reported usage");
    assert.equal(accounting.costUsd, null, "costUsd stays null while any request is not USD-expressible");
});
