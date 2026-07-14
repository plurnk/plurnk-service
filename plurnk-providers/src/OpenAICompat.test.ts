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
type ScriptedResponse = { status: number; chunks?: unknown[]; retryAfter?: number | string };
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

import { resetEmittedWarnings } from "./warnings.ts";
test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); }); // #40: warning-asserting tests stay order-independent

test("effortFromBudget: maps budget to tiers", () => {
    assert.equal(effortFromBudget(1), "low");
    assert.equal(effortFromBudget(1000), "low");
    assert.equal(effortFromBudget(1001), "medium");
    assert.equal(effortFromBudget(4000), "medium");
    assert.equal(effortFromBudget(4001), "high");
});

test("identity getters and defaults", () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    assert.equal(p.model, "m");
    assert.equal(p.contextSize, null); // default
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("four"), 2); // default heuristic ceil(4/2) upper bound
    assert.equal(p.costFor({ prompt: 9, completion: 9, reasoning: 0, cached: 0, total: 18 }), 0); // default free
});

test("injected countTokens and costFor are used", () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://x", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0,
        countTokens: (t) => t.length,
        costFor: (u) => u.total * 2,
    });
    assert.equal(p.countTokens("abc"), 3);
    assert.equal(p.costFor({ prompt: 1, completion: 1, reasoning: 0, cached: 0, total: 5 }), 10);
});

test("generate maps a streamed response into ProviderResponse", async () => {
    const p = new OpenAICompatProvider({ model: "req-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "function_call" }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.finishReason, null);
});

test("generate aggregates reasoning deltas under multiple field names", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { reasoning_content: "be", thinking: "cause" } }] }]);
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.reasoning, "because");
});

test("reasoningStyle 'think' gates on budget != 0 (magnitude irrelevant for native)", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "think" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).think, true);

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "think" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.equal("think" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'effort' sends a reasoning_effort tier from the budget", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "on", budget: 5000 }, retryAttempts: 0, reasoningStyle: "effort" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("reasoningStyle 'effort_explicit': off SENDS none, adaptive OMITS (#403 — literal is MiniMax-only), on sends the tier", async () => {
    // expected === null → the field must be ABSENT from the wire body. Fireworks
    // 400s reasoning_effort='adaptive' for non-MiniMax models (wire-verified,
    // #403): adaptive = the backend's own default posture = omission.
    for (const [reasoning, expected] of [[{ mode: "off", budget: null }, "none"], [{ mode: "adaptive", budget: null }, null], [{ mode: "on", budget: 5000 }, "high"]] as Array<[{ mode: "off" | "adaptive" | "on"; budget: number | null }, string | null]>) {
        const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning, retryAttempts: 0, reasoningStyle: "effort_explicit" });
        const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
        await p.generate({ runId: "r", messages: [] });
        const body = JSON.parse(calls[0].init.body as string);
        if (expected === null) assert.equal("reasoning_effort" in body, false, `mode ${reasoning.mode}: field must be omitted`);
        else assert.equal(body.reasoning_effort, expected, `mode ${reasoning.mode}`);
        mock.restoreAll();
    }
});

test("the family temperature default rides every request; caller sampling overrides it (#30)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "response_format" });
    // default rides with the grammar (non-streamed demotion path)
    let calls = installFetchJson(jsonChoice);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.2);
    mock.restoreAll();
    // explicit caller sampling wins over the default
    calls = installFetchJson(jsonChoice);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"', sampling: { temperature: 0.7 } });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.7);
    mock.restoreAll();
    // temperature is now the UNIVERSAL default: present without a grammar too
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.2);
});

test("effort_explicit: intent maps IDENTICALLY with and without a grammar — the #32 clamp is lifted (reasoning+rails coexist)", async () => {
    const warned: Array<string | Error> = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { warned.push(msg); });
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "on", budget: 8192 }, retryAttempts: 0, reasoningStyle: "effort_explicit", grammarStyle: "response_format", source: "provider:test" });
    // grammar transported → intent STILL flows through (canary-verified: the mask
    // covers only content; clamping to "none" was the plan-less #331 regression)
    let calls = installFetchJson(jsonChoice);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
    assert.equal(warned.filter((w) => String(w).includes("clamped")).length, 0, "no clamp warning — the clamp is gone");
    mock.restoreAll();
    // no grammar → same mapping
    const p2 = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "on", budget: 8192 }, retryAttempts: 0, reasoningStyle: "effort_explicit", grammarStyle: "response_format" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p2.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("llamacpp grammar path: temperature default + the managed repeat-penalty floor", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.repeat_penalty, 1.15);
});

