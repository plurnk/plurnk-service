import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import AiSdkProvider, { effortFromBudget } from "./AiSdkProvider.ts";
import { ProviderError } from "./errors.ts";

// Build a fake fetch returning a one-chunk SSE stream, capturing the request
// so tests can assert what the spine sent on the wire.
const sseStream = (chunks: unknown[]) => {
    const normalized = chunks.map((value, index) => {
        const chunk = value as Record<string, any>;
        const usage = chunk.usage !== undefined
            ? {
                ...chunk.usage,
                ...(chunk.usage.cached_tokens !== undefined
                    ? {
                        prompt_tokens_details: {
                            cached_tokens: chunk.usage.cached_tokens,
                        },
                    }
                    : {}),
            }
            : undefined;
        if (usage !== undefined) delete usage.cached_tokens;
        return {
            id: "test-completion",
            object: "chat.completion.chunk",
            created: index + 1,
            model: "m",
            ...chunk,
            ...(chunk.choices === undefined && usage !== undefined ? { choices: [] } : {}),
            ...(usage !== undefined ? { usage } : {}),
        };
    });
    const lines = [...normalized.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"].join("\n\n");
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

// Fake fetch returning one non-streamed JSON body. Captures the request too.
const installFetchJson = (payload: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return calls;
};

const jsonChoice = { model: "m", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

const injectedBase = {
    model: "m",
    url: "https://example.test/v1/chat/completions",
    fetchTimeoutMs: 5000,
    temperature: 0.2,
    repeatPenalty: 1.15,
    retryAttempts: 0,
    reasoning: { mode: "off" as const, budget: null },
};

test("per-instance fetch owns streaming and buffered requests", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const streamingFetch: typeof globalThis.fetch = async (input, init) => {
        calls.push({ input, init });
        return new Response(sseStream([
            { model: "wire-model", choices: [{ delta: { content: "streamed", reasoning_content: "thought" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
        ]), { status: 200 });
    };
    const bufferedFetch: typeof globalThis.fetch = async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({
            ...jsonChoice,
            choices: [{ message: { content: "buffered" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const streamed = await new AiSdkProvider({ ...injectedBase, fetch: streamingFetch, rawBody: true })
        .generate({ workerId: "stream", messages: [{ role: "user", content: "hello" }] });
    const buffered = await new AiSdkProvider({ ...injectedBase, fetch: bufferedFetch, streaming: false })
        .generate({ workerId: "buffer", messages: [{ role: "user", content: "hello" }] });

    assert.equal(streamed.assistant.content, "streamed");
    assert.equal(streamed.assistant.reasoning, "thought");
    assert.ok(streamed.rawBody !== undefined);
    assert.equal(buffered.assistant.content, "buffered");
    assert.equal(calls.length, 2);
    assert.equal(String(calls[0].input), injectedBase.url);
    assert.equal(calls[0].init?.method, "POST");
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(JSON.parse(String(calls[0].init?.body)).stream, true);
    assert.equal(JSON.parse(String(calls[1].init?.body)).stream, undefined);
});

test("caller cancellation and provider timeout reach an injected fetch", async () => {
    const pendingFetch: typeof globalThis.fetch = async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    const caller = new AbortController();
    const callerProvider = new AiSdkProvider({ ...injectedBase, fetch: pendingFetch });
    const callerRequest = callerProvider.generate({ workerId: "cancel", messages: [], signal: caller.signal });
    caller.abort(new Error("operator cancelled"));
    await assert.rejects(callerRequest, /operator cancelled/);

    const timeoutProvider = new AiSdkProvider({ ...injectedBase, fetch: pendingFetch, fetchTimeoutMs: 1 });
    await assert.rejects(
        timeoutProvider.generate({ workerId: "timeout", messages: [] }),
        (error: ProviderError) => error.kind === "network_failure",
    );
});

test("per-instance fetch owns tokenization and retry attempts", async () => {
    const calls: string[] = [];
    let generationAttempts = 0;
    const providerFetch: typeof globalThis.fetch = async (input) => {
        calls.push(String(input));
        if (String(input).endsWith("/tokenize")) {
            return new Response(JSON.stringify({ tokens: [10, 20] }), { status: 200 });
        }
        generationAttempts++;
        if (generationAttempts === 1) return new Response("busy", { status: 503 });
        return new Response(sseStream([
            { model: "m", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ]), { status: 200 });
    };
    const provider = new AiSdkProvider({
        ...injectedBase,
        fetch: providerFetch,
        retryAttempts: 1,
        tokenizeUrl: "https://example.test/tokenize",
    });

    assert.deepEqual(await provider.tokenize?.("hello"), [10, 20]);
    assert.equal((await provider.generate({ workerId: "retry", messages: [] })).assistant.content, "ok");
    assert.deepEqual(calls, [
        "https://example.test/tokenize",
        injectedBase.url,
        injectedBase.url,
    ]);
});

// Sequenced fetch mock for retry tests: each entry is one HTTP response. A 200
// streams its chunks; any other status returns that error (with an optional
// retry-after header). The last entry repeats once the script runs out.
type ScriptedResponse = {
    status: number;
    chunks?: unknown[];
    retryAfter?: number | string;
    shouldRetry?: boolean;
    body?: string;
};
const installFetchScript = (responses: ScriptedResponse[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (r.status === 200) return new Response(sseStream(r.chunks ?? []), { status: 200 });
        const headers = {
            "content-type": "application/json",
            ...(r.retryAfter !== undefined ? { "retry-after": String(r.retryAfter) } : {}),
            ...(r.shouldRetry !== undefined ? { "x-should-retry": String(r.shouldRetry) } : {}),
        };
        return new Response(
            r.body ?? JSON.stringify({ error: { message: `HTTP ${r.status}` } }),
            { status: r.status, headers },
        );
    });
    return calls;
};

// Let the pending request + its catch/backoff scheduling drain before asserting.
const flush = () => new Promise<void>((r) => setImmediate(r));

import { resetEmittedWarnings } from "./warnings.ts";
test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); });

test("effortFromBudget: maps budget to tiers", () => {
    assert.equal(effortFromBudget(1), "low");
    assert.equal(effortFromBudget(1000), "low");
    assert.equal(effortFromBudget(1001), "medium");
    assert.equal(effortFromBudget(4000), "medium");
    assert.equal(effortFromBudget(4001), "high");
});

test("a 524 Cloudflare edge timeout fails fast - not retried despite retryAttempts", async () => {
    const calls = installFetchScript([{ status: 524, retryAfter: 120 }]);
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 3 });
    await assert.rejects(p.generate({ workerId: "r", messages: [] }));
    await flush();
    assert.equal(calls.length, 1); // edge code: one attempt, no retry despite retryAttempts: 3
    mock.restoreAll();
});

test("a 422 grammar_invalid is a failed exchange, not transport replay policy", async () => {
    const body = JSON.stringify({ error: { message: "non-conforming emission rejected: ...", type: "grammar_invalid" } });
    const calls = installFetchScript([{ status: 422, body }]);
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 2 });
    await assert.rejects(
        p.generate({ workerId: "r", messages: [] }),
        (e: unknown) => e instanceof ProviderError && e.kind === "grammar_invalid",
    );
    await flush();
    assert.equal(calls.length, 1);
    mock.restoreAll();
});

test("an SSE error frame is a failed exchange, not an empty completion", async () => {
    const calls = installFetch([{
        status: 422,
        error: { message: "non-conforming emission rejected", type: "grammar_invalid" },
    }]);
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    await assert.rejects(
        p.generate({ workerId: "r", messages: [] }),
        (e: unknown) => e instanceof ProviderError && e.kind === "grammar_invalid",
    );
    assert.equal(calls.length, 1);
});

test("a trailing eos_token (--special EOG leak) is stripped from content", async () => {
    installFetchJson({ model: "m", choices: [{ message: { content: "the answer<eos>" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, eosText: "<eos>" });
    const res = await p.generate({ workerId: "r", messages: [] });
    assert.equal(res.assistant.content, "the answer"); // trailing <eos> gone; packet + verdict see clean bytes
});

test("without a probed eos_token the content passes through untouched", async () => {
    installFetchJson({ model: "m", choices: [{ message: { content: "keeps <eos> literally" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const res = await p.generate({ workerId: "r", messages: [] });
    assert.equal(res.assistant.content, "keeps <eos> literally"); // no eosText (a cloud backend) -> no strip
});

test("only the trailing eos_token is stripped; a quoted one mid-body survives", async () => {
    installFetchJson({ model: "m", choices: [{ message: { content: "quotes <eos> in the body<eos>" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, eosText: "<eos>" });
    const res = await p.generate({ workerId: "r", messages: [] });
    assert.equal(res.assistant.content, "quotes <eos> in the body"); // only the tail goes
});

test("identity getters and default prompt estimate", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    assert.equal(p.model, "m");
    assert.equal(p.contextWindow, null); // default
    assert.deepEqual(
        await p.countPromptTokens([{ role: "user", content: "漢漢漢" }]),
        {
            kind: "estimate",
            tokens: 2,
            source: "heuristic:chars2",
            detail: "chars/2 over message content; provider request framing is unknown",
        },
        "chars/2 is explicitly an estimate; high-token-density Unicode prevents an upper-bound claim",
    );
    assert.equal(p.calculateCost({ prompt: 9, completion: 9, reasoning: 0, cached: 0, total: 18 }), 0); // current unknown-rate sentinel
});

test("injected prompt measurement preserves provenance and calculateCost is used", async () => {
    const seen: string[] = [];
    const p = new AiSdkProvider({
        model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0,
        countPromptTokens: (messages) => {
            seen.push(...messages.map(({ content }) => content));
            return { kind: "upper_bound", tokens: 7, source: "test:proven-bound" };
        },
        calculateCost: (u) => u.total * 2,
    });
    assert.deepEqual(
        await p.countPromptTokens([{ role: "system", content: "system" }, { role: "user", content: "user" }]),
        { kind: "upper_bound", tokens: 7, source: "test:proven-bound" },
    );
    assert.deepEqual(seen, ["system", "user"]);
    assert.equal(p.calculateCost({ prompt: 1, completion: 1, reasoning: 0, cached: 0, total: 5 }), 10);
});

test("generate maps a streamed response into ProviderResponse", async () => {
    const p = new AiSdkProvider({ model: "req-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([
        { model: "wire-model", choices: [{ delta: { content: "hel" } }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 1 } },
    ]);
    const { assistant, assistantRaw } = await p.generate({ workerId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.model, "wire-model"); // wire-reported wins
    assert.equal(assistant.finishReason, "stop");
    assert.deepEqual(assistant.usage, { prompt: 3, completion: 2, reasoning: 0, cached: 1, total: 5 });
    assert.equal(assistant.reasoning, null); // none emitted
    assert.notEqual(assistantRaw, undefined);
});

test("generate surfaces and normalizes an out-of-set finish_reason", async () => {
    const warnings: Array<{ message: string; code?: string }> = [];
    mock.method(process, "emitWarning", (message: string | Error, options?: string | { code?: string }) => {
        warnings.push({
            message: String(message),
            ...(typeof options === "object" && options.code !== undefined ? { code: options.code } : {}),
        });
    });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "function_call" }] }]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.finishReason, null);
    assert.deepEqual(warnings, [{
        message: 'unrecognized finish_reason "function_call"; treated as no-signal (finishReason=null). If it denotes a token-cap hit, core\'s length-cap detection will miss it.',
        code: "PLURNK_FINISH_REASON_UNKNOWN",
    }]);
});

test("#161: a streamed resource interruption is a failed exchange with complete attempt evidence", async () => {
    const calls = installFetch([
        { model: "served-model", choices: [{ delta: { reasoning_content: "partial thought", content: "partial answer" } }] },
        {
            choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        },
    ]);
    const provider = new AiSdkProvider({
        ...injectedBase,
        retryAttempts: 2,
        rawBody: true,
    });

    await assert.rejects(
        provider.generate({ workerId: "interrupted", messages: [{ role: "user", content: "hello" }] }),
        (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.kind, "resource_interrupted");
            assert.equal(error.status, 503);
            assert.equal(error.problem.stage, "provider-response");
            assert.equal(error.problem.retryable, false);
            assert.equal(error.problem.finishReason, "resource_interrupted");
            assert.equal(error.problem.rawFinishReason, "insufficient_system_resource");
            assert.equal(error.attempt?.assistant.content, "partial answer");
            assert.equal(error.attempt?.assistant.reasoning, "partial thought");
            assert.equal(error.attempt?.assistant.finishReason, "resource_interrupted");
            assert.deepEqual(error.attempt?.assistant.usage, {
                prompt: 7,
                completion: 2,
                reasoning: 3,
                cached: 0,
                total: 12,
            });
            assert.equal(
                (error.attempt?.assistantRaw as { rawFinishReason?: string }).rawFinishReason,
                "insufficient_system_resource",
            );
            assert.ok(Array.isArray(error.attempt?.rawBody));
            return true;
        },
    );
    assert.equal(calls.length, 1, "a semantic interruption is not replayed as an HTTP failure");
});

test("#161: a buffered resource interruption preserves the successful wire response as failed-attempt evidence", async () => {
    const wire = {
        model: "served-model",
        choices: [{
            message: { content: "partial answer", reasoning_content: "partial thought" },
            finish_reason: "insufficient_system_resource",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    };
    const calls = installFetchJson(wire);
    const provider = new AiSdkProvider({
        ...injectedBase,
        streaming: false,
        retryAttempts: 2,
        rawBody: true,
    });

    await assert.rejects(
        provider.generate({ workerId: "interrupted", messages: [{ role: "user", content: "hello" }] }),
        (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.kind, "resource_interrupted");
            assert.equal(error.attempt?.assistant.content, "partial answer");
            assert.equal(error.attempt?.assistant.reasoning, "partial thought");
            assert.equal(error.attempt?.assistant.finishReason, "resource_interrupted");
            assert.deepEqual(error.attempt?.rawBody, wire);
            assert.equal(
                (error.attempt?.assistantRaw as { rawFinishReason?: string }).rawFinishReason,
                "insufficient_system_resource",
            );
            return true;
        },
    );
    assert.equal(calls.length, 1);
});

test("generate translates a backend cap synonym to canonical length", async () => {
    // gemini shouts MAX_TOKENS, anthropic says max_tokens -- both must reach core as
    // "length" so its truncation check (=== "length") is a cross-backend invariant.
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "MAX_TOKENS" }] }]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.finishReason, "length");
});

test("generate translates end_turn to canonical stop", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "end_turn" }] }]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.finishReason, "stop");
});

