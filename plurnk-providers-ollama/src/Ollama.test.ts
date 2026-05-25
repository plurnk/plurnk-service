import test from "node:test";
import assert from "node:assert/strict";
import Ollama from "./Ollama.ts";

// Minimum env that satisfies all required guards in fromEnv. Tests that need
// to exercise one specific knob override its key on top of this.
const baseEnv = Object.freeze({
    OLLAMA_BASE_URL: "http://x",
    PLURNK_FETCH_TIMEOUT: "600000",
    PLURNK_REASON: "0",
});

test("fromEnv: throws when OLLAMA_BASE_URL is unset", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({}, "qwenzel:latest"),
        /OLLAMA_BASE_URL must be set/,
    );
});

test("fromEnv: throws when PLURNK_FETCH_TIMEOUT is unset", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({ OLLAMA_BASE_URL: "http://x", PLURNK_REASON: "0" }, "m"),
        /PLURNK_FETCH_TIMEOUT must be set/,
    );
});

test("fromEnv: throws when PLURNK_FETCH_TIMEOUT is non-numeric", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({ ...baseEnv, PLURNK_FETCH_TIMEOUT: "abc" }, "m"),
        /PLURNK_FETCH_TIMEOUT must be a number/,
    );
});

test("fromEnv: throws when PLURNK_REASON is unset", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({ OLLAMA_BASE_URL: "http://x", PLURNK_FETCH_TIMEOUT: "600000" }, "m"),
        /PLURNK_REASON must be set/,
    );
});

test("fromEnv: throws when PLURNK_REASON is non-numeric", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({ ...baseEnv, PLURNK_REASON: "lots" }, "m"),
        /PLURNK_REASON must be a number/,
    );
});

test("fromEnv: resolves contextSize from /api/show model_info", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ model_info: { "qwen35.context_length": 262144 } }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ ...baseEnv, OLLAMA_BASE_URL: "http://192.168.1.17:11434" }, "qwenzel:latest");
    assert.equal(p.contextSize, 262144);
    assert.equal(p.model, "qwenzel:latest");
});

test("fromEnv: scans any family prefix for *.context_length", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ model_info: { "llama.context_length": 131072, "other.field": "ignored" } }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ ...baseEnv }, "llama3:latest");
    assert.equal(p.contextSize, 131072);
});

test("fromEnv: throws when /api/show has no context_length", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ model_info: { "some.other.field": 1 } }),
    })) as unknown as typeof fetch;

    await assert.rejects(
        () => Ollama.fromEnv({ ...baseEnv }, "unknown:latest"),
        /no \*\.context_length key for "unknown:latest"/,
    );
});

test("fromEnv: throws when /api/show returns non-2xx", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: false,
        status: 404,
        text: async () => "model not found",
    })) as unknown as typeof fetch;

    await assert.rejects(
        () => Ollama.fromEnv({ ...baseEnv }, "missing:latest"),
        /\/api\/show returned 404/,
    );
});

test("contextSize, model, baseUrl exposed; baseUrl strips trailing slash", () => {
    const p = new Ollama({
        baseUrl: "http://192.168.1.17:11434/",
        model: "qwenzel:latest",
        contextSize: 262144,
        fetchTimeoutMs: 600000,
        reasonBudget: 0, tokenizer: "heuristic",
    });
    assert.equal(p.contextSize, 262144);
    assert.equal(p.model, "qwenzel:latest");
    assert.equal(p.baseUrl, "http://192.168.1.17:11434");
});

test("costFor: returns 0 unconditionally (local models are free)", () => {
    const p = new Ollama({
        baseUrl: "http://x", model: "m", contextSize: 1, fetchTimeoutMs: 1, reasonBudget: 0, tokenizer: "heuristic",
    });
    assert.equal(p.costFor({ prompt: 100000, completion: 50000, cached: 10000, total: 160000 }), 0);
});

test("countTokens (heuristic family): empty → 0; ceil(len/4) otherwise", () => {
    const p = new Ollama({
        baseUrl: "http://x", model: "m", contextSize: 1, fetchTimeoutMs: 1, reasonBudget: 0, tokenizer: "heuristic",
    });
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("abcd"), 1);
    assert.equal(p.countTokens("abcde"), 2);
});

test("countTokens (llama family): uses llama-tokenizer-js", () => {
    const p = new Ollama({
        baseUrl: "http://x", model: "llama3:latest", contextSize: 1, fetchTimeoutMs: 1, reasonBudget: 0,
        tokenizer: "llama",
    });
    assert.equal(p.countTokens(""), 0);
    // "hello world" → 3 tokens in Llama BPE (different breakdown from cl100k's 2).
    assert.equal(p.countTokens("hello world"), 3);
    // Real tokenizer diverges from the chars/4 heuristic. For Llama BPE the
    // direction is actually MORE tokens than heuristic (leading-space tokens
    // + BPE merges), which is exactly why the heuristic was wrong — it
    // underestimates and would give the model false confidence about
    // remaining context budget.
    const sentence = "The quick brown fox jumps over the lazy dog.";
    const heuristic = Math.ceil(sentence.length / 4);
    const real = p.countTokens(sentence);
    assert.ok(real > 0 && real !== heuristic, `real ${real} should differ from heuristic ${heuristic}`);
});

test("fromEnv: dispatches to llama tokenizer when details.family is llama", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            model_info: { "llama.context_length": 131072 },
            details: { family: "llama" },
        }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ ...baseEnv }, "llama3:latest");
    assert.equal(p.tokenizer, "llama");
    assert.equal(p.countTokens("hello world"), 3);
});

test("fromEnv: falls back to heuristic when family is unknown", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
            model_info: { "qwen35.context_length": 262144 },
            details: { family: "qwen35" },
        }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ ...baseEnv }, "qwenzel:latest");
    assert.equal(p.tokenizer, "heuristic");
    // 8-char text under heuristic: ceil(8/4) = 2
    assert.equal(p.countTokens("12345678"), 2);
});

test("fromEnv: heuristic when details block is absent", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ model_info: { "phi.context_length": 8192 } }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ ...baseEnv }, "phi:latest");
    assert.equal(p.tokenizer, "heuristic");
});
