import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createOpenAI, createProviderModel } from "./modelAdapters.ts";
import { catalogProviderFromEnv, catalogEfforts, providerFromModelAdapter } from "./catalogProvider.ts";
import { catalogSnapshot, lookupProvider, resolveModel } from "@plurnk/plurnk-models";
import { calculateCostUsdDecimal } from "./usage.ts";
import { withProviderDefaults } from "./defaults.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { UnsupportedEffortError, type ModelTransport, type ModelTransportCallOptions, type ModelTransportResult } from "./types.ts";
import { requestBody, requestUrl } from "../../scripts/lib/test-fetch.ts";
import { executeModelTransport, executeOpenAICompatible } from "./modelTransport.ts";
import { withoutNativeTools } from "./native-tools.ts";
import { ollamaProviderFromEnv } from "./ollama.ts";

// A rate literal breaks at every catalog refresh (the 1.17.0 stamp moved DeepSeek's rates); the
// claim under test is that the estimate is the catalog's rates applied to the reported usage.
// {§provider-effort} — witnesses derive a route's effort vocabulary from the catalog it
// ships with, so they pin the mechanism (catalog → policies) and never one snapshot's data (#796).
const catalogEffortsOf = (provider: string, model: string): readonly string[] =>
    resolveModel(provider, model)?.info.reasoningOptions?.filter((option) => option.type === "effort").flatMap((option) => option.values).flatMap((effort) => effort === null ? [] : [effort]) ?? [];
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const policiesOver = (efforts: Iterable<string>, off = false): string[] => {
    const set = new Set(efforts);
    return [...(off ? ["off"] : []), "adaptive", ...EFFORT_ORDER.filter((effort) => effort !== "minimal" && set.has(effort))];
};
const fallbackOf = (efforts: Iterable<string>): string | undefined => {
    const set = new Set(efforts);
    return set.has("high") ? "high" : undefined;
};
const catalogRatesOf = (provider: string, model: string) => {
    const cost = resolveModel(provider, model)?.info.cost;
    if (cost === undefined) throw new Error(`${provider}/${model} has no catalog rates`);
    return {
        input: cost.inputPer1M,
        output: cost.outputPer1M,
        ...(cost.reasoningPer1M === undefined ? {} : { reasoning: cost.reasoningPer1M }),
        ...(cost.cacheReadPer1M === undefined ? {} : { cacheRead: cost.cacheReadPer1M }),
        ...(cost.cacheWritePer1M === undefined ? {} : { cacheWrite: cost.cacheWritePer1M }),
    };
};





const env = withProviderDefaults({
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_EFFORT: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
    PLURNK_PROVIDERS_OUTPUT_FLOOR: "10%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
    PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
});

test.afterEach(() => {
    mock.restoreAll();
    resetEmittedWarnings();
});

test("{§provider-effort} catalog provider resolves model physics and Models.dev USD rates", () => {
    const provider = catalogProviderFromEnv("openai", env, "gpt-4.1-mini");
    assert.notEqual(provider, null);
    assert.equal(provider?.model, "gpt-4.1-mini");
    assert.equal(provider?.contextWindow, 1_047_576);
    assert.equal(provider?.maxInputTokens, null);
    assert.equal(provider?.maxOutputTokens, 32_768);
    assert.equal(provider?.outputBudget, 32_768);
    assert.equal(provider?.reasoningBudget, null);
    assert.deepEqual(provider?.supportedEfforts, ["off", "adaptive"]);
});

test("{§provider-effort} (#472) an effort refusal names the operator's declaration lever with the exact key", () => {
    assert.throws(
        () => catalogProviderFromEnv("fireworks-ai", withProviderDefaults({
            ...env,
            FIREWORKS_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: "medium",
        }), "accounts/fireworks/models/glm-5p3-flash"),
        /declare it: PLURNK_PROVIDERS_PROVIDER_FIREWORKS_AI_REASONING_EFFORTS=medium/,
        "the refusal is actionable: it names the exact env declaration",
    );
    // And the lever works: the same route with the declaration constructs.
    const declared = catalogProviderFromEnv("fireworks-ai", withProviderDefaults({
        ...env,
        FIREWORKS_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "medium",
        PLURNK_PROVIDERS_PROVIDER_FIREWORKS_AI_REASONING_EFFORTS: "low,medium,high,max",
    }), "accounts/fireworks/models/glm-5p3-flash");
    assert.ok(declared, "the declared effort admits the route");
    assert.ok(declared.supportedEfforts.includes("medium"), "medium is admitted through the operator's declaration");
});

