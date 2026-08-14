import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { ollamaProviderFromEnv } from "./ollama.ts";

const env = Object.freeze({
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "1000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "3000",
    PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "1000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REASONING: "off",
    PLURNK_PROVIDERS_TEMPERATURE: "0.2",
    PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15",
    PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0",
    PLURNK_PROVIDERS_REASONING_RESERVE: "10%",
    PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%",
    PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512",
    PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
    PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
});

test.afterEach(() => mock.restoreAll());

// {§model-fact-resolution}
test("#126: Ollama always probes model physics and applies an operator context-window ceiling", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response(JSON.stringify({
            model_info: { "qwen.context_length": 32_768 },
        }));
    });

    const windows: Array<number | null> = [];
    for (const operatorCap of [undefined, "8192", "65536"] as const) {
        const provider = await ollamaProviderFromEnv({
            ...env,
            ...(operatorCap === undefined ? {} : { PLURNK_PROVIDERS_CONTEXT_WINDOW: operatorCap }),
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434/v1" });
        windows.push(provider.contextWindow);
    }

    assert.deepEqual(windows, [32_768, 8_192, 32_768]);
    assert.deepEqual(calls, Array.from({ length: 3 }, () => "http://ollama.test:11434/api/show"));
});

test("#126: an operator ceiling does not hide an Ollama probe HTTP failure", async () => {
    mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    await assert.rejects(
        () => ollamaProviderFromEnv({
            ...env,
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434" }),
        /ollama provider: \/api\/show returned 503/,
    );
});

test("#126: an operator ceiling does not hide a missing Ollama model fact", async () => {
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ model_info: {} })));
    await assert.rejects(
        () => ollamaProviderFromEnv({
            ...env,
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        }, "qwen2.5-coder", { baseUrl: "http://ollama.test:11434" }),
        /ollama provider: \/api\/show has no \*\.context_length key for "qwen2\.5-coder"/,
    );
});
