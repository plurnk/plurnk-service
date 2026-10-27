import test, { mock } from "node:test";
import assert from "node:assert/strict";
import ModelProvider, { type ModelProviderConfig } from "./ModelProvider.ts";
import { configuredProviderInfo, createProviderModel, providerReadiness } from "./modelAdapters.ts";
import { withProviderDefaults } from "./defaults.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { catalogProviderFromEnv } from "./catalogProvider.ts";
import { requestBody, requestUrl } from "../../scripts/lib/test-fetch.ts";
import { loadActiveProvider } from "./ProviderRegistry.ts";

test("{§model-fact-resolution} one env declaration holds one credential name", () => {
    assert.deepEqual(configuredProviderInfo("acme-cloud", {
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_ADAPTER: "openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_BASE_URL: "https://api.acme.test/v1",
        PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_API_KEY_ENV: "ACME_API_KEY",
    }), {
        id: "acme-cloud",
        name: "acme-cloud",
        adapter: "openai-compatible",
        env: ["ACME_API_KEY"],
        api: "https://api.acme.test/v1",
    });
    assert.throws(
        () => configuredProviderInfo("acme-cloud", {
            PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_ADAPTER: "openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_ACME_CLOUD_API_KEY_ENV: "ACME_API_KEY,ACME_TOKEN",
        }),
        /one exact name, never an ordered fallback/,
    );
});

test("{§provider-configuration}: readiness uses the construction credential and endpoint requirements without exposing values", () => {
    assert.deepEqual(providerReadiness("google", {}), {
        ready: false,
        causes: [{
            kind: "credential",
            alternatives: [["GOOGLE_API_KEY"], ["GOOGLE_GENERATIVE_AI_API_KEY"], ["GEMINI_API_KEY"]],
        }],
    });
    assert.deepEqual(providerReadiness("google", { GEMINI_API_KEY: "secret-value" }), {
        ready: true,
        causes: [],
    });
    assert.doesNotMatch(JSON.stringify(providerReadiness("google", { GEMINI_API_KEY: "secret-value" })), /secret-value/);

    assert.deepEqual(providerReadiness("cloudflare-workers-ai", { CLOUDFLARE_API_KEY: "key" }), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["CLOUDFLARE_ACCOUNT_ID"]],
        }],
    });
    assert.deepEqual(providerReadiness("cloudflare-workers-ai", {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "key",
    }), { ready: true, causes: [] });
});

test("{§provider-configuration}: Bedrock reports its actual alternative authentication sets and region requirement", () => {
    assert.deepEqual(providerReadiness("amazon-bedrock", {}), {
        ready: false,
        causes: [{
            kind: "credential",
            alternatives: [
                ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
                ["AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_REGION"],
                ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
                ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
            ],
        }],
    });
    assert.deepEqual(providerReadiness("amazon-bedrock", {
        AWS_BEARER_TOKEN_BEDROCK: "bearer",
        AWS_REGION: "us-east-1",
    }), { ready: true, causes: [] });
    assert.deepEqual(providerReadiness("amazon-bedrock", {
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
    }), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["AWS_REGION"], ["AWS_DEFAULT_REGION"]],
        }],
    });
});

test("{§provider-configuration}: operator-declared unauthenticated compatible endpoints are ready without an invented credential", () => {
    assert.deepEqual(providerReadiness("acme", {
        PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTER: "openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL: "http://127.0.0.1:9000/v1",
    }), { ready: true, causes: [] });
});

test("{§provider-configuration}: an authenticated operator declaration reports its missing credential-name configuration", () => {
    const env = {
        PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTER: "openai",
    };
    assert.deepEqual(providerReadiness("acme", env), {
        ready: false,
        causes: [{
            kind: "configuration",
            alternatives: [["PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV"]],
        }],
    });
    assert.throws(
        () => createProviderModel("acme", "model", env),
        /PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV must be set/,
    );
});

