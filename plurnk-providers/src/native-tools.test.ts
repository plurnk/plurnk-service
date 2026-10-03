import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { createSdkModel } from "./sdkModels.ts";
import { executeAiSdkModel, executeOpenAICompatible } from "./aiSdkTransport.ts";
import { withoutNativeTools } from "./native-tools.ts";
import { ollamaProviderFromEnv } from "./ollama.ts";
import { withProviderDefaults } from "./defaults.ts";

type Protocol = "chat" | "responses" | "messages" | "generate-content";

const response = (protocol: Protocol, streaming: boolean): Response => {
    const message = {
        id: "reply", type: "message", role: "assistant", model: "fixture",
        content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
    };
    const completed = {
        id: "reply", object: "response", created_at: 1, model: "fixture", status: "completed",
        output: [{ id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer", annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        incomplete_details: null,
    };
    const google = {
        responseId: "reply", modelVersion: "fixture",
        candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    };
    const chat = {
        id: "reply", object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    if (!streaming) {
        return Response.json({ chat, responses: completed, messages: message, "generate-content": google }[protocol]);
    }
    const chunks = {
        chat: [{ ...chat, choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }] }],
        responses: [
            { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...completed.output[0], content: [] } },
            { type: "response.content_part.added", item_id: "message", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", item_id: "message", output_index: 0, content_index: 0, delta: "answer" },
            { type: "response.output_text.done", item_id: "message", output_index: 0, content_index: 0, text: "answer" },
            { type: "response.output_item.done", output_index: 0, item: completed.output[0] },
            { type: "response.completed", response: completed },
        ],
        messages: [
            { type: "message_start", message: { ...message, content: [] } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
        ],
        "generate-content": [google],
    }[protocol];
    return new Response(chunks.map((chunk) => `${"type" in chunk ? `event: ${chunk.type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
    });
};

const request = {
    messages: [{ role: "user" as const, content: "question" }],
    headers: { "x-fixture": "preserved" },
    maxOutputTokens: 1_000,
    captureRawBody: true,
};

const assertToolFree = (body: Record<string, unknown>, protocol: Protocol): void => {
    assert.deepEqual(body.tools, [], "the wire explicitly declares an empty native-tool set");
    if (protocol === "generate-content") {
        assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
        assert.equal(body.tool_choice, undefined, "do not send a different protocol's fields");
    } else {
        assert.deepEqual(body.tool_choice, protocol === "messages" ? { type: "none" } : "none");
        assert.equal(body.toolConfig, undefined);
    }
    assert.equal(body.functions, undefined, "do not add deprecated function declarations");
    assert.equal(body.function_call, undefined);
    assert.equal(body.parallel_tool_calls, undefined, "limiting parallel calls is not disabling tool use");
};

test("{§provider-native-tools-disabled} compatible wire explicitly disables native tools for both response modes", async (t) => {
    for (const streaming of [false, true]) {
        await t.test(`${streaming ? "stream" : "buffered"}`, async () => {
            const requests: Record<string, unknown>[] = [];
            const result = await executeOpenAICompatible({
                ...request, streaming, url: "https://fixture.test/v1/chat/completions", model: "fixture",
                body: { reasoning_effort: "high" },
                fetch: async (_url, init) => {
                    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                    return response("chat", streaming);
                },
            });
            assert.equal(result.content, "answer");
            assert.equal(result.usage?.totalTokens, 12);
            assert.equal(requests.length, 1);
            assertToolFree(requests[0]!, "chat");
            assert.equal(requests[0]!.reasoning_effort, "high");
            assert.deepEqual(requests[0]!.messages, request.messages);
        });
    }
});

test("{§provider-native-tools-disabled} the protocol projection cannot acquire tools or mutate caller input", () => {
    for (const protocol of ["openai", "messages", "generate-content"] as const) {
        const body = Object.freeze({ model: "fixture", temperature: 0.4, tools: Object.freeze([]) });
        const projected = withoutNativeTools(body, protocol);
        assert.equal(projected.model, "fixture");
        assert.equal(projected.temperature, 0.4);
        assert.notEqual(projected, body);
        assert.equal("tool_choice" in body, false);
        assert.equal("toolConfig" in body, false);
        for (const tools of [[{ type: "function" }], {}, null]) {
            assert.throws(() => withoutNativeTools({ tools }, protocol), {
                name: "TypeError", message: "PLURNK provider requests cannot declare native tools",
            });
        }
    }
});

test("{§provider-native-tools-disabled} request extensions cannot override the managed opt-out", async () => {
    let dispatched = false;
    for (const field of ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"]) {
        await assert.rejects(executeOpenAICompatible({
            ...request, streaming: false, url: "https://fixture.test/v1/chat/completions", model: "fixture",
            body: { [field]: "caller override" },
            fetch: async () => { dispatched = true; return response("chat", false); },
        }), {
            name: "TypeError", message: `OpenAI-compatible request extensions may not override SDK-owned field ${JSON.stringify(field)}`,
        });
    }
    assert.equal(dispatched, false);
});

test("{§provider-native-tools-disabled} opaque SDK plugins receive portable none intent in both modes", async () => {
    const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
    };
    const finishReason = { unified: "stop" as const, raw: "stop" };
    const model = new MockLanguageModelV4({
        doGenerate: async () => ({ content: [{ type: "text", text: "answer" }], finishReason, usage, warnings: [] }),
        doStream: async () => ({ stream: new ReadableStream({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "text" });
                controller.enqueue({ type: "text-delta", id: "text", delta: "answer" });
                controller.enqueue({ type: "text-end", id: "text" });
                controller.enqueue({ type: "finish", finishReason, usage });
                controller.close();
            },
        }) }),
    });
    for (const streaming of [false, true]) {
        const result = await executeAiSdkModel({ ...request, streaming, languageModel: model });
        assert.equal(result.content, "answer");
        assert.equal(result.usage?.totalTokens, 12);
    }
    for (const call of [...model.doGenerateCalls, ...model.doStreamCalls]) {
        assert.deepEqual(call.toolChoice, { type: "none" });
        assert.equal(call.tools, undefined);
    }
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(model.doStreamCalls.length, 1);
});