test("#426: the repeat penalty rides EVERY request rail-off, keyed per backend (cloud degeneration guard)", async () => {
    // response_format cloud (fireworks) with NO grammar - the firefast case that went out bare
    const fw = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "response_format" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await fw.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).repetition_penalty, 1.15);
    mock.restoreAll();
    // llama.cpp with NO grammar carries its key too (unconstrained local is guarded now)
    const llama = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await llama.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).repeat_penalty, 1.15);
    mock.restoreAll();
    // a `none`-style backend stays BARE - no unknown penalty key (would 400 on strict cloud)
    const bare = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await bare.generate({ runId: "r", messages: [] });
    const bareBody = JSON.parse(calls[0].init.body as string);
    assert.equal("repetition_penalty" in bareBody, false);
    assert.equal("repeat_penalty" in bareBody, false);
});

test("sampling passthrough forwards caller params; managed + reserved keys win", async () => {
    const p = new OpenAICompatProvider({ model: "managed-model", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({
        runId: "r",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        sampling: {
            temperature: 0.2, top_p: 0.9, top_k: 40, stop: ["\n"],            // real sampling → passthrough
            model: "hijack", response_format: { type: "grammar", grammar: "x" }, id_slot: 7, // reserved → stripped
        },
    });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.deepEqual(body.stop, ["\n"]);
    assert.equal(body.model, "managed-model"); // managed field wins over a hijack attempt
    assert.equal(body.max_tokens, 100);
    assert.equal("response_format" in body, false); // reserved transport key stripped
    assert.equal("id_slot" in body, false); // reserved slot key stripped
});

test("reasoningStyle 'template' always emits enable_thinking mirroring budget != 0 — explicit false, never omitted", async () => {
    const on = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: true });

    mock.restoreAll();
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "template" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).chat_template_kwargs, { enable_thinking: false });
});

test("budget 0 suppresses effort and include_reasoning", async () => {
    const effort = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "effort" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await effort.generate({ runId: "r", messages: [] });
    assert.equal("reasoning_effort" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const relay = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await relay.generate({ runId: "r", messages: [] });
    assert.equal("include_reasoning" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'include_reasoning' sets the relay passthrough toggle", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).include_reasoning, true);
});

// — grammar-constrained sampling (SPEC §13, issues #8/#9) —

test("grammar transport 'llamacpp': top-level grammar + the repeat-penalty floor", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.grammar, 'root ::= "x"');
    assert.equal(body.repeat_penalty, 1.15);
    assert.equal("response_format" in body, false);
});

test("grammar transport 'response_format': response_format.grammar, no top-level grammar (Fireworks)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "response_format" });
    const calls = installFetchJson(jsonChoice);   // response_format grammar demotes off SSE
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.response_format, { type: "grammar", grammar: 'root ::= "x"' });
    assert.equal("grammar" in body, false);          // not the llama.cpp shape
    assert.equal("repeat_penalty" in body, false);   // llama.cpp spelling not used here
    assert.equal(body.repetition_penalty, 1.15);     // the floor still rides (OpenAI-compat spelling, #20)
});

// A response_format grammar is the one case the spine drops streaming for, even
// with streaming on (default): fireworks mislabels the streamed grammar output
// as reasoning_content but returns it as content non-streamed (§13). The demotion
// is per-request — a grammarless call on the same provider still streams.
test("response_format grammar demotes THIS request off SSE; grammarless calls still stream", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "response_format" });
    const jsonCalls = installFetchJson(jsonChoice);
    await p.generate({ runId: "r", messages: [], grammar: 'root ::= "x"' });
    assert.equal("stream" in JSON.parse(jsonCalls[0].init.body as string), false);   // no SSE flag
    mock.restoreAll();
    const sseCalls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });                                   // no grammar → streams
    assert.equal(JSON.parse(sseCalls[0].init.body as string).stream, true);           // SSE flag present
});

test("grammar transport 'none' (default): the grammar is never sent — no silent unconstrained", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("response_format" in body, false);
});

// — grammar conformance OBSERVATION (SPEC §10.14, §13): a completed exchange always
//   returns; bytes flow; a non-accept verdict rides response.telemetry —

const grammarProvider = () => new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", source: "provider:test" });
const streamingContent = (content: string) => installFetch([{ choices: [{ delta: { content }, finish_reason: "stop" }] }]);