test("generate translates xAI completed to canonical stop", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" }, finish_reason: "completed" }] }]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.finishReason, "stop");
});

test("generate aggregates reasoning deltas under multiple field names", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { reasoning_content: "be", thinking: "cause" } }] }]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.reasoning, "because");
    assert.equal("reasoningEncrypted" in assistant, false); // open reasoning only -> field absent
});

test("{§provider-tagged-reasoning} explicit think-tags projects one streamed leading envelope and reclassifies usage", async () => {
    const config = { ...injectedBase, reasoningResponseStyle: "think-tags" as const };
    const p = new AiSdkProvider(config);
    installFetch([
        { choices: [{ delta: { content: "<thi" } }] },
        { choices: [{ delta: { content: "nk>12345</th" } }] },
        { choices: [{ delta: { content: "ink>abcde" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 10, total_tokens: 13 } },
    ]);

    const response = await p.generate({ workerId: "tagged-stream", messages: [] });

    assert.equal(response.assistant.reasoning, "12345");
    assert.equal(response.assistant.content, "abcde");
    assert.deepEqual(response.assistant.usage, {
        prompt: 3,
        completion: 5,
        reasoning: 5,
        cached: 0,
        total: 13,
    });
});

test("{§provider-tagged-reasoning} explicit think-tags projects one buffered leading envelope", async () => {
    installFetchJson({
        model: "m",
        choices: [{ message: { content: "<think>12345</think>abcde" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 10, total_tokens: 13 },
    });
    const config = { ...injectedBase, streaming: false, reasoningResponseStyle: "think-tags" as const };
    const response = await new AiSdkProvider(config).generate({ workerId: "tagged-buffer", messages: [] });

    assert.equal(response.assistant.reasoning, "12345");
    assert.equal(response.assistant.content, "abcde");
    assert.equal(response.assistant.usage.completion, 5);
    assert.equal(response.assistant.usage.reasoning, 5);
});

test("{§provider-tagged-reasoning} an unclosed capped envelope is wholly reasoning in streamed and buffered responses", async () => {
    const config = { ...injectedBase, reasoningResponseStyle: "think-tags" as const };
    installFetch([
        { choices: [{ delta: { content: "<think>unfinished" }, finish_reason: "length" }] },
        { usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } },
    ]);
    const streamed = await new AiSdkProvider(config).generate({ workerId: "tagged-capped-stream", messages: [] });
    assert.equal(streamed.assistant.reasoning, "unfinished");
    assert.equal(streamed.assistant.content, "");
    assert.deepEqual(streamed.assistant.usage, {
        prompt: 3,
        completion: 0,
        reasoning: 8,
        cached: 0,
        total: 11,
    });

    mock.restoreAll();
    installFetchJson({
        model: "m",
        choices: [{ message: { content: "<think>unfinished" }, finish_reason: "length" }],
        usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 },
    });
    const bufferedConfig = { ...config, streaming: false };
    const buffered = await new AiSdkProvider(bufferedConfig).generate({ workerId: "tagged-capped-buffer", messages: [] });
    assert.equal(buffered.assistant.reasoning, "unfinished");
    assert.equal(buffered.assistant.content, "");
    assert.equal(buffered.assistant.usage.completion, 0);
    assert.equal(buffered.assistant.usage.reasoning, 8);
});

test("{§provider-tagged-reasoning} verbatim, non-leading, and structured-reasoning controls preserve literal tags", async () => {
    installFetchJson({
        model: "m",
        choices: [{ message: { content: "<think>literal</think>answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
    });
    const verbatim = await new AiSdkProvider({ ...injectedBase, streaming: false })
        .generate({ workerId: "verbatim", messages: [] });
    assert.equal(verbatim.assistant.content, "<think>literal</think>answer");
    assert.equal(verbatim.assistant.reasoning, null);
    assert.equal(verbatim.assistant.usage.completion, 4);

    mock.restoreAll();
    installFetchJson({
        model: "m",
        choices: [{ message: { content: "show <think>literal</think> exactly" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
    });
    const taggedConfig = { ...injectedBase, streaming: false, reasoningResponseStyle: "think-tags" as const };
    const nonLeading = await new AiSdkProvider(taggedConfig)
        .generate({ workerId: "non-leading", messages: [] });
    assert.equal(nonLeading.assistant.content, "show <think>literal</think> exactly");
    assert.equal(nonLeading.assistant.reasoning, null);

    mock.restoreAll();
    installFetchJson({
        model: "m",
        choices: [{ message: {
            content: "<think>literal visible bytes</think>",
            reasoning_content: "structured reasoning",
        }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 7, total_tokens: 8 },
    });
    const structured = await new AiSdkProvider(taggedConfig)
        .generate({ workerId: "structured", messages: [] });
    assert.equal(structured.assistant.content, "<think>literal visible bytes</think>");
    assert.equal(structured.assistant.reasoning, "structured reasoning");
});

test("{§provider-tagged-reasoning} grammar evidence retains the exact pre-projection tagged sentence", async () => {
    const content = "<think>reason</think><<PLAN::PLAN\n<<SEND[200]:done:SEND";
    const config = {
        ...injectedBase,
        contextWindow: 640,
        reasoning: { mode: "adaptive" as const, budget: null },
        reasoningResponseStyle: "think-tags" as const,
        reasoningStyle: "think" as const,
        grammarStyle: "llamacpp" as const,
    };
    installFetch([{ choices: [{ delta: { content }, finish_reason: "stop" }] }]);

    const response = await new AiSdkProvider(config).generate({
        workerId: "tagged-grammar",
        messages: [],
        grammar: `root ::= ${JSON.stringify(content)}`,
    });

    assert.equal(response.assistant.reasoning, "reason");
    assert.equal(response.assistant.content, "<<PLAN::PLAN\n<<SEND[200]:done:SEND");
    assert.deepEqual(response.grammarEvidence, {
        input: content,
        contentStart: [..."<think>reason</think>"].length,
        transported: true,
    });
});

test("encrypted reasoning (non-streamed): encrypted entries normalize and text entries stay separate", async () => {
    // The live o4-mini-via-OpenRouter shape: reasoning null, one encrypted entry.
    installFetchJson({ model: "m", choices: [{ message: {
        content: "4", reasoning: null,
        reasoning_details: [
            { type: "reasoning.encrypted", data: "gAAAAABqBLOB", format: "openai-responses-v1", id: "rs_1", index: 0 },
            { type: "reasoning.text", text: "never surfaced here" },
        ],
    }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    // Wire detail ID is preserved; the assistant-message location supports the
    // derived classification but supplies no downstream client entity ID.
    assert.deepEqual(assistant.reasoningEncrypted, [{ id: "rs_1", subtype: "message", encrypted: [{ data: "gAAAAABqBLOB", format: "openai-responses-v1" }] }]);
    assert.equal(assistant.reasoning, null); // Encrypted turn: nothing readable.
    assert.equal(assistant.content, "4");
});

test("distinct encrypted-reasoning wire ids stay distinct items", async () => {
    installFetchJson({ model: "m", choices: [{ message: { content: "ok", reasoning: null, reasoning_details: [
        { type: "reasoning.encrypted", data: "AAA", format: "openai-responses-v1", id: "rs_1" },
        { type: "reasoning.encrypted", data: "BBB", format: "openai-responses-v1", id: "rs_2" },
    ] }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.reasoningEncrypted?.length, 2);
    assert.deepEqual(assistant.reasoningEncrypted?.map((i) => i.id), ["rs_1", "rs_2"]);
});

test("assistant-message location classifies encrypted reasoning without inventing a missing detail id", async () => {
    installFetchJson({ model: "m", choices: [{ message: { content: "ok", reasoning_details: [
        { type: "reasoning.encrypted", data: "OPAQUE", format: "openai-responses-v1", id: null, index: 0 },
    ] }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.deepEqual(assistant.reasoningEncrypted, [{
        id: null,
        subtype: "message",
        encrypted: [{ data: "OPAQUE", format: "openai-responses-v1" }],
    }]);
});

test("encrypted reasoning (streamed): chunked blob concatenates per entry index", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "gAAAA", format: "openai-responses-v1", id: "rs_1", index: 0 }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "BqXYZ", id: "rs_1", index: 0 }] } }] },
        { choices: [{ delta: { content: "4" }, finish_reason: "stop" }] },
    ]);
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.deepEqual(assistant.reasoningEncrypted, [{ id: "rs_1", subtype: "message", encrypted: [{ data: "gAAAABqXYZ", format: "openai-responses-v1" }] }]);
    assert.equal(assistant.content, "4");
});

test("reasoningStyle 'think' gates on budget != 0 (magnitude irrelevant for native)", async () => {
    const on = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "think" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).think, true);

    mock.restoreAll();
    const off = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "think" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ workerId: "r", messages: [] });
    assert.equal("think" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'effort' sends a reasoning_effort tier from the budget", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "on", budget: 5000 }, retryAttempts: 0, reasoningStyle: "effort" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).reasoning_effort, "high");
});

test("reasoningStyle 'effort_explicit': off SENDS none, adaptive OMITS, on sends the tier", async () => {
    // expected === null → the field must be ABSENT from the wire body. Fireworks
    // 400s reasoning_effort='adaptive' for non-MiniMax models (wire-verified,
    // Adaptive = the backend's own default posture = omission.
    for (const [reasoning, expected] of [[{ mode: "off", budget: null }, "none"], [{ mode: "adaptive", budget: null }, null], [{ mode: "on", budget: 5000 }, "high"]] as Array<[{ mode: "off" | "adaptive" | "on"; budget: number | null }, string | null]>) {
        const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning, retryAttempts: 0, reasoningStyle: "effort_explicit" });
        const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
        await p.generate({ workerId: "r", messages: [] });
        const body = JSON.parse(calls[0].init.body as string);
        if (expected === null) assert.equal("reasoning_effort" in body, false, `mode ${reasoning.mode}: field must be omitted`);
        else assert.equal(body.reasoning_effort, expected, `mode ${reasoning.mode}`);
        mock.restoreAll();
    }
});

test("{§deepseek-reasoning-request} #157: thinking_effort maps the complete DeepSeek reasoning contract", async () => {
    const cases = [
        [{ mode: "off", budget: null }, { thinking: { type: "disabled" } }],
        [{ mode: "adaptive", budget: null }, {}],
        [{ mode: "on", budget: 5000 }, { thinking: { type: "enabled" }, reasoning_effort: "high" }],
    ] as const;
    for (const [reasoning, expected] of cases) {
        const p = new AiSdkProvider({
            model: "m",
            url: "http://x/v1/chat/completions",
            fetchTimeoutMs: 5000,
            temperature: 0.2,
            repeatPenalty: 1.15,
            reasoning,
            retryAttempts: 0,
            reasoningStyle: "thinking_effort",
        });
        const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
        await p.generate({
            workerId: "r",
            messages: [],
            sampling: { thinking: { type: "disabled" }, reasoning_effort: "max" },
        });
        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(
            Object.fromEntries(Object.entries(body).filter(([key]) => key === "thinking" || key === "reasoning_effort")),
            expected,
        );
        mock.restoreAll();
    }
});

test("the family temperature default rides every request; caller sampling overrides it", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.2);
    mock.restoreAll();
    // explicit caller sampling wins over the default
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], sampling: { temperature: 0.7 } });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.7);
    mock.restoreAll();
    // temperature is now the UNIVERSAL default: present without a grammar too
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).temperature, 0.2);
});

