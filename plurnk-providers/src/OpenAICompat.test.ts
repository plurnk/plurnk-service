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

// Fake fetch returning one non-streamed JSON body — for the paths the spine
// demotes off SSE (a response_format grammar). Captures the request the same way.
const installFetchJson = (payload: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return calls;
};

const jsonChoice = { model: "m", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

// Sequenced fetch mock for retry tests: each entry is one HTTP response. A 200
// streams its chunks; any other status returns that error (with an optional
// retry-after header). The last entry repeats once the script runs out.
type ScriptedResponse = { status: number; chunks?: unknown[]; retryAfter?: number };
const installFetchScript = (responses: ScriptedResponse[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (r.status === 200) return new Response(sseStream(r.chunks ?? []), { status: 200 });
        const headers = r.retryAfter !== undefined ? { "retry-after": String(r.retryAfter) } : {};
        return new Response("err", { status: r.status, headers });
    });
    return calls;
};

// Let the pending request + its catch/backoff scheduling drain before asserting.
const flush = () => new Promise<void>((r) => setImmediate(r));

test.afterEach(() => mock.restoreAll());

test("effortFromBudget: maps budget to tiers", () => {
    assert.equal(effortFromBudget(1), "low");
    assert.equal(effortFromBudget(1000), "low");
    assert.equal(effortFromBudget(1001), "medium");
    assert.equal(effortFromBudget(4000), "medium");
    assert.equal(effortFromBudget(4001), "high");
});

test("identity getters and defaults", () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, reasoningBudget: 0, retryAttempts: 0 });
    assert.equal(p.model, "m");
    assert.equal(p.contextSize, null); // default
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("four"), 1); // default heuristic ceil(4/4)
    assert.equal(p.costFor({ prompt: 9, completion: 9, reasoning: 0, cached: 0, total: 18 }), 0); // default free
});

test("injected countTokens and costFor are used", () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://x", fetchTimeoutMs: 1000, reasoningBudget: 0, retryAttempts: 0,
        countTokens: (t) => t.length,
        costFor: (u) => u.total * 2,
    });
    assert.equal(p.countTokens("abc"), 3);
    assert.equal(p.costFor({ prompt: 1, completion: 1, reasoning: 0, cached: 0, total: 5 }), 10);
});

test("generate maps a streamed response into ProviderResponse", async () => {
    const p = new OpenAICompatProvider({ model: "req-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "function_call" }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.finishReason, null);
});

test("generate aggregates reasoning deltas under multiple field names", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { reasoning_content: "be", thinking: "cause" } }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.reasoning, "because");
});

test("reasoningStyle 'think' gates on budget != 0 (magnitude irrelevant for native)", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, retryAttempts: 0, reasoningStyle: "think" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).think, true);

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, reasoningStyle: "think" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.equal("think" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'effort' sends a reasoning_effort tier from the budget", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 5000, retryAttempts: 0, reasoningStyle: "effort" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("reasoningStyle 'template' always emits enable_thinking mirroring budget != 0 — explicit false, never omitted", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, retryAttempts: 0, reasoningStyle: "template" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: true });

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, reasoningStyle: "template" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: false });
});

test("budget 0 suppresses effort and include_reasoning", async () => {
    const effort = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, reasoningStyle: "effort" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await effort.generate({ runId: "r", messages: [] });
    assert.equal("reasoning_effort" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const relay = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await relay.generate({ runId: "r", messages: [] });
    assert.equal("include_reasoning" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'include_reasoning' sets the relay passthrough toggle", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: -1, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).include_reasoning, true);
});

// — grammar-constrained sampling (SPEC §13, issues #8/#9) —

test("grammar transport 'llamacpp': top-level grammar + the repeat-penalty floor", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.grammar, "root ::= statement");
    assert.equal(body.repeat_penalty, 1.15);
    assert.equal("response_format" in body, false);
});

test("grammar transport 'response_format': response_format.grammar, no top-level grammar (Fireworks)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, grammarStyle: "response_format" });
    const calls = installFetchJson(jsonChoice);   // response_format grammar demotes off SSE
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.response_format, { type: "grammar", grammar: "root ::= statement" });
    assert.equal("grammar" in body, false);          // not the llama.cpp shape
    assert.equal("repeat_penalty" in body, false);
});

// A response_format grammar is the one case the spine drops streaming for, even
// with streaming on (default): fireworks mislabels the streamed grammar output
// as reasoning_content but returns it as content non-streamed (§13). The demotion
// is per-request — a grammarless call on the same provider still streams.
test("response_format grammar demotes THIS request off SSE; grammarless calls still stream", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, grammarStyle: "response_format" });
    const jsonCalls = installFetchJson(jsonChoice);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    assert.equal("stream" in JSON.parse(jsonCalls[0].init.body as string), false);   // no SSE flag
    mock.restoreAll();
    const sseCalls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });                                   // no grammar → streams
    assert.equal(JSON.parse(sseCalls[0].init.body as string).stream, true);           // SSE flag present
});

test("grammar transport 'none' (default): the grammar is never sent — no silent unconstrained", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("response_format" in body, false);
});

test("grammar transport: capable backend with no grammar passed sends neither field", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("repeat_penalty" in body, false);
});