test("enforcement: conforming output passes through unchanged", async () => {
    const p = grammarProvider();
    streamingContent("ok");
    const { assistant } = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(assistant.content, "ok");
});

test("observation: REJECTED output still returns — bytes present, verdict attached with position", async () => {
    const p = grammarProvider();
    streamingContent("no");
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "no"); // bytes ALWAYS flow
    assert.equal(res.telemetry?.length, 1);
    const ev = res.telemetry![0];
    assert.equal(ev.kind, "grammar_unenforced");
    assert.equal(ev.source, "provider:test");
    assert.match(String(ev.message), /grammar not enforced: output rejected .* at code point 0/);
    assert.equal(ev.position, 0); // divergence offset for consumer policy
});

test("observation: an incomplete (valid prefix, never terminated) also returns with the verdict", async () => {
    const p = grammarProvider();
    streamingContent("ok");
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok" "!"' });
    assert.equal(res.assistant.content, "ok");
    assert.equal(res.telemetry?.length, 1);
    assert.match(String(res.telemetry![0].message), /incomplete match .* never terminated/);
    assert.equal(res.telemetry![0].position, 2);
});

test("observation: conforming output attaches NO telemetry", async () => {
    const p = grammarProvider();
    streamingContent("ok");
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.telemetry, undefined);
});

test("observation: empty content under a non-empty grammar returns with the verdict (the 'content never arrives' leak, observed)", async () => {
    const p = grammarProvider();
    installFetch([{ choices: [{ delta: {}, finish_reason: "stop" }] }]); // no content delta → ""
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "");
    assert.equal(res.telemetry?.[0].kind, "grammar_unenforced");
});

test("enforcement: when no grammar is sent (grammarStyle 'none'), output is NOT validated — no wire fields, no error (SPEC §10.13)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 }); // grammarStyle defaults to "none"
    streamingContent("anything goes");
    const { assistant } = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' }); // grammar passed but never transported
    assert.equal(assistant.content, "anything goes"); // no enforcement check
});

test("enforcement: a grammar our validator can't parse is a NON-FATAL verify gap — warn, return content", async () => {
    const p = grammarProvider();
    streamingContent("whatever");
    const warnings: Error[] = [];
    const onWarn = (w: Error) => warnings.push(w);
    process.on("warning", onWarn);
    const { assistant } = await p.generate({ runId: "r", messages: [], grammar: 'foo ::= "a"' }); // no `root` rule → validateGbnf throws
    await flush();
    process.off("warning", onWarn);
    assert.equal(assistant.content, "whatever"); // transport not failed
    assert.ok(warnings.some((w) => (w as Error & { code?: string }).code === "PLURNK_GRAMMAR_UNVERIFIABLE"), "emitted the verify-gap warning");
});

// — PLURNK_PROVIDERS_GBNF_DEBUG: run unconstrained, then verify the free output against the grammar —

test("gbnfDebug: the grammar is NOT transported; conforming free output passes through with NO telemetry", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true, source: "provider:test" });
    const calls = installFetch([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);            // grammar never sent — model ran unconstrained
    assert.equal(body.repeat_penalty, 1.15);           // #426: penalty rides even rail-off - unconstrained decode needs it MORE
    assert.equal(res.assistant.content, "ok");         // free output happens to conform → returned
    assert.equal("telemetry" in res, false);           // conforming → no event
});

test("gbnfDebug: a conflict does NOT throw — it returns the bytes plus a grammar_unenforced telemetry event with the divergence position (#24)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true, source: "provider:test" });
    const calls = installFetch([{ choices: [{ delta: { reasoning_content: "let me think about ok", content: "xon-conforming output" }, finish_reason: "stop" }] }]);
    const res = await p.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    // The model's bytes survive — not discarded by a throw (the empty-turn cascade root cause).
    assert.equal(res.assistant.content, "xon-conforming output");
    assert.equal(res.assistant.reasoning, "let me think about ok");
    // Non-fatal telemetry carries the divergence so the consumer can self-correct.
    assert.equal(res.telemetry?.length, 1);
    const [event] = res.telemetry ?? [];
    assert.equal(event.source, "provider:test");
    assert.equal(event.kind, "grammar_unenforced");
    assert.equal(event.position, 0);                   // 'x' rejected at code point 0
    assert.match(event.message ?? "", /output rejected by the transported grammar at code point 0 \("x"\)/);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);            // still never sent — diagnosed, not enforced
});