test("{§provider-sdk-boundary} createProviderModel constructs Cerebras from Models.dev facts", () => {
    const sdk = createProviderModel("cerebras", "gemma-4-31b", {
        CEREBRAS_API_KEY: "test-key",
    });
    assert.notEqual(sdk, null);
    assert.equal(sdk?.catalog?.adapter, "cerebras");
    assert.notEqual(sdk?.modelTransport, undefined);
    assert.equal(sdk?.compatible, undefined);
});

test("{§provider-effort} adapter construction does not freeze request-local reasoning controls", () => {
    const source = createProviderModel("openrouter", "z-ai/glm-5.3-flash", {
        OPENROUTER_API_KEY: "test-key",
    })?.modelTransport;
    assert.equal(typeof source, "function");
    const model = (typeof source === "function" ? source(globalThis.fetch) : source) as { settings?: { reasoning?: unknown } };
    assert.ok(model);
    assert.equal(model.settings?.reasoning, undefined);
});

test("{§provider-request-authority} attribution rejects malformed URLs", () => {
    assert.throws(
        () => createProviderModel("openrouter", "openai/gpt-5", {
            OPENROUTER_API_KEY: "key",
            PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL: "plurnk",
        }),
        /PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL must be an absolute HTTP\(S\) URL/,
    );
});

test("{§provider-effort} the Google adapter owns its readable-reasoning response projection", () => {
    assert.deepEqual(
        createProviderModel("google", "gemini-flash-latest", { GEMINI_API_KEY: "test-key" })?.reasoningResponseProviderOptions,
        { google: { thinkingConfig: { includeThoughts: true } } },
    );
    assert.equal(
        createProviderModel("cerebras", "gemma-4-31b", { CEREBRAS_API_KEY: "test-key" })?.reasoningResponseProviderOptions,
        undefined,
    );
});

test("{§provider-monetary-evidence} createProviderModel attaches DeepInfra's documented response-cost normalizer", () => {
    const sdk = createProviderModel("deepinfra", "zai-org/GLM-5.2", {
        DEEPINFRA_API_KEY: "test-key",
    });
    assert.notEqual(sdk?.modelTransport, undefined);
    assert.deepEqual(sdk?.normalizeCost?.({
        usage: { estimated_cost: 5.04e-5 },
        response: { id: "response-1" },
    }), {
        kind: "estimated",
        amount: { amount: "0.0000504", currency: "USD" },
        source: "DeepInfra response usage.estimated_cost",
    });
});

test("{§model-fact-resolution} catalog credential names are law without any package or operator alias", () => {
    const sdk = createProviderModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", withProviderDefaults({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_KEY: "key",
    }));
    assert.equal(sdk?.modelTransport, undefined);
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        headers: { Authorization: "Bearer key" },
    });
    assert.deepEqual(sdk?.cacheAffinity, { target: "header", name: "x-session-affinity" });
});

test("{§model-fact-resolution} an operator credential override holds one exact name", () => {
    const sdk = createProviderModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", {
        CLOUDFLARE_ACCOUNT_ID: "account",
        MY_ORG_CLOUDFLARE_KEY: "key",
        PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_API_KEY_ENV: "MY_ORG_CLOUDFLARE_KEY",
    });
    assert.deepEqual(sdk?.compatible, {
        url: "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
        headers: { Authorization: "Bearer key" },
    });
});

test("{§model-fact-resolution} ordered credential fallbacks are rejected at construction", () => {
    assert.throws(
        () => createProviderModel("cloudflare-workers-ai", "@cf/google/gemma-4-26b-a4b-it", {
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_TOKEN: "token",
            PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_API_KEY_ENV: "CLOUDFLARE_API_TOKEN,CLOUDFLARE_API_KEY",
        }),
        /one exact name, never an ordered fallback/,
    );
    assert.throws(
        () => createProviderModel("acme", "model", {
            PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTER: "openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY,ACME_TOKEN",
        }),
        /one exact name, never an ordered fallback/,
    );
});