test("DRY + repeat_last_n ride the llamacpp path when set; unset leaves the box default; never on cloud", async () => {
    const base = { model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off" as const, budget: null }, retryAttempts: 0 };
    // set + llamacpp -> the loop-breakers ride the wire
    const p = new AiSdkProvider({ ...base, grammarStyle: "llamacpp", dryMultiplier: 0.8, dryBase: 1.75, dryAllowedLength: 2, repeatLastN: 512 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    let body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.dry_multiplier, 0.8);
    assert.equal(body.dry_base, 1.75);
    assert.equal(body.dry_allowed_length, 2);
    assert.equal(body.repeat_last_n, 512);
    assert.equal(body.repeat_penalty, 1.15); // repeat_penalty always rides the llamacpp path
    mock.restoreAll();
    // unset -> no dry_*/repeat_last_n on the wire (box keeps its own defaults)
    const p2 = new AiSdkProvider({ ...base, grammarStyle: "llamacpp" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p2.generate({ workerId: "r", messages: [] });
    body = JSON.parse(calls[0].init.body as string);
    assert.equal("dry_multiplier" in body, false);
    assert.equal("repeat_last_n" in body, false);
    mock.restoreAll();
    // DRY is a llama.cpp sampler: a cloud ("none") provider never emits it, even if configured
    const p3 = new AiSdkProvider({ ...base, grammarStyle: "none", dryMultiplier: 0.8, repeatLastN: 512 });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p3.generate({ workerId: "r", messages: [] });
    body = JSON.parse(calls[0].init.body as string);
    assert.equal("dry_multiplier" in body, false);
    assert.equal("repeat_last_n" in body, false);
    mock.restoreAll();
});

test("llamacpp grammar path: temperature default + the managed repeat-penalty floor", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "x"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.repeat_penalty, 1.15);
});

test("the repeat penalty rides every request rail-off, keyed per backend", async () => {
    // llama.cpp with NO grammar carries its key too (unconstrained local is guarded)
    const llama = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await llama.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).repeat_penalty, 1.15);
    mock.restoreAll();
    // A `none`-style cloud backend with a frequency penalty gets frequency_penalty.
    const cloud = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, frequencyPenalty: 0.4, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await cloud.generate({ workerId: "r", messages: [] });
    const cloudBody = JSON.parse(calls[0].init.body as string);
    assert.equal(cloudBody.frequency_penalty, 0.4);            // the OpenAI-standard additive, not the multiplier
    assert.equal("repetition_penalty" in cloudBody, false);
    assert.equal("repeat_penalty" in cloudBody, false);
    mock.restoreAll();
    // frequencyPenalty unset (default 0) opts out cleanly - sends nothing (an out-of-date plugin runs unguarded, never breaks)
    const bare = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await bare.generate({ workerId: "r", messages: [] });
    assert.equal("frequency_penalty" in JSON.parse(calls[0].init.body as string), false);
});

