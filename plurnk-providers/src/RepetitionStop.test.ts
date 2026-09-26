import test from "node:test";
import assert from "node:assert/strict";
import AiSdkProvider from "./AiSdkProvider.ts";
import { ProviderError } from "./providerError.ts";

// A stream that repeats one line well past the limit, then would run on; the stop must not wait for it.
const repeatingStream = (line: string, times: number): Response => {
    const chunk = (content: string): string => `data: ${JSON.stringify({ id: "repeat-response", object: "chat.completion.chunk", created: 1, model: "repeat-witness", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    const body = Array.from({ length: times }, () => chunk(`${line}\n`)).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

test("{§repetition-stop} a streamed line repeated to the limit stops the call with the partial attempt as evidence", async () => {
    const line = "gitea list_issues {\"owner\": \"plunk\", \"repo\": \"plunk-service\"}";
    let settled = 0;
    const provider = new AiSdkProvider({
        model: "repeat-witness",
        url: "https://provider.test/v1/chat/completions",
        contextWindow: 100_000,
        fetch: async () => repeatingStream(line, 200),
        fetchTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        firstContentTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        repeatedLineLimit: 4,
        temperature: 0.2,
        repeatPenalty: 1.15,
        reasoning: { mode: "off", budget: null },
        retryAttempts: 0,
        source: "provider:repeat-witness",
    });
    const failure = await provider.generate({
        workerId: "repeat",
        messages: [{ role: "user", content: "go" }],
        observeRequest: async () => async () => { settled++; },
    }).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof ProviderError, String(failure));
    assert.equal(failure.kind, "repetition");
    assert.equal(failure.message, `The response repeated one line 4 times and was stopped: \`${line}\``);
    assert.equal(failure.attempt?.assistant.finishReason, "repetition");
    assert.equal(failure.attempt?.assistant.content, `${line}\n`.repeat(4));
    assert.equal(failure.accounting.length, 1, "the physical request is settled, not left open");
    assert.equal(settled, 1);
});
