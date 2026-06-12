/**
 * Live GBNF validation against a local llama.cpp server. Opt-in, NOT part of
 * `test:all` (CI has no server): run with `npm run test:llama`.
 *
 * Requires a llama-server at PLURNK_LLAMA_URL (default http://127.0.0.1:11435).
 * The server's grammar parser is the authoritative format check — a malformed
 * .gbnf is rejected at request time, which is exactly what test 1 asserts.
 *
 * Sampling notes (probed against gemma-4-26B-A4B, llama.cpp b894):
 * - A per-request repeat_penalty > 1.0 is required; greedy decoding under hard
 *   constraint masks degenerates into repetition loops without it.
 * - The shipped root (`statement+`) never forces EOS, so greedy generation runs
 *   to max_tokens; a `root ::= statement` override terminates at the close tag.
 * - Native thinking MUST be disabled when a grammar is attached: llama.cpp's
 *   grammar filter sits below the reasoning/content split, so the think channel
 *   consumes the grammar (a final-SEND mentioned in thought force-stops the turn
 *   with empty content). The lax root's text segments ARE the thinking channel.
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

const complete = async (userPrompt: string, activeGrammar: string, maxTokens: number): Promise<Completion> => {
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
            grammar: activeGrammar,
            chat_template_kwargs: { enable_thinking: false },
        }),
    });
    const json = await response.json() as { error?: unknown; choices: Array<{ message: { content: string }; finish_reason: string }> };
    assert.equal(response.ok, true, `llama-server rejected the request: ${JSON.stringify(json).slice(0, 400)}`);
    assert.equal(json.error, undefined, `llama-server returned an error: ${JSON.stringify(json).slice(0, 400)}`);
    return { content: json.choices[0].message.content, finishReason: json.choices[0].finish_reason };
};

test("llama.cpp accepts the shipped plurnk.gbnf", async () => {
    const { content } = await complete("Say anything.", grammar, 1);
    assert.equal(typeof content, "string");
});

test("single-statement root: constrained emission terminates at the close tag and parses", async () => {
    const singleRoot = grammar.replace(/^root ::= .*$/m, "root ::= statement");
    const { content, finishReason } = await complete(
        "What is the capital of France? Deliver the answer with a SEND.",
        singleRoot,
        384,
    );
    assert.equal(finishReason, "stop", `expected grammar-forced EOS, got ${finishReason}: ${JSON.stringify(content)}`);
    const result = PlurnkParser.parse(content);
    const statements = result.items.filter((item) => item.kind === "statement");
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 0, `constrained output produced parse errors: ${JSON.stringify(content)}`);
    assert.equal(statements.length, 1, `expected exactly 1 statement: ${JSON.stringify(content)}`);
    assert.equal(result.unparsedTail, undefined, `unparsed tail: ${JSON.stringify(content)}`);
});

test("shipped root: every completed statement in constrained emission parses cleanly", async () => {
    const { content, finishReason } = await complete(
        "What is the capital of France? Record the fact as a known entry, then deliver the answer with a SEND.",
        grammar,
        384,
    );
    const result = PlurnkParser.parse(content);
    const statements = result.items.filter((item) => item.kind === "statement");
    const errors = result.items.filter((item) => item.kind === "error");
    assert.ok(statements.length >= 1, `expected at least 1 statement: ${JSON.stringify(content)}`);
    if (finishReason === "stop") {
        assert.equal(errors.length, 0, `parse errors in completed output: ${JSON.stringify(content)}`);
        assert.equal(result.unparsedTail, undefined, `unparsed tail in completed output: ${JSON.stringify(content)}`);
        // Turn shape (#29): the root forces termination on a final pathless 102/200 SEND.
        const last = statements.at(-1)!;
        assert.ok(last.kind === "statement");
        if (last.kind !== "statement") return;
        assert.equal(last.statement.op, "SEND", `turn did not close with SEND: ${JSON.stringify(content)}`);
        assert.equal(last.statement.target, null, `final SEND has a target: ${JSON.stringify(content)}`);
        assert.ok(last.statement.signal === 102 || last.statement.signal === 200, `final SEND signal ${last.statement.signal} is not 102/200`);
        return;
    }
    // finish_reason "length" truncates mid-statement — a harness artifact, not a
    // grammar failure. Everything before the cut must still be clean.
    assert.equal(finishReason, "length");
    const trailing = result.items.at(-1);
    const interiorErrors = errors.filter((e) => e !== trailing);
    assert.equal(interiorErrors.length, 0, `parse errors before the truncation point: ${JSON.stringify(content)}`);
});
