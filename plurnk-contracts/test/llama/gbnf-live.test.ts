/**
 * Live GBNF validation against a local llama.cpp server. Opt-in, NOT part of
 * The deterministic gate has no server: run explicitly with `npm run test:llama`.
 *
 * Requires a llama-server at PLURNK_LLAMA_URL (default http://127.0.0.1:11435).
 * The server's grammar parser is the authoritative format check — a malformed or
 * oversized .gbnf is rejected at request time, which is exactly what test 1 asserts.
 *
 * Sampling notes:
 * - A per-request repeat_penalty > 1.0 is required; greedy decoding under hard
 *   constraint masks degenerates into repetition loops without it.
 * - The grammar constrains the raw decode to exactly one Gemma Harmony reasoning
 *   enclosure, then `sep`, mandatory `# PLAN1`, H2 operations, and terminal SEND.
 *   llama-server applies `reasoning_format: "auto"` after that constrained decode,
 *   projecting the enclosure body out of `content` into `reasoning_content`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";

const BASE_URL = process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const grammar = readFileSync(join(repoRoot, "dist", "plurnk.gbnf"), "utf8");
const system = readFileSync(join(repoRoot, "plurnk.md"), "utf8");
const reasoningAllowance = 64;

type Completion = { content: string; reasoning: string; finishReason: string };

const complete = async (userPrompt: string, maxTokens: number): Promise<Completion> => {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
            messages: [
                { role: "system", content: system },
                { role: "user", content: userPrompt },
            ],
            max_tokens: maxTokens,
            temperature: 0,
            seed: 42,
            repeat_penalty: 1.15,
            reasoning_format: "auto",
            thinking_budget_tokens: reasoningAllowance,
            chat_template_kwargs: { enable_thinking: true },
            grammar,
        }),
    });
    const json = await response.json() as { error?: unknown; choices: Array<{ message: { content: string; reasoning_content?: string }; finish_reason: string }> };
    assert.equal(response.ok, true, `llama-server rejected the request: ${JSON.stringify(json).slice(0, 400)}`);
    assert.equal(json.error, undefined, `llama-server returned an error: ${JSON.stringify(json).slice(0, 400)}`);
    return {
        content: json.choices[0].message.content,
        reasoning: json.choices[0].message.reasoning_content ?? "",
        finishReason: json.choices[0].finish_reason,
    };
};

test("llama.cpp accepts the shipped plurnk.gbnf (size/format check)", async () => {
    const { content } = await complete("Say anything.", 1);
    assert.equal(typeof content, "string");
});

// {§gbnf-reasoning-boundary} — this observes the real post-grammar projection.
test("llama projection separates reasoning and the model completes a PLAN turn", async () => {
    const { content, reasoning, finishReason } = await complete(
        "What is the capital of France? Record the fact as a known entry, then deliver the answer.",
        1024,
    );
    assert.equal(content.includes("<|channel>"), false, `reasoning opener leaked into content: ${JSON.stringify(content)}`);
    assert.equal(content.includes("<channel|>"), false, `reasoning closer leaked into content: ${JSON.stringify(content)}`);
    assert.equal(typeof reasoning, "string");
    // Feed the projected content directly; parsing begins at the H1 PLAN anchor.
    const result = PlurnkParser.parse(content);
    const statements = result.items.filter((item) => item.kind === "statement");
    const errors = result.items.filter((item) => item.kind === "error");

    assert.ok(statements.length > 0, `reasoning allowance left no actionable turn: ${JSON.stringify(content)}`);
    const first = statements[0];
    assert.ok(first.kind === "statement" && first.statement.op === "PLAN", `turn did not open with PLAN: ${JSON.stringify(content)}`);
    assert.equal(finishReason, "stop", `reasoning or content exhausted the generation envelope: ${JSON.stringify(content)}`);
    assert.equal(
        errors.length,
        0,
        `model emitted a parser-invalid operation inside the constrained frame: ${JSON.stringify(content)}`,
    );
    assert.equal(result.unparsedTail, undefined, `unparsed tail: ${JSON.stringify(content)}`);
    const last = statements.at(-1)!;
    assert.ok(last.kind === "statement" && last.statement.op === "SEND", `turn did not close with SEND: ${JSON.stringify(content)}`);
    if (last.kind !== "statement") return;
    assert.ok(
        [102, 200, 202, 300, 499].includes(last.statement.signal as number),
        `final SEND signal ${last.statement.signal} is not a terminal disposition (102/202/200/300/499)`,
    );
});
