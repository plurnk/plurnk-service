import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, streamText } from "ai";

const encoder = new TextEncoder();

const sseResponse = (...chunks: object[]): Response => new Response(
    new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    }),
    { headers: { "content-type": "text/event-stream" } },
);

describe("AI SDK adapter spike", () => {
    it("preserves PLURNK request extensions and complete stream evidence", async () => {
        let requestBody: Record<string, unknown> | undefined;
        const rawChunks = [
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{
                    index: 0,
                    delta: { role: "assistant", reasoning_content: "because " },
                    finish_reason: null,
                }],
            },
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{
                    index: 0,
                    delta: { content: "answer" },
                    finish_reason: null,
                }],
            },
            {
                id: "response-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 3,
                    completion_tokens: 5,
                    total_tokens: 8,
                    completion_tokens_details: { reasoning_tokens: 2 },
                },
            },
        ];
        const provider = createOpenAICompatible({
            name: "spike",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            includeUsage: true,
            fetch: async (_input, init) => {
                requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return sseResponse(...rawChunks);
            },
        });

        const result = streamText({
            model: provider("test-model"),
            messages: [{ role: "user", content: "question" }],
            maxOutputTokens: 64,
            temperature: 0.25,
            maxRetries: 0,
            timeout: { totalMs: 1_000, chunkMs: 500 },
            includeRawChunks: true,
            providerOptions: {
                spike: {
                    grammar: "root ::= \"answer\"",
                    id_slot: 2,
                    enable_thinking: true,
                    service_tier: "flex",
                },
            },
        });
        const parts = [];
        for await (const part of result.fullStream) parts.push(part);

        assert.equal(requestBody?.model, "test-model");
        assert.equal(requestBody?.max_tokens, 64);
        assert.equal(requestBody?.temperature, 0.25);
        assert.equal(requestBody?.grammar, "root ::= \"answer\"");
        assert.equal(requestBody?.id_slot, 2);
        assert.equal(requestBody?.enable_thinking, true);
        assert.equal(requestBody?.service_tier, "flex");
        assert.equal(requestBody?.stream, true);
        assert.deepEqual(requestBody?.stream_options, { include_usage: true });

        assert.equal(await result.text, "answer");
        assert.equal(await result.reasoningText, "because ");
        assert.equal(await result.finishReason, "stop");
        assert.equal(await result.rawFinishReason, "stop");
        const usage = await result.usage;
        assert.equal(usage.inputTokens, 3);
        assert.equal(usage.outputTokens, 5);
        assert.equal(usage.outputTokenDetails.reasoningTokens, 2);
        assert.equal(usage.outputTokenDetails.textTokens, 3);
        assert.equal(usage.totalTokens, 8);
        assert.deepEqual(
            parts.filter((part) => part.type === "raw").map((part) => part.rawValue),
            rawChunks,
        );
    });

    it("surfaces typed HTTP failures without retrying", async () => {
        let requests = 0;
        const provider = createOpenAICompatible({
            name: "spike",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            fetch: async () => {
                requests += 1;
                return new Response(
                    JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }),
                    {
                        status: 429,
                        headers: {
                            "content-type": "application/json",
                            "retry-after": "3",
                            "x-request-id": "request-1",
                        },
                    },
                );
            },
        });
        const result = streamText({
            model: provider("test-model"),
            prompt: "question",
            maxRetries: 0,
            onError: () => {},
        });

        const parts = [];
        for await (const part of result.fullStream) parts.push(part);
        const errorPart = parts.find((part) => part.type === "error");
        assert.ok(errorPart?.type === "error");
        assert.ok(APICallError.isInstance(errorPart.error));
        assert.equal(errorPart.error.statusCode, 429);
        assert.equal(errorPart.error.isRetryable, true);
        assert.equal(errorPart.error.responseHeaders?.["retry-after"], "3");
        assert.equal(errorPart.error.responseHeaders?.["x-request-id"], "request-1");
        assert.match(errorPart.error.responseBody ?? "", /rate limited/);
        assert.equal(requests, 1);
    });

    it("enforces stream-idle timeout through the transport contract", async () => {
        const provider = createOpenAICompatible({
            name: "spike",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            fetch: async () => new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                            id: "response-1",
                            object: "chat.completion.chunk",
                            created: 1,
                            model: "test-model",
                            choices: [{
                                index: 0,
                                delta: { role: "assistant", content: "started" },
                                finish_reason: null,
                            }],
                        })}\n\n`));
                        setTimeout(() => controller.close(), 100);
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const result = streamText({
            model: provider("test-model"),
            prompt: "question",
            maxRetries: 0,
            timeout: { totalMs: 500, chunkMs: 25 },
            onError: () => {},
        });

        await assert.rejects(
            () => Promise.resolve(result.text),
            (error: unknown) => {
                assert.match(String(error), /timed out|timeout/i);
                return true;
            },
        );
    });

    it("propagates caller cancellation into the injected transport", async () => {
        const caller = new AbortController();
        let transportAborted = false;
        const provider = createOpenAICompatible({
            name: "spike",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            fetch: async (_input, init) => {
                const transportSignal = init?.signal as AbortSignal;
                return await new Promise<Response>((_resolve, reject) => {
                    transportSignal.addEventListener(
                        "abort",
                        () => {
                            transportAborted = true;
                            reject(transportSignal.reason);
                        },
                        { once: true },
                    );
                });
            },
        });
        const result = streamText({
            model: provider("test-model"),
            prompt: "question",
            maxRetries: 0,
            abortSignal: caller.signal,
            onError: () => {},
        });
        const partsPromise = (async () => {
            const parts = [];
            for await (const part of result.fullStream) parts.push(part);
            return parts;
        })();

        await new Promise((resolve) => setTimeout(resolve, 0));
        caller.abort(new Error("caller stopped"));
        const parts = await partsPromise;

        assert.equal(transportAborted, true);
        assert.ok(parts.some((part) => part.type === "abort"));
    });
});
