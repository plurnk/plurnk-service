import assert from "node:assert/strict";
import test from "node:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import AiSdkProvider from "./AiSdkProvider.ts";
import { providerCostNormalizer } from "./accounting.ts";
import { ProviderError } from "./errors.ts";

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
const fixture = (streaming: boolean, billing: Record<string, unknown>, failure = false) => {
    let calls = 0;
    const wireUsage = { ...usage, ...billing };
    const identity = { id: "router-response", model: "served-model", provider: "Z.AI", created: 1 };
    const sdk = createOpenRouter({
        apiKey: "test-key",
        fetch: async (_url, init) => {
            calls += 1;
            const request = JSON.parse(init!.body as string) as Record<string, unknown>;
            assert.equal(request.model, "requested-model");
            assert.equal(request.max_tokens, 1024);
            assert.deepEqual(request.reasoning, { effort: "low" });
            if (streaming) {
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
            }
            return Response.json(failure ? {
                error: { message: "upstream interrupted", code: 502 },
                usage: wireUsage,
            } : {
                ...identity,
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: wireUsage,
            }, { status: failure ? 502 : 200 });
        },
    });
    const provider = new AiSdkProvider({
        model: "requested-model",
        languageModel: sdk.chat("requested-model", { reasoning: { effort: "low" } }),
        normalizeCost: providerCostNormalizer("@openrouter/ai-sdk-provider"),
        estimateCost: () => ({ kind: "estimated", amount: { amount: "999", currency: "USD" }, source: "fixture catalog" }),
        source: "provider:openrouter",
        contextWindow: 8192,
        outputBudget: 1024,
        temperature: null,
        repeatPenalty: null,
        reasoning: { mode: "low", budget: null },
        supportedReasoningPolicies: ["low"],
        fetchTimeoutMs: 2000,
        operationTimeoutMs: 2000,
        firstContentTimeoutMs: 2000,
        retryAttempts: 0,
        streaming,
        rawBody: false,
    });
    return {
        generate: () => provider.generate({
            workerId: "router-worker",
            messages: [{ role: "user", content: "Reply ok." }],
            maxOutputTokens: 1024,
        }),
        calls: () => calls,
        wireUsage,
    };
};

for (const streaming of [false, true]) {
    test(`{§provider-monetary-evidence} real router SDK ${streaming ? "streamed" : "buffered"} accounting`, async (t) => {
        for (const specimen of [
            { name: "BYOK fee waived", billing: { is_byok: true, cost: 0, cost_details: upstream }, cost: charged("0.00000745") },
            { name: "BYOK fee charged", billing: { is_byok: true, cost: 0.00000032, cost_details: upstream }, cost: charged("0.00000777") },
            { name: "router-funded", billing: { is_byok: false, cost: 0.00000745, cost_details: upstream }, cost: charged("0.00000745", false) },
            { name: "missing upstream charge", billing: { is_byok: true, cost: 0 }, cost: { kind: "unknown", reason: "OpenRouter BYOK usage.cost_details.upstream_inference_cost is missing" } },
        ]) {
            await t.test(specimen.name, async () => {
                const probe = fixture(streaming, specimen.billing);
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
        await t.test("failed request retains its reported BYOK charge", async () => {
            const probe = fixture(streaming, { is_byok: true, cost: 0, cost_details: upstream }, true);
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