test("{§provider-sdk-boundary} the adapter supplies each documented cache-affinity projection", () => {
    assert.deepEqual(
        createProviderModel("openai", "gpt-4.1-mini", withProviderDefaults({ OPENAI_API_KEY: "key" }))?.cacheAffinity,
        { target: "provider-option", provider: "openai", name: "promptCacheKey" },
    );
    assert.deepEqual(
        createProviderModel("deepinfra", "zai-org/GLM-5.2", withProviderDefaults({ DEEPINFRA_API_KEY: "key" }))?.cacheAffinity,
        { target: "provider-option", provider: "deepinfra", name: "prompt_cache_key" },
    );
    assert.deepEqual(
        createProviderModel("openrouter", "openai/gpt-5", withProviderDefaults({ OPENROUTER_API_KEY: "key" }))?.cacheAffinity,
        { target: "header", name: "x-session-id" },
    );
    assert.deepEqual(
        createProviderModel("fireworks-ai", "accounts/fireworks/models/test", withProviderDefaults({ FIREWORKS_API_KEY: "key" }))?.cacheAffinity,
        { target: "header", name: "x-session-affinity" },
    );
    assert.equal(createProviderModel("cerebras", "gemma-4-31b", { CEREBRAS_API_KEY: "key" })?.cacheAffinity, undefined);
});

test("{§provider-sdk-boundary} explicit stable-system cache breakpoints exist only where a provider supports them", () => {
    const cacheControl = { type: "ephemeral" };
    const system = (provider: string, model: string, env: NodeJS.ProcessEnv) => createProviderModel(provider, model, withProviderDefaults(env))?.systemCacheProviderOptions;
    assert.deepEqual(system("anthropic", "claude-sonnet-4-6", { ANTHROPIC_API_KEY: "key" }), { anthropic: { cacheControl } });
    assert.deepEqual(system("openrouter", "anthropic/claude-sonnet-4.6", { OPENROUTER_API_KEY: "key" }), { openrouter: { cacheControl } });
    assert.deepEqual(system("openrouter", "~anthropic/claude-sonnet-latest", { OPENROUTER_API_KEY: "key" }), { openrouter: { cacheControl } });
    assert.equal(system("openrouter", "openai/gpt-5", { OPENROUTER_API_KEY: "key" }), undefined);
    assert.equal(system("deepseek", "deepseek-v4-flash", { DEEPSEEK_API_KEY: "key" }), undefined);
    assert.equal(system("minimax", "MiniMax-M2.5", { MINIMAX_API_KEY: "key" }), undefined, "another provider on the Anthropic adapter declares none");
});

test("{§provider-sdk-boundary} an operator-declared compatible provider receives no guessed cache extension", () => {
    const sdk = createProviderModel("acme", "model", {
        ACME_API_KEY: "key",
        PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTER: "openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL: "https://api.acme.test/v1",
        PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV: "ACME_API_KEY",
    });
    assert.equal(sdk?.cacheAffinity, undefined);
    assert.equal(sdk?.systemCacheProviderOptions, undefined);
});

test("{§provider-configuration} a cataloged compatible provider fails before transport when its declared credential is absent", () => {
    assert.throws(
        () => createProviderModel("deepseek", "deepseek-v4-flash", {}),
        /deepseek provider: DEEPSEEK_API_KEY must be set/,
    );
});

test("{§model-fact-resolution} createProviderModel fails clearly for a declared but unsupported adapter", () => {
    assert.throws(
        () => createProviderModel("acme", "model", {
            PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTER: "acme-custom",
        }),
        /unsupported provider adapter acme-custom/,
    );
});