test("gbnfDebug: an INVALID grammar throws before any wire call — it never reaches the model", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(
        () => p.generate({ runId: "r", messages: [], grammar: 'foo ::= "a"' }), // no `root` rule → invalid GBNF
        /grammar validation \(PLURNK_PROVIDERS_GBNF_DEBUG\): invalid GBNF/,
    );
    assert.equal(calls.length, 0); // fail-hard before the fetch — grammar never transported
});

// — meta bag: pass-through extras + validated known keys (#23) —

test("meta: the spec's balance field is normalized to a validated meta.balancePico", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, balanceMetaKey: "balance_pico" });
    installFetchJson({ ...jsonChoice, balance_pico: 4_200_000 });
    const res = await p.generate({ runId: "r", messages: [] });
    assert.equal(res.meta?.balancePico, 4_200_000);
    assert.equal("balance_pico" in (res.meta ?? {}), false); // raw key renamed to the canonical balancePico
});

test("meta: passes the backend's extra top-level fields through verbatim (every provider)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false }); // no balanceMetaKey
    installFetchJson({ ...jsonChoice, balance_pico: 4_200_000, system_fingerprint: "fp_abc" });
    const res = await p.generate({ runId: "r", messages: [] });
    assert.equal(res.meta?.balance_pico, 4_200_000); // passed through raw — no balance contract on this provider
    assert.equal(res.meta?.system_fingerprint, "fp_abc");
    assert.equal("balancePico" in (res.meta ?? {}), false); // not normalized without the key
});

test("meta: a non-numeric balance is dropped, never surfaced as balancePico (null-honest)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, balanceMetaKey: "balance_pico" });
    installFetchJson({ ...jsonChoice, balance_pico: "lots" });
    const res = await p.generate({ runId: "r", messages: [] });
    assert.equal("balancePico" in (res.meta ?? {}), false);
    assert.equal("balance_pico" in (res.meta ?? {}), false); // raw dropped too — the known key is validated away
});

// — first-party telemetry headers (attribution + client, SPEC §5) —

const headerVal = (init: RequestInit, name: string): string | undefined =>
    new Headers(init.headers).get(name) ?? undefined;

test("firstPartyMetadata: attributions + client ride as Plurnk-* headers", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], attributions: ["@acme/x@1.2.0", "@foo/y@0.3.1"], client: "plurnk.nvim/1.4.0" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), '["@acme/x@1.2.0","@foo/y@0.3.1"]');
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), "plurnk.nvim/1.4.0");
});

test("firstPartyMetadata off (default): the headers are structurally dropped even when values are passed", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], attributions: ["@acme/x@1.2.0"], client: "plurnk-cli/2.0.0" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), undefined);   // never leaks to a non-first-party backend
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), undefined);
});

test("firstPartyMetadata on but empty values: no header emitted", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], attributions: [], client: "" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), undefined);
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), undefined);
});

test("grammar transport: no grammar passed sends no grammar field, but the penalty rides (#426)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal(body.repeat_penalty, 1.15);           // #426: penalty is no longer grammar-gated - it rides rail-off
});

test("maxTokens transports as max_tokens; absent → no wire field (server default)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], maxTokens: 2048 });
    assert.equal(JSON.parse(calls[0].init.body as string).max_tokens, 2048);

    mock.restoreAll();
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal("max_tokens" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity is internal: sticky per runId, distinct runs spread across slots (#11)", async () => {
    const pinning = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await pinning.generate({ runId: "run-A", messages: [] });
    await pinning.generate({ runId: "run-B", messages: [] });
    await pinning.generate({ runId: "run-A", messages: [] }); // sticky
    await pinning.generate({ runId: "run-C", messages: [] }); // wraps round-robin
    const slots = calls.map((c) => JSON.parse(c.init.body as string).id_slot);
    assert.deepEqual(slots, [0, 1, 0, 0]);
});

test("slot affinity: no pinning backend or unknown slotCount → no id_slot ever", async () => {
    const cloud = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 }); // default: no pinning
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await cloud.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const noCount = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true }); // slotCount null
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await noCount.generate({ runId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity: a run past the LRU window (slotCount*8) loses its pin; recent runs stay sticky (#11)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const slotOf = (i: number) => JSON.parse(calls[i].init.body as string).id_slot;
    for (let i = 0; i < 16; i++) await p.generate({ runId: `r${i}`, messages: [] }); // fills the 16-entry window {r0..r15}
    await p.generate({ runId: "r16", messages: [] });   // call 16: size==cap → evicts the oldest (r0), itself → slot 0
    await p.generate({ runId: "r0", messages: [] });     // call 17: r0 was evicted → treated as NEW, re-slotted
    await p.generate({ runId: "r16", messages: [] });    // call 18: r16 still resident → sticky to its slot
    assert.equal(slotOf(0), 0);    // r0's original pin
    assert.notEqual(slotOf(17), slotOf(0)); // …lost after eviction (would equal 0 if it had stayed sticky)
    assert.equal(slotOf(18), slotOf(16)); // r16 kept its slot — recent run survives the window
});

test("streaming:false: a non-ok response rejects as a classified ProviderError (covers the non-streamed transport)", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, source: "provider:test" });
    mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
    await assert.rejects(() => p.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.kind, "network_failure"); // ≥500 → network_failure
        assert.equal(err.status, 500);
        return true;
    });
});