test("{§provider-effort} provider adapters advertise only efforts they can preserve", () => {
    const deepseek = catalogProviderFromEnv("deepseek", {
        ...env,
        DEEPSEEK_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "deepseek-v4-flash");
    assert.deepEqual(deepseek?.supportedEfforts, ["off", "adaptive", "low", "high", "max"]);

    assert.throws(
        () => catalogProviderFromEnv("deepseek", {
            ...env,
            DEEPSEEK_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: "medium",
        }, "deepseek-v4-flash"),
        /effort 'medium' is unsupported; supported efforts: off, adaptive, low, high/,
    );

    const mistral = catalogProviderFromEnv("mistral", {
        ...env,
        MISTRAL_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "mistral-small-latest");
    assert.deepEqual(mistral?.supportedEfforts, ["off", "adaptive", "high"], "Mistral's low/medium coercion is not advertised as exact support");


    const gemini = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "gemini-flash-latest");
    assert.deepEqual(gemini?.supportedEfforts, ["adaptive", "low", "medium", "high"], "Gemini 3's mandatory minimum is not advertised as off");
});

test("{§provider-effort}: catalog discovery and construction agree on native and compatible routes", () => {
    const fetch = mock.method(globalThis, "fetch", () => {
        throw new Error("capability discovery and construction require no provider request");
    });
    const configured = withProviderDefaults({
        ...env,
        DEEPSEEK_API_KEY: "test-key",
        GEMINI_API_KEY: "test-key",
        MISTRAL_API_KEY: "test-key",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    });
    for (const [name, model] of [
        ["openai", "gpt-4.1-mini"],
        ["google", "gemini-flash-latest"],
        ["mistral", "mistral-small-latest"],
        ["deepseek", "deepseek-v4-flash"],
        ["cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b"],
        ["cloudflare-workers-ai", "@cf/ibm-granite/granite-4.0-h-micro"],
        ["cloudflare-workers-ai", "@cf/zai-org/glm-5.3-flash"],
    ]) {
        const providerInfo = lookupProvider(name);
        const info = resolveModel(name, model)?.info;
        assert.ok(providerInfo);
        assert.ok(info);
        for (const declaration of ["", "medium,high,max"]) {
            const key = `PLURNK_PROVIDERS_PROVIDER_${name.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_REASONING_EFFORTS`;
            const localEnv = { ...configured, [key]: declaration };
            const provider = catalogProviderFromEnv(name, localEnv, model);
            assert.ok(provider);
            assert.deepEqual(
                catalogEfforts(providerInfo, info, localEnv),
                provider.supportedEfforts,
                `${name}/${model} with declared efforts ${JSON.stringify(declaration)}`,
            );
            assert.deepEqual(
                catalogEfforts(providerInfo, info, { [key]: declaration }),
                provider.supportedEfforts,
                `${name}/${model}: discovery applies the same installed floor without credentials or operational knobs`,
            );
        }
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("{§provider-effort}: discovery never offers a fixed effort the installed transport rejects", () => {
    const info = resolveModel("deepseek", "deepseek-v4-flash")?.info;
    assert.ok(info);
    const declared = withProviderDefaults({
        ...env,
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        PLURNK_PROVIDERS_PROVIDER_OPENAI_REASONING_EFFORTS: "medium,xhigh",
    });
    const catalog = lookupProvider("openai");
    assert.ok(catalog);
    assert.deepEqual(catalogEfforts(catalog, info, declared), ["off", "adaptive", "low", "medium", "high", "xhigh"]);
    assert.throws(() => providerFromModelAdapter({
        name: "openai", model: "fixture", contextWindow: 32_768, info,
        env: { ...declared, PLURNK_PROVIDERS_EFFORT: "max" },
        modelTransport: { provider: "openai", modelId: "fixture", execute: async () => { throw new Error("unreachable"); } },
    }), UnsupportedEffortError);
});

test("{§provider-effort} Models.dev controls Cloudflare's exact effort vocabulary", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
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
    };
    const low = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_EFFORT: "low",
    }, "@cf/qwen/qwen3.8-27b");
    assert.deepEqual(low?.supportedEfforts, policiesOver(catalogEffortsOf("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b")));
    await low?.generate({ sessionId: "cloudflare-low", messages: [{ role: "user", content: "hello" }] });

    const adaptive = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "@cf/qwen/qwen3.8-27b");
    await adaptive?.generate({ sessionId: "cloudflare-adaptive", messages: [{ role: "user", content: "hello" }] });

    const nonReasoning = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "@cf/ibm-granite/granite-4.0-h-micro");
    assert.deepEqual(nonReasoning?.supportedEfforts, ["off", "adaptive"]);
    await nonReasoning?.generate({ sessionId: "cloudflare-granite", messages: [{ role: "user", content: "hello" }] });

    const ungradedReasoner = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...cloudflareEnv,
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "@cf/zai-org/glm-5.3-flash");
    assert.deepEqual(ungradedReasoner?.supportedEfforts, policiesOver(catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-5.3-flash")), "the catalog's vocabulary, exactly");
    await ungradedReasoner?.generate({ sessionId: "cloudflare-ungraded", messages: [{ role: "user", content: "hello" }] });

    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["low", undefined, undefined, fallbackOf(catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-5.3-flash"))], "adaptive selects high only when supported; it does not escalate to xhigh");
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", cloudflareEnv, "@cf/qwen/qwen3.8-27b"),
        /effort 'off' is unsupported; supported efforts: adaptive, low, medium/,
    );
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", {
            ...cloudflareEnv,
            PLURNK_PROVIDERS_EFFORT: "high",
        }, "@cf/qwen/qwen3.8-27b"),
        /effort 'high' is unsupported; supported efforts: adaptive, low, medium/,
    );
});