// {§model-fact-resolution}: the catalog admits a provider only for an adapter it names, so every admitted
// provider constructs; an adapter on the generator's list without a construction here is a route that reports ready
// and then cannot run.
test("{§model-fact-resolution} every catalog provider constructs a model through its adapter", async () => {
    const { catalogSnapshot, lookupProvider } = await import("@plurnk/plurnk-models");
    const failures: string[] = [];
    for (const [provider, models] of Object.entries(catalogSnapshot())) {
        const info = lookupProvider(provider)!;
        const model = Object.keys(models)[0];
        const env = withProviderDefaults(Object.fromEntries(info.env.map((name) => [name, "test-value"])));
        try { if (createProviderModel(provider, model, env) === null) failures.push(`${provider} (${info.adapter}): no model`); }
        catch (cause) { failures.push(`${provider} (${info.adapter}): ${(cause as Error).message}`); }
    }
    assert.deepEqual(failures, []);
});

{
// {§provider-request-authority} — a configured service tier or logprobs count reaches a native route only
// through the option its adapter documents, and a control the adapter does not document is named, never
// dropped in silence (#988). Requests are captured as serialized; nothing leaves the host.

const KEYS = {
    OPENAI_API_KEY: "k", GROQ_API_KEY: "k", CEREBRAS_API_KEY: "k", MISTRAL_API_KEY: "k",
    XAI_API_KEY: "k", GOOGLE_GENERATIVE_AI_API_KEY: "k", ANTHROPIC_API_KEY: "k",
};

const nativeProvider = (provider: string, model: string, extra: Partial<ModelProviderConfig> = {}): ModelProvider => {
    const sdk = createProviderModel(provider, model, KEYS);
    assert.ok(sdk?.modelTransport, `${provider} is a native route`);
    return new ModelProvider({
        model, modelTransport: sdk.modelTransport, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        retryAttempts: 0, temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null },
        ...(sdk.requestControls === undefined ? {} : { requestControls: sdk.requestControls }),
        ...extra,
    });
};

const captureBodies = (respond: (body: Record<string, unknown>) => Response): Array<Record<string, unknown>> => {
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
        bodies.push(body);
        return respond(body);
    });
    return bodies;
};

