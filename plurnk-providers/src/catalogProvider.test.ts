import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:http";
import { catalogProviderFromEnv, providerFromSdkModel } from "./catalogProvider.ts";
import type { LanguageModel } from "ai";
import { resetEmittedWarnings } from "./warnings.ts";

const env = {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "1000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REASONING: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
    PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
};

test.afterEach(() => {
    mock.restoreAll();
    resetEmittedWarnings();
});

test("catalog provider resolves model physics and Models.dev USD rates", () => {
    const provider = catalogProviderFromEnv("openai", env, "gpt-4.1-mini");
    assert.notEqual(provider, null);
    assert.equal(provider?.model, "gpt-4.1-mini");
    assert.equal(provider?.contextWindow, 1_047_576);
    assert.equal(provider?.maxInputTokens, null);
    assert.equal(provider?.maxOutputTokens, 32_768);
    assert.equal(provider?.outputBudget, 32_768);
    assert.equal(provider?.reasoningBudget, null);
    assert.deepEqual(provider?.supportedReasoningPolicies, ["off", "adaptive"]);
});

test("provider adapters advertise only reasoning policies they can preserve", () => {
    const deepseek = catalogProviderFromEnv("deepseek", {
        ...env,
        DEEPSEEK_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort",
    }, "deepseek-v4-flash");
    assert.deepEqual(deepseek?.supportedReasoningPolicies, ["off", "adaptive", "low", "high"]);

    assert.throws(
        () => catalogProviderFromEnv("deepseek", {
            ...env,
            DEEPSEEK_API_KEY: "test-key",
            PLURNK_PROVIDERS_REASONING: "medium",
            PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort",
        }, "deepseek-v4-flash"),
        /reasoning policy 'medium' is unsupported; supported policies: off, adaptive, low, high/,
    );

    const mistral = catalogProviderFromEnv("mistral", {
        ...env,
        MISTRAL_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "mistral-small-latest");
    assert.deepEqual(mistral?.supportedReasoningPolicies, ["off", "adaptive", "high"], "Mistral's low/medium coercion is not advertised as exact support");

    const grok = catalogProviderFromEnv("xai", {
        ...env,
        XAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "grok-4.6");
    assert.deepEqual(grok?.supportedReasoningPolicies, ["adaptive", "low", "medium", "high"], "Grok 4.6 cannot disable reasoning");

    const gemini = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "gemini-3.7-flash");
    assert.deepEqual(gemini?.supportedReasoningPolicies, ["adaptive", "low", "medium", "high"], "Gemini 3's mandatory minimum is not advertised as off");
});

test("Models.dev controls Cloudflare's exact effort vocabulary", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response([
            `data: ${JSON.stringify({
                id: "cloudflare-effort",
                object: "chat.completion.chunk",
                created: 1,
                model: "@cf/qwen/qwen3.8-27b",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const cloudflareEnv = {
        ...env,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "token",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_STYLE: "effort_required",
    };
    const low = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_REASONING: "low",
    }, "@cf/qwen/qwen3.8-27b");
    assert.deepEqual(low?.supportedReasoningPolicies, ["adaptive", "low", "medium"]);
    await low?.generate({ workerId: "cloudflare-low", messages: [{ role: "user", content: "hello" }] });

    const adaptive = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "@cf/qwen/qwen3.8-27b");
    await adaptive?.generate({ workerId: "cloudflare-adaptive", messages: [{ role: "user", content: "hello" }] });

    const nonReasoning = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "@cf/ibm-granite/granite-4.0-h-micro");
    assert.deepEqual(nonReasoning?.supportedReasoningPolicies, ["off", "adaptive"]);
    await nonReasoning?.generate({ workerId: "cloudflare-granite", messages: [{ role: "user", content: "hello" }] });

    const ungradedReasoner = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "@cf/zai-org/glm-5.3-flash");
    assert.deepEqual(ungradedReasoner?.supportedReasoningPolicies, ["adaptive"]);
    await ungradedReasoner?.generate({ workerId: "cloudflare-ungraded", messages: [{ role: "user", content: "hello" }] });

    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["low", "xhigh", undefined, undefined]);
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", cloudflareEnv, "@cf/qwen/qwen3.8-27b"),
        /reasoning policy 'off' is unsupported; supported policies: adaptive, low, medium/,
    );
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", {
            ...cloudflareEnv,
            PLURNK_PROVIDERS_REASONING: "high",
        }, "@cf/qwen/qwen3.8-27b"),
        /reasoning policy 'high' is unsupported; supported policies: adaptive, low, medium/,
    );
});

test("an operator-declared effort vocabulary extends Models.dev's for a provider's reasoning routes (#439)", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response([
            `data: ${JSON.stringify({
                id: "cloudflare-declared",
                object: "chat.completion.chunk",
                created: 1,
                model: "@cf/zai-org/glm-5.3-flash",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const declaredEnv = {
        ...env,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "token",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_STYLE: "effort_required",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "low, medium,high",
    };
    // Models.dev lists this route as reasoning with no effort vocabulary; the declaration supplies one.
    const low = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_REASONING: "low" }, "@cf/zai-org/glm-5.3-flash");
    assert.deepEqual(low?.supportedReasoningPolicies, ["adaptive", "low", "medium", "high"]);
    await low?.generate({ workerId: "declared-low", messages: [{ role: "user", content: "hello" }] });
    const adaptive = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_REASONING: "adaptive" }, "@cf/zai-org/glm-5.3-flash");
    await adaptive?.generate({ workerId: "declared-adaptive", messages: [{ role: "user", content: "hello" }] });
    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["low", "high"], "a fixed level keeps its name; adaptive takes the strongest declared effort");
    // A declared `none` admits `off` on an effort transport; the catalog's own vocabulary stays in the union.
    const withOff = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...declaredEnv,
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "none,high",
    }, "@cf/qwen/qwen3.8-27b");
    assert.deepEqual(withOff?.supportedReasoningPolicies, ["off", "adaptive", "low", "medium", "high"]);
    // The declaration never turns a non-reasoning route into a reasoning one.
    const nonReasoning = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_REASONING: "adaptive" }, "@cf/ibm-granite/granite-4.0-h-micro");
    assert.deepEqual(nonReasoning?.supportedReasoningPolicies, ["off", "adaptive"]);
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", {
            ...declaredEnv,
            PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "low,turbo",
        }, "@cf/zai-org/glm-5.3-flash"),
        /PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS has invalid value "turbo"; declarable efforts: none, minimal, low, medium, high, xhigh, max/,
    );
});