test("generate fail-hards on a missing or empty runId", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(() => p.generate({ runId: "", messages: [] }), /runId is required/);
    await assert.rejects(() => (p.generate as (a: object) => Promise<unknown>)({ messages: [] }), /runId is required/);
});

test("messages pass through verbatim — the provider injects no turn (PLAN lives in the grammar, never a provider prefill)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "out" } }] }]);
    const input = [{ role: "user" as const, content: "hi" }];
    const res = await p.generate({ runId: "r", messages: input });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).messages, input); // no extra assistant turn
    assert.equal(res.assistant.content, "out"); // content returned verbatim
});

test("generate wraps an HTTP failure as a ProviderError carrying a TelemetryEvent", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, source: "provider:test" });
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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const signal = AbortSignal.abort(new Error("nope"));
    await assert.rejects(() => p.generate({ runId: "r", messages: [], signal }));
});

test("configured headers and url are sent verbatim", async () => {
    const p = new OpenAICompatProvider({
        model: "m", url: "http://host/custom/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0,
        headers: { Authorization: "Bearer secret", "X-Title": "plurnk" },
    });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [] });
    assert.equal(calls[0].url, "http://host/custom/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Title"], "plurnk");
});

// — transient-failure retry (#18) —

const retryCfg = { model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null } as const };

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

test("retry: a Retry-After HTTP-date is honored — a past date parses to a 0ms wait, then retries", async () => {
    const calls = installFetchScript([
        { status: 503, retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT" }, // date form, in the past → max(0, past−now) = 0
        { status: 200, chunks: [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }] },
    ]);
    const p = new OpenAICompatProvider({ ...retryCfg, retryAttempts: 1 });
    const { assistant } = await p.generate({ runId: "r", messages: [] });
    assert.equal(assistant.content, "ok");
    assert.equal(calls.length, 2); // initial 503 + one retry, no real wall-clock wait
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

test("retry: a caller abort during backoff rejects promptly with no further attempt (mid-flight abort, SPEC §10.9)", async () => {
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
    const capped = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "on", budget: 4096 }, reasoningStyle: "anthropic" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await capped.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "enabled", budget_tokens: 4096 });

    mock.restoreAll();
    // 0 → explicit disabled
    const off = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, reasoningStyle: "anthropic" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "disabled" });

    mock.restoreAll();
    // -1 adaptive → omit (API default depth)
    const adaptive = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "adaptive", budget: null }, reasoningStyle: "anthropic" });
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
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const res = await p.generate({ runId: "r", messages: [] });
    const sent = JSON.parse(calls[0].body);
    assert.equal("stream" in sent, false);                 // no streaming flag
    assert.equal(res.assistant.content, "hello");          // content from message.content
    assert.equal(res.assistant.reasoning, "because");      // reasoning_content mapped
    assert.equal(res.assistant.finishReason, "stop");
    assert.equal(res.assistant.usage.total, 4);
    mock.restoreAll();
});

// ── Data capture (#36): logprobs + verbatim rawBody, opt-in, off by default ──
const captureBase = { model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null } as const, retryAttempts: 0 };