test("sampling passthrough forwards caller params; managed + reserved keys win", async () => {
    const p = new AiSdkProvider({ model: "managed-model", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({
        workerId: "r",
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

test("sampling passthrough guards contract invariants: n/tools/caps stripped, platform knobs pass", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({
        workerId: "r",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        sampling: {
            n: 3,                                                    // breaks choices[0] atomicity -> stripped
            tools: [{ type: "function" }], tool_choice: "auto",      // tools-in-body doctrine -> stripped
            modalities: ["text", "audio"], prediction: { type: "content" }, // text-only / decode semantics -> stripped
            max_tokens: 999999, max_completion_tokens: 999999,       // envelope bypass -> stripped
            seed: 42, user: "acct-7", service_tier: "flex",          // platform/sampling intent -> pass
        },
    });
    const body = JSON.parse(calls[0].init.body as string);
    for (const k of ["n", "tools", "tool_choice", "modalities", "prediction", "max_completion_tokens"]) {
        assert.equal(k in body, false, `${k} must be stripped`);
    }
    assert.equal(body.max_tokens, 100); // the managed envelope, not the smuggled 999999
    assert.equal(body.seed, 42);
    assert.equal(body.user, "acct-7");
    assert.equal(body.service_tier, "flex");
});

test("template reasoning returns the exact pre-projection grammar sentence ({§gbnf-response-observation})", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", contextWindow: 640, reasoningReserve: { tokens: 64 }, completionReserve: { tokens: 160 }, fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template", grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { reasoning_content: "con🙂sider", content: "x" } }] }]);
    const grammarInput = "<|channel>thought\ncon🙂sider<channel|>x";
    const res = await p.generate({ workerId: "r", messages: [], grammar: `root ::= ${JSON.stringify(grammarInput)}` });
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.reasoning_format, "auto");
    assert.equal(body.thinking_budget_tokens, 64);
    assert.equal(body.grammar, `root ::= ${JSON.stringify(grammarInput)}`);
    assert.deepEqual(res.grammarEvidence, {
        input: grammarInput,
        contentStart: [..."<|channel>thought\ncon🙂sider<channel|>"].length,
        transported: true,
    });
    assert.equal(res.meta?.railsVerdict, undefined, "the provider represents evidence but does not grade itself");
});