test("{§provider-native-tools-disabled} Bedrock uses its valid no-tool configuration", async (t) => {
    let body: Record<string, unknown> | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
            output: { message: { role: "assistant", content: [{ text: "answer" }] } },
            stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            metrics: { latencyMs: 1 },
        });
    });
    const sdk = createSdkModel("fixture", "fixture", {
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_NPM: "@ai-sdk/amazon-bedrock",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test",
        AWS_BEARER_TOKEN_BEDROCK: "fixture-only", AWS_REGION: "us-east-1",
    });
    assert.ok(sdk?.languageModel);
    const result = await executeAiSdkModel({ ...request, streaming: false, languageModel: sdk.languageModel });
    assert.equal(result.content, "answer");
    assert.equal(result.usage?.totalTokens, 12);
    assert.ok(body);
    for (const key of ["tools", "toolConfig", "tool_choice"]) assert.equal(key in body, false);
});

test("{§provider-native-tools-disabled} Ollama keeps its probe unmodified and disables native calls for emission and BARE", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (String(url).endsWith("/api/show")) return Response.json({ model_info: { "fixture.context_length": 32768 } });
        assert.ok(String(url).endsWith("/v1/chat/completions"));
        return response("chat", body.stream === true);
    });
    for (const streaming of [false, true]) {
        const provider = await ollamaProviderFromEnv(withProviderDefaults({
            PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_STREAMING: streaming ? "1" : "0",
        }), "fixture", { baseUrl: "http://fixture.test" });
        assert.deepEqual(bodies.at(-1), { model: "fixture" });
        for (const callKind of ["emission", "bare"] as const) {
            const result = await provider.generate({ workerId: "fixture", messages: request.messages, callKind });
            assert.equal(result.assistant.content, "answer");
            assertToolFree(bodies.at(-1)!, "chat");
        }
    }
    assert.equal(bodies.length, 6);
});

test("{§provider-native-tools-disabled} configured SDK families preserve the opt-out on the actual wire", async (t) => {
    const families: readonly [string, Protocol][] = [
        ["@ai-sdk/openai", "chat"],
        ["@ai-sdk/groq", "chat"],
        ["@ai-sdk/cerebras", "chat"],
        ["@ai-sdk/mistral", "chat"],
        ["@ai-sdk/togetherai", "chat"],
        ["@ai-sdk/deepinfra", "chat"],
        ["@openrouter/ai-sdk-provider", "chat"],
        ["@ai-sdk/xai", "responses"],
        ["@ai-sdk/anthropic", "messages"],
        ["@ai-sdk/google", "generate-content"],
    ];
    for (const [npm, protocol] of families) {
        for (const streaming of [false, true]) {
            await t.test(`${npm}, ${streaming ? "stream" : "buffered"}`, async (t) => {
                const requests: Record<string, unknown>[] = [];
                t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
                    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                    assert.equal(new Headers(init?.headers).get("x-fixture"), "preserved");
                    return response(protocol, streaming);
                });
                const sdk = createSdkModel("fixture", "fixture", {
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_NPM: npm,
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_API_KEY_ENV: "FIXTURE_API_KEY",
                    PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: "https://fixture.test/v1",
                    FIXTURE_API_KEY: "fixture-only",
                });
                assert.ok(sdk?.languageModel);
                const result = await executeAiSdkModel({ ...request, streaming, languageModel: sdk.languageModel });
                assert.equal(result.content, "answer");
                assert.equal(result.usage?.totalTokens, 12);
                assert.equal(requests.length, 1);
                assertToolFree(requests[0]!, protocol);
            });
        }
    }
});
