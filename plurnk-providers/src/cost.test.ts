import assert from "node:assert/strict";
import test from "node:test";
import ModelProvider from "./ModelProvider.ts";
import { addDecimals, estimateProviderCost, providerCostUsd, resolveProviderCost, sumProviderCostsUsd, validateChargedCost } from "./cost.ts";
import { aggregateProviderAccounting, providerCostNormalizer } from "./accounting.ts";
import { calculateCostUsdDecimal, normalizeUsage, UsageDetailError } from "./usage.ts";
import { createProviderModel } from "./modelAdapters.ts";
import { ProviderError } from "./errors.ts";
import { type ProviderUsage } from "./types.ts";

{
const usage: ProviderUsage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
};

test("{§provider-monetary-evidence} direct charged evidence wins over a Models.dev estimate", () => {
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

test("{§provider-request-accounting} an exact zero estimate remains distinguishable from unknown cost", () => {
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

test("{§provider-monetary-evidence} a distinct cache rate requires the applicable token category", () => {
    assert.deepEqual(
        estimateProviderCost(usage, { input: 1, output: 1, cacheRead: 0.1 }, "Models.dev"),
        {
            kind: "unknown",
            reason: "the provider response omitted a token category with a distinct Models.dev rate",
        },
    );
});

test("{§model-fact-resolution} a distinct reasoning rate prices reasoning as a subset of output", () => {
    const withReasoning: ProviderUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        outputTokenDetails: { reasoningTokens: 20 },
    };
    assert.deepEqual(
        estimateProviderCost(withReasoning, {
            input: 1,
            output: 2,
            reasoning: 5,
        }, "Models.dev"),
        {
            kind: "estimated",
            amount: { amount: "0.00026", currency: "USD" },
            source: "Models.dev",
        },
    );
});

test("{§provider-monetary-evidence} a distinct reasoning rate requires reported reasoning usage", () => {
    assert.deepEqual(
        estimateProviderCost(usage, { input: 1, output: 2, reasoning: 5 }, "Models.dev"),
        {
            kind: "unknown",
            reason: "the provider response omitted a token category with a distinct Models.dev rate",
        },
    );
});

test("{§provider-request-accounting} decimal aggregation is exact and becomes unknown if any request is unknown", () => {
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

test("{§provider-request-accounting} malformed charged money is rejected instead of coerced", () => {
    assert.throws(() => validateChargedCost({
        kind: "charged",
        amount: { amount: "1e3", currency: "usd" },
        usdEquivalent: "1000",
        source: "wire",
    }), /canonical non-negative decimal string/);
});
}

{
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
    const normalize = providerCostNormalizer("openrouter");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { is_byok: false, cost: 3.2e-7 } })), {
        kind: "charged",
        amount: { amount: "0.00000032", currency: "USD" },
        source: "OpenRouter response usage.cost",
    });
});

