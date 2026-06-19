import test from "node:test";
import { strict as assert } from "node:assert";
import { tokenizerFor, parseTokenizerFamily, tokenizerByPublisher, type TokenizerFamily } from "./tokenizers.ts";

// — tokenizerFor: the three synchronous strategies (SPEC §2) —

test("tokenizerFor 'heuristic': empty → 0, else ceil(len/4)", () => {
    const count = tokenizerFor("heuristic");
    assert.equal(count(""), 0);
    assert.equal(count("four"), 1);   // ceil(4/4)
    assert.equal(count("12345"), 2);  // ceil(5/4)
});

test("tokenizerFor 'cl100k': empty → 0, real BPE counts otherwise", () => {
    const count = tokenizerFor("cl100k");
    assert.equal(count(""), 0);
    assert.equal(count("hello"), 1);
    assert.equal(count("hello world"), 2);
});

test("tokenizerFor 'llama': empty → 0, real SentencePiece counts otherwise", () => {
    const count = tokenizerFor("llama");
    assert.equal(count(""), 0);
    assert.equal(count("hello"), 2);
    assert.equal(count("the quick brown fox"), 6);
});

// — parseTokenizerFamily: operator override parsing (fail-hard on garbage) —

test("parseTokenizerFamily: unset/empty falls back", () => {
    assert.equal(parseTokenizerFamily(undefined, "heuristic", "OPENAI_TOKENIZER", "openai"), "heuristic");
    assert.equal(parseTokenizerFamily("", "llama", "X_TOKENIZER", "x"), "llama");
});

test("parseTokenizerFamily: legacy 'cl100k_base' spelling maps to 'cl100k'", () => {
    assert.equal(parseTokenizerFamily("cl100k_base", "heuristic", "OPENAI_TOKENIZER", "openai"), "cl100k");
});

test("parseTokenizerFamily: canonical families pass through", () => {
    for (const fam of ["heuristic", "cl100k", "llama"] as TokenizerFamily[]) {
        assert.equal(parseTokenizerFamily(fam, "heuristic", "X_TOKENIZER", "x"), fam);
    }
});

test("parseTokenizerFamily: an unknown value throws naming the env var and the bad value", () => {
    assert.throws(
        () => parseTokenizerFamily("gpt2", "heuristic", "OPENAI_TOKENIZER", "openai"),
        /openai provider: OPENAI_TOKENIZER must be one of "heuristic", "cl100k", "llama" \(got "gpt2"\)/,
    );
});

// — tokenizerByPublisher: relay dispatch by id segment (openrouter, cloudflare) —

test("tokenizerByPublisher: index 0 dispatches on the leading segment", () => {
    const table = new Map<string, TokenizerFamily>([["anthropic", "cl100k"]]);
    assert.equal(tokenizerByPublisher("anthropic/claude-opus", table), "cl100k");
});

test("tokenizerByPublisher: a non-zero index selects a deeper publisher segment (e.g. @cf/meta/…)", () => {
    const table = new Map<string, TokenizerFamily>([["meta", "llama"]]);
    assert.equal(tokenizerByPublisher("@cf/meta/llama-3-8b", table, 1), "llama");
});

test("tokenizerByPublisher: an unknown publisher falls back to heuristic", () => {
    const table = new Map<string, TokenizerFamily>([["anthropic", "cl100k"]]);
    assert.equal(tokenizerByPublisher("mystery/model", table), "heuristic");
});

test("tokenizerByPublisher: a missing segment at the requested index falls back to heuristic", () => {
    const table = new Map<string, TokenizerFamily>([["x", "llama"]]);
    assert.equal(tokenizerByPublisher("solo", table, 1), "heuristic"); // no [1] segment
});