test("maxTokens transports as max_tokens; absent → no wire field (server default)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], maxTokens: 2048 });
    assert.equal(JSON.parse(calls[0].init.body as string).max_tokens, 2048);

    mock.restoreAll();
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal("max_tokens" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity is internal: sticky per runId, distinct runs spread across slots (#11)", async () => {
    const pinning = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await pinning.generate({ runId: "run-A", messages: [] });
    await pinning.generate({ runId: "run-B", messages: [] });
    await pinning.generate({ runId: "run-A", messages: [] }); // sticky
    await pinning.generate({ runId: "run-C", messages: [] }); // wraps round-robin
    const slots = calls.map((c) => JSON.parse(c.init.body as string).id_slot);
    assert.deepEqual(slots, [0, 1, 0, 0]);
});

test("slot affinity: no pinning backend or unknown slotCount → no id_slot ever", async () => {
    const cloud = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 }); // default: no pinning
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await cloud.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const noCount = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, supportsSlotPinning: true }); // slotCount null
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await noCount.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);
});

test("generate fail-hards on a missing or empty runId", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(() => p.generate({ runId: "", messages: [] }), /runId is required/);
    await assert.rejects(() => (p.generate as (a: object) => Promise<unknown>)({ messages: [] }), /runId is required/);
});

test("messages pass through verbatim — the provider injects no turn (PLAN prefill removed, #16)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "out" } }] }]);
    const input = [{ role: "user" as const, content: "hi" }];
    const res = await p.generate({ runId: "r", messages: input });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).messages, input); // no extra assistant turn
    assert.equal(res.assistant.content, "out"); // content returned verbatim
});

test("generate wraps an HTTP failure as a ProviderError carrying a TelemetryEvent", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, source: "provider:test" });
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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const signal = AbortSignal.abort(new Error("nope"));
    await assert.rejects(() => p.generate({ runId: "r", messages: [], signal }));
});

test("configured headers and url are sent verbatim", async () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://host/custom/chat/completions", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0,
        headers: { Authorization: "Bearer secret", "X-Title": "plurnk" },
    });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(calls[0].url, "http://host/custom/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Title"], "plurnk");
});

// — transient-failure retry (#18) —

const retryCfg = { model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0 as const };

test("retry: a transient failure retries and a later success resolves", async () => {
    const calls = installFetchScript([
        { status: 429, retryAfter: 0 },
        { status: 503, retryAfter: 0 },
        { status: 200, chunks: [{ choices: [{ delta: { content: "ok" } }] }] },
    ]);
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 3 });
    const res = await p.generate({ runId: "r", messages: [] });
    assert.equal(res.assistant.content, "ok");
    assert.equal(calls.length, 3); // 429 → 503 → 200
});

test("retry: exhausting the budget surfaces the classified ProviderError", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const calls = installFetchScript([{ status: 429, retryAfter: 0 }]); // always rate-limited
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 2 });
    await assert.rejects(
        () => p.generate({ runId: "r", messages: [] }),
        (err: unknown) => { assert.ok(err instanceof ProviderError); assert.equal(err.kind, "rate_limit"); return true; },
    );
    assert.equal(calls.length, 3); // 1 initial + 2 retries
});

test("retry: a terminal error (401 unauthorized) is never retried", async () => {
    const calls = installFetchScript([{ status: 401 }]);
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 5 });
    await assert.rejects(() => p.generate({ runId: "r", messages: [] }), /401/);
    assert.equal(calls.length, 1); // terminal — no retry despite budget
});

test("retry: retryAttempts 0 surfaces the first transient failure immediately", async () => {
    const calls = installFetchScript([{ status: 503, retryAfter: 0 }]);
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 0 });
    await assert.rejects(() => p.generate({ runId: "r", messages: [] }));
    assert.equal(calls.length, 1); // no retry budget
});

test("retry: a caller abort during backoff rejects promptly with no further attempt", async () => {
    const ac = new AbortController();
    const calls = installFetchScript([{ status: 503, retryAfter: 5 }]); // 5s backoff we never wait out
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 3 });
    const promise = p.generate({ runId: "r", messages: [], signal: ac.signal });
    await flush(); // attempt 0 fails, enters the backoff sleep
    assert.equal(calls.length, 1);
    ac.abort(new Error("cancelled"));
    await assert.rejects(() => promise); // abort cuts through the backoff
    assert.equal(calls.length, 1); // never retried after cancellation
});

// — anthropic reasoning style (thinking param, #18) —

test("reasoningStyle 'anthropic' maps the budget to the thinking param", async () => {
    // N>0 → enabled with budget_tokens
    const capped = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, reasoningBudget: 4096, reasoningStyle: "anthropic" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await capped.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "enabled", budget_tokens: 4096 });

    mock.restoreAll();
    // 0 → explicit disabled
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, reasoningBudget: 0, reasoningStyle: "anthropic" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "disabled" });

    mock.restoreAll();
    // -1 adaptive → omit (API default depth)
    const adaptive = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, reasoningBudget: -1, reasoningStyle: "anthropic" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await adaptive.generate({ runId: "r", messages: [] });
    assert.equal("thinking" in JSON.parse(calls[0].init.body as string), false);
});

// — non-streaming transport (streaming:false) —

test("streaming:false posts without stream and parses the single JSON response", async () => {
    const calls: { body: string }[] = [];
    mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        calls.push({ body: String(init.body) });
        return new Response(JSON.stringify({
            model: "wire-model",
            choices: [{ message: { content: "hello", reasoning_content: "because" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, reasoningBudget: 0, retryAttempts: 0, streaming: false });
    const res = await p.generate({ runId: "r", messages: [] });
    const sent = JSON.parse(calls[0].body);
    assert.equal("stream" in sent, false);                 // no streaming flag
    assert.equal(res.assistant.content, "hello");          // content from message.content
    assert.equal(res.assistant.reasoning, "because");      // reasoning_content mapped
    assert.equal(res.assistant.finishReason, "stop");
    assert.equal(res.assistant.usage.total, 4);
    mock.restoreAll();
});
