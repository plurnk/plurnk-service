import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { ProviderTimeoutError } from "./errors.ts";
import { calculateCostUsdDecimal } from "./usage.ts";
import {
    executeAiSdkModel,
    executeOpenAICompatible,
    normalizeRetryAttemptError,
    transportFailureOutputObserved,
    transportFailureEvidence,
} from "./aiSdkTransport.ts";

const request = {
    url: "https://example.test/v1/chat/completions",
    model: "test-model",
    headers: {},
    body: {},
    messages: [{ role: "user" as const, content: "question" }],
    fetchTimeoutMs: 1_000,
    streaming: false,
    captureRawBody: false,
};

test("{§provider-usage} implicit caching retains the SDK input partition without inventing missing counters", async (t) => {
    for (const streaming of [false, true]) {
        for (const cached of [undefined, 0, 400]) {
            await t.test(`${streaming ? "stream" : "buffered"}, cached=${cached}`, async () => {
                const usage = {
                    prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
                    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
                    completion_tokens_details: { reasoning_tokens: 40 },
                };
                const body = {
                    id: "cache-reply", model: "test-model",
                    choices: [{ index: 0, [streaming ? "delta" : "message"]: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage,
                };
                const result = await executeOpenAICompatible({
                    ...request, streaming,
                    fetch: async () => new Response(
                        streaming ? `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n` : JSON.stringify(body),
                        { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } },
                    ),
                });
                assert.deepEqual(result.usage?.inputTokenDetails, cached === undefined ? undefined : {
                    noCacheTokens: 1000 - cached, cacheReadTokens: cached, cacheWriteTokens: 0,
                });
                assert.equal(result.usageRefusal, undefined);
                assert.equal(calculateCostUsdDecimal(result.usage!, {
                    input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0,
                }), cached === undefined ? null : cached === 0 ? "0.0002" : "0.000152");
                assert.deepEqual(result.chargeEvidence.usage, usage, "the original counters remain unmodified");
            });
        }
    }
});

test("{§provider-sdk-boundary} native cache accounting uses the SDK's total rather than a raw uncached-input counter", async (t) => {
    const rawUsage = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 };
    const message = {
        id: "native-cache-reply", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: rawUsage,
    };
    for (const streaming of [false, true]) {
        await t.test(streaming ? "stream" : "buffered", async () => {
            const chunks = [
                { type: "message_start", message: { ...message, content: [], usage: { ...rawUsage, output_tokens: 0 } } },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } },
                { type: "message_stop" },
            ];
            const anthropic = createAnthropic({
                apiKey: "test-key",
                fetch: async () => new Response(streaming
                    ? chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("")
                    : JSON.stringify(message), { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } }),
            });
            const result = await executeAiSdkModel({
                ...request, streaming, languageModel: anthropic("claude-sonnet-4-5"),
            });
            assert.deepEqual(result.usage, {
                inputTokens: 1000, outputTokens: 100, totalTokens: 1100,
                inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 },
            });
            assert.equal(result.usageRefusal, undefined);
            assert.equal(calculateCostUsdDecimal(result.usage!, {
                input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.2,
            }), "0.000126");
            assert.deepEqual(result.chargeEvidence.usage, streaming ? { output_tokens: 100 } : rawUsage);
        });
    }
});

test("{§provider-usage-refusal} failure evidence retains valid MiMo totals and cache counters", () => {
    const usage = {
        prompt_tokens: 38673, completion_tokens: 16384, total_tokens: 55057,
        completion_tokens_details: { reasoning_tokens: 16385 },
        prompt_tokens_details: { cached_tokens: 14528 },
    };
    const error = new APICallError({
        message: "upstream error", url: request.url, requestBodyValues: {},
        statusCode: 500, responseBody: JSON.stringify({ usage }),
    });
    const evidence = transportFailureEvidence(error);
    assert.deepEqual(evidence.usage, {
        inputTokens: 38673, outputTokens: 16384, totalTokens: 55057,
        inputTokenDetails: { cacheReadTokens: 14528 },
    });
    assert.deepEqual(evidence.usageRefusal?.usage, usage);
    assert.equal(evidence.usageRefusal?.reason, "provider usage.outputTokenDetails.textTokens must be a non-negative safe integer");
    assert.equal(evidence.status, 500);
});