test("template reasoning does not invent pre-projection evidence when the wire omits its reasoning field", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", contextWindow: 640, reasoningReserve: { tokens: 64 }, completionReserve: { tokens: 160 }, fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template", grammarStyle: "llamacpp" });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "x"' });
    assert.equal(res.grammarEvidence, undefined);
});

test("channel-escape detector: billed completion tokens vastly beyond visible channels attach grammar_unenforced", async () => {
    // The run105 shape: tiny visible content, no reasoning, thousands billed — the decode
    // escaped into a discarded reasoning block, unconstrained.
    const chunks = [
        { choices: [{ delta: { content: "x" }, finish_reason: "length" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5000, total_tokens: 5010 } },
    ];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        if (String(input).endsWith("/tokenize")) {
            const body = JSON.parse(String(init?.body)) as { content: string };
            return new Response(JSON.stringify({
                tokens: body.content.length === 0 ? [] : [1],
            }), { headers: { "content-type": "application/json" } });
        }
        return new Response(sseStream(chunks), { status: 200 });
    };
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetch, tokenizeUrl: "http://x/tokenize", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template", grammarStyle: "llamacpp" });
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "x"' });
    const escape = res.notices?.find((e) => e.message.includes("escaped the grammar"));
    assert.ok(escape, "escape notice attached");
    assert.equal(escape!.kind, "grammar_unenforced");
    assert.match(escape!.message ?? "", /5000 completion tokens billed/);
});

test("channel-escape state is absent without a transported grammar", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template", grammarStyle: "llamacpp" });
    installFetch([
        { choices: [{ delta: { content: "x" }, finish_reason: "length" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5000, total_tokens: 5010 } },
    ]);
    const res = await p.generate({ workerId: "r", messages: [] }); // no grammar arg
    assert.equal(res.grammarEvidence, undefined);
    assert.equal(res.notices, undefined);
});

test("reasoningStyle 'template' sends llama-server activation, parser, and response-wide allowance", async () => {
    const on = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", contextWindow: 640, reasoningReserve: { percent: 0.1 }, completionReserve: { percent: 0.25 }, fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "template" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await on.generate({ workerId: "r", messages: [] });
    let body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.reasoning_format, "auto");
    assert.equal(body.thinking_budget_tokens, 64);

    mock.restoreAll();
    const off = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", contextWindow: 640, reasoningReserve: { percent: 0.1 }, completionReserve: { percent: 0.25 }, fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "template" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ workerId: "r", messages: [] });
    body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_format, "auto");
    assert.equal(body.thinking_budget_tokens, 0);
});

test("reasoningStyle 'template' explicit budget tightens the reserve and cannot exceed it", async () => {
    const base = { model: "m", url: "http://x/v1/chat/completions", contextWindow: 640, reasoningReserve: { tokens: 64 } as const, completionReserve: { tokens: 160 } as const, fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, retryAttempts: 0, reasoningStyle: "template" as const };
    const p = new AiSdkProvider({ ...base, reasoning: { mode: "on", budget: 32 } });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], sampling: { thinking_budget_tokens: 999, reasoning_format: "none" } });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.thinking_budget_tokens, 32);
    assert.equal(body.reasoning_format, "auto");
    assert.throws(
        () => new AiSdkProvider({ ...base, reasoning: { mode: "on", budget: 65 } }),
        /REASONING_BUDGET \(65\) exceeds the resolved PLURNK_PROVIDERS_REASONING_RESERVE \(64\)/,
    );
});

test("budget 0 suppresses effort and include_reasoning", async () => {
    const effort = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "effort" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await effort.generate({ workerId: "r", messages: [] });
    assert.equal("reasoning_effort" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const relay = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await relay.generate({ workerId: "r", messages: [] });
    assert.equal("include_reasoning" in JSON.parse(calls[0].init.body as string), false);
});

test("reasoningStyle 'include_reasoning' sets the relay passthrough toggle", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, retryAttempts: 0, reasoningStyle: "include_reasoning" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).include_reasoning, true);
});

// — grammar-constrained sampling —

test("grammar transport 'llamacpp': top-level grammar + the repeat-penalty floor", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "x"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.grammar, 'root ::= "x"');
    assert.equal(body.repeat_penalty, 1.15);
    assert.equal("response_format" in body, false);
});

test("grammar transport 'none' (default): the grammar is never sent — no silent unconstrained", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], grammar: "root ::= statement" });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal("response_format" in body, false);
});

// — exact pre-projection grammar evidence ({§gbnf-response-observation}) —

const grammarProvider = () => new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", source: "provider:test" });
const streamingContent = (content: string) => installFetch([{ choices: [{ delta: { content }, finish_reason: "stop" }] }]);

test("an unsplit grammar response carries the exact observed sentence", async () => {
    const p = grammarProvider();
    streamingContent("ok");
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "ok");
    assert.deepEqual(res.grammarEvidence, {
        input: "ok",
        contentStart: 0,
        transported: true,
    });
});

test("the provider returns rejected or incomplete bytes as evidence without grading them", async () => {
    const p = grammarProvider();
    streamingContent("no");
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "no");
    assert.deepEqual(res.grammarEvidence, { input: "no", contentStart: 0, transported: true });
    assert.equal(res.notices, undefined);
    assert.equal(res.meta?.railsVerdict, undefined);
});

test("empty unsplit content remains exact grammar evidence", async () => {
    const p = grammarProvider();
    installFetch([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "");
    assert.deepEqual(res.grammarEvidence, { input: "", contentStart: 0, transported: true });
});

test("grammarStyle 'none' produces no grammar observation", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 }); // grammarStyle defaults to "none"
    streamingContent("anything goes");
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "anything goes");
    assert.equal(res.grammarEvidence, undefined);
});