test("{§provider-monetary-evidence} router-paid inference is not counted twice", () => {
    const normalize = providerCostNormalizer("openrouter")!;
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
    const normalize = providerCostNormalizer("openrouter")!;
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
    const normalize = providerCostNormalizer("openrouter")!;
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
    const normalize = providerCostNormalizer("openrouter")!;
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

test("{§provider-monetary-evidence} DeepInfra's documented response estimate remains estimated", () => {
    const normalize = providerCostNormalizer("deepinfra");
    assert.notEqual(normalize, undefined);
    assert.deepEqual(normalize!(evidence({ usage: { estimated_cost: 5.04e-5 } })), {
        kind: "estimated",
        amount: { amount: "0.0000504", currency: "USD" },
        source: "DeepInfra response usage.estimated_cost",
    });
});

test("{§provider-monetary-evidence} response cost normalization is an explicit adapter capability", () => {
    assert.equal(providerCostNormalizer("anthropic"), undefined);
    assert.equal(providerCostNormalizer("deepinfra")!(evidence({ usage: {} })), undefined);
    assert.throws(
        () => providerCostNormalizer("deepinfra")!(evidence({ usage: { estimated_cost: "1" } })),
        /estimated_cost must be numeric/,
    );
});

test("{§provider-request-accounting} unknown requests retain subtotals without presenting them as totals", () => {
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
    assert.equal(accounting.usage, null);
    assert.deepEqual(accounting.knownUsage, {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
    }, "a response-less failure is skipped, never allowed to erase reported usage");
    assert.equal(accounting.costUsd, null, "unknown is not free");
    assert.equal(accounting.knownCostUsd, "0.25", "received price evidence is retained separately");
});

test("{§provider-request-accounting} aggregateProviderAccounting omits unknown nested usage fields from its JSON projection", () => {
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

test("{§provider-request-accounting} aggregateProviderAccounting does not invent complete detail partitions across heterogeneous requests", () => {
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
    });
    assert.deepEqual(accounting.knownUsage, {
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
}

{
test("{§provider-sdk-boundary} normalizeUsage recovers additive hidden reasoning from an exact total", () => {
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

test("{§provider-sdk-boundary} normalizeUsage preserves OpenAI output totals while itemizing reasoning", () => {
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

test("{§provider-sdk-boundary} normalizeUsage recognizes xAI reasoning as additive from the total identity", () => {
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

test("{§provider-request-accounting} normalizeUsage maps cache-read spellings without inventing uncached tokens", () => {
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

test("{§provider-request-accounting} normalizeUsage maps DeepSeek cache hit and miss counts", () => {
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
        inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
    });
});

test("{§provider-request-accounting} input partitions derive exactly one missing category, not an unknown split", () => {
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 100, prompt_cache_miss_tokens: 20,
        prompt_tokens_details: { cache_write_tokens: 30 },
    })?.inputTokenDetails, { noCacheTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 30 });
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 100, prompt_cache_miss_tokens: 20,
    })?.inputTokenDetails, { noCacheTokens: 20 });
    assert.deepEqual(normalizeUsage({
        prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 },
    }, { inputTokens: 100, inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0 } })?.inputTokenDetails,
    { cacheReadTokens: 30 }, "SDK defaults cannot contradict a reported cache counter");
});

test("{§provider-failure-normalization} partition derivation never replaces an invalid counter", () => {
    assert.throws(() => normalizeUsage({
        prompt_tokens: 100, prompt_cache_miss_tokens: -1,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
    }), (error: unknown) => {
        assert.ok(error instanceof UsageDetailError);
        assert.deepEqual(error.usage, {
            inputTokens: 100, inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 20 },
        });
        return true;
    });
    assert.throws(() => normalizeUsage({
        prompt_tokens: 100, prompt_cache_miss_tokens: 80,
        prompt_tokens_details: { cached_tokens: 30 },
    }), (error: unknown) => {
        assert.ok(error instanceof UsageDetailError);
        assert.deepEqual(error.usage, { inputTokens: 100 });
        return true;
    });
});

test("{§provider-request-accounting} normalizeUsage derives only exact totals", () => {
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

test("{§provider-request-accounting} normalizeUsage preserves unknown usage as absence", () => {
    assert.equal(normalizeUsage(null), undefined);
    assert.equal(normalizeUsage(undefined), undefined);
});

test("{§provider-failure-normalization} rejected details preserve independently valid totals and cache counts", () => {
    const raw = {
        prompt_tokens: 38673, completion_tokens: 16384, total_tokens: 55057,
        completion_tokens_details: { reasoning_tokens: 16385 },
        prompt_tokens_details: { cached_tokens: 14528 },
    };
    assert.throws(() => normalizeUsage(raw), (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.deepEqual((error as TypeError & { usage?: unknown }).usage, {
            inputTokens: 38673, outputTokens: 16384, totalTokens: 55057,
            inputTokenDetails: { cacheReadTokens: 14528 },
        });
        return true;
    });
});

test("{§provider-request-accounting} normalizeUsage never apportions tokens from reasoning or content length", () => {
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

test("{§provider-failure-normalization} invalid optional counts never erase the other valid breakdown", () => {
    for (const cached of [-1, 11]) {
        assert.throws(() => normalizeUsage({
            prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
            prompt_tokens_details: { cached_tokens: cached },
            completion_tokens_details: { reasoning_tokens: 2 },
        }), (error: unknown) => {
            assert.ok(error instanceof UsageDetailError);
            assert.deepEqual(error.usage, {
                inputTokens: 10, outputTokens: 5, totalTokens: 15,
                outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
            });
            return true;
        });
    }
    assert.throws(() => normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 14 }),
        (error: unknown) => error instanceof TypeError && !(error instanceof UsageDetailError)
            && error.message === "provider usage total is inconsistent with input and output tokens");
    assert.throws(() => normalizeUsage({ reasoning_tokens: -1 }),
        (error: unknown) => error instanceof TypeError && !(error instanceof UsageDetailError)
            && error.message === "provider usage reasoning tokens must be a non-negative safe integer");
});

test("{§model-fact-resolution} calculateCostUsdDecimal bills all output, including reasoning, at the output rate", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 100,
        outputTokens: 250,
        totalTokens: 350,
        outputTokenDetails: { textTokens: 50, reasoningTokens: 200 },
    }, { input: 1, output: 10 }), "0.0026");
});

test("{§model-fact-resolution} calculateCostUsdDecimal applies distinct cache-read and cache-write rates", () => {
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

test("{§provider-monetary-evidence} calculateCostUsdDecimal returns unknown when a differently-priced category is absent", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 1000,
        outputTokens: 0,
        totalTokens: 1000,
    }, { input: 5, output: 99, cacheRead: 1 }), null);
});

test("{§provider-request-accounting} calculateCostUsdDecimal preserves Models.dev decimals without floating-point artifacts", () => {
    assert.equal(calculateCostUsdDecimal({
        inputTokens: 1000,
        outputTokens: 150,
        totalTokens: 1150,
        inputTokenDetails: { cacheReadTokens: 400 },
        outputTokenDetails: { textTokens: 100, reasoningTokens: 50 },
    }, { input: 0.14, output: 0.28, cacheRead: 0.0028 }), "0.00012712");
});
}