test("an operator context window caps catalog physics and percentage output policy", () => {
    const provider = catalogProviderFromEnv("openai", {
        ...env,
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "128000",
    }, "gpt-4.1-mini");
    assert.equal(provider?.contextWindow, 128_000);
    assert.equal(provider?.outputBudget, 32_768, "the model output maximum remains the tighter cap");
    assert.equal(provider?.reasoningBudget, null);

    const oversized = catalogProviderFromEnv("openai", {
        ...env,
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "2000000",
    }, "gpt-4.1-mini");
    assert.equal(oversized?.contextWindow, 1_047_576, "an operator ceiling cannot enlarge model physics");
});

test("official AI SDK provider owns the native request while PLURNK owns call settings", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(input),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const chunks = [
            `data: ${JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-4.1-mini",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 2,
                model: "gpt-4.1-mini",
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            })}`,
            "data: [DONE]",
        ].join("\n\n");
        return new Response(chunks, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    });

    const provider = catalogProviderFromEnv("openai", env, "gpt-4.1-mini");
    const result = await provider?.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 64,
        sampling: { top_p: 0.8, seed: 7 },
    });

    assert.equal(result?.assistant.content, "done");
    assert.equal(result?.accounting[0]?.usage?.totalTokens, 3);
    assert.deepEqual(result?.accounting[0]?.cost, {
        kind: "unknown",
        reason: "the provider response omitted a token category with a distinct Models.dev rate",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0]?.body.model, "gpt-4.1-mini");
    assert.equal(calls[0]?.body.temperature, 0.2);
    assert.equal(calls[0]?.body.top_p, 0.8);
    assert.equal(calls[0]?.body.seed, 7);
    assert.equal(calls[0]?.body.max_tokens, 64);
    assert.equal(calls[0]?.body.prompt_cache_key, "worker", "the official OpenAI SDK projects the documented affinity key");
});