test("provider evidence does not depend on the local validator understanding the grammar", async () => {
    const p = grammarProvider();
    streamingContent("whatever");
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'foo ::= "a"' });
    assert.equal(res.assistant.content, "whatever");
    assert.deepEqual(res.grammarEvidence, { input: "whatever", contentStart: 0, transported: true });
    assert.equal(res.notices, undefined);
});

// — PLURNK_PROVIDERS_GBNF_DEBUG: validate the grammar, withhold it, and preserve the observation —

test("gbnfDebug marks an unconstrained observation as not transported", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true, source: "provider:test" });
    const calls = installFetch([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal(body.repeat_penalty, 1.15);
    assert.equal(res.assistant.content, "ok");
    assert.deepEqual(res.grammarEvidence, { input: "ok", contentStart: 0, transported: false });
    assert.equal(res.notices, undefined);
});

test("gbnfDebug preserves conflicting bytes without a provider verdict", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true, source: "provider:test" });
    const calls = installFetch([{ choices: [{ delta: { content: "xon-conforming output" }, finish_reason: "stop" }] }]);
    const res = await p.generate({ workerId: "r", messages: [], grammar: 'root ::= "ok"' });
    assert.equal(res.assistant.content, "xon-conforming output");
    assert.deepEqual(res.grammarEvidence, { input: "xon-conforming output", contentStart: 0, transported: false });
    assert.equal(res.notices, undefined);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
});

test("gbnfDebug: an INVALID grammar throws before any wire call — it never reaches the model", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp", gbnfDebug: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(
        () => p.generate({ workerId: "r", messages: [], grammar: 'foo ::= "a"' }), // no `root` rule → invalid GBNF
        /grammar validation \(PLURNK_PROVIDERS_GBNF_DEBUG\): invalid GBNF/,
    );
    assert.equal(calls.length, 0); // fail-hard before the fetch — grammar never transported
});

// — meta bag: verbatim provider metadata —

test("meta: passes backend fields through without reinterpreting monetary values", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const balance = { amount: "0.0000042", currency: "XMR" };
    installFetchJson({ ...jsonChoice, balance, system_fingerprint: "fp_abc" });
    const res = await p.generate({ workerId: "r", messages: [] });
    assert.deepEqual(res.meta?.balance, balance);
    assert.equal(res.meta?.system_fingerprint, "fp_abc");
});

// — first-party telemetry headers ({§provider-request-authority}) —

const headerVal = (init: RequestInit, name: string): string | undefined =>
    new Headers(init.headers).get(name) ?? undefined;

test("firstPartyMetadata: attributions + client ride as Plurnk-* headers", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], attributions: ["@acme/x@1.2.0", "@foo/y@0.3.1"], client: "plurnk.nvim/1.4.0" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), '["@acme/x@1.2.0","@foo/y@0.3.1"]');
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), "plurnk.nvim/1.4.0");
});

test("Plurnk-Worker-Primary: the lineage root rides under the gate; emitted even when it equals workerId", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "w-child", primaryWorkerId: "w-root", messages: [] });
    assert.equal(headerVal(calls[0].init, "Plurnk-Worker-Primary"), "w-root"); // a descendant: Primary != Worker-Id
    mock.restoreAll();

    // the primary worker's own turn: Primary == Worker-Id, still stamped (never skipped on equality)
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "w-root", primaryWorkerId: "w-root", messages: [] });
    assert.equal(headerVal(calls[0].init, "Plurnk-Worker-Primary"), "w-root");
    mock.restoreAll();

    // absent when the consumer supplies none — the provider never invents a primary
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "w-root", messages: [] });
    assert.equal(headerVal(calls[0].init, "Plurnk-Worker-Primary"), undefined);
});

test("Plurnk-Worker-Primary is structurally dropped when firstPartyMetadata is off", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "w-child", primaryWorkerId: "w-root", messages: [] });
    assert.equal(headerVal(calls[0].init, "Plurnk-Worker-Primary"), undefined); // never reaches a third-party backend
});

test("firstPartyMetadata off (default): the headers are structurally dropped even when values are passed", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], attributions: ["@acme/x@1.2.0"], client: "plurnk-cli/2.0.0" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), undefined);   // never leaks to a non-first-party backend
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), undefined);
});

test("firstPartyMetadata on but empty values: no header emitted", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], attributions: [], client: "" });
    assert.equal(headerVal(calls[0].init, "Plurnk-Attribution"), undefined);
    assert.equal(headerVal(calls[0].init, "Plurnk-Client"), undefined);
});

test("grammar transport: no grammar passed sends no grammar field, but the penalty rides", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, grammarStyle: "llamacpp" });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal("grammar" in body, false);
    assert.equal(body.repeat_penalty, 1.15);           // penalty is not grammar-gated
});

test("maxTokens transports as max_tokens; absent → no wire field (server default)", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], maxTokens: 2048 });
    assert.equal(JSON.parse(calls[0].init.body as string).max_tokens, 2048);

    mock.restoreAll();
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal("max_tokens" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity is internal: sticky per workerId, distinct workers spread across slots", async () => {
    const pinning = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await pinning.generate({ workerId: "run-A", messages: [] });
    await pinning.generate({ workerId: "run-B", messages: [] });
    await pinning.generate({ workerId: "run-A", messages: [] }); // sticky
    await pinning.generate({ workerId: "run-C", messages: [] }); // wraps round-robin
    const slots = calls.map((c) => JSON.parse(c.init.body as string).id_slot);
    assert.deepEqual(slots, [0, 1, 0, 0]);
});

test("slot affinity: no pinning backend or unknown slotCount → no id_slot ever", async () => {
    const cloud = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 }); // default: no pinning
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await cloud.generate({ workerId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);

    mock.restoreAll();
    const noCount = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true }); // slotCount null
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await noCount.generate({ workerId: "run-A", messages: [] });
    assert.equal("id_slot" in JSON.parse(calls[0].init.body as string), false);
});

test("slot affinity: a worker past the LRU window (slotCount*8) loses its pin; recent workers stay sticky", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, supportsSlotPinning: true, slotCount: 2 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const slotOf = (i: number) => JSON.parse(calls[i].init.body as string).id_slot;
    for (let i = 0; i < 16; i++) await p.generate({ workerId: `r${i}`, messages: [] }); // fills the 16-entry window {r0..r15}
    await p.generate({ workerId: "r16", messages: [] });   // call 16: size==cap → evicts the oldest (r0), itself → slot 0
    await p.generate({ workerId: "r0", messages: [] });     // call 17: r0 was evicted → treated as NEW, re-slotted
    await p.generate({ workerId: "r16", messages: [] });    // call 18: r16 still resident → sticky to its slot
    assert.equal(slotOf(0), 0);    // r0's original pin
    assert.notEqual(slotOf(17), slotOf(0)); // …lost after eviction (would equal 0 if it had stayed sticky)
    assert.equal(slotOf(18), slotOf(16)); // r16 kept its slot — recent run survives the window
});

test("streaming:false: a non-ok response rejects as a classified ProviderError (covers the non-streamed transport)", async () => {
    const { ProviderError } = await import("./errors.ts");
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false, source: "provider:test" });
    mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
    await assert.rejects(() => p.generate({ workerId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
        assert.equal(err.kind, "network_failure"); // ≥500 → network_failure
        assert.equal(err.status, 500);
        return true;
    });
});

test("generate fail-hards on a missing or empty workerId", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await assert.rejects(() => p.generate({ workerId: "", messages: [] }), /workerId is required/);
    await assert.rejects(() => (p.generate as (a: object) => Promise<unknown>)({ messages: [] }), /workerId is required/);
});