test("{§provider-effort} an operator-declared effort vocabulary extends Models.dev's for a provider's reasoning routes (#439)", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
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
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "low, medium,high",
    };
    // Models.dev lists this route as reasoning with no effort vocabulary; the declaration supplies one.
    const low = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_EFFORT: "low" }, "@cf/zai-org/glm-5.3-flash");
    assert.deepEqual(low?.supportedEfforts, policiesOver([...catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-5.3-flash"), "low", "medium", "high"]), "the declaration joins the catalog's vocabulary");
    await low?.generate({ sessionId: "declared-low", messages: [{ role: "user", content: "hello" }] });
    const adaptive = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_EFFORT: "adaptive" }, "@cf/zai-org/glm-5.3-flash");
    await adaptive?.generate({ sessionId: "declared-adaptive", messages: [{ role: "user", content: "hello" }] });
    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["low", "high"], "a fixed level keeps its name; declared high admits the configured fallback");
    // A declared `none` admits `off` on an effort transport; the catalog's own vocabulary stays in the union.
    const withOff = catalogProviderFromEnv("cloudflare-workers-ai", {
        ...declaredEnv,
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "none,high",
    }, "@cf/qwen/qwen3.8-27b");
    assert.deepEqual(withOff?.supportedEfforts, policiesOver([...catalogEffortsOf("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b"), "high"], true));
    // The declaration never turns a non-reasoning route into a reasoning one.
    const nonReasoning = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_EFFORT: "adaptive" }, "@cf/ibm-granite/granite-4.0-h-micro");
    assert.deepEqual(nonReasoning?.supportedEfforts, ["off", "adaptive"]);
    assert.throws(
        () => catalogProviderFromEnv("cloudflare-workers-ai", {
            ...declaredEnv,
            PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS: "low,turbo",
        }, "@cf/zai-org/glm-5.3-flash"),
        /PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS has invalid value "turbo"; declarable efforts: none, minimal, low, medium, high, xhigh, max/,
    );
});

test("{§provider-effort} an operator context window caps catalog physics and percentage output policy", () => {
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

test("{§provider-effort} native OpenAI adapter owns the request while PLURNK owns call settings", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: requestUrl(input),
            body: JSON.parse(requestBody(init)) as Record<string, unknown>,
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
        sessionId: "session",
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
    assert.equal(calls[0]?.body.prompt_cache_key, "session", "the OpenAI adapter projects the documented affinity key");
});

test("{§provider-effort} Cerebras explicit and adaptive reasoning do not invent a token budget", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        return new Response([
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 1,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, delta: { reasoning: "consider" }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 2,
                model: "qwen-3.8-27b",
                choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
            })}`,
            `data: ${JSON.stringify({
                id: "chatcmpl-cerebras",
                object: "chat.completion.chunk",
                created: 3,
                model: "qwen-3.8-27b",
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

    for (const policy of ["high", "adaptive"] as const) {
        const provider = catalogProviderFromEnv("cerebras", {
            ...env,
            CEREBRAS_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: policy,
        }, "qwen-3.8-27b");
        const result = await provider?.generate({
            sessionId: "session",
            messages: [{ role: "user", content: "hello" }],
        });

        assert.equal(body?.reasoning_effort, "high", `${policy} reaches the native SDK as high`);
        assert.equal("thinking_budget_tokens" in (body ?? {}), false, "activation does not invent a token budget");
        assert.equal(result?.assistant.reasoning, "consider");
        assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 1);
    }
});

test("{§provider-effort} Meta Muse adaptive reasoning is requested even when the endpoint returns no readable trace", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(requestBody(init)) as Record<string, unknown>;
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
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "muse-spark-1.2-contributor");
    const result = await provider?.generate({
        sessionId: "session",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(body?.reasoning_effort, "high");
    assert.equal(result?.assistant.reasoning, null);
    assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 37);
});

