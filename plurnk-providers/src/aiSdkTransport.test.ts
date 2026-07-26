import assert from "node:assert/strict";
import test from "node:test";
import { executeOpenAICompatible } from "./aiSdkTransport.ts";

const request = {
    url: "https://example.test/v1/chat/completions",
    model: "test-model",
    headers: {},
    body: {},
    messages: [{ role: "user" as const, content: "question" }],
    fetchTimeoutMs: 1_000,
    retryAttempts: 2,
    streaming: false,
    captureRawBody: false,
};

test("X-Should-Retry:false prevents nested retries for a normally retryable status", async () => {
    let calls = 0;
    await assert.rejects(executeOpenAICompatible({
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
    }));
    assert.equal(calls, 1);
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
        retryAttempts: 0,
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
        prompt: 3,
        completion: 3,
        reasoning: 2,
        cached: 0,
        total: 8,
    });
    assert.equal(result.logprobs[0]?.token, "answer");
    assert.deepEqual(result.metadata.balance, { amount: 1.25, currency: "USD" });
    assert.deepEqual(result.rawBody, responseBody);
});

test("the adapter preserves nonstandard reasoning accounting after SDK parsing", async (t) => {
    const execute = (responseBody: object) => executeOpenAICompatible({
        ...request,
        retryAttempts: 0,
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
            prompt: 2,
            completion: 3,
            reasoning: 4,
            cached: 0,
            total: 9,
        });
    });

    await t.test("Fireworks-style unitemized output is split by returned channels", async () => {
        const result = await execute(response(
            { content: "aa", reasoning_content: "bbbbbb" },
            { prompt_tokens: 2, completion_tokens: 10, total_tokens: 12 },
        ));
        assert.deepEqual(result.usage, {
            prompt: 2,
            completion: 2,
            reasoning: 8,
            cached: 0,
            total: 12,
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
            retryAttempts: 0,
            streaming: true,
            fetch: async () => new Response(
                `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
        });
        assert.deepEqual(result.usage, {
            prompt: 2,
            completion: 3,
            reasoning: 4,
            cached: 0,
            total: 9,
        });
    });

    await t.test("streamed Fireworks-style channels preserve the output split", async () => {
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
            retryAttempts: 0,
            streaming: true,
            fetch: async () => new Response(
                `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
        });
        assert.deepEqual(result.usage, {
            prompt: 2,
            completion: 2,
            reasoning: 8,
            cached: 0,
            total: 12,
        });
    });
});