test("xAI's native chat contract requests its strongest cataloged effort and caps the complete reasoning response", async () => {
    let call: { headers: Headers; body: Record<string, unknown> } | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        call = {
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return new Response([
            `data: ${JSON.stringify({
                id: "response-xai",
                object: "chat.completion.chunk",
                created: 1,
                model: "grok-4.6",
                choices: [{ index: 0, delta: { reasoning_content: "consider" }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
                id: "response-xai",
                object: "chat.completion.chunk",
                created: 2,
                model: "grok-4.6",
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "response-xai",
                object: "chat.completion.chunk",
                created: 3,
                model: "grok-4.6",
                choices: [],
                usage: {
                    prompt_tokens: 5,
                    completion_tokens: 4,
                    total_tokens: 9,
                    prompt_tokens_details: { cached_tokens: 2 },
                    completion_tokens_details: { reasoning_tokens: 3 },
                    cost_in_usd_ticks: 1_230_000,
                },
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });

    const provider = catalogProviderFromEnv("xai", {
        ...env,
        XAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "grok-4.6");
    const result = await provider?.generate({
        workerId: "xai-worker",
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 16,
    });

    assert.equal(call?.body.max_completion_tokens, 16);
    assert.equal(call?.body.reasoning_effort, "xhigh", "adaptive uses the strongest route-advertised generic effort");
    assert.equal("max_tokens" in (call?.body ?? {}), false);
    assert.equal(call?.headers.get("x-grok-conv-id"), "xai-worker");
    assert.equal(result?.assistant.reasoning, "consider");
    assert.equal(result?.assistant.content, "OK");
    assert.deepEqual(result?.accounting[0]?.usage, {
        inputTokens: 5,
        outputTokens: 4,
        totalTokens: 9,
        inputTokenDetails: { cacheReadTokens: 2 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 3 },
    });
    assert.deepEqual(result?.accounting[0]?.cost, {
        kind: "charged",
        amount: { amount: "1230000", currency: "USDTICK" },
        usdEquivalent: "0.000123",
        source: "xAI response usage.cost_in_usd_ticks",
    });
});

test("Cerebras explicit reasoning activation needs no operator effort or token budget", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response([
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 1,
                model: "gemma-4-31b",
                choices: [{ index: 0, delta: { reasoning: "consider" }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 2,
                model: "gemma-4-31b",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 3,
                model: "gemma-4-31b",
                choices: [],
                usage: {
                    prompt_tokens: 2,
                    completion_tokens: 2,
                    total_tokens: 4,
                    completion_tokens_details: { reasoning_tokens: 1 },
                },
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });

    const provider = catalogProviderFromEnv("cerebras", {
        ...env,
        CEREBRAS_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "high",
    }, "gemma-4-31b");
    const result = await provider?.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(body?.reasoning_effort, "high", "the native SDK preserves the explicit durable effort");
    assert.equal("thinking_budget_tokens" in (body ?? {}), false, "activation does not invent a token budget");
    assert.equal(result?.assistant.reasoning, "consider");
    assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 1);
});

test("Meta Muse adaptive reasoning is requested even when the endpoint returns no readable trace", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response([
            `data: ${JSON.stringify({
                id: "chatcmpl-meta",
                object: "chat.completion.chunk",
                created: 1,
                model: "muse-spark-1.2-contributor",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-meta",
                object: "chat.completion.chunk",
                created: 2,
                model: "muse-spark-1.2-contributor",
                choices: [],
                usage: {
                    prompt_tokens: 2,
                    completion_tokens: 38,
                    total_tokens: 40,
                    completion_tokens_details: { reasoning_tokens: 37 },
                },
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });

    const provider = catalogProviderFromEnv("meta", {
        ...env,
        META_MODEL_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "muse-spark-1.2-contributor");
    const result = await provider?.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(body?.reasoning_effort, "xhigh");
    assert.equal(result?.assistant.reasoning, null);
    assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 37);
});

test("Google adaptive reasoning requests and preserves readable thought summaries", async () => {
    const bodies: Array<{
        generationConfig?: { thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number } };
    }> = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
        return new Response(`data: ${JSON.stringify({
            responseId: "response-gemini",
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        { text: "consider", thought: true },
                        { text: "done" },
                    ],
                },
                finishReason: "STOP",
            }],
            usageMetadata: {
                promptTokenCount: 2,
                candidatesTokenCount: 1,
                thoughtsTokenCount: 1,
                totalTokenCount: 4,
            },
        })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
        });
    });

    const provider = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "gemini-3.7-flash");
    const result = await provider?.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.deepEqual(bodies[0]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "high",
    }, "Gemini 3 adaptive selects its documented high/dynamic posture and readable summary");
    assert.equal(result?.assistant.reasoning, "consider");
    assert.equal(result?.assistant.content, "done");
    assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 1);

    assert.throws(
        () => catalogProviderFromEnv("google", {
            ...env,
            GEMINI_API_KEY: "test-key",
            PLURNK_PROVIDERS_REASONING: "off",
        }, "gemini-3.7-flash"),
        /reasoning policy 'off' is unsupported/,
        "Gemini 3's mandatory minimum thinking is not mislabeled as off",
    );

    const dynamic25 = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "gemini-2.5-flash");
    await dynamic25?.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "hello" }],
    });
    assert.deepEqual(bodies[1]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingBudget: -1,
    }, "Gemini 2.5 adaptive uses the provider's native dynamic budget sentinel");
});

test("native Anthropic adaptive policy uses adaptive thinking rather than a fixed high effort", async () => {
    let request: Record<string, unknown> | undefined;
    const languageModel = {
        specificationVersion: "v4",
        provider: "anthropic.messages",
        modelId: "claude-sonnet-4-6",
        supportedUrls: {},
        doGenerate: async (options: Record<string, unknown>) => {
            request = options;
            return {
                content: [{ type: "text", text: "ok" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
                response: { id: "response", modelId: "claude-sonnet-4-6" },
                warnings: [],
            };
        },
        doStream: async (options: Record<string, unknown>) => {
            request = options;
            return {
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ type: "response-metadata", id: "response", modelId: "claude-sonnet-4-6" });
                        controller.enqueue({ type: "text-start", id: "text-1" });
                        controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" });
                        controller.enqueue({ type: "text-end", id: "text-1" });
                        controller.enqueue({
                            type: "finish",
                            finishReason: { unified: "stop", raw: "stop" },
                            usage: {
                                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                                outputTokens: { total: 1, text: 1, reasoning: 0 },
                            },
                        });
                        controller.close();
                    },
                }),
                response: {},
            };
        },
    } as unknown as LanguageModel;
    const provider = providerFromSdkModel({
        name: "anthropic",
        env: {
            ...env,
            PLURNK_PROVIDERS_REASONING: "adaptive",
            PLURNK_PROVIDERS_STREAMING: "0",
        },
        model: "claude-sonnet-4-6",
        languageModel,
        sdkPackage: "@ai-sdk/anthropic",
        additiveReasoningProvider: "anthropic",
        contextWindow: 16_384,
        info: {
            name: "Claude Sonnet 4.6",
            contextWindow: 16_384,
            maxOutputTokens: 8_192,
            reasoning: true,
            reasoningOptions: [{ type: "toggle" }],
            attachment: true,
            toolCall: true,
            modalities: { input: ["text", "image"], output: ["text"] },
        },
    });
    await provider.generate({ workerId: "worker", messages: [{ role: "user", content: "hello" }] });
    assert.equal(request?.reasoning, "provider-default");
    assert.deepEqual(request?.providerOptions, {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
});

test("native provider routes project their documented cache controls through the actual SDK request", async (t) => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response([
            `data: ${JSON.stringify({
                id: "response",
                object: "chat.completion.chunk",
                created: 1,
                model: "served",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "response",
                object: "chat.completion.chunk",
                created: 2,
                model: "served",
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });

    await t.test("DeepInfra native options become prompt_cache_key", async () => {
        const provider = catalogProviderFromEnv("deepinfra", {
            ...env,
            DEEPINFRA_API_KEY: "test-key",
        }, "zai-org/GLM-5.2");
        await provider?.generate({
            workerId: "deepinfra-worker",
            messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(calls.at(-1)?.body.prompt_cache_key, "deepinfra-worker");
    });

    await t.test("OpenRouter carries session affinity and an Anthropic system breakpoint", async () => {
        let call: { headers: Headers; body: Record<string, unknown> } | undefined;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            call = {
                headers: new Headers(request.headers as Record<string, string>),
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end([
                `data: ${JSON.stringify({
                    id: "response",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "served",
                    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
                })}`,
                `data: ${JSON.stringify({
                    id: "response",
                    object: "chat.completion.chunk",
                    created: 2,
                    model: "served",
                    choices: [],
                    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                })}`,
                "data: [DONE]",
            ].join("\n\n"));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        }));
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("OpenRouter request-capture server did not bind a TCP address");
        }

        const provider = catalogProviderFromEnv("openrouter", {
            ...env,
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_HTTP_REFERER: "https://github.com/plurnk/plurnk-service",
            OPENROUTER_APP_TITLE: "Plurnk",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await provider?.generate({
            workerId: "openrouter-worker",
            messages: [
                { role: "system", content: "stable system packet" },
                { role: "user", content: "changing user packet" },
            ],
        });
        assert.equal(call?.headers.get("x-session-id"), "openrouter-worker");
        assert.equal(call?.headers.get("http-referer"), "https://github.com/plurnk/plurnk-service");
        assert.equal(call?.headers.get("x-openrouter-title"), "Plurnk");
        assert.deepEqual((call?.body.messages as unknown[] | undefined)?.[0], {
            role: "system",
            content: [{
                type: "text",
                text: "stable system packet",
                cache_control: { type: "ephemeral" },
            }],
        });
        assert.deepEqual((call?.body.messages as unknown[] | undefined)?.[1], {
            role: "user",
            content: "changing user packet",
        });
    });

    await t.test("{§provider-reasoning-policy} a resolved reasoning budget reaches the OpenRouter wire as max_tokens", async () => {
        let call: { body: Record<string, unknown> } | undefined;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            call = { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end([
                `data: ${JSON.stringify({
                    id: "response",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "served",
                    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
                })}`,
                "data: [DONE]",
            ].join("\n\n"));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        }));
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("OpenRouter budget-capture server did not bind a TCP address");
        }
        const budgetEnv = {
            ...env,
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_HTTP_REFERER: "https://github.com/plurnk/plurnk-service",
            OPENROUTER_APP_TITLE: "Plurnk",
            PLURNK_PROVIDERS_REASONING_BUDGET: "2048",
        };
        const adaptive = catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_REASONING: "adaptive",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await adaptive?.generate({
            workerId: "openrouter-budget",
            messages: [{ role: "user", content: "budgeted" }],
        });
        assert.deepEqual(call?.body.reasoning, { max_tokens: 2048 });
        const fixed = catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_REASONING: "low",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await fixed?.generate({
            workerId: "openrouter-budget",
            messages: [{ role: "user", content: "budgeted" }],
        });
        assert.deepEqual(call?.body.reasoning, { effort: "low" }, "a fixed policy keeps the effort form");
    });
});

test("cataloged unknown model fails unless its context is explicit", () => {
    assert.throws(
        () => catalogProviderFromEnv("xai", env, "not-in-the-catalog"),
        /context window unresolved/,
    );
    const provider = catalogProviderFromEnv("xai", {
        ...env,
        XAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "not-in-the-catalog");
    assert.equal(provider?.contextWindow, 8192);
    assert.deepEqual(provider?.supportedReasoningPolicies, ["off", "adaptive"]);
});

test("Models.dev is the only fallback rate table", async () => {
    mock.method(globalThis, "fetch", async () => new Response([
        `data: ${JSON.stringify({
            id: "response",
            model: "served",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}`,
        `data: ${JSON.stringify({
            id: "response",
            model: "served",
            choices: [],
            usage: {
                prompt_tokens: 1_000,
                prompt_tokens_details: { cached_tokens: 400 },
                completion_tokens: 100,
                total_tokens: 1_150,
            },
        })}`,
        "data: [DONE]",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const cataloged = catalogProviderFromEnv("deepseek", {
        ...env,
        DEEPSEEK_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort",
    }, "deepseek-v4-flash");
    assert.notEqual(cataloged, null);
    const catalogedResponse = await cataloged!.generate({ workerId: "cataloged", messages: [] });
    assert.deepEqual(catalogedResponse.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: "0.00012712", currency: "USD" },
        source: "Models.dev catalog rates",
    });

    const uncataloged = catalogProviderFromEnv("xai", {
        ...env,
        XAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_REASONING: "adaptive",
    }, "not-in-the-catalog");
    const uncatalogedResponse = await uncataloged!.generate({ workerId: "uncataloged", messages: [] });
    assert.deepEqual(uncatalogedResponse.accounting[0]?.cost, {
        kind: "unknown",
        reason: "Models.dev has no complete rate for this model",
    });
});

test("{§operator-cost-override} declared rates overlay the catalog and the source names the override", async () => {
    mock.method(globalThis, "fetch", async () => new Response([
        `data: ${JSON.stringify({
            id: "response",
            model: "served",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}`,
        `data: ${JSON.stringify({
            id: "response",
            model: "served",
            choices: [],
            usage: {
                prompt_tokens: 1_000,
                prompt_tokens_details: { cached_tokens: 400 },
                completion_tokens: 100,
                total_tokens: 1_150,
            },
        })}`,
        "data: [DONE]",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const overridden = catalogProviderFromEnv("deepseek", {
        ...env,
        DEEPSEEK_API_KEY: "test-key",
        PLURNK_PROVIDERS_REASONING: "adaptive",
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_REASONING_STYLE: "thinking_effort",
        PLURNK_PROVIDERS_COST: "input=0.22,output=0.66,cacheRead=0.007",
    }, "deepseek-v4-flash");
    const response = await overridden!.generate({ workerId: "overridden", messages: [] });
    assert.deepEqual(response.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: "0.0002148", currency: "USD" },
        source: "operator PLURNK_PROVIDERS_COST override over Models.dev catalog rates",
    });
    mock.restoreAll();
});