test("{§provider-sdk-boundary} the transport performs exactly one physical request", async () => {
    let calls = 0;
    await assert.rejects(
        executeOpenAICompatible({
            ...request,
            fetch: async () => {
                calls += 1;
                return new Response(
                    JSON.stringify({ error: { message: "upstream attempts exhausted" } }),
                    {
                        status: 503,
                        headers: {
                            "content-type": "application/json",
                            "x-should-retry": "false",
                        },
                    },
                );
            },
        }),
        (error) => APICallError.isInstance(error)
            && error.statusCode === 503
            && error.isRetryable === false,
    );
    assert.equal(calls, 1);
});

test("stream failure evidence distinguishes semantic output from pre-output failure ({§provider-connectivity})", async (t) => {
    const cases = [
        { name: "text", delta: { content: "partial" }, expected: true },
        { name: "reasoning", delta: { reasoning_content: "partial" }, expected: true },
        { name: "empty", delta: {}, expected: false },
    ] as const;
    for (const specimen of cases) {
        await t.test(specimen.name, async () => {
            await assert.rejects(
                executeOpenAICompatible({
                    ...request,
                    streaming: true,
                    fetch: async () => new Response(new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(
                                `data: ${JSON.stringify({
                                    id: "interrupted",
                                    object: "chat.completion.chunk",
                                    created: 1,
                                    model: "test-model",
                                    choices: [{ index: 0, delta: specimen.delta, finish_reason: null }],
                                })}\n\n`,
                            ));
                            setTimeout(() => controller.error(new TypeError("terminated")), 10);
                        },
                    }), { status: 200 }),
                }),
                (error) => {
                    assert.equal(transportFailureOutputObserved(error), specimen.expected);
                    return true;
                },
            );
        });
    }
});

test("the adapter preserves PLURNK request extensions and response evidence", async () => {
    let body: Record<string, unknown> | undefined;
    const responseBody = {
        id: "response-1",
        object: "chat.completion",
        created: 1,
        model: "served-model",
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: "answer",
                reasoning_content: "because",
            },
            finish_reason: "stop",
            logprobs: {
                content: [{ token: "answer", logprob: -0.1, top_logprobs: [] }],
            },
        }],
        usage: {
            prompt_tokens: 3,
            completion_tokens: 5,
            total_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 2 },
        },
        balance: { amount: 1.25, currency: "USD" },
    };
    const result = await executeOpenAICompatible({
        ...request,
        captureRawBody: true,
        body: {
            grammar: "root ::= \"answer\"",
            id_slot: 2,
        },
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify(responseBody), {
                headers: { "content-type": "application/json" },
            });
        },
    });

    assert.equal(body?.grammar, "root ::= \"answer\"");
    assert.equal(body?.id_slot, 2);
    assert.equal(result.model, "served-model");
    assert.equal(result.content, "answer");
    assert.equal(result.reasoning, "because");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
    });
    assert.equal(result.logprobs[0]?.token, "answer");
    assert.deepEqual(result.metadata.balance, { amount: 1.25, currency: "USD" });
    assert.deepEqual(result.rawBody, responseBody);
});

test("request extensions cannot replace SDK-owned model or message serialization", async () => {
    await assert.rejects(
        executeOpenAICompatible({
            ...request,
            body: { messages: [] },
        }),
        /request extensions may not override SDK-owned field "messages"/,
    );
});

test("the adapter maps leading system messages to AI SDK instructions", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
            model: "m",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await executeOpenAICompatible({
        url: "https://example.test/v1/chat/completions",
        model: "m",
        headers: {},
        body: {},
        messages: [
            { role: "system", content: "system contract" },
            { role: "user", content: "hello" },
        ],
        fetchTimeoutMs: 1000,
        streaming: false,
        captureRawBody: false,
        fetch,
    });
    assert.deepEqual(calls[0]?.messages, [
        { role: "system", content: "system contract" },
        { role: "user", content: "hello" },
    ]);
});

