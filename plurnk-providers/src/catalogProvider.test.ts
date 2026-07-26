import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { catalogProviderFromEnv } from "./catalogProvider.ts";
import { resetEmittedWarnings } from "./warnings.ts";

const env = {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REASONING: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_REASONING_RESERVE: "10%",
    PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "1",
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
    assert.equal(provider?.reasoningReserve, 16_384);
    assert.equal(provider?.completionReserve, 32_768);
    assert.ok((provider?.calculateCost({
        prompt: 1_000_000,
        completion: 1_000_000,
        reasoning: 0,
        cached: 0,
        total: 2_000_000,
    }) ?? 0) > 0);
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
        maxTokens: 64,
        sampling: { top_p: 0.8, seed: 7 },
    });

    assert.equal(result?.assistant.content, "done");
    assert.equal(result?.assistant.usage.total, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0]?.body.model, "gpt-4.1-mini");
    assert.equal(calls[0]?.body.temperature, 0.2);
    assert.equal(calls[0]?.body.top_p, 0.8);
    assert.equal(calls[0]?.body.seed, 7);
    assert.equal(calls[0]?.body.max_tokens, 64);
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
    }, "not-in-the-catalog");
    assert.equal(provider?.contextWindow, 8192);
});

test("explicit operator rates price out-of-snapshot models and override catalog rates", () => {
    const priced = {
        ...env,
        XAI_API_KEY: "test-key",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_INPUT_USD_PER_MILLION: "2",
        PLURNK_PROVIDERS_CACHE_READ_USD_PER_MILLION: "0.5",
        PLURNK_PROVIDERS_OUTPUT_USD_PER_MILLION: "8",
    };
    const usage = {
        prompt: 1_000_000,
        cached: 250_000,
        completion: 500_000,
        reasoning: 500_000,
        total: 2_000_000,
    };
    assert.equal(catalogProviderFromEnv("xai", priced, "not-in-the-catalog")?.calculateCost(usage), 9.625);
    assert.equal(catalogProviderFromEnv("openai", priced, "gpt-4.1-mini")?.calculateCost(usage), 9.625);
});
