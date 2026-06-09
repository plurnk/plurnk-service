import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

const baseEnv = Object.freeze({ PLURNK_FETCH_TIMEOUT: "600000", PLURNK_REASON: "0" });

// Mock fetch: serves GET /v1/models (the n_ctx probe) and a [DONE] stream for
// /chat/completions (generate). `nctx` controls the probed window. Records URLs.
const mockEndpoint = ({ nctx, modelId = "m" }: { nctx?: number; modelId?: string } = {}) => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/models")) {
            const row = { id: modelId, ...(nctx !== undefined ? { n_ctx: nctx } : {}) };
            return new Response(JSON.stringify({ data: [row] }), { status: 200 });
        }
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    return calls;
};
const chatCall = (calls: string[]) => calls.find((u) => u.endsWith("/chat/completions"));
test.afterEach(() => mock.restoreAll());

test("isStandardProvider: known vs unknown", () => {
    assert.equal(isStandardProvider("openai"), true);
    assert.equal(isStandardProvider("groq"), true);
    assert.equal(isStandardProvider("openrouter"), false); // bespoke sibling
    assert.equal(isStandardProvider("nope"), false);
});

test("standardProviderFromEnv: returns null for a non-standard name", async () => {
    assert.equal(await standardProviderFromEnv("openrouter", { ...baseEnv }, "m"), null);
});

test("openai: throws a named error when OPENAI_BASE_URL is unset", async () => {
    await assert.rejects(standardProviderFromEnv("openai", { ...baseEnv }, "m"), /OPENAI_BASE_URL must be set/);
});

test("openai: invalid tokenizer value throws", async () => {
    await assert.rejects(
        standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "bogus" }, "m"),
        /OPENAI_TOKENIZER must be one of/,
    );
});

test("openai: OPENAI_TOKENIZER=cl100k_base enables real tokenization", async () => {
    mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "cl100k_base" }, "m");
    assert.equal(p!.countTokens("hello world"), 2);
});

test("openai: defaults to heuristic tokenizer", async () => {
    mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    const s = "The quick brown fox.";
    assert.equal(p!.countTokens(s), Math.ceil(s.length / 4));
});

// — context-window resolution (issue #6) —

test("openai: derives contextSize from endpoint n_ctx when env unset", async () => {
    mockEndpoint({ nctx: 49152, modelId: "macher.gguf" });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "macher.gguf");
    assert.equal(p!.contextSize, 49152);
});

test("openai: explicit PLURNK_PROVIDER_CONTEXT_SIZE wins over n_ctx", async () => {
    mockEndpoint({ nctx: 49152 });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local", PLURNK_PROVIDER_CONTEXT_SIZE: "400000" }, "m");
    assert.equal(p!.contextSize, 400000);
});

test("openai: contextSize null when the endpoint reports no n_ctx (e.g. real OpenAI)", async () => {
    mockEndpoint({}); // models response without n_ctx
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, null);
});

test("openai: probe failure degrades to null, never throws", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response("nope", { status: 503 });
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, null);
});

test("cloud standard providers do not probe (no n_ctx fetch)", async () => {
    const calls = mockEndpoint({ nctx: 99999 });
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k" }, "m");
    assert.equal(p!.contextSize, null);           // groq has no probeNctx
    assert.equal(calls.some((u) => u.endsWith("/models")), false); // never queried /models
});

test("groq: requires its API key", async () => {
    await assert.rejects(standardProviderFromEnv("groq", { ...baseEnv }, "m"), /GROQ_API_KEY must be set/);
});

test("groq: applies PLURNK_PROVIDER_CONTEXT_SIZE", async () => {
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", PLURNK_PROVIDER_CONTEXT_SIZE: "131072" }, "m");
    assert.equal(p!.contextSize, 131072);
});

// — URL resolution —

test("openai flexBaseStrip: base with trailing /v1 yields a single /v1/chat/completions", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x/v1" }, "m");
    await p!.generate({ messages: [] });
    assert.equal(chatCall(calls), "http://x/v1/chat/completions");
});

test("fixed-base provider resolves the documented chat-completions URL", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("deepinfra", { ...baseEnv, DEEPINFRA_API_KEY: "k" }, "m");
    await p!.generate({ messages: [] });
    assert.equal(chatCall(calls), "https://api.deepinfra.com/v1/openai/chat/completions");
});

test("baseUrlVar overrides the fixed default", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", GROQ_BASE_URL: "http://proxy/openai/v1" }, "m");
    await p!.generate({ messages: [] });
    assert.equal(chatCall(calls), "http://proxy/openai/v1/chat/completions");
});

test("every registry entry resolves the chat URL the spec encodes", async () => {
    const envFor = (name: string): NodeJS.ProcessEnv => ({
        ...baseEnv,
        OPENAI_BASE_URL: "http://x",
        ...Object.fromEntries([[STANDARD_PROVIDERS[name].apiKeyVar, "k"]]),
    });
    for (const name of Object.keys(STANDARD_PROVIDERS)) {
        const calls = mockEndpoint();
        const p = await standardProviderFromEnv(name, envFor(name), "m");
        await p!.generate({ messages: [] });
        const u = chatCall(calls)!;
        assert.ok(u.endsWith("/chat/completions"), `${name} → ${u}`);
        assert.ok(u.startsWith("http"), `${name} → ${u}`);
        mock.restoreAll();
    }
});
