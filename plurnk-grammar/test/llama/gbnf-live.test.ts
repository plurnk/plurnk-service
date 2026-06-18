/**
 * Live GBNF validation against a local llama.cpp server. Opt-in, NOT part of
 * `test:all` (CI has no server): run with `npm run test:llama`.
 *
 * Requires a llama-server at PLURNK_LLAMA_URL (default http://127.0.0.1:11435).
 * The server's grammar parser is the authoritative format check — a malformed or
 * oversized .gbnf is rejected at request time, which is exactly what test 1 asserts.
 *
 * Sampling notes (probed against gemma-4-26B-A4B, llama.cpp b894):
 * - A per-request repeat_penalty > 1.0 is required; greedy decoding under hard
 *   constraint masks degenerates into repetition loops without it.
 * - Native thinking MUST be disabled when a grammar is attached: llama.cpp's
 *   grammar filter sits below the reasoning/content split, so the think channel
 *   would consume the grammar. PLAN bodies are the in-grammar reasoning chamber.
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

type Completion = { content: string; finishReason: string };

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
            grammar,
            chat_template_kwargs: { enable_thinking: false },
        }),
    });
    const json = await response.json() as { error?: unknown; choices: Array<{ message: { content: string }; finish_reason: string }> };
    assert.equal(response.ok, true, `llama-server rejected the request: ${JSON.stringify(json).slice(0, 400)}`);
    assert.equal(json.error, undefined, `llama-server returned an error: ${JSON.stringify(json).slice(0, 400)}`);
    return { content: json.choices[0].message.content, finishReason: json.choices[0].finish_reason };
};

test("llama.cpp accepts the shipped plurnk.gbnf (size/format check)", async () => {
    const { content } = await complete("Say anything.", 1);
    assert.equal(typeof content, "string");
});

test("plan root: constrained emission is a clean PLAN-led turn (force-stops on a terminal SEND, or rambles to the max_tokens backstop)", async () => {
    const { content, finishReason } = await complete(
        "What is the capital of France? Record the fact as a known entry, then deliver the answer.",
        384,
    );
    const result = PlurnkParser.parse(content);
    const statements = result.items.filter((item) => item.kind === "statement");
    const errors = result.items.filter((item) => item.kind === "error");
    assert.ok(statements.length >= 1, `expected at least a PLAN: ${JSON.stringify(content)}`);
    const first = statements[0];
    assert.ok(first.kind === "statement" && first.statement.op === "PLAN", `turn did not open with PLAN: ${JSON.stringify(content)}`);

    if (finishReason === "stop") {
        // Forced EOS fired: a clean turn ending in a terminal SEND.
        assert.equal(errors.length, 0, `constrained output produced parse errors: ${JSON.stringify(content)}`);
        assert.equal(result.unparsedTail, undefined, `unparsed tail: ${JSON.stringify(content)}`);
        const last = statements.at(-1)!;
        assert.ok(last.kind === "statement" && last.statement.op === "SEND", `turn did not close with SEND: ${JSON.stringify(content)}`);
        if (last.kind !== "statement") return;
        assert.ok(
            [102, 200, 202, 300, 499].includes(last.statement.signal as number),
            `final SEND signal ${last.statement.signal} is not a terminal disposition (102/202/200/300/499)`,
        );
        return;
    }
    // finish_reason "length": the model rambled past the optional terminal without
    // emitting a status SEND — the #30-accepted residual (the grammar does NOT force
    // termination within a bounded op count; max_tokens is the backstop). Not a
    // grammar failure; the parseable prefix before the truncation must still be clean.
    assert.equal(finishReason, "length", `unexpected finish reason: ${finishReason}`);
    const trailing = result.items.at(-1);
    const interiorErrors = errors.filter((e) => e !== trailing);
    assert.equal(interiorErrors.length, 0, `parse errors before the truncation point: ${JSON.stringify(content)}`);
});