test("#36 logprobs OFF by default: no wire request, no assistant.logprobs, no rawBody", async () => {
    const calls = installFetch([{ model: "m", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]);
    const p = new OpenAICompatProvider({ ...captureBase });
    const res = await p.generate({ runId: "r", messages: [{ role: "user", content: "q" }] });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal("logprobs" in body, false);
    assert.equal("top_logprobs" in body, false);
    assert.equal(res.assistant.logprobs, undefined);
    assert.equal(res.assistant.meanLogprob, undefined);
    assert.equal(res.rawBody, undefined);
    mock.restoreAll();
});

test("#36 logprobs ON (streamed): requests logprobs+top_logprobs, surfaces raw logprob + meanLogprob", async () => {
    const chunk = { model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, choices: [{ delta: { content: "yesno" }, finish_reason: "stop", logprobs: { content: [
        { token: "yes", logprob: -0.5, sampling_logprob: -0.5, top_logprobs: [{ token: "yes", logprob: -0.5 }, { token: "no", logprob: -1.0 }] },
        { token: "no", logprob: -0.1, sampling_logprob: -0.1, top_logprobs: [{ token: "no", logprob: -0.1 }] },
    ] } }] };
    const calls = installFetch([chunk]);
    const p = new OpenAICompatProvider({ ...captureBase, logprobs: 2 });
    const res = await p.generate({ runId: "r", messages: [{ role: "user", content: "q" }] });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 2);
    assert.equal(res.assistant.logprobs?.length, 2);
    assert.deepEqual(res.assistant.logprobs?.[0], { token: "yes", logprob: -0.5, top: [{ token: "yes", logprob: -0.5 }, { token: "no", logprob: -1.0 }] });
    assert.equal(res.assistant.meanLogprob, -0.3); // (-0.5 + -0.1) / 2
    mock.restoreAll();
});

test("#36 rawBody ON (non-streamed): verbatim wire body incl. sampling_logprob preserved", async () => {
    const wire = { model: "m", extra_top_level: "kept", choices: [{ message: { content: "no" }, finish_reason: "stop", logprobs: { content: [{ token: "no", logprob: -0.1, sampling_logprob: -0.1, token_id: 42 }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    installFetchJson(wire);
    const p = new OpenAICompatProvider({ ...captureBase, streaming: false, logprobs: 0, rawBody: true });
    const res = await p.generate({ runId: "r", messages: [{ role: "user", content: "q" }] });
    assert.deepEqual(res.rawBody, wire); // verbatim
    assert.equal((res.rawBody as typeof wire).choices[0].logprobs.content[0].sampling_logprob, -0.1);
    assert.equal((res.rawBody as typeof wire).choices[0].logprobs.content[0].token_id, 42);
    assert.equal(res.assistant.logprobs?.[0].token, "no"); // structured view still uses raw logprob
    mock.restoreAll();
});

test("#36 caller sampling cannot forge logprobs (reserved keys): the env flag is the only control", async () => {
    const calls = installFetch([{ model: "m", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]);
    const p = new OpenAICompatProvider({ ...captureBase }); // logprobs OFF
    await p.generate({ runId: "r", messages: [{ role: "user", content: "q" }], sampling: { logprobs: true, top_logprobs: 5 } });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal("logprobs" in body, false);   // sampling passthrough stripped it
    assert.equal("top_logprobs" in body, false);
    mock.restoreAll();
});

// — turn coordinate headers (#404, per #391): same gate as every first-party signal —

test("#404: sessionId/loop/turn ride as Plurnk-Session-Id/Loop/Turn under the first-party gate", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], sessionId: "s-9", loop: 3, turn: 41 });
    const h = (calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal(h["Plurnk-Session-Id"], "s-9");
    assert.equal(h["Plurnk-Loop"], "3");
    assert.equal(h["Plurnk-Turn"], "41");
});

test("#404: third-party providers structurally DROP the coordinate (gate off by default)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], sessionId: "s-9", loop: 3, turn: 41 });
    const h = (calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal("Plurnk-Session-Id" in h, false);
    assert.equal("Plurnk-Loop" in h, false);
    assert.equal("Plurnk-Turn" in h, false);
});

test("#404: coordinates are 1-based — 0/absent/empty emit no header (no strikes-style zero exception)", async () => {
    const p = new OpenAICompatProvider({ model: "m", url: "http://x", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryDelayMs: 1, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ runId: "r", messages: [], sessionId: "", loop: 0, turn: 0 });
    const h = (calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal("Plurnk-Session-Id" in h, false);
    assert.equal("Plurnk-Loop" in h, false);
    assert.equal("Plurnk-Turn" in h, false);
    assert.equal(typeof h["Plurnk-Strikes"], "undefined"); // and absent strikes stays absent
});
