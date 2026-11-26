import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createProviderModel } from "./modelAdapters.ts";
import { catalogProviderFromEnv, catalogEfforts, providerFromModelAdapter } from "./catalogProvider.ts";
import { catalogSnapshot, lookupProvider, resolveModel } from "@plurnk/plurnk-models";
import { calculateCostUsdDecimal } from "./usage.ts";
import { withProviderDefaults } from "./defaults.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { UnsupportedEffortError } from "./types.ts";
import { requestBody, requestUrl } from "../../scripts/lib/test-fetch.ts";
import ModelProvider from "./ModelProvider.ts";
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
    PLURNK_PROVIDERS_FETCH_TIMEOUT_MS: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT_MS: "3000",
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
        ["cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash"],
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
        providerModel: createProviderModel("openai", "fixture", { OPENAI_API_KEY: "test-key" })!.providerModel!,
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
    }, "@cf/zai-org/glm-4.7-flash");
    assert.deepEqual(ungradedReasoner?.supportedEfforts, policiesOver(catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash")), "the catalog's vocabulary, exactly");
    await ungradedReasoner?.generate({ sessionId: "cloudflare-ungraded", messages: [{ role: "user", content: "hello" }] });

    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["low", undefined, undefined, fallbackOf(catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash"))], "adaptive selects high only when supported; it does not escalate to xhigh");
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
                model: "@cf/zai-org/glm-4.7-flash",
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
    const low = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_EFFORT: "low" }, "@cf/zai-org/glm-4.7-flash");
    assert.deepEqual(low?.supportedEfforts, policiesOver([...catalogEffortsOf("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash"), "low", "medium", "high"]), "the declaration joins the catalog's vocabulary");
    await low?.generate({ sessionId: "declared-low", messages: [{ role: "user", content: "hello" }] });
    const adaptive = catalogProviderFromEnv("cloudflare-workers-ai", { ...declaredEnv, PLURNK_PROVIDERS_EFFORT: "adaptive" }, "@cf/zai-org/glm-4.7-flash");
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
        }, "@cf/zai-org/glm-4.7-flash"),
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
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(requestBody(init));
        return new Response(`data: ${JSON.stringify({
            id: "fallback", object: "chat.completion.chunk", created: 1, model: "o3",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const providerModel = createProviderModel("openai", "o3", { OPENAI_API_KEY: "test-key" })!.providerModel!;
    for (const [efforts, fallback, expected] of [
        [["low", "medium", "high", "xhigh", "max"], "high", "high"],
        [["low", "medium", "xhigh"], "high", undefined],
        [["low", "medium", "high", "xhigh"], "medium", "medium"],
        [["high", "max"], "max", undefined],
        [["high", "xhigh"], "", undefined],
    ] as const) {
        const provider = providerFromModelAdapter({
            name: "openai", model: "o3", providerModel,
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
        thinkingLevel: "HIGH",
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

test("{§provider-effort} {§provider-failure-normalization} Google thinkingBudget reserves outputFloor headroom and retries MALFORMED_FUNCTION_CALL and reasoning-starved MAX_TOKENS", async () => {
    const bodies: Array<{
        generationConfig?: {
            maxOutputTokens?: number;
            thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number };
        };
    }> = [];
    let callIndex = 0;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as typeof bodies[number]);
        callIndex += 1;
        if (callIndex === 1) {
            return new Response(`data: ${JSON.stringify({
                responseId: "resp-budgeted-tool",
                candidates: [{
                    content: {
                        role: "model",
                        parts: [
                            { text: "planning", thought: true },
                            { functionCall: { id: "c1", name: "mcp", args: { server: "plurnk", tool: "done", arguments: { text: "Completed." } } } },
                        ],
                    },
                    finishReason: "STOP",
                }],
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 12,
                    thoughtsTokenCount: 5,
                    totalTokenCount: 27,
                },
            })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        if (callIndex === 2) {
            return new Response(`data: ${JSON.stringify({
                responseId: "resp-malformed-fc",
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{ text: "thinking", thought: true }],
                    },
                    finishReason: "MALFORMED_FUNCTION_CALL",
                }],
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 4,
                    thoughtsTokenCount: 8,
                    totalTokenCount: 22,
                },
            })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        if (callIndex === 3) {
            return new Response(`data: ${JSON.stringify({
                responseId: "resp-starved",
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{ text: "exhausted ceiling in thoughts", thought: true }],
                    },
                    finishReason: "MAX_TOKENS",
                }],
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 0,
                    thoughtsTokenCount: 100,
                    totalTokenCount: 110,
                },
            })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(`data: ${JSON.stringify({
            responseId: "resp-recovered",
            candidates: [{
                content: {
                    role: "model",
                    parts: [
                        { text: "recovered thought", thought: true },
                        { functionCall: { id: "c2", name: "mcp", args: { server: "plurnk", tool: "done", arguments: { text: "Recovered." } } } },
                    ],
                },
                finishReason: "STOP",
            }],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 6,
                thoughtsTokenCount: 20,
                totalTokenCount: 36,
            },
        })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });

    const budgeted = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        PLURNK_PROVIDERS_REASONING_BUDGET: "30000",
    }, "gemini-4-argon");
    const first = await budgeted?.generate({
        sessionId: "google-budgeted-tool",
        messages: [{ role: "user", content: "hello" }],
    });
    assert.deepEqual(bodies[0]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingBudget: budgeted!.outputBudget! - budgeted!.outputFloor!,
    }, "thinkingBudget is bounded by maxOutputTokens minus outputFloor");
    assert.equal(first?.assistant.toolCalls?.length, 1);
    assert.equal(first?.assistant.toolCalls?.[0]?.name, "mcp");

    const adaptive = catalogProviderFromEnv("google", {
        ...env,
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_EFFORT: "adaptive",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "2",
    }, "gemini-4-argon");
    const second = await adaptive?.generate({
        sessionId: "google-retry-starved",
        messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(second?.assistant.toolCalls?.length, 1);
    assert.equal(second?.accounting.length, 3);
    assert.deepEqual(bodies[1]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "HIGH",
    });
    assert.deepEqual(bodies[2]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "HIGH",
    });
    assert.deepEqual(bodies[3]?.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: "MEDIUM",
    }, "retry after reasoning-only MAX_TOKENS steps down thinkingLevel to leave visible output headroom");
});

test("{§provider-effort} native Anthropic adaptive policy uses adaptive thinking rather than a fixed high effort", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(requestBody(init));
        const chunks = [
            { type: "message_start", message: { id: "response", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
        ];
        return new Response(chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const providerModel = createProviderModel("anthropic", "claude-sonnet-4-6", { ANTHROPIC_API_KEY: "test-key" })!.providerModel!;
    const provider = providerFromModelAdapter({
        name: "anthropic",
        env: {
            ...env,
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        },
        model: "claude-sonnet-4-6",
        providerModel,
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
    assert.deepEqual(body?.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(body?.output_config, undefined);
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
        PLURNK_PROVIDERS_COST_INPUT: "0.22",
        PLURNK_PROVIDERS_COST_OUTPUT: "0.66",
        PLURNK_PROVIDERS_COST_CACHE_READ: "0.007",
    }, "deepseek-v4-flash");
    const response = await overridden!.generate({ sessionId: "overridden", messages: [] });
    const overriddenAmount = calculateCostUsdDecimal(response.accounting[0].usage!, { ...catalogRatesOf("deepseek", "deepseek-v4-flash"), input: 0.22, output: 0.66, cacheRead: 0.007 });
    assert.notEqual(overriddenAmount, calculateCostUsdDecimal(response.accounting[0].usage!, catalogRatesOf("deepseek", "deepseek-v4-flash")), "the override changes the price");
    assert.deepEqual(response.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: overriddenAmount, currency: "USD" },
        source: "operator PLURNK_PROVIDERS_COST_* override over Models.dev catalog rates",
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
            `data: ${JSON.stringify({ id: "zai", model: "glm-5.3-flash", choices: [{ index: 0, delta: { content: "await plurnk.read({\"path\":\"django/forms/widgets.py\",\"pattern\":\"/class Media/\"});" }, finish_reason: "stop" }], usage })}`,
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

// {§provider-monetary-evidence} {§provider-request-accounting} Google proto3 usageMetadata omits zero-valued cachedContentTokenCount and thoughtsTokenCount (#1490).
for (const [name, usageMetadata, expectedInputDetails, expectedOutputDetails] of [
    [
        "uncached turn with thoughts",
        { promptTokenCount: 5415, candidatesTokenCount: 312, thoughtsTokenCount: 87, totalTokenCount: 5814 },
        { noCacheTokens: 5415, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { textTokens: 312, reasoningTokens: 87 },
    ],
    [
        "implicit-cache turn with zero thoughts",
        { promptTokenCount: 14053, candidatesTokenCount: 188, cachedContentTokenCount: 11828, totalTokenCount: 14241 },
        { noCacheTokens: 2225, cacheReadTokens: 11828, cacheWriteTokens: 0 },
        { textTokens: 188, reasoningTokens: 0 },
    ],
] as const) {
    test(`{§provider-monetary-evidence} {§provider-request-accounting} Google gemini-4-hydrogen ${name} resolves complete cache/reasoning details and exact catalog cost (#1490)`, async () => {
        mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify({
            responseId: "google-cost",
            modelVersion: "gemini-4-hydrogen",
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata,
        })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
        const provider = catalogProviderFromEnv("google", {
            ...env,
            GEMINI_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }, "gemini-4-hydrogen");
        assert.ok(provider);
        const response = await provider.generate({ sessionId: "google-cost", messages: [{ role: "user", content: "hi" }] });
        const usage = response.accounting[0]?.usage;
        assert.ok(usage);
        assert.deepEqual(usage.inputTokenDetails, expectedInputDetails);
        assert.deepEqual(usage.outputTokenDetails, expectedOutputDetails);
        const expected = calculateCostUsdDecimal(usage, catalogRatesOf("google", "gemini-4-hydrogen"));
        assert.notEqual(expected, null);
        assert.deepEqual(response.accounting[0]?.cost, {
            kind: "estimated", amount: { amount: expected, currency: "USD" }, source: "Models.dev catalog rates",
        });
        mock.restoreAll();
    });
}