const openAiReply = (body: Record<string, unknown>): Response => {
    const logprobs = { content: [{ token: "ok", logprob: -0.25, bytes: [111, 107], top_logprobs: [{ token: "ok", logprob: -0.25, bytes: [111, 107] }] }] };
    if (body.stream !== true) {
        return new Response(JSON.stringify({
            id: "c", object: "chat.completion", created: 1, model: "gpt-4.1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, logprobs, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { headers: { "content-type": "application/json" } });
    }
    const chunks = [
        { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, logprobs, finish_reason: null }] },
        { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4.1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};

for (const streaming of [true, false]) {
    test(`{§provider-request-authority} the native OpenAI route sends the service tier and logprobs it was configured with (${streaming ? "streaming" : "buffered"})`, async (t) => {
        t.after(() => mock.restoreAll());
        const bodies = captureBodies(openAiReply);
        const provider = nativeProvider("openai", "gpt-4.1", { serviceTier: "priority", topLogprobs: 3, streaming });
        const result = await provider.generate({ sessionId: "w", messages: [{ role: "user", content: "hello" }] });
        assert.equal(result.assistant.content, "ok");
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0].service_tier, "priority", "the tier rides the adapter's documented option");
        assert.equal(bodies[0].logprobs, true);
        assert.equal(bodies[0].top_logprobs, 3);
        if (!streaming) assert.equal(result.assistant.logprobs?.[0]?.token, "ok", "the requested evidence comes back");
    });
}

test("{§provider-request-authority} logprobs count 0 asks for the chosen token only", async (t) => {
    t.after(() => mock.restoreAll());
    const bodies = captureBodies(openAiReply);
    await nativeProvider("openai", "gpt-4.1", { topLogprobs: 0, streaming: false }).generate({ sessionId: "w", messages: [{ role: "user", content: "hello" }] });
    assert.equal(bodies[0].logprobs, true);
    assert.equal(bodies[0].top_logprobs, 0, "no alternative tokens are requested");
});

// Each adapter that documents a service tier serializes the configured value; the reply need not parse.
for (const [provider, model, tier] of [
    ["groq", "llama-3.3-70b-versatile", "flex"],
    ["cerebras", "gemma-4-31b", "flex"],
    ["xai", "grok-4", "priority"],
    ["google", "gemini-2.5-pro", "flex"],
    ["anthropic", "claude-sonnet-4-5", "auto"],
] as const) {
    test(`{§provider-request-authority} ${provider} receives its documented service tier`, async (t) => {
        t.after(() => mock.restoreAll());
        const bodies = captureBodies(() => new Response("{}", { status: 500 }));
        await nativeProvider(provider, model, { serviceTier: tier, streaming: false })
            .generate({ sessionId: "w", messages: [{ role: "user", content: "hello" }] })
            .catch(() => undefined);
        assert.equal(bodies.length, 1, "one request was serialized");
        assert.match(JSON.stringify(bodies[0]), new RegExp(`"(service_tier|serviceTier)":"${tier}"`, "u"));
    });
}

test("{§provider-request-authority} a control the adapter does not document is named once and not sent", async (t) => {
    t.after(() => mock.restoreAll());
    resetEmittedWarnings();
    const warned: string[] = [];
    mock.method(process, "emitWarning", (message: string, options: { code?: string }) => { warned.push(`${options.code}: ${message}`); });
    const bodies = captureBodies(() => new Response("{}", { status: 500 }));
    for (let i = 0; i < 2; i++) nativeProvider("mistral", "mistral-large-latest", { serviceTier: "flex", topLogprobs: 2, streaming: false });
    await nativeProvider("mistral", "mistral-large-latest", { serviceTier: "flex", topLogprobs: 2, streaming: false })
        .generate({ sessionId: "w", messages: [{ role: "user", content: "hello" }] })
        .catch(() => undefined);
    const named = warned.filter((line) => line.startsWith("PLURNK_REQUEST_CONTROL_UNSUPPORTED"));
    assert.equal(named.length, 2, "one warning per control, once per process");
    assert.match(named[0], /PLURNK_PROVIDERS_SERVICE_TIER is not a provider option this route's SDK \(mistral\) documents, so it is not sent/u);
    assert.match(named[1], /PLURNK_PROVIDERS_TOP_LOGPROBS/u);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /tier|logprob/iu, "nothing undocumented reaches the wire");
});

test("{§provider-request-authority} a compatible route keeps its body fields and refuses native controls", () => {
    assert.throws(() => new ModelProvider({
        model: "m", url: "https://example.test/v1/chat/completions", fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        retryAttempts: 0, temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null },
        requestControls: { namespace: "openai", serviceTier: true, logprobs: true },
    }), /native request controls require a model transport/u);
});

test("{§provider-request-authority} the catalog route carries the operator's tier and logprobs beside its cache key", async (t) => {
    t.after(() => mock.restoreAll());
    const bodies = captureBodies(openAiReply);
    const provider = catalogProviderFromEnv("openai", withProviderDefaults({
        OPENAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
        PLURNK_PROVIDERS_SERVICE_TIER: "priority",
        PLURNK_PROVIDERS_TOP_LOGPROBS: "2",
    }), "gpt-4.1-mini");
    assert.ok(provider);
    await provider.generate({ sessionId: "w-1", messages: [{ role: "user", content: "hello" }] });
    assert.equal(bodies[0].service_tier, "priority");
    assert.equal(bodies[0].logprobs, true);
    assert.equal(bodies[0].top_logprobs, 2);
    assert.equal(bodies[0].prompt_cache_key, "w-1", "the controls merge into the namespace the cache key uses");
});
}