test("{§provider-effort} native graded requests use only the supported configured fallback", async () => {
    let body: Record<string, unknown> | undefined;
    const sdk = createOpenAI({
        apiKey: "test-key",
        fetch: async (_input, init) => {
            body = JSON.parse(requestBody(init));
            return new Response(`data: ${JSON.stringify({
                id: "fallback", object: "chat.completion.chunk", created: 1, model: "o3",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    for (const [efforts, fallback, expected] of [
        [["low", "medium", "high", "xhigh", "max"], "high", "high"],
        [["low", "medium", "xhigh"], "high", undefined],
        [["low", "medium", "high", "xhigh"], "medium", "medium"],
        [["high", "max"], "max", undefined],
        [["high", "xhigh"], "", undefined],
    ] as const) {
        const provider = providerFromModelAdapter({
            name: "openai", model: "o3", modelTransport: sdk.chat("o3"),
            contextWindow: 16_384,
            env: {
                ...env,
                PLURNK_PROVIDERS_EFFORT: "adaptive",
                PLURNK_PROVIDERS_EFFORT_FALLBACK: fallback,
            },
            info: {
                name: "reasoning fixture", contextWindow: 16_384, maxOutputTokens: 8_192,
                reasoning: true, reasoningOptions: [{ type: "effort", values: [...efforts] }],
                attachment: false, toolCall: false, modalities: { input: ["text"], output: ["text"] },
            },
        });
        const result = await provider.generate({ sessionId: "fallback", messages: [{ role: "user", content: "hello" }] });
        assert.equal(result.assistant.content, "ok");
        assert.equal(body?.reasoning_effort, expected, `${fallback || "provider default"} with ${efforts.join(",")}`);
    }
});

test("{§provider-effort} Google adaptive reasoning requests and preserves readable thought summaries", async () => {
    const bodies: Array<{
        generationConfig?: { thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number } };
    }> = [];
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as typeof bodies[number]);
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
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "gemini-flash-latest");
    const result = await provider?.generate({
        sessionId: "session",
        messages: [{ role: "user", content: "hello" }],
    });

    assert.deepEqual(bodies[0]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "high",
    }, "Gemini adaptive selects its documented high posture and readable summary");
    assert.equal(result?.assistant.reasoning, "consider");
    assert.equal(result?.assistant.content, "done");
    assert.equal(result?.accounting[0]?.usage?.outputTokenDetails?.reasoningTokens, 1);

    assert.throws(
        () => catalogProviderFromEnv("google", {
            ...env,
            GEMINI_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: "off",
        }, "gemini-flash-latest"),
        /effort 'off' is unsupported/,
        "Gemini's mandatory minimum reasoning is not mislabeled as off",
    );
});

test("{§provider-effort} native Anthropic adaptive policy uses adaptive thinking rather than a fixed high effort", async () => {
    let request: ModelTransportCallOptions | undefined;
    const modelTransport: ModelTransport = {
        provider: "anthropic.messages",
        modelId: "claude-sonnet-4-6",
        execute: async (options) => {
            request = options;
            return {
                content: "ok",
                reasoning: "",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    totalTokens: 2,
                    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
                },
                rawChunks: [],
                response: { id: "response", modelId: "claude-sonnet-4-6" },
                warnings: [],
            };
        },
    };
    const provider = providerFromModelAdapter({
        name: "anthropic",
        env: {
            ...env,
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_STREAMING: "0",
        },
        model: "claude-sonnet-4-6",
        modelTransport,
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
    await provider.generate({ sessionId: "session", messages: [{ role: "user", content: "hello" }] });
    assert.equal(request?.reasoning, "provider-default");
    assert.deepEqual(request?.providerOptions, {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
});

test("{§provider-effort} native provider routes project their documented cache controls through the actual SDK request", async (t) => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: requestUrl(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(requestBody(init)) as Record<string, unknown>,
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

    await t.test("{§provider-sdk-boundary} DeepInfra native options become prompt_cache_key", async () => {
        const provider = catalogProviderFromEnv("deepinfra", {
            ...env,
            DEEPINFRA_API_KEY: "test-key",
        }, "zai-org/GLM-5.2");
        await provider?.generate({
            sessionId: "deepinfra-session",
            messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(calls.at(-1)?.body.prompt_cache_key, "deepinfra-session");
    });

    await t.test("{§provider-sdk-boundary} OpenRouter carries session affinity and an Anthropic system breakpoint", async () => {
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
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL: "https://github.com/plurnk/plurnk-service",
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_NAME: "Plurnk",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await provider?.generate({
            sessionId: "openrouter-session",
            messages: [
                { role: "system", content: "stable system packet" },
                { role: "user", content: "changing user packet" },
            ],
        });
        assert.equal(call?.headers.get("x-session-id"), "openrouter-session");
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

    await t.test("{§provider-effort} a resolved reasoning budget reaches the OpenRouter wire as max_tokens", async () => {
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
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL: "https://github.com/plurnk/plurnk-service",
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_NAME: "Plurnk",
            PLURNK_PROVIDERS_REASONING_BUDGET: "2048",
        };
        const adaptive = catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await adaptive?.generate({
            sessionId: "openrouter-budget",
            messages: [{ role: "user", content: "budgeted" }],
        });
        assert.deepEqual(call?.body.reasoning, { enabled: true, max_tokens: 2048 });
        await adaptive?.generate({
            sessionId: "openrouter-budget",
            messages: [{ role: "user", content: "tighter" }],
            maxOutputTokens: 1500,
        });
        assert.equal(call?.body.max_tokens, 1500);
        assert.deepEqual(call?.body.reasoning, { enabled: true, max_tokens: 1499 }, "the actual request keeps reasoning inside a tightened total envelope");
        assert.throws(() => catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_EFFORT: "low",
        }, "anthropic/claude-sonnet-4.6"), /reasoning effort and budget are exclusive/);
        const fixed = catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_REASONING_BUDGET: "",
            PLURNK_PROVIDERS_EFFORT: "low",
        }, "anthropic/claude-sonnet-4.6", `http://127.0.0.1:${address.port}/api/v1`);
        await fixed?.generate({
            sessionId: "openrouter-budget",
            messages: [{ role: "user", content: "budgeted" }],
        });
        assert.deepEqual(call?.body.reasoning, { enabled: true, effort: "low" }, "a fixed policy keeps the effort form");
        const fallback = catalogProviderFromEnv("openrouter", {
            ...budgetEnv,
            PLURNK_PROVIDERS_REASONING_BUDGET: "",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }, "z-ai/glm-5.3-flash", `http://127.0.0.1:${address.port}/api/v1`);
        await fallback?.generate({
            sessionId: "openrouter-fallback",
            messages: [{ role: "user", content: "hello" }],
        });
        assert.deepEqual(call?.body.reasoning, { enabled: true, effort: "high" }, "activation does not mask the adaptive effort fallback");
    });
});

test("{§provider-effort} an uncataloged model names the ids whose final segment begins with it", () => {
    assert.throws(
        () => catalogProviderFromEnv("fireworks-ai", env, "deepseek-flash"),
        (error: Error) => error.message.includes('model "deepseek-flash" is not a Models.dev id or a unique path suffix of one; candidates: ')
            && error.message.includes("accounts/fireworks/routers/deepseek-flash-latest"),
    );
});

test("{§provider-effort} cataloged unknown model fails unless its context is explicit", () => {
    assert.throws(
        () => catalogProviderFromEnv("groq", env, "not-in-the-catalog"),
        /^Error: groq provider: model "not-in-the-catalog" is not a Models\.dev id or a unique path suffix of one — correct the model id, or set PLURNK_PROVIDERS_CONTEXT_WINDOW to route an uncataloged model$/,
    );
    const provider = catalogProviderFromEnv("groq", {
        ...env,
        GROQ_API_KEY: "test-key",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "not-in-the-catalog");
    assert.equal(provider?.contextWindow, 8192);
    assert.deepEqual(provider?.supportedEfforts, ["off", "adaptive"]);
});

test("{§provider-monetary-evidence} Models.dev is the only fallback rate table", async () => {
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
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "deepseek-v4-flash");
    assert.notEqual(cataloged, null);
    const catalogedResponse = await cataloged!.generate({ sessionId: "cataloged", messages: [] });
    const catalogAmount = calculateCostUsdDecimal(catalogedResponse.accounting[0].usage!, catalogRatesOf("deepseek", "deepseek-v4-flash"));
    assert.match(String(catalogAmount), /^0\.0*[1-9]/, "the catalog prices this usage");
    assert.deepEqual(catalogedResponse.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: catalogAmount, currency: "USD" },
        source: "Models.dev catalog rates",
    });

    const uncataloged = catalogProviderFromEnv("groq", {
        ...env,
        GROQ_API_KEY: "test-key",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "not-in-the-catalog");
    const uncatalogedResponse = await uncataloged!.generate({ sessionId: "uncataloged", messages: [] });
    assert.deepEqual(uncatalogedResponse.accounting[0]?.cost, {
        kind: "unknown",
        reason: "Models.dev has no complete rate for this model",
    });
});

test("{§provider-effort} #856: catalog implicit-cache pricing composes SDK usage without an operator rate override", async () => {
    mock.method(globalThis, "fetch", async () => new Response([
        `data: ${JSON.stringify({
            id: "response", model: "glm-5.3-flash",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            usage: {
                prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
                prompt_tokens_details: { cached_tokens: 400 },
            },
        })}`,
        "data: [DONE]",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    const info = lookupProvider("zai")!;
    const provider = catalogProviderFromEnv("zai", {
        ...env, ...Object.fromEntries(info.env.map((name) => [name, "test-key"])),
        PLURNK_PROVIDERS_EFFORT: "adaptive",
    }, "glm-5.3-flash");
    assert.ok(provider);
    const response = await provider.generate({ sessionId: "implicit-cache", messages: [] });
    const usage = response.accounting[0]?.usage;
    assert.deepEqual(usage?.inputTokenDetails, { noCacheTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 0 });
    assert.equal(response.accounting.length, 1);
    const amount = calculateCostUsdDecimal(usage, catalogRatesOf("zai", "glm-5.3-flash"));
    assert.notEqual(amount, null, "the catalog rate is applicable without inventing a cache-write count");
    assert.deepEqual(response.accounting[0]?.cost, {
        kind: "estimated", amount: { amount, currency: "USD" }, source: "Models.dev catalog rates",
    });
});

test("{§provider-monetary-evidence} declared rates overlay the catalog and the source names the override", async () => {
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
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        PLURNK_PROVIDERS_COST: "input=0.22,output=0.66,cacheRead=0.007",
    }, "deepseek-v4-flash");
    const response = await overridden!.generate({ sessionId: "overridden", messages: [] });
    const overriddenAmount = calculateCostUsdDecimal(response.accounting[0].usage!, { ...catalogRatesOf("deepseek", "deepseek-v4-flash"), input: 0.22, output: 0.66, cacheRead: 0.007 });
    assert.notEqual(overriddenAmount, calculateCostUsdDecimal(response.accounting[0].usage!, catalogRatesOf("deepseek", "deepseek-v4-flash")), "the override changes the price");
    assert.deepEqual(response.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: overriddenAmount, currency: "USD" },
        source: "operator PLURNK_PROVIDERS_COST override over Models.dev catalog rates",
    });
    mock.restoreAll();
});

