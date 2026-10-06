// {§provider-request-controls} — a configured service tier or logprobs count reaches a native route only
// through the option its SDK documents, and a control the SDK does not document is named, never
// dropped in silence (#988). Requests are captured as the SDK serialized them; nothing leaves the host.
import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import AiSdkProvider, { type AiSdkProviderConfig } from "./AiSdkProvider.ts";
import { createSdkModel } from "./sdkModels.ts";
import { resetEmittedWarnings } from "./warnings.ts";
import { catalogProviderFromEnv } from "./catalogProvider.ts";
import { withProviderDefaults } from "./defaults.ts";
import { OPERATOR_MODEL_OPTIONS } from "../test/operator-model-options.ts";

const KEYS = {
    OPENAI_API_KEY: "k", GROQ_API_KEY: "k", CEREBRAS_API_KEY: "k", MISTRAL_API_KEY: "k",
    XAI_API_KEY: "k", GOOGLE_GENERATIVE_AI_API_KEY: "k", ANTHROPIC_API_KEY: "k",
};

const nativeProvider = (provider: string, model: string, extra: Partial<AiSdkProviderConfig> = {}): AiSdkProvider => {
    const sdk = createSdkModel(provider, model, KEYS);
    assert.ok(sdk?.languageModel, `${provider} is a native route`);
    return new AiSdkProvider({
        model, languageModel: sdk.languageModel, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        retryAttempts: 0, temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null },
        ...(sdk.requestControls === undefined ? {} : { requestControls: sdk.requestControls }),
        ...extra,
    });
};

const captureBodies = (respond: (body: Record<string, unknown>) => Response): Array<Record<string, unknown>> => {
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
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
    test(`{§provider-request-controls} the native OpenAI route sends the service tier and logprobs it was configured with (${streaming ? "streaming" : "buffered"})`, async (t) => {
        t.after(() => mock.restoreAll());
        const bodies = captureBodies(openAiReply);
        const provider = nativeProvider("openai", "gpt-4.1", { serviceTier: "priority", topLogprobs: 3, streaming });
        const result = await provider.generate({ workerId: "w", messages: [{ role: "user", content: "hello" }] });
        assert.equal(result.assistant.content, "ok");
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0]!.service_tier, "priority", "the tier rides the SDK's documented option");
        assert.equal(bodies[0]!.logprobs, true);
        assert.equal(bodies[0]!.top_logprobs, 3);
        if (!streaming) assert.equal(result.assistant.logprobs?.[0]?.token, "ok", "the requested evidence comes back");
    });
}

test("{§provider-request-controls} logprobs count 0 asks for the chosen token only", async (t) => {
    t.after(() => mock.restoreAll());
    const bodies = captureBodies(openAiReply);
    await nativeProvider("openai", "gpt-4.1", { topLogprobs: 0, streaming: false }).generate({ workerId: "w", messages: [{ role: "user", content: "hello" }] });
    assert.equal(bodies[0]!.logprobs, true);
    assert.equal(bodies[0]!.top_logprobs, 0, "no alternative tokens are requested");
});

// Each SDK that documents a service tier serializes the configured value; the reply need not parse.
for (const [provider, model, tier] of [
    ["groq", "llama-3.3-70b-versatile", "flex"],
    ["cerebras", "gemma-4-31b", "flex"],
    ["xai", "grok-4", "priority"],
    ["google", "gemini-2.5-pro", "flex"],
    ["anthropic", "claude-sonnet-4-5", "auto"],
] as const) {
    test(`{§provider-request-controls} ${provider} receives its documented service tier`, async (t) => {
        t.after(() => mock.restoreAll());
        const bodies = captureBodies(() => new Response("{}", { status: 500 }));
        await nativeProvider(provider, model, { serviceTier: tier, streaming: false })
            .generate({ workerId: "w", messages: [{ role: "user", content: "hello" }] })
            .catch(() => undefined);
        assert.equal(bodies.length, 1, "one request was serialized");
        assert.match(JSON.stringify(bodies[0]), new RegExp(`"(service_tier|serviceTier)":"${tier}"`, "u"));
    });
}

test("{§provider-request-controls} a control the SDK does not document is named once and not sent", async (t) => {
    t.after(() => mock.restoreAll());
    resetEmittedWarnings();
    const warned: string[] = [];
    mock.method(process, "emitWarning", (message: string, options: { code?: string }) => { warned.push(`${options.code}: ${message}`); });
    const bodies = captureBodies(() => new Response("{}", { status: 500 }));
    for (let i = 0; i < 2; i++) nativeProvider("mistral", "mistral-large-latest", { serviceTier: "flex", topLogprobs: 2, streaming: false });
    await nativeProvider("mistral", "mistral-large-latest", { serviceTier: "flex", topLogprobs: 2, streaming: false })
        .generate({ workerId: "w", messages: [{ role: "user", content: "hello" }] })
        .catch(() => undefined);
    const named = warned.filter((line) => line.startsWith("PLURNK_REQUEST_CONTROL_UNSUPPORTED"));
    assert.equal(named.length, 2, "one warning per control, once per process");
    assert.match(named[0]!, /PLURNK_PROVIDERS_SERVICE_TIER is not a provider option this route's SDK \(mistral\) documents, so it is not sent/u);
    assert.match(named[1]!, /PLURNK_PROVIDERS_TOP_LOGPROBS/u);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /tier|logprob/iu, "nothing undocumented reaches the wire");
});

test("{§provider-request-controls} a compatible route keeps its body fields and refuses native controls", () => {
    assert.throws(() => new AiSdkProvider({
        model: "m", url: "https://example.test/v1/chat/completions", fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        retryAttempts: 0, temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null },
        requestControls: { namespace: "openai", serviceTier: true, logprobs: true },
    }), /native request controls require an AI SDK model/u);
});

test("{§provider-request-controls} the catalog route carries the operator's tier and logprobs beside its cache key", async (t) => {
    t.after(() => mock.restoreAll());
    const bodies = captureBodies(openAiReply);
    const provider = catalogProviderFromEnv("openai", withProviderDefaults({
        ...OPERATOR_MODEL_OPTIONS,
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
    await provider.generate({ workerId: "w-1", messages: [{ role: "user", content: "hello" }] });
    assert.equal(bodies[0]!.service_tier, "priority");
    assert.equal(bodies[0]!.logprobs, true);
    assert.equal(bodies[0]!.top_logprobs, 2);
    assert.equal(bodies[0]!.prompt_cache_key, "w-1", "the controls merge into the namespace the cache key uses");
});