{
const baseEnv = {
    PLURNK_MODEL: "sample_box",
    PLURNK_MODEL_sample_box: "fireworks-ai/accounts/fireworks/models/kimi-k3",
    FIREWORKS_API_KEY: "test-key",
    OPENAI_API_KEY: "test-key",
    PLURNK_PROVIDERS_EFFORT: "adaptive",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_PROBE_ATTEMPTS: "1",
    PLURNK_PROVIDERS_PROBE_DELAY: "0",
};

const installWire = () => {
    const calls: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/models")) return Response.json({ data: [{ id: "local", meta: { n_ctx: 8192 } }] });
        if (url.endsWith("/props")) return Response.json({ total_slots: 1 });
        if (url.endsWith("/input_tokens")) return Response.json({ input_tokens: 2 });
        calls.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
        return new Response([
            `data: ${JSON.stringify({
                id: "sampling-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
            })}`,
            "data: [DONE]",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    });
    return calls;
};

const generateArgs = { sessionId: "sampling-test", messages: [{ role: "user" as const, content: "hello" }] };
const samplingKeys = new Set(["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed"]);
const samplingOf = (body: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => samplingKeys.has(key)));

test.afterEach(() => mock.restoreAll());

for (const [name, route] of [
    ["catalog compatible", "fireworks-ai/accounts/fireworks/models/kimi-k3"],
    ["native OpenAI adapter", "openai/gpt-4.1-mini"],
    ["local compatible", "openai/local-sampling-test"],
] as const) {
    test(`{§provider-configuration}: ${name} carries alias sampling to the wire and caller values win`, async () => {
        const calls = installWire();
        const topK = name === "native OpenAI adapter" ? {} : { PLURNK_PROVIDERS_TOP_K_SAMPLE_BOX: "40" };
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_MODEL_sample_box: route,
            PLURNK_BASEURL_sample_box: "http://sampling.test/v1",
            PLURNK_PROVIDERS_TEMPERATURE: "0.6",
            PLURNK_PROVIDERS_TEMPERATURE_SAMPLE_BOX: "1",
            PLURNK_PROVIDERS_TOP_P: "0.95",
            PLURNK_PROVIDERS_TOP_P_SAMPLE_BOX: "1",
            ...topK,
            PLURNK_PROVIDERS_PRESENCE_PENALTY_SAMPLE_BOX: "0.25",
            PLURNK_PROVIDERS_FREQUENCY_PENALTY_SAMPLE_BOX: "-0.5",
            PLURNK_PROVIDERS_SEED_SAMPLE_BOX: "0",
        });
        assert.equal((await provider.generate(generateArgs)).assistant.content, "ok");
        assert.deepEqual(samplingOf(calls[0]), {
            temperature: 1,
            top_p: 1,
            ...(name === "native OpenAI adapter" ? {} : { top_k: 40 }),
            presence_penalty: 0.25,
            frequency_penalty: -0.5,
            seed: 0,
        });
        const sampling = {
            temperature: 0,
            top_p: 0.7,
            ...(name === "native OpenAI adapter" ? {} : { top_k: 10 }),
            presence_penalty: 0,
            frequency_penalty: 0,
            seed: 17,
        };
        await provider.generate({ ...generateArgs, sampling });
        assert.deepEqual(samplingOf(calls[1]), sampling);
    });

    test(`{§provider-configuration}: ${name} omits unset sampling and ignores other aliases`, async () => {
        const calls = installWire();
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_MODEL_sample_box: route,
            PLURNK_BASEURL_sample_box: "http://sampling.test/v1",
            PLURNK_PROVIDERS_TOP_P_other: "0.5",
            PLURNK_PROVIDERS_TOP_K_other: "20",
            PLURNK_PROVIDERS_PRESENCE_PENALTY_other: "1",
            PLURNK_PROVIDERS_SEED_other: "42",
        });
        await provider.generate(generateArgs);
        assert.deepEqual(samplingOf(calls[0]), {});
    });
}