{
type Protocol = "chat" | "responses" | "messages" | "generate-content";

const response = (protocol: Protocol): Response => {
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

const assertToolFree = (body: Record<string, unknown>): void => {
    for (const key of ["tools", "toolConfig", "tool_choice", "functions", "function_call", "parallel_tool_calls"]) {
        assert.equal(key in body, false, `do not send ${key} on default tool-free requests`);
    }
};

const assertMcpToolPresent = (body: Record<string, unknown>): void => {
    const tools = body.tools;
    if (Array.isArray(tools)) {
        assert.equal(tools.length, 1);
        const first = tools[0] as Record<string, unknown>;
        const name = typeof first.name === "string"
            ? first.name
            : typeof (first.function as { name?: unknown } | undefined)?.name === "string"
                ? (first.function as { name: string }).name
                : Array.isArray(first.functionDeclarations)
                    ? ((first.functionDeclarations[0] as { name?: string } | undefined)?.name ?? "")
                    : "";
        assert.equal(name, "mcp");
        return;
    }
    const configTools = (body.config as { tools?: unknown[] } | undefined)?.tools;
    if (Array.isArray(configTools)) {
        const decls = (configTools[0] as { functionDeclarations?: Array<{ name?: string }> } | undefined)?.functionDeclarations;
        assert.equal(decls?.[0]?.name, "mcp");
        return;
    }
    const bedrockTools = (body.toolConfig as { tools?: Array<{ toolSpec?: { name?: string } }> } | undefined)?.tools;
    assert.equal(bedrockTools?.[0]?.toolSpec?.name, "mcp");
};

test("{§provider-interface} {§provider-request-authority} compatible wire projects universal mcp tool on emission and strips caller sampling tool fields", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = new ModelProvider({
        model: "fixture",
        url: "https://fixture.test/v1/chat/completions",
        headers: request.headers,
        fetchTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        effort: { mode: "high", budget: null },
        supportedEfforts: ["off", "adaptive", "high"],
        reasoningRequestBody: () => ({ reasoning_effort: "high" }),
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
        rawBody: true,
        fetch: async (_url, init) => {
            requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("chat");
        },
    });
    const result = await provider.generate({
        sessionId: "fixture",
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        sampling: {
            tools: [{ type: "function" }],
            tool_choice: "auto",
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            functions: [],
            function_call: "auto",
            parallel_tool_calls: true,
        },
    });
    assert.equal(result.assistant.content, "answer");
    assert.equal(result.accounting[0]?.usage?.totalTokens, 12);
    assert.equal(requests.length, 1);
    assertMcpToolPresent(requests[0]);
    assert.equal("tool_choice" in requests[0], false);
    assert.equal(requests[0].max_tokens, 1_000);
    assert.equal(requests[0].max_completion_tokens, undefined);
    assert.equal(requests[0].reasoning_effort, "high");
    assert.deepEqual(requests[0].messages, request.messages);
});

test("{§provider-effort} {§provider-sdk-boundary} {§provider-request-authority} deepseek-flash projects reasoning_effort, single max_tokens cap, mcp tool, and assistant reasoning_content compat (#1417)", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
        return response("chat");
    });
    for (const [effort, expectedWireEffort] of [["low", "low"], ["adaptive", "high"]] as const) {
        const provider = catalogProviderFromEnv("deepseek", withProviderDefaults({
            DEEPSEEK_API_KEY: "test-key",
            PLURNK_PROVIDERS_EFFORT: effort,
        }), "deepseek-flash");
        assert.ok(provider);
        assert.deepEqual(provider.supportedEfforts, ["off", "adaptive", "low", "high", "max"]);
        await provider.generate({
            sessionId: "deepseek-flash-wire",
            messages: [
                { role: "user", content: "first" },
                { role: "assistant", content: "prior reply" },
                { role: "user", content: "second" },
            ],
            maxOutputTokens: 4096,
        });
        const sent = bodies.at(-1)!;
        assertMcpToolPresent(sent);
        assert.deepEqual(sent.thinking, { type: "enabled" });
        assert.equal(sent.reasoning_effort, expectedWireEffort);
        assert.equal(sent.max_tokens, 4096);
        assert.equal(sent.max_completion_tokens, undefined);
        const wireMessages = sent.messages as Array<Record<string, unknown>>;
        assert.equal(wireMessages[1]?.role, "assistant");
        assert.equal(wireMessages[1]?.reasoning_content, "");
    }
});

test("{§provider-interface} {§provider-request-authority} adapter tool declarations pass through on emission calls, empty tools arrays are omitted, and bare calls strip tool fields", async () => {
    const sdk = createProviderModel("fixture", "fixture", {
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_ADAPTER: "openai",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_API_KEY_ENV: "FIXTURE_API_KEY",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test/v1",
        FIXTURE_API_KEY: "fixture-only",
    });
    assert.ok(sdk?.providerModel);

    const sent: Record<string, unknown>[] = [];
    const declaredTools = [{ type: "function", function: { name: "fixture_op", parameters: { type: "object" } } }];
    const withTools = new ModelProvider({
        model: "fixture",
        providerModel: {
            ...sdk.providerModel,
            onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: declaredTools, tool_choice: "auto" }),
        },
        headers: request.headers,
        fetchTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        effort: { mode: "off", budget: null },
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
        fetch: async (_url, init) => {
            sent.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("chat");
        },
    });
    await withTools.generate({
        sessionId: "fixture",
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        callKind: "emission",
    });
    assert.deepEqual(sent[0]?.tools, declaredTools);
    assert.equal(sent[0]?.tool_choice, "auto");

    await withTools.generate({
        sessionId: "fixture",
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        callKind: "bare",
    });
    assertToolFree(sent[1]);

    const withEmptyTools = new ModelProvider({
        model: "fixture",
        providerModel: {
            ...sdk.providerModel,
            onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: [] }),
        },
        headers: request.headers,
        fetchTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        effort: { mode: "off", budget: null },
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
        fetch: async (_url, init) => {
            sent.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("chat");
        },
    });
    await withEmptyTools.generate({
        sessionId: "fixture",
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
        callKind: "emission",
    });
    assertToolFree(sent[2]);
});

