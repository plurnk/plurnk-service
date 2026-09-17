import test from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { Mock, type ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { settleGenAiResponse } from "./genai.ts";

test("{§observability-genai-conventions} telemetry aggregates every reported request without inventing unknown usage", async (t) => {
    const response = await new Mock({ contextWindow: 16_384, responses: [{
        assistant: { content: "answer", reasoning: null },
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    }] }).generate({ messages: [] });
    const unknown: ProviderRequestAccounting = {
        provider: "mock", model: "mock", outcome: "error",
        cost: { kind: "unknown", reason: "no response" },
    };
    const partial: ProviderRequestAccounting = {
        ...unknown, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    };
    for (const [accounting, expected] of [
        [[unknown, ...response.accounting], [5, 3]],
        [[partial, ...response.accounting], [7, 4]],
        [[unknown], [undefined, undefined]],
    ] as const) {
        const span = trace.getTracer("genai-accounting-fixture").startSpan("request");
        const setAttribute = t.mock.method(span, "setAttribute");
        settleGenAiResponse(span, { ...response, accounting });
        const attributes = new Map(setAttribute.mock.calls.map(({ arguments: [name, value] }) => [name, value]));
        assert.equal(attributes.get("gen_ai.usage.input_tokens"), expected[0]);
        assert.equal(attributes.get("gen_ai.usage.output_tokens"), expected[1]);
        assert.deepEqual(attributes.get("gen_ai.response.finish_reasons"), ["stop"]);
        span.end();
    }
});
