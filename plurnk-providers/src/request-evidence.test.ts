import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAnthropic } from "@ai-sdk/anthropic";
import AiSdkProvider from "./AiSdkProvider.ts";
import { createSdkModel } from "./sdkModels.ts";
import type { ProviderRequestAccounting } from "./types.ts";

for (const native of [false, true]) {
    for (const capture of [false, true]) {
        test(`{§provider-request-evidence} retained request equals dispatched bytes; native=${native}, capture=${capture}`, async (t) => {
            const received = new Map<string, string>();
            const secondArrived = Promise.withResolvers<void>();
            const server = createServer(async (request, response) => {
                let body = "";
                for await (const chunk of request) body += chunk.toString();
                const content = JSON.parse(body).messages[0].content as string;
                received.set(content, body);
                if (content.startsWith("first")) await secondArrived.promise;
                else secondArrived.resolve();
                assert.equal(request.headers.authorization, "Bearer fixture-secret");
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({
                    id: "fixture", model: "fixture", created: 0,
                    choices: [{ index: 0, message: { role: "assistant", content: "observed" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
                }));
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
            const address = server.address();
            assert.ok(address !== null && typeof address === "object");
            const origin = `http://127.0.0.1:${address.port}`;
            const provider = new AiSdkProvider({
                model: "fixture",
                ...(native
                    ? { languageModel: createSdkModel("openai", "fixture", { OPENAI_API_KEY: "fixture-secret" }, `${origin}/v1`)!.languageModel! }
                    : { url: `${origin}/v1/chat/completions`, headers: { Authorization: "Bearer fixture-secret" } }),
                streaming: false, rawBody: capture,
                fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
                temperature: 0.25, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            });
            await Promise.all(["first", "second"].map(async (identity) => {
                const content = `${identity}: literal "quotes" and a newline\n`;
                const evidence: unknown[] = [];
                const result = await provider.generate({
                    workerId: identity, messages: [{ role: "user", content }],
                    observeRequest: async () => async (_accounting, value) => { evidence.push(value); },
                });
                assert.equal(result.assistant.content, "observed");
                assert.equal(evidence.length, 1);
                assert.deepEqual((evidence[0] as { request?: unknown }).request,
                    capture ? { method: "POST", origin, body: received.get(content) } : undefined);
                const dispatched = JSON.parse(received.get(content)!);
                assert.deepEqual(dispatched.tools, []);
                assert.equal(dispatched.tool_choice, "none");
                assert.equal(dispatched.temperature, 0.25);
                assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret/u);
            }));
            assert.equal(received.size, 2, "concurrent calls retain their own request bodies");
        });
    }
}

for (const protocol of ["google", "anthropic", "openrouter", "amazon-bedrock"] as const) {
    test(`{§provider-dispatched-request}: ${protocol} retains the native SDK body after owned transforms`, async () => {
        const sdk = createSdkModel(protocol, "fixture", {
            GEMINI_API_KEY: "fixture-secret", ANTHROPIC_API_KEY: "fixture-secret", OPENROUTER_API_KEY: "fixture-secret",
            AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "fixture-secret",
        });
        assert.ok(sdk?.languageModel);
        let sent: string | undefined;
        let evidence: { request?: { body: string } } | undefined;
        const provider = new AiSdkProvider({
            model: "fixture", languageModel: sdk.languageModel,
            streaming: false, rawBody: true, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            fetch: async (_url, init) => {
                sent = String(init?.body);
                const response = protocol === "google"
                    ? { candidates: [{ content: { role: "model", parts: [{ text: "observed" }] }, finishReason: "STOP" }],
                        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }
                    : protocol === "anthropic"
                        ? { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "observed" }],
                            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }
                        : protocol === "amazon-bedrock"
                            ? { output: { message: { role: "assistant", content: [{ text: "observed" }] } },
                                stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } }
                            : { id: "fixture", model: "fixture", created: 0,
                                choices: [{ index: 0, message: { role: "assistant", content: "observed" }, finish_reason: "stop" }],
                                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
                return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
            },
        });
        const result = await provider.generate({ workerId: "witness", messages: [{ role: "user", content: "Inspect the native body." }],
            observeRequest: async () => async (_accounting, value) => { evidence = value as typeof evidence; },
        });
        assert.equal(result.assistant.content, "observed");
        assert.equal(evidence?.request?.body, sent);
        assert.ok(sent?.includes("Inspect the native body."));
        assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret/u);
        const body = JSON.parse(sent!);
        if (protocol === "google") assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
        else if (protocol !== "amazon-bedrock") assert.deepEqual(body.tool_choice, protocol === "anthropic" ? { type: "none" } : "none");
    });
}