test("the adapter preserves nonstandard reasoning accounting after SDK parsing", async (t) => {
    const execute = (responseBody: object) => executeOpenAICompatible({
        ...request,
        fetch: async () => new Response(JSON.stringify(responseBody), {
            headers: { "content-type": "application/json" },
        }),
    });
    const response = (
        message: Record<string, unknown>,
        usage: Record<string, number>,
    ) => ({
        id: "response-1",
        object: "chat.completion",
        created: 1,
        model: "served-model",
        choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
        usage,
    });

    await t.test("Gemini-style total gap becomes reasoning", async () => {
        const result = await execute(response(
            { content: "answer" },
            { prompt_tokens: 2, completion_tokens: 3, total_tokens: 9 },
        ));
        assert.deepEqual(result.usage, {
            inputTokens: 2,
            outputTokens: 7,
            totalTokens: 9,
            outputTokenDetails: { textTokens: 3, reasoningTokens: 4 },
        });
    });

    await t.test("Fireworks-style channels do not invent token attribution", async () => {
        const result = await execute(response(
            { content: "aa", reasoning_content: "bbbbbb" },
            { prompt_tokens: 2, completion_tokens: 10, total_tokens: 12 },
        ));
        assert.deepEqual(result.usage, {
            inputTokens: 2,
            outputTokens: 10,
            totalTokens: 12,
        });
    });

    await t.test("streamed Gemini-style total gap is preserved", async () => {
        const chunks = [
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "served-model",
                choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
            },
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "served-model",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 9 },
            },
        ];
        const result = await executeOpenAICompatible({
            ...request,
            streaming: true,
            fetch: async () => new Response(
                `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
        });
        assert.deepEqual(result.usage, {
            inputTokens: 2,
            outputTokens: 7,
            totalTokens: 9,
            outputTokenDetails: { textTokens: 3, reasoningTokens: 4 },
        });
    });

    await t.test("streamed Fireworks-style channels do not invent an output split", async () => {
        const reasoning: string[] = [];
        const chunks = [
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "served-model",
                choices: [{
                    index: 0,
                    delta: { reasoning_content: "bbbbbb", content: "aa" },
                    finish_reason: null,
                }],
            },
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "served-model",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 10, total_tokens: 12 },
            },
        ];
        const result = await executeOpenAICompatible({
            ...request,
            streaming: true,
            observeReasoning: (delta) => reasoning.push(delta),
            fetch: async () => new Response(
                `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
        });
        assert.deepEqual(result.usage, {
            inputTokens: 2,
            outputTokens: 10,
            totalTokens: 12,
        });
        assert.equal(reasoning.join(""), "bbbbbb", "readable reasoning is observed before transport completion");
    });
});

test("normalizeRetryAttemptError — deadlines surface at once, never transport-retried ({§provider-connectivity}, #479)", () => {
    const first = normalizeRetryAttemptError(new ProviderTimeoutError("first_content", 180000));
    assert.equal(APICallError.isInstance(first), true);
    assert.equal((first as APICallError).isRetryable, false);
    const attempt = normalizeRetryAttemptError(new ProviderTimeoutError("attempt", 60000));
    assert.equal((attempt as APICallError).isRetryable, false);
    const idle = normalizeRetryAttemptError(new ProviderTimeoutError("stream_idle", 120000));
    assert.equal((idle as APICallError).isRetryable, false);
    const operation = new ProviderTimeoutError("operation", 2700000);
    assert.equal(normalizeRetryAttemptError(operation), operation);
});

test("normalizeRetryAttemptError — only provider-directed waits retry: 429, Retry-After, or a directive (#479 supersedes #446)", () => {
    const garbage = new APICallError({
        message: "Failed to process successful response",
        url: "https://api.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 200,
        responseBody: "not json",
        isRetryable: false,
    });
    assert.equal(normalizeRetryAttemptError(garbage), garbage, "2xx invalid-response surfaces at once — no promoted budget (#446 superseded)");

    const directed = new APICallError({
        message: "Failed to process successful response",
        url: "https://api.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 200,
        responseHeaders: { "x-should-retry": "true" },
        isRetryable: false,
    });
    assert.equal((normalizeRetryAttemptError(directed) as APICallError).isRetryable, true, "an explicit directive still outranks");

    const rateLimited = new APICallError({
        message: "slow down",
        url: "https://api.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
    });
    assert.equal((normalizeRetryAttemptError(rateLimited) as APICallError).isRetryable, true, "a 429 is the provider-directed wait");

    const directedWait = new APICallError({
        message: "maintenance",
        url: "https://api.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after": "1" },
        isRetryable: true,
    });
    assert.equal((normalizeRetryAttemptError(directedWait) as APICallError).isRetryable, true, "Retry-After on any status is a directed wait");

    const bareServerError = new APICallError({
        message: "internal error",
        url: "https://api.example/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
    });
    assert.equal((normalizeRetryAttemptError(bareServerError) as APICallError).isRetryable, false, "a bare 5xx surfaces at once for the engine's recovery");
});