test("{§provider-interface} {§provider-request-authority} Bedrock uses its valid no-tool configuration", async (t) => {
    let body: Record<string, unknown> | undefined;
    t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: { input: unknown }) => {
        body = command.input as Record<string, unknown>;
        return {
            $metadata: { httpStatusCode: 200, requestId: "req-1" },
            stream: (async function* () {
                yield { messageStart: { role: "assistant" } };
                yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } };
                yield { contentBlockStop: { contentBlockIndex: 0 } };
                yield { messageStop: { stopReason: "end_turn" } };
                yield { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } } };
            })(),
        };
    });
    const sdk = createProviderModel("fixture", "fixture", {
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_ADAPTER: "amazon-bedrock",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test",
        AWS_BEARER_TOKEN_BEDROCK: "fixture-only", AWS_REGION: "us-east-1",
    });
    assert.ok(sdk?.providerModel);
    const provider = new ModelProvider({
        model: "fixture",
        providerModel: sdk.providerModel,
        headers: request.headers,
        fetchTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        effort: { mode: "off", budget: null },
        temperature: null,
        repeatPenalty: null,
        retryAttempts: 0,
        rawBody: true,
    });
    const result = await provider.generate({
        sessionId: "fixture",
        messages: request.messages,
        maxOutputTokens: request.maxOutputTokens,
    });
    assert.equal(result.assistant.content, "answer");
    assert.equal(result.accounting[0]?.usage?.totalTokens, 12);
    assert.ok(body);
    assertMcpToolPresent(body);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
});

test("{§provider-interface} {§provider-request-authority} Ollama keeps its probe unmodified, projects mcp on emission, and strips tools on BARE", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        bodies.push(body);
        if (String(url).endsWith("/api/show")) return Response.json({ model_info: { "fixture.context_length": 32768 } });
        assert.ok(String(url).endsWith("/v1/chat/completions"));
        return response("chat");
    });
    const provider = await ollamaProviderFromEnv(withProviderDefaults({
        PLURNK_PROVIDERS_EFFORT: "off",
    }), "fixture", { baseUrl: "http://fixture.test" });
    assert.deepEqual(bodies.at(-1), { model: "fixture" });
    for (const callKind of ["emission", "bare"] as const) {
        const result = await provider.generate({ sessionId: "fixture", messages: request.messages, callKind });
        assert.equal(result.assistant.content, "answer");
        if (callKind === "emission") assertMcpToolPresent(bodies.at(-1)!);
        else assertToolFree(bodies.at(-1)!);
    }
    assert.equal(bodies.length, 3);
});

test("{§provider-interface} {§provider-request-authority} configured adapter families project mcp on emission and omit tool fields on BARE", async (t) => {
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
        await t.test(`{§provider-interface} {§provider-request-authority} ${adapter}`, async (t) => {
            const requests: Record<string, unknown>[] = [];
            t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
                requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
                assert.equal(new Headers(init?.headers).get("x-fixture"), "preserved");
                return response(protocol);
            });
            const sdk = createProviderModel("fixture", "fixture", {
                PLURNK_PROVIDERS_PROVIDER_FIXTURE_ADAPTER: adapter,
                PLURNK_PROVIDERS_PROVIDER_FIXTURE_API_KEY_ENV: "FIXTURE_API_KEY",
                PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test/v1",
                FIXTURE_API_KEY: "fixture-only",
            });
            assert.ok(sdk?.providerModel);
            const provider = new ModelProvider({
                model: "fixture",
                providerModel: sdk.providerModel,
                headers: request.headers,
                fetchTimeoutMs: 1_000,
                operationTimeoutMs: 5_000,
                effort: { mode: "off", budget: null },
                temperature: null,
                repeatPenalty: null,
                retryAttempts: 0,
                rawBody: true,
            });
            for (const callKind of ["emission", "bare"] as const) {
                const result = await provider.generate({
                    sessionId: "fixture",
                    messages: request.messages,
                    maxOutputTokens: request.maxOutputTokens,
                    callKind,
                });
                assert.equal(result.assistant.content, "answer");
                assert.equal(result.accounting[0]?.usage?.totalTokens, 12);
                if (callKind === "emission") assertMcpToolPresent(requests.at(-1)!);
                else assertToolFree(requests.at(-1)!);
            }
            assert.equal(requests.length, 2);
        });
    }
});

test("{§provider-request-authority} cataloged openai-compatible providers project mcp on emission and omit tool fields on BARE", async (t) => {
    const cases: readonly {
        readonly provider: string;
        readonly env: Record<string, string>;
    }[] = [
        { provider: "fireworks-ai", env: { FIREWORKS_API_KEY: "fixture-only" } },
        { provider: "cloudflare-workers-ai", env: { CLOUDFLARE_API_KEY: "fixture-only", CLOUDFLARE_ACCOUNT_ID: "acct" } },
        { provider: "deepseek", env: { DEEPSEEK_API_KEY: "fixture-only" } },
        { provider: "alibaba", env: { DASHSCOPE_API_KEY: "fixture-only" } },
        { provider: "alibaba-coding-plan", env: { ALIBABA_CODING_PLAN_API_KEY: "fixture-only" } },
        { provider: "zai", env: { ZHIPU_API_KEY: "fixture-only" } },
        { provider: "zhipuai", env: { ZHIPU_API_KEY: "fixture-only" } },
        { provider: "longcat", env: { LONGCAT_API_KEY: "fixture-only" } },
        { provider: "xiaomi", env: { XIAOMI_API_KEY: "fixture-only" } },
        { provider: "moonshotai", env: { MOONSHOT_API_KEY: "fixture-only" } },
        { provider: "siliconflow", env: { SILICONFLOW_API_KEY: "fixture-only" } },
        {
            provider: "custom-compat",
            env: {
                PLURNK_PROVIDERS_PROVIDER_CUSTOM_COMPAT_ADAPTER: "openai-compatible",
                PLURNK_PROVIDERS_PROVIDER_CUSTOM_COMPAT_BASE_URL: "https://fixture.test/v1",
                PLURNK_PROVIDERS_PROVIDER_CUSTOM_COMPAT_API_KEY_ENV: "FIXTURE_API_KEY",
                FIXTURE_API_KEY: "fixture-only",
            },
        },
    ];
    for (const row of cases) {
        await t.test(`{§provider-request-authority} ${row.provider}`, async (t) => {
            const sentBodies: Record<string, unknown>[] = [];
            t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
                sentBodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
                return response("chat");
            });
            const provider = catalogProviderFromEnv(row.provider, withProviderDefaults({
                ...row.env,
                PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
                PLURNK_PROVIDERS_EFFORT: "off",
            }), "fixture-model", "https://fixture.test/v1");
            assert.ok(provider);
            for (const callKind of ["emission", "bare"] as const) {
                const result = await provider.generate({
                    sessionId: `mcp-${row.provider}`,
                    messages: request.messages,
                    maxOutputTokens: 512,
                    callKind,
                });
                assert.equal(result.assistant.content, "answer");
                if (callKind === "emission") assertMcpToolPresent(sentBodies.at(-1)!);
                else assertToolFree(sentBodies.at(-1)!);
            }
            assert.equal(sentBodies.length, 2);
        });
    }
});