test("messages pass through verbatim — the provider injects no turn (PLAN lives in the grammar, never a provider prefill)", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "out" } }] }]);
    const input = [{ role: "user" as const, content: "hi" }];
    const res = await p.generate({ workerId: "r", messages: input });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).messages, input); // no extra assistant turn
    assert.equal(res.assistant.content, "out"); // content returned verbatim
});

test("generate wraps an HTTP failure as a ProviderError carrying Problem Details", async () => {
    const { ProviderError } = await import("./errors.ts");
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, source: "provider:test" });
    mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));
    await assert.rejects(() => p.generate({ workerId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
        assert.equal(err.kind, "rate_limit");
        assert.equal(err.status, 429);
        assert.equal(err.problem.status, 429);
        assert.equal(err.problem.detail, err.message);
        assert.equal(err.problem.type, "https://problems.plurnk.dev/provider/test/rate-limit");
        return true;
    });
});

test("generate rejects on a pre-aborted external signal", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    const signal = AbortSignal.abort(new Error("nope"));
    await assert.rejects(() => p.generate({ workerId: "r", messages: [], signal }));
});

test("configured headers and url are sent verbatim", async () => {
    const p = new AiSdkProvider({
        model: "m", url: "http://host/custom/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0,
        headers: { Authorization: "Bearer secret", "X-Title": "plurnk" },
    });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [] });
    assert.equal(calls[0].url, "http://host/custom/chat/completions");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");
    assert.equal(headers.get("x-title"), "plurnk");
});

// — transient-failure retry —

const retryCfg = { model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null } as const };

test("retry: a transient failure retries and a later success resolves", async () => {
    const calls = installFetchScript([
        { status: 429, retryAfter: 0 },
        { status: 503, retryAfter: 0 },
        { status: 200, chunks: [{ choices: [{ delta: { content: "ok" } }] }] },
    ]);
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 3 });
    const res = await p.generate({ workerId: "r", messages: [] });
    assert.equal(res.assistant.content, "ok");
    assert.equal(calls.length, 3); // 429 → 503 → 200
});

test("streamed-body silence fails the exchange without replaying partial output", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
        calls++;
        if (calls === 1) {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(
                        'data: {"id":"first","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
                    ));
                    setTimeout(() => controller.close(), 100);
                },
            }), { status: 200 });
        }
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(
                    'data: {"id":"second","object":"chat.completion.chunk","created":2,"model":"m","choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ));
                controller.close();
            },
        }), { status: 200 });
    });
    const p = new AiSdkProvider({
        model: "m",
        url: "http://x/v1/chat/completions",
        fetchTimeoutMs: 1000,
        streamIdleTimeoutMs: 10,
        temperature: 0.2,
        repeatPenalty: 1.15,
        reasoning: { mode: "off", budget: null },
        retryAttempts: 1,
        source: "provider:test",
    });
    await assert.rejects(
        p.generate({ workerId: "r", messages: [] }),
        (error: ProviderError) => error.kind === "network_failure"
            && /chunk timeout/i.test(error.message),
    );
    assert.equal(calls, 1);
    mock.restoreAll();
});

test("a zero stream-idle timeout permits a slow inter-chunk pause", async () => {
    mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
        async start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"slow "}}]}\n\n'));
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"is valid"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200 }));
    const p = new AiSdkProvider({
        model: "m",
        url: "http://x/v1/chat/completions",
        fetchTimeoutMs: 1000,
        streamIdleTimeoutMs: 0,
        temperature: 0.2,
        repeatPenalty: 1.15,
        reasoning: { mode: "off", budget: null },
        retryAttempts: 0,
    });
    const result = await p.generate({ workerId: "r", messages: [] });
    assert.equal(result.assistant.content, "slow is valid");
    mock.restoreAll();
});

test("retry: exhausting the budget surfaces the classified ProviderError", async () => {
    const { ProviderError } = await import("./errors.ts");
    const calls = installFetchScript([{ status: 429, retryAfter: 0 }]); // always rate-limited
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 2 });
    await assert.rejects(
        () => p.generate({ workerId: "r", messages: [] }),
        (err: unknown) => { assert.ok(err instanceof ProviderError); assert.equal(err.kind, "rate_limit"); return true; },
    );
    assert.equal(calls.length, 3); // 1 initial + 2 retries
});

test("retry: a Retry-After HTTP-date is honored — a past date parses to a 0ms wait, then retries", async () => {
    const calls = installFetchScript([
        { status: 503, retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT" }, // date form, in the past → max(0, past−now) = 0
        { status: 200, chunks: [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }] },
    ]);
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 1 });
    const { assistant } = await p.generate({ workerId: "r", messages: [] });
    assert.equal(assistant.content, "ok");
    assert.equal(calls.length, 2); // initial 503 + one retry, no real wall-clock wait
});

test("retry: a terminal error (401 unauthorized) is never retried", async () => {
    const calls = installFetchScript([{ status: 401 }]);
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 5 });
    await assert.rejects(() => p.generate({ workerId: "r", messages: [] }), /401/);
    assert.equal(calls.length, 1); // terminal — no retry despite budget
});

test("retry: retryAttempts 0 surfaces the first transient failure immediately", async () => {
    const calls = installFetchScript([{ status: 503, retryAfter: 0 }]);
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 0 });
    await assert.rejects(() => p.generate({ workerId: "r", messages: [] }));
    assert.equal(calls.length, 1); // no retry budget
});

test("retry: a caller abort during backoff rejects promptly with no further attempt", async () => {
    const ac = new AbortController();
    const calls = installFetchScript([{ status: 503, retryAfter: 5 }]); // 5s backoff we never wait out
    const p = new AiSdkProvider({ ...retryCfg, retryAttempts: 3 });
    const promise = p.generate({ workerId: "r", messages: [], signal: ac.signal });
    await flush(); // attempt 0 fails, enters the backoff sleep
    assert.equal(calls.length, 1);
    ac.abort(new Error("cancelled"));
    await assert.rejects(() => promise); // abort cuts through the backoff
    assert.equal(calls.length, 1); // never retried after cancellation
});

// — Anthropic reasoning style (wire `thinking` parameter) —

test("reasoningStyle 'anthropic' maps the budget to the thinking param", async () => {
    // N>0 → enabled with budget_tokens
    const capped = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "on", budget: 4096 }, reasoningStyle: "anthropic" });
    let calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await capped.generate({ workerId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "enabled", budget_tokens: 4096 });

    mock.restoreAll();
    // 0 → explicit disabled
    const off = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, reasoningStyle: "anthropic" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await off.generate({ workerId: "r", messages: [] });
    assert.deepEqual(JSON.parse(calls[0].init.body as string).thinking, { type: "disabled" });

    mock.restoreAll();
    // -1 adaptive → omit (API default depth)
    const adaptive = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, retryAttempts: 0, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "adaptive", budget: null }, reasoningStyle: "anthropic" });
    calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await adaptive.generate({ workerId: "r", messages: [] });
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
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, streaming: false });
    const res = await p.generate({ workerId: "r", messages: [] });
    const sent = JSON.parse(calls[0].body);
    assert.equal("stream" in sent, false);                 // no streaming flag
    assert.equal(res.assistant.content, "hello");          // content from message.content
    assert.equal(res.assistant.reasoning, "because");      // reasoning_content mapped
    assert.equal(res.assistant.finishReason, "stop");
    assert.equal(res.assistant.usage.total, 4);
    mock.restoreAll();
});