// {§provider-wire-emission} — a blank emission is readable: what the stream carried is kept, channel by channel.
test("the transport record keeps the wire emission: empty chunks, tool calls and channels the protocol does not read", async (t) => {
    const usage = { prompt_tokens: 10, completion_tokens: 13, total_tokens: 23, completion_tokens_details: { reasoning_tokens: 4 } };
    await t.test("streamed", async () => {
        const chunks = [
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { reasoning_content: "Let me read it." }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { content: null }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "READ", arguments: "{\"path\": \"dja" } }] }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "ngo/views/debug.py\"}" } }] }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { refusal: "no" }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
        ];
        const result = await executeOpenAICompatible({
            ...request,
            streaming: true,
            fetch: async () => new Response(new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                },
            }), { headers: { "content-type": "text/event-stream" } }),
        });
        assert.equal(result.content, "", "the protocol's channel was blank");
        assert.equal(result.reasoning, "Let me read it.");
        assert.deepEqual(result.wire, {
            chunks: 8,
            emptyChunks: 4,
            fields: { reasoning_content: 1, tool_calls: 2, refusal: 1 },
            channels: { refusal: "no" },
            toolCalls: [{ index: 0, id: "call-1", type: "function", name: "READ", arguments: "{\"path\": \"django/views/debug.py\"}" }],
            finishReasons: ["stop"],
        }, "the record says what the thirteen billed tokens were");
    });
    await t.test("unstreamed", async () => {
        const result = await executeOpenAICompatible({
            ...request,
            fetch: async () => new Response(JSON.stringify({
                id: "response-1", object: "chat.completion", created: 1, model: "served-model",
                choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "why", tool_calls: [{ id: "c", type: "function", function: { name: "FIND", arguments: "{}" } }] }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
            }), { headers: { "content-type": "application/json" } }),
        });
        assert.equal(result.content, "answer");
        assert.deepEqual(result.wire, {
            chunks: 1,
            emptyChunks: 0,
            fields: { content: 1, reasoning_content: 1, tool_calls: 1 },
            channels: {},
            toolCalls: [{ index: 0, id: "c", type: "function", name: "FIND", arguments: "{}" }],
            finishReasons: ["stop"],
        });
    });
});

// {§provider-usage-refusal} (#580) — the provider's counters disagree with themselves; the
// exchange is not the casualty.
test("inconsistent usage counters refuse normalization without failing the response, in both shapes", async (t) => {
    const usage = { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6, completion_tokens_details: { reasoning_tokens: 7 } };
    await t.test("non-streamed", async () => {
        const result = await executeOpenAICompatible({
            ...request,
            fetch: async () => new Response(JSON.stringify({
                id: "response-1", object: "chat.completion", created: 1, model: "served-model",
                choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
                usage,
            }), { headers: { "content-type": "application/json" } }),
        });
        assert.equal(result.content, "answer", "the model's answer survives the provider's bookkeeping");
        assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 5, totalTokens: 6 }, "valid totals survive; the contradictory breakdown is not clamped");
        assert.deepEqual(result.usageRefusal, {
            reason: "provider usage.outputTokenDetails.textTokens must be a non-negative safe integer",
            usage,
        }, "the counters as reported ride beside the refusal");
        assert.deepEqual(result.chargeEvidence.usage, usage, "charge evidence still carries the wire usage");
    });
    await t.test("streamed", async () => {
        const chunks = [
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
            { id: "r", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
        ];
        const result = await executeOpenAICompatible({
            ...request,
            streaming: true,
            fetch: async () => new Response(new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                },
            }), { headers: { "content-type": "text/event-stream" } }),
        });
        assert.equal(result.content, "answer");
        assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 5, totalTokens: 6 });
        assert.equal(result.usageRefusal?.reason, "provider usage.outputTokenDetails.textTokens must be a non-negative safe integer");
        assert.deepEqual(result.usageRefusal?.usage, usage);
    });
    await t.test("consistent counters still normalize", async () => {
        const result = await executeOpenAICompatible({
            ...request,
            fetch: async () => new Response(JSON.stringify({
                id: "response-1", object: "chat.completion", created: 1, model: "served-model",
                choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } },
            }), { headers: { "content-type": "application/json" } }),
        });
        assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 5, totalTokens: 6, outputTokenDetails: { textTokens: 3, reasoningTokens: 2 } });
        assert.equal(result.usageRefusal, undefined);
    });
});
