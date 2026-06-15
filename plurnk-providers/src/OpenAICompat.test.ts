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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, reasoningBudget: 0 });
    assert.equal(p.model, "m");
    assert.equal(p.contextSize, null); // default
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("four"), 1); // default heuristic ceil(4/4)
    assert.equal(p.costFor({ prompt: 9, completion: 9, reasoning: 0, cached: 0, total: 18 }), 0); // default free
});

test("injected countTokens and costFor are used", () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://x", fetchTimeoutMs: 1000, reasoningBudget: 0,
        countTokens: (t) => t.length,
        costFor: (u) => u.total * 2,
    });
    assert.equal(p.countTokens("abc"), 3);
    assert.equal(p.costFor({ prompt: 1, completion: 1, reasoning: 0, cached: 0, total: 5 }), 10);
});

test("generate maps a streamed response into ProviderResponse", async () => {
    const p = new OpenAICompatProvider({ model: "req-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    installFetch([
        { model: "wire-model", choices: [{ delta: { content: "hel" } }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1 } },
    ]);
    const { assistant, assistantRaw } = await p.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.model, "wire-model"); // wire-reported wins
    assert.equal(assistant.finishReason, "stop");
    assert.deepEqual(assistant.usage, { prompt: 3, completion: 2, reasoning: 0, cached: 1, total: 5 });
    assert.equal(assistant.reasoning, null); // none emitted
    assert.notEqual(assistantRaw, undefined);
});

test("generate normalizes an out-of-set finish_reason to null", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "function_call" }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.finishReason, null);
});

test("generate aggregates reasoning deltas under multiple field names", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    installFetch([{ choices: [{ delta: { reasoning_content: "be", thinking: "cause" } }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.reasoning, "because");
});

test("reasoningStyle 'think' gates on budget != 0 (magnitude irrelevant for native)", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, reasoningStyle: "think" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).think, true);

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, reasoningStyle: "think" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.equal("think" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'effort' sends a reasoning_effort tier from the budget", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 5000, reasoningStyle: "effort" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("reasoningStyle 'template' always emits enable_thinking mirroring budget != 0 — explicit false, never omitted", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, reasoningStyle: "template" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: true });

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, reasoningStyle: "template" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: false });
});

test("budget 0 suppresses effort and include_reasoning", async () => {
    const effort = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, reasoningStyle: "effort" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await effort.generate({ runId: "r", messages: [] });
    assert.equal("reasoning_effort" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const relay = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, reasoningStyle: "include_reasoning" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await relay.generate({ runId: "r", messages: [] });
    assert.equal("include_reasoning" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'include_reasoning' sets the relay passthrough toggle", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, reasoningStyle: "include_reasoning" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).include_reasoning, true);
});

// — grammar-constrained sampling (SPEC §13, issues #8/#9) —

test("grammar transport: attaches the GBNF verbatim plus the repeat-penalty floor", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, supportsGrammar: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.grammar, "root ::= statement");
    assert.equal(body.repeat_penalty, 1.15);
});

test("grammar transport: unsupported backend ignores the grammar (no wire fields)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 }); // default: no support
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("repeat_penalty" in body, false);
});

test("grammar transport: capable backend with no grammar passed sends neither field", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, supportsGrammar: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("repeat_penalty" in body, false);
});

test("maxTokens transports as max_tokens; absent → no wire field (server default)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], maxTokens: 2048 });
    assert.equal(JSON.parse(calls[0].init.body as string).max_tokens, 2048);

    mock.restoreAll();
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal("max_tokens" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity is internal: sticky per runId, distinct runs spread across slots (#11)", async () => {
    const pinning = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await pinning.generate({ runId: "run-A", messages: [] });
    await pinning.generate({ runId: "run-B", messages: [] });
    await pinning.generate({ runId: "run-A", messages: [] }); // sticky
    await pinning.generate({ runId: "run-C", messages: [] }); // wraps round-robin
    const slots = calls.map((c) => JSON.parse(c.init.body as string).id_slot);
    assert.deepEqual(slots, [0, 1, 0, 0]);
});

test("slot affinity: no pinning backend or unknown slotCount → no id_slot ever", async () => {
    const cloud = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 }); // default: no pinning
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await cloud.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const noCount = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, supportsSlotPinning: true }); // slotCount null
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await noCount.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);
});

test("generate fail-hards on a missing or empty runId", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(() => p.generate({ runId: "", messages: [] }), /runId is required/);
    await assert.rejects(() => (p.generate as (a: object) => Promise<unknown>)({ messages: [] }), /runId is required/);
});

test("PLAN prefill (PLURNK_PLAN): seeds a <<PLAN: assistant turn when on, omits otherwise", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, plan: true });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    const sent = JSON.parse(calls[0].init.body as string).messages;
    assert.deepEqual(sent.at(-1), { role: "assistant", content: "<<PLAN:\n" });

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 }); // plan default false
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.equal(JSON.parse(calls[0].init.body as string).messages.length, 1); // no prefill appended
});

test("generate wraps an HTTP failure as a ProviderError carrying a TelemetryEvent", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, source: "provider:test" });
    mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));
    await assert.rejects(() => p.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, "rate_limit");
        assert.equal(err.status, 429);
        assert.deepEqual(err.toTelemetryEvent(), { source: "provider:test", kind: "rate_limit", message: err.message, position: null });
        return true;
    });
});

test("generate rejects on a pre-aborted external signal", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const signal = AbortSignal.abort(new Error("nope"));
    await assert.rejects(() => p.generate({ runId: "r", messages: [], signal }));
});

test("configured headers and url are sent verbatim", async () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://host/custom/chat/completions", fetchTimeoutMs: 5000, reasoningBudget: 0,
        headers: { Authorization: "Bearer secret", "X-Title": "plurnk" },
    });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(calls[0].url, "http://host/custom/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Title"], "plurnk");
});
