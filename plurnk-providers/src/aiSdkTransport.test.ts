import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { ProviderTimeoutError } from "./errors.ts";
import {
    executeOpenAICompatible,
    normalizeRetryAttemptError,
    transportFailureOutputObserved,
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

test("the transport performs exactly one physical request", async () => {
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

test("normalizeRetryAttemptError — attempt, first-content, and stream-idle deadlines are retryable transients ({§provider-connectivity})", () => {
    const first = normalizeRetryAttemptError(new ProviderTimeoutError("first_content", 180000));
    assert.equal(APICallError.isInstance(first), true);
    assert.equal((first as APICallError).isRetryable, true);
    const attempt = normalizeRetryAttemptError(new ProviderTimeoutError("attempt", 60000));
    assert.equal((attempt as APICallError).isRetryable, true);
    const idle = normalizeRetryAttemptError(new ProviderTimeoutError("stream_idle", 120000));
    assert.equal((idle as APICallError).isRetryable, true);
    const operation = new ProviderTimeoutError("operation", 2700000);
    assert.equal(normalizeRetryAttemptError(operation), operation);
});