test("{§provider-effort} (#458) declared efforts union into the supported set under the models.dev-id prefix", () => {
    const provider = catalogProviderFromEnv("fireworks-ai", {
        ...env,
        FIREWORKS_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        PLURNK_PROVIDERS_PROVIDER_FIREWORKS_AI_REASONING_EFFORTS: "low,high,max",
    }, "accounts/fireworks/models/glm-5p3-flash");
    // (#474) "max" joined the portable vocabulary; "off" still requires a declared "none".
    assert.deepEqual(provider?.supportedEfforts, ["adaptive", "low", "high", "max"]);
});

for (const name of ["deepinfra", "togetherai"]) {
    test(`{§provider-effort} ${name}: the catalog's strongest effort, and off, reach the wire as reasoning_effort`, async (t) => {
        const routes = Object.entries(catalogSnapshot()[name] ?? {})
            .map(([model, info]) => ({
                model,
                efforts: catalogEffortsOf(name, model),
                off: info.reasoningOptions?.some((option) => option.type === "toggle" || option.type === "effort" && option.values.includes("none")) === true,
            }))
            .filter(({ efforts, off }) => efforts.length > 0 && off);
        assert.ok(routes.length > 0, `the ${name} catalog documents no reasoning effort to witness`);
        const { model, efforts } = routes.find((route) => route.efforts.includes("max")) ?? routes[0];
        const effort = EFFORT_ORDER.findLast((value) => efforts.includes(value))!;
        const bodies: Record<string, unknown>[] = [];
        mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
            const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
            bodies.push(body);
            const chunk = { id: "x", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        });
        t.after(() => mock.restoreAll());
        const credential = lookupProvider(name)!.env[0];
        for (const [policy, wire] of [[effort, effort], ["off", "none"]] as const) {
            const provider = catalogProviderFromEnv(name, withProviderDefaults({ [credential]: "test-key", PLURNK_PROVIDERS_EFFORT: policy }), model)!;
            await provider.generate({ sessionId: "wire", messages: [{ role: "user", content: "hi" }] });
            assert.equal(bodies.at(-1)?.reasoning_effort, wire);
        }
    });
}

