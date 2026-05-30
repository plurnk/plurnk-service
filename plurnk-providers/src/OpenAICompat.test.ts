import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import OpenAICompatProvider, { effortFromBudget } from "./OpenAICompat.ts";

// Build a fake fetch returning a one-chunk SSE stream, capturing the request
// so tests can assert what the spine sent on the wire.
const sseStream = (chunks: unknown[]) => {
    const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"].join("\n\n");
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(lines));
            controller.close();
        },
    });
};

const installFetch = (chunks: unknown[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(sseStream(chunks), { status: 200 });
    });
    return calls;
};

test.afterEach(() => mock.restoreAll());

test("effortFromBudget: maps budget to tiers", () => {
    assert.equal(effortFromBudget(1), "low");
    assert.equal(effortFromBudget(1000), "low");
    assert.equal(effortFromBudget(1001), "medium");
    assert.equal(effortFromBudget(4000), "medium");
    assert.equal(effortFromBudget(4001), "high");
});

test("identity getters and defaults", () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000 });
    assert.equal(p.model, "m");
    assert.equal(p.contextSize, null); // default
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("four"), 1); // default heuristic ceil(4/4)
    assert.equal(p.costFor({ prompt: 9, completion: 9, cached: 0, total: 18 }), 0); // default free
});

test("injected countTokens and costFor are used", () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://x", fetchTimeoutMs: 1000,
        countTokens: (t) => t.length,
        costFor: (u) => u.total * 2,
    });
    assert.equal(p.countTokens("abc"), 3);
    assert.equal(p.costFor({ prompt: 1, completion: 1, cached: 0, total: 5 }), 10);
});

test("generate maps a streamed response into ProviderResponse", async () => {
    const p = new OpenAICompatProvider({ model: "req-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000 });
    installFetch([
        { model: "wire-model", choices: [{ delta: { content: "hel" } }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1 } },
    ]);
    const { assistant, assistantRaw } = await p.generate({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.model, "wire-model"); // wire-reported wins
    assert.equal(assistant.finishReason, "stop");
    assert.deepEqual(assistant.usage, { prompt: 3, completion: 2, cached: 1, total: 5 });
    assert.equal(assistant.reasoning, null); // none emitted
    assert.notEqual(assistantRaw, undefined);
});

test("generate normalizes an out-of-set finish_reason to null", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "function_call" }] }]);
    const { assistant } = await p.generate({ messages: [] });
    assert.equal(assistant.finishReason, null);
});

test("generate aggregates reasoning deltas under multiple field names", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000 });
    installFetch([{ choices: [{ delta: { reasoning_content: "be", thinking: "cause" } }] }]);
    const { assistant } = await p.generate({ messages: [] });
    assert.equal(assistant.reasoning, "because");
});

test("reasoningStyle 'think' sends think:true only when budget > 0", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningStyle: "think", reasonBudget: 1 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).think, true);

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningStyle: "think", reasonBudget: 0 });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ messages: [] });
    assert.equal("think" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'effort' sends a reasoning_effort tier from the budget", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningStyle: "effort", reasonBudget: 5000 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("reasoningStyle 'include_reasoning' sets the relay passthrough toggle", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningStyle: "include_reasoning", reasonBudget: 1 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).include_reasoning, true);
});

test("generate rejects on a pre-aborted external signal", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const signal = AbortSignal.abort(new Error("nope"));
    await assert.rejects(() => p.generate({ messages: [], signal }));
});

test("configured headers and url are sent verbatim", async () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://host/custom/chat/completions", fetchTimeoutMs: 5000,
        headers: { Authorization: "Bearer secret", "X-Title": "plurnk" },
    });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ messages: [] });
    assert.equal(calls[0].url, "http://host/custom/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Title"], "plurnk");
});
