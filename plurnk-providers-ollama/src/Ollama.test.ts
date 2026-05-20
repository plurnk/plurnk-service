import test from "node:test";
import assert from "node:assert/strict";
import Ollama from "./Ollama.ts";

test("fromEnv: throws when OLLAMA_BASE_URL is unset", async () => {
    await assert.rejects(
        () => Ollama.fromEnv({}, "qwenzel:latest"),
        /OLLAMA_BASE_URL must be set/,
    );
});

test("fromEnv: resolves contextSize from /api/show model_info", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ model_info: { "qwen35.context_length": 262144 } }),
    })) as unknown as typeof fetch;

    const p = await Ollama.fromEnv({ OLLAMA_BASE_URL: "http://192.168.1.17:11434" }, "qwenzel:latest");
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

    const p = await Ollama.fromEnv({ OLLAMA_BASE_URL: "http://x" }, "llama3:latest");
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
        () => Ollama.fromEnv({ OLLAMA_BASE_URL: "http://x" }, "unknown:latest"),
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
        () => Ollama.fromEnv({ OLLAMA_BASE_URL: "http://x" }, "missing:latest"),
        /\/api\/show returned 404/,
    );
});

test("contextSize, model, baseUrl exposed; baseUrl strips trailing slash", () => {
    const p = new Ollama({
        baseUrl: "http://192.168.1.17:11434/",
        model: "qwenzel:latest",
        contextSize: 262144,
        fetchTimeoutMs: 600000,
        reasonBudget: 0,
    });
    assert.equal(p.contextSize, 262144);
    assert.equal(p.model, "qwenzel:latest");
    assert.equal(p.baseUrl, "http://192.168.1.17:11434");
});

test("costFor: returns 0 unconditionally (local models are free)", () => {
    const p = new Ollama({
        baseUrl: "http://x", model: "m", contextSize: 1, fetchTimeoutMs: 1, reasonBudget: 0,
    });
    assert.equal(p.costFor({ prompt: 100000, completion: 50000, cached: 10000, total: 160000 }), 0);
});

test("countTokens: heuristic returns 0 for empty, ceil(len/4) otherwise", () => {
    const p = new Ollama({
        baseUrl: "http://x", model: "m", contextSize: 1, fetchTimeoutMs: 1, reasonBudget: 0,
    });
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("abcd"), 1);
    assert.equal(p.countTokens("abcde"), 2);
});
