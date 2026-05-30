import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

const baseEnv = Object.freeze({ PLURNK_FETCH_TIMEOUT: "600000", PLURNK_REASON: "0" });

const captureUrl = () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(url);
        const body = new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); },
        });
        return new Response(body, { status: 200 });
    });
    return calls;
};
test.afterEach(() => mock.restoreAll());

test("isStandardProvider: known vs unknown", () => {
    assert.equal(isStandardProvider("openai"), true);
    assert.equal(isStandardProvider("groq"), true);
    assert.equal(isStandardProvider("openrouter"), false); // bespoke sibling
    assert.equal(isStandardProvider("nope"), false);
});

test("standardProviderFromEnv: returns null for a non-standard name", () => {
    assert.equal(standardProviderFromEnv("openrouter", { ...baseEnv }, "m"), null);
});

test("openai: constructs with operator base, key optional, contextSize null", () => {
    const p = standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "macher.gguf");
    assert.notEqual(p, null);
    assert.equal(p!.model, "macher.gguf");
    assert.equal(p!.contextSize, null);
});

test("openai: throws a named error when OPENAI_BASE_URL is unset", () => {
    assert.throws(() => standardProviderFromEnv("openai", { ...baseEnv }, "m"), /OPENAI_BASE_URL must be set/);
});

test("openai: OPENAI_TOKENIZER=cl100k_base enables real tokenization", () => {
    const p = standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "cl100k_base" }, "m");
    assert.equal(p!.countTokens("hello world"), 2);
});

test("openai: defaults to heuristic tokenizer", () => {
    const p = standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    const s = "The quick brown fox.";
    assert.equal(p!.countTokens(s), Math.ceil(s.length / 4));
});

test("openai: invalid tokenizer value throws", () => {
    assert.throws(
        () => standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "bogus" }, "m"),
        /OPENAI_TOKENIZER must be one of/,
    );
});

test("groq: requires its API key", () => {
    assert.throws(() => standardProviderFromEnv("groq", { ...baseEnv }, "m"), /GROQ_API_KEY must be set/);
});

test("groq: applies PLURNK_PROVIDER_CONTEXT_SIZE", () => {
    const p = standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", PLURNK_PROVIDER_CONTEXT_SIZE: "131072" }, "m");
    assert.equal(p!.contextSize, 131072);
});

test("openai flexBaseStrip: base with trailing /v1 yields a single /v1/chat/completions", async () => {
    const p = standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x/v1" }, "m");
    const calls = captureUrl();
    await p!.generate({ messages: [] });
    assert.equal(calls[0], "http://x/v1/chat/completions");
});

test("fixed-base provider resolves the documented chat-completions URL", async () => {
    const p = standardProviderFromEnv("deepinfra", { ...baseEnv, DEEPINFRA_API_KEY: "k" }, "m");
    const calls = captureUrl();
    await p!.generate({ messages: [] });
    assert.equal(calls[0], "https://api.deepinfra.com/v1/openai/chat/completions");
});

test("baseUrlVar overrides the fixed default", async () => {
    const p = standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", GROQ_BASE_URL: "http://proxy/openai/v1" }, "m");
    const calls = captureUrl();
    await p!.generate({ messages: [] });
    assert.equal(calls[0], "http://proxy/openai/v1/chat/completions");
});

test("every registry entry resolves the chat URL the spec encodes", async () => {
    // Guards against a malformed base/chatPath pair sneaking into the table.
    const envFor = (name: string): NodeJS.ProcessEnv => ({
        ...baseEnv,
        OPENAI_BASE_URL: "http://x",
        ...Object.fromEntries([[STANDARD_PROVIDERS[name].apiKeyVar, "k"]]),
    });
    for (const name of Object.keys(STANDARD_PROVIDERS)) {
        const p = standardProviderFromEnv(name, envFor(name), "m");
        const calls = captureUrl();
        await p!.generate({ messages: [] });
        assert.ok(calls[0].endsWith("/chat/completions"), `${name} → ${calls[0]}`);
        assert.ok(calls[0].startsWith("http"), `${name} → ${calls[0]}`);
        mock.restoreAll();
    }
});
