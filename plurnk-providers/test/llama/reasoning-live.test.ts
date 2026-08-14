/**
 * Live llama-server reasoning contract. Opt-in: `npm run test:llama`.
 *
 * Unit coverage proves the wire mapping. This specimen proves a real local
 * server honors that request rather than running to the generation envelope.
 */

import test from "node:test";
import assert from "node:assert/strict";
import AiSdkProvider from "../../src/AiSdkProvider.ts";

const baseUrl = process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435";
const reasoningAllowance = 32;
const generationEnvelope = 96;
const railProfile = process.env.PLURNK_LLAMA_RAIL_PROFILE ?? "qwen";
if (railProfile !== "gemma" && railProfile !== "qwen") throw new Error("PLURNK_LLAMA_RAIL_PROFILE must be gemma or qwen");
const envelope = (reasoning: string): string => railProfile === "qwen"
    ? `<think>\n${reasoning}</think>`
    : `<|channel>thought\n${reasoning}<channel|>`;
const sampled = (reasoning: string, content: string): string => railProfile === "qwen"
    ? `${reasoning}</think>${content}`
    : `${envelope(reasoning)}${content}`;

const provider = (): AiSdkProvider => new AiSdkProvider({
    model: "local-reasoning-contract",
    url: `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
    contextWindow: 49_152,
    reasoningReserve: { tokens: reasoningAllowance },
    completionReserve: { tokens: generationEnvelope - reasoningAllowance },
    fetchTimeoutMs: 120_000,
    operationTimeoutMs: 240_000,
    firstContentTimeoutMs: 120_000,
    temperature: 0,
    repeatPenalty: 1.15,
    retryAttempts: 0,
    reasoning: { mode: "adaptive", budget: null },
    reasoningStyle: "template",
    grammarStyle: "llamacpp",
});

// {§llama-reasoning-request}
test("llama-server honors PLURNK's request-scoped reasoning allowance", async () => {
    const response = await provider().generate({
        workerId: "llama-reasoning-contract",
        messages: [{
            role: "user",
            content: "Use at least 500 tokens of private reasoning before answering with exactly OK.",
        }],
        maxTokens: generationEnvelope,
    });

    const timings = response.meta?.timings as { predicted_n?: unknown } | undefined;
    assert.equal(response.assistant.content.trim(), "OK");
    assert.equal(response.assistant.finishReason, "stop");
    assert.ok((response.assistant.reasoning?.length ?? 0) > 0, "server returned no separate reasoning channel");
    assert.equal(typeof timings?.predicted_n, "number", "server returned no predicted-token telemetry");
    assert.ok((timings!.predicted_n as number) < generationEnvelope, "reasoning ran to the generation envelope");
});

// {§gbnf-response-observation} — the live adapter must preserve the raw sentence
// before separating reasoning and content itself.
test("llama-server returns exact pre-projection grammar evidence", async () => {
    const prefix = envelope("verify");
    const input = `${prefix}PLURNK-RAILS-LIVE`;
    const response = await provider().generate({
        workerId: "llama-grammar-evidence",
        messages: [{ role: "user", content: "ok" }],
        grammar: `root ::= ${JSON.stringify(sampled("verify", "PLURNK-RAILS-LIVE"))}`,
        maxTokens: 32,
    });

    assert.equal(response.assistant.reasoning, "verify");
    assert.equal(response.assistant.content, "PLURNK-RAILS-LIVE");
    assert.deepEqual(response.grammarEvidence, {
        input,
        contentStart: [...prefix].length,
        transported: true,
    });
});

test("llama-server preserves an empty grammar-required reasoning channel", async () => {
    const prefix = envelope("");
    const input = `${prefix}PLURNK-EMPTY-RAILS-LIVE`;
    const response = await provider().generate({
        workerId: "llama-empty-grammar-evidence",
        messages: [{ role: "user", content: "ok" }],
        grammar: `root ::= ${JSON.stringify(sampled("", "PLURNK-EMPTY-RAILS-LIVE"))}`,
        maxTokens: 32,
    });

    assert.equal(response.assistant.reasoning, null);
    assert.equal(response.assistant.content, "PLURNK-EMPTY-RAILS-LIVE");
    assert.deepEqual(response.grammarEvidence, {
        input,
        contentStart: [...prefix].length,
        transported: true,
    });
});