test("{§provider-sdk-boundary} conversation cache write policy places bounded prefix breakpoints across Anthropic, MiniMax Anthropic, OpenRouter Anthropic, and Bedrock Claude while preserving prior-turn cached blocks and bare suppression", async (t) => {
    const turn1Log = "## Log\n\n### log:///1/1/1/send · 8\nShip it.";
    const turn1Emission = "\n\n### log:///1/1/2/emission (ops://s1/1/1)";
    const turn1Status = "\n\n## Git\n{\"branch\":\"main\"}\n\n## Session\n{\"turn\":1}";
    const turn2Log = "### log:///1/1/3/read · 12\n1:const x = 1;";
    const turn2Emission = "\n\n### log:///1/2/1/emission (ops://s1/1/2)";
    const turn2Status = "\n\n## Git\n{\"branch\":\"main\"}\n\n## Session\n{\"turn\":2}";
    const turn3Log = "### log:///1/2/2/read · 10\n1:const y = 2;";
    const turn3Status = "\n\n## Git\n{\"branch\":\"main\"}\n\n## Session\n{\"turn\":3}";

    await t.test("{§provider-sdk-boundary} anthropic-messages multi-turn historical block preservation, 3-breakpoint bound, status-only tail, native parts, and bare suppression", async (t) => {
        const requests: Record<string, unknown>[] = [];
        t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("messages");
        });
        const provider = catalogProviderFromEnv("anthropic", withProviderDefaults({
            ANTHROPIC_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        }), "claude-sonnet-4-6");
        assert.ok(provider);

        // Turn 1: system + durable log split from volatile status clump (2 breakpoints total).
        await provider.generate({
            sessionId: "s1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                { role: "user", content: turn1Log + turn1Status },
            ],
            userCachePrefixes: [undefined, { kind: "chars", length: turn1Log.length }],
        });
        assert.deepEqual(requests[0].system, [{ type: "text", text: "card", cache_control: { type: "ephemeral" } }]);
        assert.deepEqual(requests[0].messages, [{
            role: "user",
            content: [
                { type: "text", text: turn1Log, cache_control: { type: "ephemeral" } },
                { type: "text", text: turn1Status },
            ],
        }]);

        // Turn 2: Turn 1's emission row arrived at the tail of user[0] (`turn1Log + turn1Emission`);
        // userCachePrefixes[1] isolates `turn1Log` as block 0 (matching Turn 1's cached block byte-for-byte)
        // and `turn1Emission` as block 1 without adding a 4th breakpoint (3 breakpoints <= 4).
        await provider.generate({
            sessionId: "s1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                { role: "user", content: turn1Log + turn1Emission },
                { role: "assistant", content: "await plurnk.read({\"path\":\"a.ts\"});" },
                { role: "user", content: turn2Log + turn2Status },
            ],
            userCachePrefixes: [
                undefined,
                { kind: "chars", length: turn1Log.length },
                undefined,
                { kind: "chars", length: turn2Log.length },
            ],
        });
        assert.deepEqual(requests[1].messages, [
            {
                role: "user",
                content: [
                    { type: "text", text: turn1Log },
                    { type: "text", text: turn1Emission },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "await plurnk.read({\"path\":\"a.ts\"});", cache_control: { type: "ephemeral" } }],
            },
            {
                role: "user",
                content: [
                    { type: "text", text: turn2Log, cache_control: { type: "ephemeral" } },
                    { type: "text", text: turn2Status },
                ],
            },
        ]);

        // Turn 3 (5+ messages): total `cache_control` blocks across system + messages remains bounded at 3 (<= 4).
        await provider.generate({
            sessionId: "s1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                { role: "user", content: turn1Log + turn1Emission },
                { role: "assistant", content: "await plurnk.read({\"path\":\"a.ts\"});" },
                { role: "user", content: turn2Log + turn2Emission },
                { role: "assistant", content: "await plurnk.read({\"path\":\"b.ts\"});" },
                { role: "user", content: turn3Log + turn3Status },
            ],
            userCachePrefixes: [
                undefined,
                { kind: "chars", length: turn1Log.length },
                undefined,
                { kind: "chars", length: turn2Log.length },
                undefined,
                { kind: "chars", length: turn3Log.length },
            ],
        });
        assert.equal((JSON.stringify(requests[2]).match(/"cache_control"/gu) ?? []).length, 3);
        assert.deepEqual((requests[2].messages as Array<{ content: unknown }>)[2].content, [
            { type: "text", text: turn2Log },
            { type: "text", text: turn2Emission },
        ]);

        // Status-only final user message (`length: 0`): penultimate durable message cached, volatile tail uncached.
        await provider.generate({
            sessionId: "s1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                { role: "user", content: turn1Log },
                { role: "assistant", content: "await plurnk.kill({\"path\":\"log:///1/1/1\"});" },
                { role: "user", content: turn2Status.trimStart() },
            ],
            userCachePrefixes: [undefined, undefined, undefined, { kind: "chars", length: 0 }],
        });
        assert.deepEqual(requests[3].messages, [
            { role: "user", content: turn1Log },
            {
                role: "assistant",
                content: [{ type: "text", text: "await plurnk.kill({\"path\":\"log:///1/1/1\"});", cache_control: { type: "ephemeral" } }],
            },
            { role: "user", content: turn2Status.trimStart() },
        ]);

        // Native PDF attachment in durable prefix (`kind: "parts"`): document block converted + cached before status part.
        await provider.generate({
            sessionId: "s1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: turn2Log },
                        { type: "file", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mediaType: "application/pdf" },
                        { type: "text", text: turn2Status },
                    ],
                },
            ],
            userCachePrefixes: [undefined, { kind: "parts", count: 2 }],
        });
        const pdfMsg = (requests[4].messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
        assert.equal(pdfMsg.content[0].cache_control, undefined);
        assert.equal(pdfMsg.content[1].type, "document");
        assert.deepEqual(pdfMsg.content[1].cache_control, { type: "ephemeral" });
        assert.equal(pdfMsg.content[2].cache_control, undefined);

        // Stateless `bare` call suppresses paid cache writes completely.
        await provider.generate({
            sessionId: "s1",
            callKind: "bare",
            messages: [{ role: "user", content: "Summarize once." }],
        });
        assert.deepEqual(requests[5].messages, [{ role: "user", content: "Summarize once." }]);
    });

    await t.test("{§provider-sdk-boundary} MiniMax Anthropic conversation breakpoints", async (t) => {
        const requests: Record<string, unknown>[] = [];
        t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("messages");
        });
        const provider = catalogProviderFromEnv("minimax-coding-plan", withProviderDefaults({
            MINIMAX_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        }), "MiniMax-M2.1", "https://minimax.test/anthropic/v1");
        assert.ok(provider);
        await provider.generate({
            sessionId: "mm-1",
            callKind: "emission",
            messages: [
                { role: "system", content: "card" },
                { role: "user", content: turn1Log + turn1Emission },
                { role: "assistant", content: "await plurnk.note({\"text\":\"ok\"});" },
                { role: "user", content: turn2Log + turn2Status },
            ],
            userCachePrefixes: [
                undefined,
                { kind: "chars", length: turn1Log.length },
                undefined,
                { kind: "chars", length: turn2Log.length },
            ],
        });
        assert.deepEqual(requests[0].system, [{ type: "text", text: "card", cache_control: { type: "ephemeral" } }]);
        assert.deepEqual(requests[0].messages, [
            {
                role: "user",
                content: [
                    { type: "text", text: turn1Log },
                    { type: "text", text: turn1Emission },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "await plurnk.note({\"text\":\"ok\"});", cache_control: { type: "ephemeral" } }],
            },
            {
                role: "user",
                content: [
                    { type: "text", text: turn2Log, cache_control: { type: "ephemeral" } },
                    { type: "text", text: turn2Status },
                ],
            },
        ]);
    });

    await t.test("{§provider-sdk-boundary} OpenRouter Anthropic conversation, off, and bare breakpoints", async (t) => {
        const requests: Record<string, unknown>[] = [];
        t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("chat");
        });
        const providerFor = (policy?: string) => {
            const p = catalogProviderFromEnv("openrouter", withProviderDefaults({
                OPENROUTER_API_KEY: "fixture-key",
                PLURNK_PROVIDERS_EFFORT: "off",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
                ...(policy === undefined ? {} : { PLURNK_PROVIDERS_CACHE_WRITE_POLICY: policy }),
            }), "anthropic/claude-sonnet-4.6", "https://openrouter.test/api/v1");
            assert.ok(p);
            return p;
        };
        const multiTurn = [
            { role: "system" as const, content: "card" },
            { role: "user" as const, content: turn1Log + turn1Emission },
            { role: "assistant" as const, content: "await plurnk.note({\"text\":\"ok\"});" },
            { role: "user" as const, content: turn2Log + turn2Status },
        ];
        const prefixes = [
            undefined,
            { kind: "chars" as const, length: turn1Log.length },
            undefined,
            { kind: "chars" as const, length: turn2Log.length },
        ];
        await providerFor().generate({
            sessionId: "or-1",
            callKind: "emission",
            messages: multiTurn,
            userCachePrefixes: prefixes,
        });
        assert.deepEqual(requests[0].messages, [
            { role: "system", content: [{ type: "text", text: "card", cache_control: { type: "ephemeral" } }] },
            {
                role: "user",
                content: [
                    { type: "text", text: turn1Log },
                    { type: "text", text: turn1Emission },
                ],
            },
            { role: "assistant", content: [{ type: "text", text: "await plurnk.note({\"text\":\"ok\"});", cache_control: { type: "ephemeral" } }] },
            {
                role: "user",
                content: [
                    { type: "text", text: turn2Log, cache_control: { type: "ephemeral" } },
                    { type: "text", text: turn2Status },
                ],
            },
        ]);

        await providerFor("off").generate({
            sessionId: "or-1",
            callKind: "emission",
            messages: multiTurn,
            userCachePrefixes: prefixes,
        });
        assert.equal(JSON.stringify(requests[1].messages).includes("cache_control"), false);

        await providerFor("conversation").generate({
            sessionId: "or-1",
            callKind: "bare",
            messages: multiTurn,
            userCachePrefixes: prefixes,
        });
        assert.equal(JSON.stringify(requests[2].messages).includes("cache_control"), false);
    });

    await t.test("{§provider-sdk-boundary} OpenAI GPT-5.6+ explicit prompt_cache_options and monotonic prompt_cache_breakpoint placement", async (t) => {
        const requests: Record<string, unknown>[] = [];
        t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
            return response("chat");
        });
        const gpt6For = (policy: string) => {
            const p = catalogProviderFromEnv("openrouter", withProviderDefaults({
                OPENROUTER_API_KEY: "fixture-key",
                PLURNK_PROVIDERS_EFFORT: "adaptive",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
                PLURNK_PROVIDERS_CACHE_WRITE_POLICY: policy,
            }), "openai/gpt-6-luna", "https://openrouter.test/api/v1");
            assert.ok(p);
            return p;
        };
        const bp = { mode: "explicit" };
        const threeTurnMessages = [
            { role: "system" as const, content: "card" },
            { role: "user" as const, content: turn1Log + turn1Emission },
            { role: "assistant" as const, content: "await plurnk.note({\"text\":\"t1\"});" },
            { role: "user" as const, content: turn2Log + turn2Emission },
            { role: "assistant" as const, content: "await plurnk.note({\"text\":\"t2\"});" },
            { role: "user" as const, content: turn3Log + turn3Status },
        ];
        const threeTurnPrefixes = [
            undefined,
            { kind: "chars" as const, length: turn1Log.length },
            undefined,
            { kind: "chars" as const, length: turn2Log.length },
            undefined,
            { kind: "chars" as const, length: turn3Log.length },
        ];

        await gpt6For("off").generate({
            sessionId: "gpt6-1",
            callKind: "emission",
            messages: threeTurnMessages,
            userCachePrefixes: threeTurnPrefixes,
        });
        assert.deepEqual(requests[0].prompt_cache_options, { mode: "explicit" });
        assert.equal(JSON.stringify(requests[0].messages).includes("prompt_cache_breakpoint"), false);

        await gpt6For("conversation").generate({
            sessionId: "gpt6-1",
            callKind: "bare",
            messages: threeTurnMessages,
            userCachePrefixes: threeTurnPrefixes,
        });
        assert.deepEqual(requests[1].prompt_cache_options, { mode: "explicit" });
        assert.equal(JSON.stringify(requests[1].messages).includes("prompt_cache_breakpoint"), false);

        await gpt6For("stable-system").generate({
            sessionId: "gpt6-1",
            callKind: "emission",
            messages: threeTurnMessages,
            userCachePrefixes: threeTurnPrefixes,
        });
        assert.deepEqual(requests[2].prompt_cache_options, { mode: "explicit" });
        assert.deepEqual((requests[2].messages as unknown[])[0], {
            role: "system",
            content: [{ type: "text", text: "card", prompt_cache_breakpoint: bp }],
        });
        assert.equal(JSON.stringify((requests[2].messages as unknown[]).slice(1)).includes("prompt_cache_breakpoint"), false);

        await gpt6For("conversation").generate({
            sessionId: "gpt6-1",
            callKind: "emission",
            messages: threeTurnMessages,
            userCachePrefixes: threeTurnPrefixes,
        });
        assert.deepEqual(requests[3].prompt_cache_options, { mode: "explicit" });
        assert.deepEqual(requests[3].messages, [
            { role: "system", content: [{ type: "text", text: "card", prompt_cache_breakpoint: bp }] },
            {
                role: "user",
                content: [
                    { type: "text", text: turn1Log, prompt_cache_breakpoint: bp },
                    { type: "text", text: turn1Emission },
                ],
            },
            { role: "assistant", content: "await plurnk.note({\"text\":\"t1\"});" },
            {
                role: "user",
                content: [
                    { type: "text", text: turn2Log, prompt_cache_breakpoint: bp },
                    { type: "text", text: turn2Emission },
                ],
            },
            { role: "assistant", content: "await plurnk.note({\"text\":\"t2\"});" },
            {
                role: "user",
                content: [
                    { type: "text", text: turn3Log, prompt_cache_breakpoint: bp },
                    { type: "text", text: turn3Status },
                ],
            },
        ]);
    });

    await t.test("{§provider-sdk-boundary} Bedrock Claude off, stable-system, and conversation cachePoint placement", async (t) => {
        const inputs: Record<string, unknown>[] = [];
        t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: { input: unknown }) => {
            inputs.push(structuredClone(command.input as Record<string, unknown>));
            return {
                $metadata: { httpStatusCode: 200, requestId: "req-cache" },
                stream: (async function* () {
                    yield { messageStart: { role: "assistant" } };
                    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } };
                    yield { contentBlockStop: { contentBlockIndex: 0 } };
                    yield { messageStop: { stopReason: "end_turn" } };
                    yield { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } } };
                })(),
            };
        });
        const bedrockFor = (policy: string) => {
            const p = catalogProviderFromEnv("amazon-bedrock", withProviderDefaults({
                AWS_BEARER_TOKEN_BEDROCK: "fixture-key",
                AWS_REGION: "us-east-1",
                PLURNK_PROVIDERS_EFFORT: "off",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
                PLURNK_PROVIDERS_CACHE_WRITE_POLICY: policy,
            }), "us.anthropic.claude-sonnet-4-6");
            assert.ok(p);
            return p;
        };
        const multiTurnMessages = [
            { role: "system" as const, content: "card" },
            { role: "user" as const, content: turn1Log + turn1Emission },
            { role: "assistant" as const, content: "await plurnk.note({\"text\":\"ok\"});" },
            { role: "user" as const, content: turn2Log + turn2Status },
        ];
        const multiTurnPrefixes = [
            undefined,
            { kind: "chars" as const, length: turn1Log.length },
            undefined,
            { kind: "chars" as const, length: turn2Log.length },
        ];

        await bedrockFor("off").generate({
            sessionId: "br-1",
            callKind: "emission",
            messages: multiTurnMessages,
            userCachePrefixes: multiTurnPrefixes,
        });
        assert.deepEqual(inputs[0].system, [{ text: "card" }]);
        assert.equal(JSON.stringify(inputs[0].messages).includes("cachePoint"), false);

        await bedrockFor("stable-system").generate({
            sessionId: "br-1",
            callKind: "emission",
            messages: multiTurnMessages,
            userCachePrefixes: multiTurnPrefixes,
        });
        assert.deepEqual(inputs[1].system, [{ text: "card" }, { cachePoint: { type: "default" } }]);
        assert.equal(JSON.stringify(inputs[1].messages).includes("cachePoint"), false);

        await bedrockFor("conversation").generate({
            sessionId: "br-1",
            callKind: "emission",
            messages: multiTurnMessages,
            userCachePrefixes: multiTurnPrefixes,
        });
        assert.deepEqual(inputs[2].system, [{ text: "card" }, { cachePoint: { type: "default" } }]);
        assert.deepEqual(inputs[2].messages, [
            { role: "user", content: [{ text: turn1Log }, { text: turn1Emission }] },
            { role: "assistant", content: [{ text: "await plurnk.note({\"text\":\"ok\"});" }, { cachePoint: { type: "default" } }] },
            {
                role: "user",
                content: [
                    { text: turn2Log },
                    { cachePoint: { type: "default" } },
                    { text: turn2Status },
                ],
            },
        ]);
    });

    await t.test("{§provider-sdk-boundary} prompt_cache_key affinity routes Kimi/Moonshot and xAI and clamps 64+ character session identifiers", async (t) => {
        const longSessionId = "s".repeat(80);
        const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
        t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
            const urlStr = String(url);
            requests.push({ url: urlStr, body: JSON.parse(requestBody(init)) as Record<string, unknown> });
            return response(urlStr.includes("/responses") ? "responses" : "chat");
        });
        const kimi = catalogProviderFromEnv("kimi-code-plan-global", withProviderDefaults({
            KIMI_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        }), "k3", "https://kimi.test/coding/v1");
        assert.ok(kimi);
        await kimi.generate({
            sessionId: longSessionId,
            callKind: "emission",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(requests[0].body.prompt_cache_key, "s".repeat(64));

        const xai = catalogProviderFromEnv("xai", withProviderDefaults({
            XAI_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        }), "grok-4.20-0309-non-reasoning", "https://xai.test/v1");
        assert.ok(xai);
        await xai.generate({
            sessionId: longSessionId,
            callKind: "emission",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(requests[1].body.prompt_cache_key, "s".repeat(64));
    });

    await t.test("{§provider-sdk-boundary} coalesced tool_result + user cache breakpoints across Anthropic, Bedrock, OpenRouter Anthropic, and OpenAI explicit (#1482)", async (t) => {
        const anthropicRequests: Record<string, unknown>[] = [];
        const chatRequests: Record<string, unknown>[] = [];
        const bedrockInputs: Record<string, unknown>[] = [];
        t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
            const urlStr = String(url);
            const parsed = JSON.parse(requestBody(init)) as Record<string, unknown>;
            if (urlStr.includes("/messages")) {
                anthropicRequests.push(parsed);
                return response("messages");
            }
            chatRequests.push(parsed);
            return response("chat");
        });
        t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: { input: unknown }) => {
            bedrockInputs.push(structuredClone(command.input as Record<string, unknown>));
            return {
                $metadata: { httpStatusCode: 200, requestId: "req-tool-cache" },
                stream: (async function* () {
                    yield { messageStart: { role: "assistant" } };
                    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } };
                    yield { contentBlockStop: { contentBlockIndex: 0 } };
                    yield { messageStop: { stopReason: "end_turn" } };
                    yield { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } } };
                })(),
            };
        });

        const toolCalls = [
            { id: "call_1_1_0", name: "mcp", arguments: { server: "plurnk", tool: "find", arguments: { path: "*" } } },
            { id: "call_1_1_1", name: "mcp", arguments: { server: "plurnk", tool: "read", arguments: { path: "README.md" } } },
        ];
        // Case A: zero-prefix volatile status tail after two tool results -> breakpoint lands on last tool_result, NEVER on volatile status tail!
        const zeroPrefixMessages = [
            { role: "system" as const, content: "card" },
            { role: "user" as const, content: turn1Log },
            { role: "assistant" as const, content: "", toolCalls },
            { role: "tool" as const, toolCallId: "call_1_1_0", toolName: "mcp", content: "### log:///1/1/2/find" },
            { role: "tool" as const, toolCallId: "call_1_1_1", toolName: "mcp", content: "### log:///1/1/3/read" },
            { role: "user" as const, content: turn2Status },
        ];
        const zeroPrefixHints = [undefined, undefined, undefined, undefined, undefined, { kind: "chars" as const, length: 0 }];

        // Case B: durable user prompt + volatile status tail + PDF after tool results -> PDF becomes document, breakpoint splits durable prompt!
        const splitMessages = [
            { role: "system" as const, content: "card" },
            { role: "user" as const, content: turn1Log },
            { role: "assistant" as const, content: "", toolCalls: [toolCalls[0]] },
            { role: "tool" as const, toolCallId: "call_1_1_0", toolName: "mcp", content: "### log:///1/1/2/find" },
            {
                role: "user" as const,
                content: [
                    { type: "text" as const, text: turn2Log },
                    { type: "file" as const, data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mediaType: "application/pdf" },
                    { type: "text" as const, text: turn2Status },
                ],
            },
        ];
        const splitHints = [undefined, undefined, undefined, undefined, { kind: "parts" as const, count: 2 }];

        const anthropic = catalogProviderFromEnv("minimax-coding-plan", withProviderDefaults({
            MINIMAX_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "conversation",
        }), "MiniMax-M2.1", "https://minimax.test/anthropic/v1");
        assert.ok(anthropic);
        await anthropic.generate({ sessionId: "tc-a", callKind: "emission", messages: zeroPrefixMessages, userCachePrefixes: zeroPrefixHints });
        const anthZeroWire = anthropicRequests[0].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
        assert.equal(anthZeroWire.length, 3);
        assert.deepEqual(anthZeroWire[1].content.at(-1)?.cache_control, { type: "ephemeral" });
        assert.equal(anthZeroWire[2].content.length, 3);
        assert.equal(anthZeroWire[2].content[0].cache_control, undefined);
        assert.deepEqual(anthZeroWire[2].content[1].cache_control, { type: "ephemeral" }, "last tool_result marked before volatile status block");
        assert.equal(anthZeroWire[2].content[2].cache_control, undefined, "volatile status block stays uncached");

        await anthropic.generate({ sessionId: "tc-a", callKind: "emission", messages: splitMessages, userCachePrefixes: splitHints });
        const anthSplitWire = anthropicRequests[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
        assert.equal(anthSplitWire[2].content[0].type, "tool_result");
        assert.equal(anthSplitWire[2].content[2].type, "document", "PDF part after coalesced tool_result becomes document");
        assert.deepEqual(anthSplitWire[2].content[2].cache_control, { type: "ephemeral" }, "PDF part at durable boundary gets cache_control");
        assert.equal(anthSplitWire[2].content[3].cache_control, undefined);

        const bedrock = catalogProviderFromEnv("amazon-bedrock", withProviderDefaults({
            AWS_BEARER_TOKEN_BEDROCK: "fixture-key",
            AWS_REGION: "us-east-1",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "conversation",
        }), "us.anthropic.claude-sonnet-4-6");
        assert.ok(bedrock);
        await bedrock.generate({ sessionId: "tc-b", callKind: "emission", messages: zeroPrefixMessages, userCachePrefixes: zeroPrefixHints });
        const bedZeroWire = bedrockInputs[0].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
        assert.equal(bedZeroWire.length, 3);
        assert.deepEqual(bedZeroWire[2].content[2], { cachePoint: { type: "default" } }, "Bedrock cachePoint sits right after toolResult blocks and ahead of volatile status");
        assert.deepEqual(bedZeroWire[2].content[3], { text: turn2Status });

        const openrouterAnthropic = catalogProviderFromEnv("openrouter", withProviderDefaults({
            OPENROUTER_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "conversation",
        }), "anthropic/claude-sonnet-4.6", "https://openrouter.test/api/v1");
        assert.ok(openrouterAnthropic);
        await openrouterAnthropic.generate({
            sessionId: "tc-or",
            callKind: "emission",
            messages: [
                ...zeroPrefixMessages.slice(0, -1),
                { role: "user", content: turn2Log + turn2Status },
            ],
            userCachePrefixes: [undefined, undefined, undefined, undefined, undefined, { kind: "chars", length: turn2Log.length }],
        });
        const orMsgs = chatRequests[0].messages as Array<Record<string, unknown>>;
        const lastToolMsg = orMsgs[orMsgs.length - 2];
        assert.equal(lastToolMsg.role, "tool");
        assert.deepEqual(lastToolMsg.content, [{ type: "text", text: "### log:///1/1/3/read", cache_control: { type: "ephemeral" } }]);
        assert.deepEqual(orMsgs.at(-1), {
            role: "user",
            content: [
                { type: "text", text: turn2Log, cache_control: { type: "ephemeral" } },
                { type: "text", text: turn2Status },
            ],
        });

        await openrouterAnthropic.generate({
            sessionId: "tc-or",
            callKind: "emission",
            messages: zeroPrefixMessages,
            userCachePrefixes: zeroPrefixHints,
        });
        const orZeroMsgs = chatRequests[1].messages as Array<Record<string, unknown>>;
        assert.equal(JSON.stringify(orZeroMsgs.at(-1)).includes("cache_control"), false, "zero-prefix final user message never gets cache_control");

        const gpt6 = catalogProviderFromEnv("openrouter", withProviderDefaults({
            OPENROUTER_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "conversation",
        }), "openai/gpt-6-luna", "https://openrouter.test/api/v1");
        assert.ok(gpt6);
        await gpt6.generate({
            sessionId: "tc-gpt6",
            callKind: "emission",
            messages: zeroPrefixMessages,
            userCachePrefixes: zeroPrefixHints,
        });
        const gpt6ZeroMsgs = chatRequests[2].messages as Array<Record<string, unknown>>;
        assert.deepEqual(gpt6ZeroMsgs[gpt6ZeroMsgs.length - 2].content, [
            { type: "text", text: "### log:///1/1/3/read", prompt_cache_breakpoint: { mode: "explicit" } },
        ]);
        assert.equal(JSON.stringify(gpt6ZeroMsgs.at(-1)).includes("prompt_cache_breakpoint"), false, "zero-prefix final user message never gets prompt_cache_breakpoint");
    });

    await t.test("{§provider-sdk-boundary} {§provider-failure-normalization} Google merges consecutive user entries after functionResponse, marks only first parallel functionCall thoughtSignature, and retains usageMetadata on MALFORMED_RESPONSE", async (t) => {
        const googleBodies: Array<{
            contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        }> = [];
        let callIndex = 0;
        t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
            googleBodies.push(JSON.parse(requestBody(init)) as typeof googleBodies[number]);
            callIndex += 1;
            if (callIndex === 1) {
                return new Response(`data: ${JSON.stringify({
                    responseId: "resp-malformed-resp",
                    candidates: [{
                        content: { role: "model", parts: [] },
                        finishReason: "MALFORMED_RESPONSE",
                    }],
                    usageMetadata: {
                        promptTokenCount: 200,
                        candidatesTokenCount: 0,
                        thoughtsTokenCount: 45,
                        cachedContentTokenCount: 150,
                        totalTokenCount: 245,
                    },
                })}\n\n`, { headers: { "content-type": "text/event-stream" } });
            }
            return new Response(`data: ${JSON.stringify({
                responseId: "resp-ok",
                candidates: [{
                    content: {
                        role: "model",
                        parts: [
                            { functionCall: { id: "c_next", name: "mcp", args: { server: "plurnk", tool: "done", arguments: { text: "Compared." } } } },
                        ],
                    },
                    finishReason: "STOP",
                }],
                usageMetadata: {
                    promptTokenCount: 200,
                    candidatesTokenCount: 18,
                    thoughtsTokenCount: 12,
                    cachedContentTokenCount: 150,
                    totalTokenCount: 230,
                },
            })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        });

        const gemini = catalogProviderFromEnv("google", withProviderDefaults({
            GOOGLE_GENERATIVE_AI_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "1",
        }), "gemini-4-hydrogen");
        assert.ok(gemini);

        const observedRequests: Array<{ usage?: unknown }> = [];
        const res = await gemini.generate({
            sessionId: "tc-google",
            callKind: "emission",
            observeRequest: async () => async (acc) => {
                observedRequests.push(acc);
            },
            messages: [
                { role: "system", content: "# Plurnk Session" },
                { role: "user", content: "## Log\n\n### log:///3/1/1/send\nCompare floors." },
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [
                        { id: "call_3_1_0", name: "mcp", arguments: { server: "plurnk", tool: "sh", arguments: { text: "ls -la ../plurnk-bench/" } } },
                        { id: "call_3_1_1", name: "mcp", arguments: { server: "plurnk", tool: "note", arguments: { text: "Check plurnk-bench." } } },
                    ],
                },
                { role: "tool", toolCallId: "call_3_1_0", toolName: "mcp", content: "### log:///3/1/3/sh\n{\"stream\":\"sh:///d6abe40a\"}" },
                { role: "tool", toolCallId: "call_3_1_1", toolName: "mcp", content: "### log:///3/1/4/note" },
                { role: "user", content: "### log:///3/2/1/read (sh:///d6abe40a#stdout)\ntotal 328\n\n## Session\n{\"turn\":2}" },
            ],
        });
        assert.equal(res.assistant.toolCalls?.length, 1);
        assert.equal(googleBodies.length, 2);
        const sentContents = googleBodies[0].contents ?? [];
        assert.deepEqual(
            sentContents.map((entry) => entry.role),
            ["user", "model", "user"],
            "functionResponse parts and trailing user status coalesce into strictly alternating user/model/user roles",
        );
        const modelParts = sentContents[1].parts;
        assert.equal(modelParts.length, 2);
        assert.equal(modelParts[0].thoughtSignature, "skip_thought_signature_validator");
        assert.equal(modelParts[1].thoughtSignature, undefined, "parallel sibling functionCall parts omit duplicate skip_thought_signature_validator");
        const finalUserParts = sentContents[2].parts;
        assert.equal(
            finalUserParts.length,
            2,
            "trailing user packet text folds into the final functionResponse instead of mixing functionResponse and text parts",
        );
        const secondFnResp = (finalUserParts[1].functionResponse as { response?: { output?: string } } | undefined)?.response?.output ?? "";
        assert.match(secondFnResp, /### log:\/\/\/3\/1\/4\/note/u);
        assert.match(secondFnResp, /### log:\/\/\/3\/2\/1\/read \(sh:\/\/\/d6abe40a#stdout\)/u);
        assert.match(secondFnResp, /## Session\n\{"turn":2\}/u);
        assert.deepEqual(observedRequests[0].usage, {
            inputTokens: 200,
            outputTokens: 45,
            totalTokens: 245,
            inputTokenDetails: { noCacheTokens: 50, cacheReadTokens: 150, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 45 },
        }, "MALFORMED_RESPONSE chunk retains usageMetadata accounting even when SDK mapStopReason throws");
    });

    await t.test("{§provider-sdk-boundary} {§provider-request-authority} preserves same-model Google thoughtSignature and Anthropic signed thinking blocks across turns while falling back safely on cross-model or displaced calls", async (t) => {
        const googleSig = Buffer.from("gemini-thought-sig-turn-1").toString("base64");
        const googleBodies: Array<{
            contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        }> = [];
        const anthropicBodies: Array<{
            messages?: Array<{ role: string; content: unknown }>;
        }> = [];

        t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("anthropic.com")) {
                anthropicBodies.push(JSON.parse(requestBody(init)) as typeof anthropicBodies[number]);
                const sse = [
                    `event: message_start\ndata: ${JSON.stringify({
                        type: "message_start",
                        message: { id: "msg_anth_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } },
                    })}`,
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting module state." } })}`,
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "anth-sig-001" } })}`,
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "redacted-blob-001" } })}`,
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "mcp", input: {} } })}`,
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify({ server: "plurnk", tool: "read", arguments: { path: "a.ts" } }) } })}`,
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 2 })}`,
                    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } })}`,
                    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
                ].join("\n\n") + "\n\n";
                return new Response(sse, { headers: { "content-type": "text/event-stream" } });
            }
            googleBodies.push(JSON.parse(requestBody(init)) as typeof googleBodies[number]);
            return new Response(`data: ${JSON.stringify({
                responseId: "resp-sig",
                candidates: [{
                    content: {
                        role: "model",
                        parts: [
                            { thought: true, text: "Check Rational._eval_power." },
                            {
                                functionCall: { id: "g_call_1", name: "mcp", args: { server: "plurnk", tool: "read", arguments: { path: "numbers.py" } } },
                                thoughtSignature: googleSig,
                            },
                            {
                                functionCall: { id: "g_call_2", name: "mcp", args: { server: "plurnk", tool: "note", arguments: { text: "Checking numbers." } } },
                            },
                        ],
                    },
                    finishReason: "STOP",
                }],
                usageMetadata: {
                    promptTokenCount: 180,
                    candidatesTokenCount: 25,
                    thoughtsTokenCount: 30,
                    cachedContentTokenCount: 100,
                    totalTokenCount: 235,
                },
            })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        });

        const gemini = catalogProviderFromEnv("google", withProviderDefaults({
            GOOGLE_GENERATIVE_AI_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }), "gemini-4-hydrogen");
        assert.ok(gemini);

        const turn1 = await gemini.generate({
            sessionId: "tc-google-sig",
            callKind: "emission",
            messages: [
                { role: "system", content: "# Plurnk Session" },
                { role: "user", content: "Inspect numbers.py." },
            ],
        });
        assert.equal(turn1.assistant.toolCalls?.[0]?.thoughtSignature, googleSig);
        assert.equal(turn1.assistant.toolCalls?.[1]?.thoughtSignature, undefined);
        const turn1Raw = turn1.assistantRaw as { wire?: { replay?: { api: string; provider: string; model: string; thinking?: Array<{ thinking: string }> } } };
        assert.deepEqual(turn1Raw.wire?.replay, {
            api: "google-generative-ai",
            provider: "google",
            model: "gemini-4-hydrogen",
            thinking: [{ thinking: "Check Rational._eval_power." }],
        });

        await gemini.generate({
            sessionId: "tc-google-sig",
            callKind: "emission",
            messages: [
                { role: "system", content: "# Plurnk Session" },
                { role: "user", content: "Inspect numbers.py." },
                // Same-model signed turn: preserves thought summary + real thoughtSignature
                {
                    role: "assistant",
                    content: "",
                    replay: {
                        api: "google-generative-ai",
                        provider: "google",
                        model: "gemini-4-hydrogen",
                        thinking: [{ thinking: "Check Rational._eval_power." }],
                    },
                    toolCalls: [
                        { id: "call_1_1_0", name: "mcp", arguments: { server: "plurnk", tool: "read", arguments: { path: "numbers.py" } }, thoughtSignature: googleSig },
                        { id: "call_1_1_1", name: "mcp", arguments: { server: "plurnk", tool: "note", arguments: { text: "Checking numbers." } } },
                    ],
                },
                { role: "tool", toolCallId: "call_1_1_0", toolName: "mcp", content: "### log:///1/1/2/read\nok" },
                { role: "tool", toolCallId: "call_1_1_1", toolName: "mcp", content: "### log:///1/1/3/note" },
                // Cross-model turn: strips incompatible signature and stamps skip_thought_signature_validator
                {
                    role: "assistant",
                    content: "",
                    replay: {
                        api: "anthropic-messages",
                        provider: "anthropic",
                        model: "claude-sonnet-4-6",
                        thinking: [{ thinking: "Anthropic thought.", thinkingSignature: "anth-sig" }],
                    },
                    toolCalls: [
                        { id: "call_1_2_0", name: "mcp", arguments: { server: "plurnk", tool: "note", arguments: { text: "Cross-model." } }, thoughtSignature: googleSig },
                    ],
                },
                { role: "tool", toolCallId: "call_1_2_0", toolName: "mcp", content: "### log:///1/2/2/note" },
                // Curated turn where leading call lacks signature: clears displaced signature and stamps firstFunctionCall
                {
                    role: "assistant",
                    content: "",
                    replay: {
                        api: "google-generative-ai",
                        provider: "google",
                        model: "gemini-4-hydrogen",
                    },
                    toolCalls: [
                        { id: "call_1_3_0", name: "mcp", arguments: { server: "plurnk", tool: "note", arguments: { text: "Lowered prose." } } },
                        { id: "call_1_3_1", name: "mcp", arguments: { server: "plurnk", tool: "read", arguments: { path: "b.py" } }, thoughtSignature: googleSig },
                    ],
                },
                { role: "tool", toolCallId: "call_1_3_0", toolName: "mcp", content: "### log:///1/3/2/note" },
                { role: "tool", toolCallId: "call_1_3_1", toolName: "mcp", content: "### log:///1/3/3/read\nok" },
                { role: "user", content: "## Session\n{\"turn\":4}" },
            ],
        });

        const replayContents = googleBodies[1].contents ?? [];
        const modelTurns = replayContents.filter((entry) => entry.role === "model");
        assert.equal(modelTurns.length, 3);
        assert.deepEqual(modelTurns[0].parts[0], { thought: true, text: "Check Rational._eval_power." });
        assert.equal(modelTurns[0].parts[1].thoughtSignature, googleSig);
        assert.equal(modelTurns[0].parts[2].thoughtSignature, undefined);
        assert.equal(modelTurns[1].parts.length, 1, "cross-model thinking block is dropped");
        assert.equal(modelTurns[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
        assert.equal(modelTurns[2].parts[0].thoughtSignature, "skip_thought_signature_validator");
        assert.equal(modelTurns[2].parts[1].thoughtSignature, undefined, "displaced later functionCall thoughtSignature is cleared");

        const claude = catalogProviderFromEnv("anthropic", withProviderDefaults({
            ANTHROPIC_API_KEY: "fixture-key",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
        }), "claude-sonnet-4-6");
        assert.ok(claude);

        const anthTurn1 = await claude.generate({
            sessionId: "tc-anth-sig",
            callKind: "emission",
            messages: [
                { role: "system", content: "# Plurnk Session" },
                { role: "user", content: "Read a.ts." },
            ],
        });
        const anthRaw = anthTurn1.assistantRaw as { wire?: { replay?: { api: string; provider: string; model: string; thinking?: unknown } } };
        assert.deepEqual(anthRaw.wire?.replay, {
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            thinking: [
                { thinking: "Inspecting module state.", thinkingSignature: "anth-sig-001" },
                { thinking: "[Reasoning redacted]", thinkingSignature: "redacted-blob-001", redacted: true },
            ],
        });

        await claude.generate({
            sessionId: "tc-anth-sig",
            callKind: "emission",
            messages: [
                { role: "system", content: "# Plurnk Session" },
                { role: "user", content: "Read a.ts." },
                {
                    role: "assistant",
                    content: "",
                    replay: {
                        api: "anthropic-messages",
                        provider: "anthropic",
                        model: "claude-sonnet-4-6",
                        thinking: [
                            { thinking: "Inspecting module state.", thinkingSignature: "anth-sig-001" },
                            { thinking: "", thinkingSignature: "redacted-blob-001", redacted: true },
                        ],
                    },
                    toolCalls: [
                        { id: "call_1_1_0", name: "mcp", arguments: { server: "plurnk", tool: "read", arguments: { path: "a.ts" } } },
                    ],
                },
                { role: "tool", toolCallId: "call_1_1_0", toolName: "mcp", content: "### log:///1/1/2/read\nok" },
                { role: "user", content: "## Session\n{\"turn\":2}" },
            ],
        });

        const anthMessages = anthropicBodies[1].messages ?? [];
        const anthAssistant = anthMessages.find((entry) => entry.role === "assistant") as { content?: Array<Record<string, unknown>> } | undefined;
        assert.ok(anthAssistant && Array.isArray(anthAssistant.content));
        assert.deepEqual(anthAssistant.content[0], {
            type: "thinking",
            thinking: "Inspecting module state.",
            signature: "anth-sig-001",
        });
        assert.deepEqual(anthAssistant.content[1], {
            type: "redacted_thinking",
            data: "redacted-blob-001",
        });
        assert.equal(anthAssistant.content[2].type, "tool_use");
        assert.deepEqual(anthAssistant.content[2].cache_control, { type: "ephemeral" });
    });
});
}