test("{§provider-request-authority} attribution is the provider's declaration: openrouter sends it, another OpenRouter-SDK provider does not", async (t) => {
    const seen = new Map<string, Headers>();
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        seen.set(new URL(url).host, new Headers(init.headers));
        const chunk = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    t.after(() => mock.restoreAll());
    for (const name of ["openrouter", "standardcompute"]) {
        const model = Object.keys(catalogSnapshot()[name] ?? {})[0];
        const providerEnv = withProviderDefaults({ [lookupProvider(name)!.env[0]]: "test-key" });
        await catalogProviderFromEnv(name, providerEnv, model)!.generate({ sessionId: "w", messages: [{ role: "user", content: "hi" }] });
    }
    const [openrouter, other] = [...seen.values()];
    assert.equal(openrouter?.get("http-referer"), "https://github.com/plurnk/plurnk-service");
    assert.equal(openrouter?.get("x-openrouter-title"), "Plurnk");
    assert.equal(other?.get("http-referer"), null);
    assert.equal(other?.get("x-openrouter-title"), null);
});

test("{§provider-effort} alibaba: DashScope's inclusive cap, effort, budget and switch reach the wire from the provider adapter", async (t) => {
    const route = Object.keys(catalogSnapshot().alibaba ?? {}).find((model) => catalogEffortsOf("alibaba", model).length > 0
        && resolveModel("alibaba", model)?.info.reasoningOptions?.some((option) => option.type === "budget_tokens"));
    assert.ok(route !== undefined, "the alibaba catalog documents no effort-and-budget route to witness");
    const effort = EFFORT_ORDER.findLast((value) => catalogEffortsOf("alibaba", route).includes(value))!;
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
        return new Response(JSON.stringify({ error: "captured" }), { status: 400 });
    });
    t.after(() => mock.restoreAll());
    for (const reasoning of [{ PLURNK_PROVIDERS_EFFORT: effort }, { PLURNK_PROVIDERS_EFFORT: "adaptive", PLURNK_PROVIDERS_REASONING_BUDGET: "2048" }, { PLURNK_PROVIDERS_EFFORT: "off" }]) {
        await catalogProviderFromEnv("alibaba", withProviderDefaults({ DASHSCOPE_API_KEY: "test-key", ...reasoning }), route)!
            .generate({ sessionId: "w", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 4096 }).catch(() => {});
    }
    const pick = (body: Record<string, unknown>) => ({ max_completion_tokens: body.max_completion_tokens, max_tokens: body.max_tokens, reasoning_effort: body.reasoning_effort, thinking_budget: body.thinking_budget, enable_thinking: body.enable_thinking });
    assert.deepEqual(bodies.map(pick), [
        { max_completion_tokens: 4096, max_tokens: undefined, reasoning_effort: effort, thinking_budget: undefined, enable_thinking: true },
        { max_completion_tokens: 4096, max_tokens: undefined, reasoning_effort: undefined, thinking_budget: 2048, enable_thinking: true },
        { max_completion_tokens: 4096, max_tokens: undefined, reasoning_effort: undefined, thinking_budget: undefined, enable_thinking: false },
    ]);
});