// ── Data capture ({§provider-evidence}): logprobs + verbatim rawBody, opt-in, off by default ──
const captureBase = { model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null } as const, retryAttempts: 0 };

test("logprobs OFF by default: no wire request, no assistant.logprobs, no rawBody", async () => {
    const calls = installFetch([{ model: "m", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]);
    const p = new AiSdkProvider({ ...captureBase });
    const res = await p.generate({ workerId: "r", messages: [{ role: "user", content: "q" }] });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal("logprobs" in body, false);
    assert.equal("top_logprobs" in body, false);
    assert.equal(res.assistant.logprobs, undefined);
    assert.equal(res.assistant.meanLogprob, undefined);
    assert.equal(res.rawBody, undefined);
    mock.restoreAll();
});

test("logprobs ON (streamed): requests logprobs+top_logprobs, surfaces raw logprob + meanLogprob", async () => {
    const chunk = { model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, choices: [{ delta: { content: "yesno" }, finish_reason: "stop", logprobs: { content: [
        { token: "yes", logprob: -0.5, sampling_logprob: -0.5, top_logprobs: [{ token: "yes", logprob: -0.5 }, { token: "no", logprob: -1.0 }] },
        { token: "no", logprob: -0.1, sampling_logprob: -0.1, top_logprobs: [{ token: "no", logprob: -0.1 }] },
    ] } }] };
    const calls = installFetch([chunk]);
    const p = new AiSdkProvider({ ...captureBase, topLogprobs: 2 });
    const res = await p.generate({ workerId: "r", messages: [{ role: "user", content: "q" }] });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 2);
    assert.equal(res.assistant.logprobs?.length, 2);
    assert.deepEqual(res.assistant.logprobs?.[0], { token: "yes", logprob: -0.5, top: [{ token: "yes", logprob: -0.5 }, { token: "no", logprob: -1.0 }] });
    assert.equal(res.assistant.meanLogprob, -0.3); // (-0.5 + -0.1) / 2
    mock.restoreAll();
});

test("rawBody ON (non-streamed): verbatim wire body incl. sampling_logprob preserved", async () => {
    const wire = { model: "m", extra_top_level: "kept", choices: [{ message: { content: "no" }, finish_reason: "stop", logprobs: { content: [{ token: "no", logprob: -0.1, sampling_logprob: -0.1, token_id: 42 }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    installFetchJson(wire);
    const p = new AiSdkProvider({ ...captureBase, streaming: false, topLogprobs: 0, rawBody: true });
    const res = await p.generate({ workerId: "r", messages: [{ role: "user", content: "q" }] });
    assert.deepEqual(res.rawBody, wire); // verbatim
    assert.equal((res.rawBody as typeof wire).choices[0].logprobs.content[0].sampling_logprob, -0.1);
    assert.equal((res.rawBody as typeof wire).choices[0].logprobs.content[0].token_id, 42);
    assert.equal(res.assistant.logprobs?.[0].token, "no"); // structured view still uses raw logprob
    mock.restoreAll();
});

test("caller sampling cannot forge logprobs (reserved keys): the env flag is the only control", async () => {
    const calls = installFetch([{ model: "m", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]);
    const p = new AiSdkProvider({ ...captureBase }); // logprobs OFF
    await p.generate({ workerId: "r", messages: [{ role: "user", content: "q" }], sampling: { logprobs: true, top_logprobs: 5 } });
    const body = JSON.parse((calls[0].init.body as string));
    assert.equal("logprobs" in body, false);   // sampling passthrough stripped it
    assert.equal("top_logprobs" in body, false);
    mock.restoreAll();
});

// — turn coordinate headers ({§lifecycle-terms}): same gate as every first-party signal —

test("workspaceId/loop/turn ride as Plurnk-Workspace-Id/Loop/Turn under the first-party gate", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], workspaceId: "s-9", loop: 3, turn: 41 });
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("plurnk-workspace-id"), "s-9");
    assert.equal(headers.get("plurnk-loop"), "3");
    assert.equal(headers.get("plurnk-turn"), "41");
});

test("third-party providers structurally DROP the coordinate (gate off by default)", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], workspaceId: "s-9", loop: 3, turn: 41 });
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.has("plurnk-workspace-id"), false);
    assert.equal(headers.has("plurnk-loop"), false);
    assert.equal(headers.has("plurnk-turn"), false);
});

test("coordinates are 1-based — 0/absent/empty emit no header", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, firstPartyMetadata: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], workspaceId: "", loop: 0, turn: 0 });
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.has("plurnk-workspace-id"), false);
    assert.equal(headers.has("plurnk-loop"), false);
    assert.equal(headers.has("plurnk-turn"), false);
    assert.equal(headers.has("plurnk-strikes"), false);
});

// -- {§provider-generation-envelope} --

test("reserves derive from the detected window; absolutes stand alone; null window + percent = no claim", () => {
    const base = { model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 1000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null } as const, retryAttempts: 0 };
    const derived = new AiSdkProvider({ ...base, contextWindow: 49152, reasoningReserve: { percent: 0.1 }, completionReserve: { percent: 0.25 } });
    assert.equal(derived.reasoningReserve, 4915);   // jennifer/turboderp: 10% of 49152
    assert.equal(derived.completionReserve, 12288); // 25% of 49152
    const pinned = new AiSdkProvider({ ...base, contextWindow: null, reasoningReserve: { tokens: 4096 }, completionReserve: { percent: 0.25 } });
    assert.equal(pinned.reasoningReserve, 4096);    // absolute pin needs no window
    assert.equal(pinned.completionReserve, null);   // percent without a window = underivable
    const legacy = new AiSdkProvider({ ...base, contextWindow: 49152 });
    assert.equal(legacy.reasoningReserve, null);    // out-of-date sibling: no claim
});

test("router-owned tuning: tuningFloors:false drops the temperature/penalty floors, caller sampling still rides", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, frequencyPenalty: 0.4, reasoning: { mode: "off", budget: null }, retryAttempts: 0, tuningFloors: false });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "r", messages: [], sampling: { temperature: 0.9 } });
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.temperature, 0.9);           // caller intent passes verbatim
    assert.equal("frequency_penalty" in body, false); // the floor is suppressed; the router owns tuning
});

// -- prompt-cache affinity (workerId -> prompt_cache_key) --

test("promptCacheKey on: body sends prompt_cache_key = workerId (serverless replica affinity)", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, promptCacheKey: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "worker-abc", messages: [] });
    assert.equal(JSON.parse(calls[0].init.body as string).prompt_cache_key, "worker-abc");
});

test("promptCacheKey off (default): no prompt_cache_key on the wire", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0 });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "worker-abc", messages: [] });
    assert.equal("prompt_cache_key" in JSON.parse(calls[0].init.body as string), false);
});

test("prompt_cache_key is managed: caller sampling cannot forge/override the affinity key", async () => {
    const p = new AiSdkProvider({ model: "m", url: "http://x/v1/chat/completions", fetchTimeoutMs: 5000, temperature: 0.2, repeatPenalty: 1.15, reasoning: { mode: "off", budget: null }, retryAttempts: 0, promptCacheKey: true });
    const calls = installFetch([{ choices: [{ delta: { content: "x" } }] }]);
    await p.generate({ workerId: "worker-abc", messages: [], sampling: { prompt_cache_key: "hijack" } });
    assert.equal(JSON.parse(calls[0].init.body as string).prompt_cache_key, "worker-abc"); // managed wins
});