test("{§provider-request-evidence} native Messages failures retain SDK reasoning and uninterpreted chunks", async () => {
    const chunks = [
        { type: "message_start", message: { id: "native-failed", type: "message", role: "assistant", model: "fixture",
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Native partial reasoning." } },
        { type: "error", error: { type: "overloaded_error", message: "Native stream failed." } },
    ];
    const anthropic = createAnthropic({ apiKey: "fixture", fetch: async () => new Response(
        chunks.map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    ) });
    const provider = new AiSdkProvider({
        model: "fixture", languageModel: anthropic("fixture"), streaming: true, rawBody: false,
        fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
        temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
    });
    const records: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
    await assert.rejects(provider.generate({ workerId: "witness", messages: [],
        observeRequest: async () => async (accounting, evidence) => { records.push({ accounting, evidence }); },
    }), /Native stream failed/);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.accounting.outcome, "error");
    const evidence = records[0]!.evidence as { reasoning: string; rawBody: unknown[]; error: { message: string } };
    assert.equal(evidence.reasoning, "Native partial reasoning.");
    assert.deepEqual(evidence.rawBody, chunks);
    assert.match(evidence.error.message, /Native stream failed/);
});

for (const reported of [false, true]) {
    test(`{§provider-request-evidence} missing finish preserves partial output and raw evidence; usage=${reported}`, async () => {
        const chunk = {
            id: "failed-request", model: "fixture",
            choices: [{ index: 0, delta: { content: "unfinished", reasoning_content: "before EOF" }, finish_reason: null }],
            ...(reported ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
            vendor_evidence: "retained without interpretation",
        };
        const settled: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
        const provider = new AiSdkProvider({
            model: "fixture", url: "https://example.test/v1/chat/completions",
            streaming: true, rawBody: false, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
                headers: { "content-type": "text/event-stream", "x-request-id": "request-991" },
            }),
        });
        await assert.rejects(provider.generate({
            workerId: "witness", messages: [],
            observeRequest: async () => async (accounting, evidence) => { settled.push({ accounting, evidence }); },
        }), /Response stream ended without a finish reason/);
        assert.equal(settled.length, 1);
        assert.equal(settled[0]!.accounting.outcome, "error");
        assert.equal(settled[0]!.accounting.usage?.inputTokens, reported ? 100 : undefined);
        const evidence = settled[0]!.evidence as {
            content: string; reasoning: string; rawBody: unknown[];
            error: { message: string }; chargeEvidence: { response: { id: string; headers: Record<string, string> } };
        };
        assert.ok(evidence, "failed requests must settle forensic evidence, not just accounting");
        assert.equal(evidence.content, "unfinished");
        assert.equal(evidence.reasoning, "before EOF");
        assert.deepEqual(evidence.rawBody, [chunk]);
        assert.equal(evidence.error.message, "Response stream ended without a finish reason.");
        assert.equal(evidence.chargeEvidence.response.id, "failed-request");
        assert.equal(evidence.chargeEvidence.response.headers["x-request-id"], "request-991");
    });
}

for (const capture of [false, true]) {
    test(`{§provider-request-evidence} a directed HTTP retry preserves the error body before a successful response; capture=${capture}`, async () => {
        const records: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
        const bodies: string[] = [];
        let calls = 0;
        const provider = new AiSdkProvider({
            model: "fixture", url: "https://example.test/v1/chat/completions", streaming: false,
            rawBody: capture, fetchTimeoutMs: 1000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 1,
            fetch: async (_input, init) => {
                calls++;
                bodies.push(String(init?.body));
                return calls === 1
                    ? new Response('{"error":{"message":"try again"},"witness":991}', {
                        status: 503, headers: { "content-type": "application/json", "x-should-retry": "true", "x-request-id": "failed-http" },
                    })
                    : new Response(JSON.stringify({
                        id: "recovered", model: "fixture",
                        choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
                    }), { headers: { "content-type": "application/json" } });
            },
        });
        const result = await provider.generate({
            workerId: "witness", messages: [],
            observeRequest: async () => async (accounting, evidence) => { records.push({ accounting, evidence }); },
        });
        assert.equal(result.assistant.content, "recovered");
        assert.deepEqual(records.map(({ accounting }) => accounting.outcome), ["error", "response"]);
        const failed = records[0]!.evidence as { rawBody: string; chargeEvidence: { response: { headers: Record<string, string> } } };
        assert.equal(failed.rawBody, '{"error":{"message":"try again"},"witness":991}');
        assert.equal(failed.chargeEvidence.response.headers["x-request-id"], "failed-http");
        assert.equal(records[0]!.accounting.status, 503);
        assert.equal((records[1]!.evidence as { content: string }).content, "recovered");
        assert.deepEqual(records.map(({ evidence }) => (evidence as { request?: { body: string } }).request?.body),
            capture ? bodies : [undefined, undefined]);
    });
}