test("{§provider-configuration}: empty alias tuning retains the configured global value", async () => {
    const calls = installWire();
    const provider = await loadActiveProvider({ ...baseEnv, PLURNK_PROVIDERS_TOP_P: "0.8", PLURNK_PROVIDERS_TOP_P_sample_box: "" });
    await provider.generate(generateArgs);
    assert.deepEqual(samplingOf(calls[0]), { top_p: 0.8 });
});

test("{§provider-configuration}: numeric boundaries remain values, not absence", async () => {
    const calls = installWire();
    for (const value of [-2, 2]) {
        const provider = await loadActiveProvider({
            ...baseEnv,
            PLURNK_PROVIDERS_TOP_P_sample_box: "0",
            PLURNK_PROVIDERS_TOP_K_sample_box: "0",
            PLURNK_PROVIDERS_PRESENCE_PENALTY_sample_box: String(value),
            PLURNK_PROVIDERS_FREQUENCY_PENALTY_sample_box: String(value),
            PLURNK_PROVIDERS_SEED_sample_box: "-1",
        });
        await provider.generate(generateArgs);
        assert.deepEqual(samplingOf(calls.at(-1)), {
            top_p: 0, top_k: 0, presence_penalty: value, frequency_penalty: value, seed: -1,
        });
    }
});

test("{§provider-configuration}: native Google adapter maps every sampling control the current model takes", async () => {
    let config: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
        config = (JSON.parse(requestBody(init)) as { generationConfig: Record<string, unknown> }).generationConfig;
        return new Response(`data: ${JSON.stringify({
            responseId: "sampling-gemini",
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const provider = await loadActiveProvider({
        ...baseEnv,
        PLURNK_MODEL_sample_box: "google/gemini-flash-latest",
        GEMINI_API_KEY: "test-key",
        PLURNK_PROVIDERS_TEMPERATURE_sample_box: "0.6",
        PLURNK_PROVIDERS_TOP_P_sample_box: "0.9",
        PLURNK_PROVIDERS_TOP_K_sample_box: "40",
        PLURNK_PROVIDERS_PRESENCE_PENALTY_sample_box: "0.5",
        PLURNK_PROVIDERS_FREQUENCY_PENALTY_sample_box: "-0.5",
        PLURNK_PROVIDERS_SEED_sample_box: "42",
    });
    const result = await provider.generate(generateArgs);
    assert.equal(result.assistant.content, "ok");
    assert.ok(config);
    const { temperature, topP, topK, presencePenalty, frequencyPenalty, seed } = config;
    assert.deepEqual({ temperature, topP, topK, presencePenalty, frequencyPenalty, seed }, {
        temperature: 0.6, topP: 0.9, topK: 40, presencePenalty: 0.5, frequencyPenalty: -0.5, seed: 42,
    });
    assert.deepEqual(result.notices?.filter(({ kind }) => kind === "provider_warning") ?? [], []);
});

for (const [knob, values] of [
    ["TOP_P", ["-0.1", "1.1", "NaN", "Infinity"]],
    ["TOP_K", ["-1", "1.5", "NaN", "9007199254740992"]],
    ["PRESENCE_PENALTY", ["-2.1", "2.1", "NaN"]],
    ["FREQUENCY_PENALTY", ["-2.1", "2.1", "NaN"]],
    ["SEED", ["1.5", "NaN", "9007199254740992"]],
] as const) {
    test(`{§provider-configuration}: invalid ${knob} refuses before inference`, async () => {
        const calls = installWire();
        for (const value of values) {
            await assert.rejects(
                loadActiveProvider({ ...baseEnv, [`PLURNK_PROVIDERS_${knob}_sample_box`]: value }),
                new RegExp(`PLURNK_PROVIDERS_${knob} must`),
            );
        }
        assert.equal(calls.length, 0);
    });
}
}
