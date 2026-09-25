import assert from "node:assert/strict";
import test from "node:test";
import {
    aggregateProviderAccounting,
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

test("{§provider-monetary-evidence} OpenRouter response cost normalizes without rate reconstruction", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { is_byok: false, cost: 3.2e-7 } })), {
        kind: "charged",
        amount: { amount: "0.00000032", currency: "USD" },
        source: "OpenRouter response usage.cost",
    });
});

test("{§provider-monetary-evidence} router-paid inference is not counted twice", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider")!;
    assert.deepEqual(normalize(evidence({ usage: {
        is_byok: false,
        cost: 0.0000274,
        cost_details: { upstream_inference_cost: 0.0000274 },
    } })), {
        kind: "charged",
        amount: { amount: "0.0000274", currency: "USD" },
        source: "OpenRouter response usage.cost",
    });
});

test("{§provider-monetary-evidence} BYOK sums the router fee and upstream inference once", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider")!;
    for (const [fee, upstream, expected] of [
        [0, 0.00000745, "0.00000745"],
        [0.00000032, 0.00000745, "0.00000777"],
        [0.1, 0.2, "0.3"],
        [0, 0, "0"],
    ] as const) {
        assert.deepEqual(normalize(evidence({ usage: {
            is_byok: true,
            cost: fee,
            cost_details: { upstream_inference_cost: upstream },
        } })), {
            kind: "charged",
            amount: { amount: expected, currency: "USD" },
            source: "OpenRouter response usage.cost + usage.cost_details.upstream_inference_cost (BYOK)",
        });
    }
});

test("{§provider-monetary-evidence} incomplete router charges remain unknown, never zero or a catalog guess", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider")!;
    for (const [usage, reason] of [
        [{ cost: 0 }, "OpenRouter usage.is_byok is missing; total request cost is unknown"],
        [{ cost: 0, is_byok: null }, "OpenRouter usage.is_byok is missing; total request cost is unknown"],
        [{ is_byok: true }, "OpenRouter BYOK usage.cost is missing"],
        [{ is_byok: true, cost: null }, "OpenRouter BYOK usage.cost is missing"],
        [{ is_byok: false, cost_details: { upstream_inference_cost: 0.1 } }, "OpenRouter usage.cost is missing"],
        [{ is_byok: true, cost: 0 }, "OpenRouter BYOK usage.cost_details.upstream_inference_cost is missing"],
        [{ is_byok: true, cost: 0, cost_details: { upstream_inference_cost: null } }, "OpenRouter BYOK usage.cost_details.upstream_inference_cost is missing"],
    ] as const) {
        assert.deepEqual(normalize(evidence({ usage })), { kind: "unknown", reason });
    }
    assert.equal(normalize(evidence({ usage: {} })), undefined);
    assert.equal(normalize(evidence({ usage: { is_byok: false } })), undefined);
});

test("{§provider-monetary-evidence} router monetary fields are validated without coercion", () => {
    const normalize = providerCostNormalizer("@openrouter/ai-sdk-provider")!;
    for (const cost of ["0", -1, NaN, Infinity]) {
        assert.throws(() => normalize(evidence({ usage: { is_byok: false, cost } })), {
            name: "TypeError",
            message: typeof cost === "number"
                ? "OpenRouter usage.cost must be a finite non-negative number"
                : "OpenRouter usage.cost must be numeric",
        });
        assert.throws(() => normalize(evidence({ usage: {
            is_byok: true, cost: 0, cost_details: { upstream_inference_cost: cost },
        } })), {
            name: "TypeError",
            message: typeof cost === "number"
                ? "OpenRouter usage.cost_details.upstream_inference_cost must be a finite non-negative number"
                : "OpenRouter usage.cost_details.upstream_inference_cost must be numeric",
        });
    }
    assert.throws(() => normalize(evidence({ usage: { is_byok: "false", cost: 0 } })), {
        name: "TypeError", message: "OpenRouter usage.is_byok must be boolean",
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

test("response cost normalization is an explicit adapter capability", () => {
    assert.equal(providerCostNormalizer("@ai-sdk/anthropic"), undefined);
    assert.equal(providerCostNormalizer("@ai-sdk/deepinfra")!(evidence({ usage: {} })), undefined);
    assert.throws(
        () => providerCostNormalizer("@ai-sdk/deepinfra")!(evidence({ usage: { estimated_cost: "1" } })),
        /estimated_cost must be numeric/,
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
    assert.equal(accounting.costUsd, "0.25", "a response-less failure is skipped; the expressible cost survives");
});

test("aggregateProviderAccounting omits unknown nested usage fields from its JSON projection", () => {
    const accounting = aggregateProviderAccounting([{
        provider: "provider:a",
        model: "m",
        outcome: "response",
        usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            inputTokenDetails: { cacheReadTokens: 1 },
            outputTokenDetails: { reasoningTokens: 2 },
        },
        cost: { kind: "unknown", reason: "no direct cost" },
    }]);

    assert.deepEqual(accounting.usage, {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        inputTokenDetails: { cacheReadTokens: 1 },
        outputTokenDetails: { reasoningTokens: 2 },
    });
});

test("aggregateProviderAccounting does not invent complete detail partitions across heterogeneous requests", () => {
    const accounting = aggregateProviderAccounting([
        {
            provider: "provider:detailed",
            model: "m",
            outcome: "response",
            usage: {
                inputTokens: 2,
                outputTokens: 0,
                totalTokens: 2,
                inputTokenDetails: {
                    noCacheTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
            },
            cost: { kind: "unknown", reason: "no direct cost" },
        },
        {
            provider: "provider:totals-only",
            model: "m",
            outcome: "response",
            usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
            cost: { kind: "unknown", reason: "no direct cost" },
        },
    ]);

    assert.deepEqual(accounting.usage, {
        inputTokens: 6,
        outputTokens: 0,
        totalTokens: 6,
        inputTokenDetails: {
            noCacheTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        },
    });
});
