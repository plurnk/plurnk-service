import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropic } from "@ai-sdk/anthropic";
import AiSdkProvider from "./AiSdkProvider.ts";
import type { ProviderRequestAccounting } from "./types.ts";

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

test("{§provider-request-evidence} a directed HTTP retry preserves the error body before a successful response", async () => {
    const records: Array<{ accounting: ProviderRequestAccounting; evidence: unknown }> = [];
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "fixture", url: "https://example.test/v1/chat/completions", streaming: false,
        rawBody: false, fetchTimeoutMs: 1000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 1,
        fetch: async () => {
            calls++;
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
});