// {§provider-monetary-evidence} Recorded native Z.ai usage (#853 zai sweep, run137 turns 1 and 3).
for (const [name, usage, expected] of [
    ["uncached turn", { prompt_tokens: 4118, completion_tokens: 89, total_tokens: 4207, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } }, "0.0006622"],
    ["implicit-cache turn", { prompt_tokens: 6359, completion_tokens: 7188, total_tokens: 13547, prompt_tokens_details: { cached_tokens: 1216 }, completion_tokens_details: { reasoning_tokens: 6191 } }, "0.00440193"],
] as const) {
    test(`{§provider-monetary-evidence} Z.ai glm-5.3-flash ${name} resolves to an exact catalog estimate, never unknown`, async () => {
        mock.method(globalThis, "fetch", async () => new Response([
            `data: ${JSON.stringify({ id: "zai", model: "glm-5.3-flash", choices: [{ index: 0, delta: { reasoning_content: "Read the widgets module." }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ id: "zai", model: "glm-5.3-flash", choices: [{ index: 0, delta: { content: "```READ (django/forms/widgets.py) /class Media/\n```" }, finish_reason: "stop" }], usage })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
        const info = lookupProvider("zai")!;
        const provider = catalogProviderFromEnv("zai", {
            ...env, ...Object.fromEntries(info.env.map((key) => [key, "test-key"])),
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }, "glm-5.3-flash");
        assert.ok(provider);
        const response = await provider.generate({ sessionId: "zai-cost", messages: [] });
        // ((input − cached) × 0.15 + cached × 0.03 + output × 0.50) / 1e6 at the Models.dev zai rates.
        assert.deepEqual(response.accounting[0]?.cost, {
            kind: "estimated", amount: { amount: expected, currency: "USD" }, source: "Models.dev catalog rates",
        });
        mock.restoreAll();
    });
}

{
class MockModelTransport implements ModelTransport {
    readonly provider = "mock.v4";
    readonly modelId = "mock-model";
    readonly executeCalls: ModelTransportCallOptions[] = [];
    readonly #executeImpl: (options: ModelTransportCallOptions) => Promise<ModelTransportResult>;

    constructor({
        execute,
    }: {
        execute: (options: ModelTransportCallOptions) => Promise<ModelTransportResult>;
    }) {
        this.#executeImpl = execute;
    }

    async execute(options: ModelTransportCallOptions): Promise<ModelTransportResult> {
        this.executeCalls.push(options);
        return this.#executeImpl(options);
    }
}





type Protocol = "chat" | "responses" | "messages" | "generate-content";

const response = (protocol: Protocol, streaming: boolean): Response => {
    const message = {
        id: "reply", type: "message", role: "assistant", model: "fixture",
        content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
    };
    const completed = {
        id: "reply", object: "response", created_at: 1, model: "fixture", status: "completed",
        output: [{ id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        incomplete_details: null,
    };
    const google = {
        responseId: "reply", modelVersion: "fixture",
        candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    };
    const chat = {
        id: "reply", object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    if (!streaming) {
        return Response.json({ chat, responses: completed, messages: message, "generate-content": google }[protocol]);
    }
    const chunks = {
        chat: [{ ...chat, choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }] }],
        responses: [
            { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...completed.output[0], content: [] } },
            { type: "response.content_part.added", item_id: "message", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", item_id: "message", output_index: 0, content_index: 0, delta: "answer" },
            { type: "response.output_text.done", item_id: "message", output_index: 0, content_index: 0, text: "answer" },
            { type: "response.output_item.done", output_index: 0, item: completed.output[0] },
            { type: "response.completed", response: completed },
        ],
        messages: [
            { type: "message_start", message: { ...message, content: [] } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
        ],
        "generate-content": [google],
    }[protocol];
    return new Response(chunks.map((chunk) => `${"type" in chunk ? `event: ${chunk.type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
    });
};

const request = {
    messages: [{ role: "user" as const, content: "question" }],
    headers: { "x-fixture": "preserved" },
    maxOutputTokens: 1_000,
    captureRawBody: true,
};

const assertToolFree = (body: Record<string, unknown>, protocol: Protocol): void => {
    assert.deepEqual(body.tools, [], "the wire explicitly declares an empty native-tool set");
    if (protocol === "generate-content") {
        assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
        assert.equal(body.tool_choice, undefined, "do not send a different protocol's fields");
    } else {
        assert.deepEqual(body.tool_choice, protocol === "messages" ? { type: "none" } : "none");
        assert.equal(body.toolConfig, undefined);
    }
    assert.equal(body.functions, undefined, "do not add deprecated function declarations");
    assert.equal(body.function_call, undefined);
    assert.equal(body.parallel_tool_calls, undefined, "limiting parallel calls is not disabling tool use");
};

test("{§provider-interface} compatible wire explicitly disables native tools for both response modes", async (t) => {
    for (const streaming of [false, true]) {
        await t.test(`{§provider-interface} ${streaming ? "stream" : "buffered"}`, async () => {
            const requests: Record<string, unknown>[] = [];
            const result = await executeOpenAICompatible({
                ...request, streaming, url: "https://fixture.test/v1/chat/completions", model: "fixture",
                body: { reasoning_effort: "high" },
                fetch: async (_url, init) => {
                    requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
                    return response("chat", streaming);
                },
            });
            assert.equal(result.content, "answer");
            assert.equal(result.usage?.totalTokens, 12);
            assert.equal(requests.length, 1);
            assertToolFree(requests[0], "chat");
            assert.equal(requests[0].reasoning_effort, "high");
            assert.deepEqual(requests[0].messages, request.messages);
        });
    }
});

test("{§provider-interface} the protocol projection cannot acquire tools or mutate caller input", () => {
    for (const protocol of ["openai", "messages", "generate-content"] as const) {
        const body = Object.freeze({ model: "fixture", temperature: 0.4, tools: Object.freeze([]) });
        const projected = withoutNativeTools(body, protocol);
        assert.equal(projected.model, "fixture");
        assert.equal(projected.temperature, 0.4);
        assert.notEqual(projected, body);
        assert.equal("tool_choice" in body, false);
        assert.equal("toolConfig" in body, false);
        for (const tools of [[{ type: "function" }], {}, null]) {
            assert.throws(() => withoutNativeTools({ tools }, protocol), {
                name: "TypeError", message: "PLURNK provider requests cannot declare native tools",
            });
        }
    }
});

test("{§provider-interface} request extensions cannot override the managed opt-out", async () => {
    let dispatched = false;
    for (const field of ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"]) {
        await assert.rejects(executeOpenAICompatible({
            ...request, streaming: false, url: "https://fixture.test/v1/chat/completions", model: "fixture",
            body: { [field]: "caller override" },
            fetch: async () => { dispatched = true; return response("chat", false); },
        }), {
            name: "TypeError", message: `OpenAI-compatible request extensions may not override SDK-owned field ${JSON.stringify(field)}`,
        });
    }
    assert.equal(dispatched, false);
});

test("{§provider-interface} opaque provider extensions receive portable none intent in both modes", async () => {
    const usage = {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    };
    const finishReason = { unified: "stop" as const, raw: "stop" };
    const model = new MockModelTransport({
        execute: async () => ({ content: "answer", reasoning: "", finishReason, usage, rawChunks: [], warnings: [] }),
    });
    for (const streaming of [false, true]) {
        const result = await executeModelTransport({ ...request, streaming, modelTransport: model });
        assert.equal(result.content, "answer");
        assert.equal(result.usage?.totalTokens, 12);
    }
    for (const call of model.executeCalls) {
        assert.deepEqual(call.toolChoice, { type: "none" });
        assert.equal(call.tools, undefined);
    }
    assert.equal(model.executeCalls.length, 2);
});

test("{§provider-interface} Bedrock uses its valid no-tool configuration", async (t) => {
    let body: Record<string, unknown> | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        return Response.json({
            output: { message: { role: "assistant", content: [{ text: "answer" }] } },
            stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            metrics: { latencyMs: 1 },
        });
    });
    const sdk = createProviderModel("fixture", "fixture", {
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_ADAPTER: "amazon-bedrock",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test",
        AWS_BEARER_TOKEN_BEDROCK: "fixture-only", AWS_REGION: "us-east-1",
    });
    assert.ok(sdk?.modelTransport);
    const result = await executeModelTransport({ ...request, streaming: false, modelTransport: sdk.modelTransport });
    assert.equal(result.content, "answer");
    assert.equal(result.usage?.totalTokens, 12);
    assert.ok(body);
    for (const key of ["tools", "toolConfig", "tool_choice"]) assert.equal(key in body, false);
});

test("{§provider-interface} Ollama keeps its probe unmodified and disables native calls for emission and BARE", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        bodies.push(body);
        if (String(url).endsWith("/api/show")) return Response.json({ model_info: { "fixture.context_length": 32768 } });
        assert.ok(String(url).endsWith("/v1/chat/completions"));
        return response("chat", body.stream === true);
    });
    for (const streaming of [false, true]) {
        const provider = await ollamaProviderFromEnv(withProviderDefaults({
            PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_STREAMING: streaming ? "1" : "0",
        }), "fixture", { baseUrl: "http://fixture.test" });
        assert.deepEqual(bodies.at(-1), { model: "fixture" });
        for (const callKind of ["emission", "bare"] as const) {
            const result = await provider.generate({ sessionId: "fixture", messages: request.messages, callKind });
            assert.equal(result.assistant.content, "answer");
            assertToolFree(bodies.at(-1)!, "chat");
        }
    }
    assert.equal(bodies.length, 6);
});

test("{§provider-interface} configured adapter families preserve the opt-out on the actual wire", async (t) => {
    const families: readonly [string, Protocol][] = [
        ["openai", "chat"],
        ["groq", "chat"],
        ["cerebras", "chat"],
        ["mistral", "chat"],
        ["togetherai", "chat"],
        ["deepinfra", "chat"],
        ["openrouter", "chat"],
        ["xai", "responses"],
        ["anthropic", "messages"],
        ["google", "generate-content"],
    ];
    for (const [adapter, protocol] of families) {
        for (const streaming of [false, true]) {
            await t.test(`{§provider-interface} ${adapter}, ${streaming ? "stream" : "buffered"}`, async (t) => {
                const requests: Record<string, unknown>[] = [];
                t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
                    requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
                    assert.equal(new Headers(init?.headers).get("x-fixture"), "preserved");
                    return response(protocol, streaming);
                });
                const sdk = createProviderModel("fixture", "fixture", {
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_ADAPTER: adapter,
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_API_KEY_ENV: "FIXTURE_API_KEY",
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test/v1",
                    FIXTURE_API_KEY: "fixture-only",
                });
                assert.ok(sdk?.modelTransport);
                const result = await executeModelTransport({ ...request, streaming, modelTransport: sdk.modelTransport });
                assert.equal(result.content, "answer");
                assert.equal(result.usage?.totalTokens, 12);
                assert.equal(requests.length, 1);
                assertToolFree(requests[0], protocol);
            });
        }
    }
});
}