{
const usage = {
    prompt_tokens: 33,
    completion_tokens: 5,
    total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 16, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 2 },
};
const upstream = { upstream_inference_cost: 0.00000745 };
const byokSource = "OpenRouter response usage.cost + usage.cost_details.upstream_inference_cost (BYOK)";
const charged = (amount: string, byok = true) => ({
    kind: "charged",
    amount: { amount, currency: "USD" },
    source: byok ? byokSource : "OpenRouter response usage.cost",
});

// {§provider-monetary-evidence} Exercise the installed router SDK's actual wire translation.
const fixture = (billing: Record<string, unknown>, failure = false) => {
    let calls = 0;
    const wireUsage = { ...usage, ...billing };
    const identity = { id: "router-response", model: "served-model", provider: "Z.AI", created: 1 };
    const sdk = createProviderModel(
        "openrouter",
        "requested-model",
        { OPENROUTER_API_KEY: "test-key" },
        "https://openrouter.ai/api/v1",
    );
    assert.ok(sdk?.providerModel);
    const provider = new ModelProvider({
        model: "requested-model",
        providerModel: sdk.providerModel,
        reasoningRequestProviderOptions: (effort) => ({ openrouter: { reasoning: { effort } } }),
        normalizeCost: providerCostNormalizer("openrouter"),
        estimateCost: () => ({ kind: "estimated", amount: { amount: "999", currency: "USD" }, source: "fixture catalog" }),
        source: "provider:openrouter",
        contextWindow: 8192,
        outputBudget: 1024,
        temperature: null,
        repeatPenalty: null,
        effort: { mode: "low", budget: null },
        supportedEfforts: ["low"],
        fetchTimeoutMs: 2000,
        operationTimeoutMs: 2000,
        retryAttempts: 0,
        rawBody: false,
        fetch: async (_url, init) => {
            calls += 1;
            const request = JSON.parse(init!.body as string) as Record<string, unknown>;
            assert.equal(request.model, "requested-model");
            assert.equal(request.max_tokens, 1024);
            assert.deepEqual(request.reasoning, { effort: "low" });
            assert.equal(request.stream, true);
            const content = {
                ...identity,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
            };
            const settlement = {
                ...identity,
                object: "chat.completion.chunk",
                choices: [],
                usage: wireUsage,
            };
            const finish = failure
                ? { error: { code: 500, message: "upstream interrupted" } }
                : { ...identity, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            return new Response([
                ...[content, settlement, finish].map((frame) => `data: ${JSON.stringify(frame)}`),
                "data: [DONE]",
                "",
            ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    return {
        generate: () => provider.generate({
            sessionId: "router-session",
            messages: [{ role: "user", content: "Reply ok." }],
            maxOutputTokens: 1024,
        }),
        calls: () => calls,
        wireUsage,
    };
};

test("{§provider-monetary-evidence} real router SDK streamed accounting", async (t) => {
    for (const specimen of [
        { name: "BYOK fee waived", billing: { is_byok: true, cost: 0, cost_details: upstream }, cost: charged("0.00000745") },
        { name: "BYOK fee charged", billing: { is_byok: true, cost: 0.00000032, cost_details: upstream }, cost: charged("0.00000777") },
        { name: "router-funded", billing: { is_byok: false, cost: 0.00000745, cost_details: upstream }, cost: charged("0.00000745", false) },
        { name: "missing upstream charge", billing: { is_byok: true, cost: 0 }, cost: { kind: "unknown", reason: "OpenRouter BYOK usage.cost_details.upstream_inference_cost is missing" } },
    ]) {
        await t.test(`{§provider-monetary-evidence} ${specimen.name}`, async () => {
            const probe = fixture(specimen.billing);
            const response = await probe.generate();
            assert.equal(probe.calls(), 1);
            assert.equal(response.assistant.content, "ok");
            assert.equal(response.assistant.model, "served-model");
            assert.equal(response.meta?.provider, "Z.AI");
            assert.equal(response.rawBody, undefined, "billing evidence does not require opt-in raw capture");
            assert.deepEqual(response.accounting[0]?.cost, specimen.cost);
            assert.deepEqual(response.accounting[0]?.usage, {
                inputTokens: 33, outputTokens: 5, totalTokens: 38,
                inputTokenDetails: { noCacheTokens: 17, cacheReadTokens: 16, cacheWriteTokens: 0 },
                outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
            });
        });
    }
    await t.test("{§provider-monetary-evidence} failed request retains its reported BYOK charge", async () => {
        const probe = fixture({ is_byok: true, cost: 0, cost_details: upstream }, true);
        await assert.rejects(probe.generate, (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.match(error.message, /upstream interrupted/);
            assert.equal(error.accounting.length, 1);
            assert.equal(error.accounting[0]?.outcome, "error");
            assert.deepEqual(error.accounting[0]?.cost, charged("0.00000745"));
            assert.equal(error.accounting[0]?.usage?.inputTokens, 33);
            return true;
        });
        assert.equal(probe.calls(), 1);
    });
});
}
