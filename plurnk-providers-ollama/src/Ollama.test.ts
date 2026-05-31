import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Ollama from "./Ollama.ts";

// Minimum env that satisfies all required guards in fromEnv. Tests that need
// to exercise one specific knob override its key on top of this.
const baseEnv = Object.freeze({
    OLLAMA_BASE_URL: "http://x",
    PLURNK_FETCH_TIMEOUT: "600000",
    PLURNK_REASON: "0",
});

// Mock the /api/show probe. `payload` becomes the JSON body it returns.
const mockShow = (payload: unknown) => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify(payload), { status: 200 });
    });
    return calls;
};
test.afterEach(() => mock.restoreAll());

// — fromEnv env guards —

test("fromEnv: throws when OLLAMA_BASE_URL is unset", async () => {
    await assert.rejects(() => Ollama.fromEnv({}, "qwenzel:latest"), /OLLAMA_BASE_URL must be set/);
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

test("fromEnv: throws when PLURNK_REASON is non-numeric", async () => {
    mockShow({ model_info: { "qwen35.context_length": 262144 } });
    await assert.rejects(() => Ollama.fromEnv({ ...baseEnv, PLURNK_REASON: "lots" }, "m"), /PLURNK_REASON must be a number/);
});

// — /api/show probe —

test("fromEnv: resolves contextSize from /api/show model_info and posts to /api/show", async () => {
    const calls = mockShow({ model_info: { "qwen35.context_length": 262144 } });
    const p = await Ollama.fromEnv({ ...baseEnv, OLLAMA_BASE_URL: "http://192.168.1.17:11434" }, "qwenzel:latest");
    assert.equal(p.contextSize, 262144);
    assert.equal(p.model, "qwenzel:latest");
    assert.equal(calls[0], "http://192.168.1.17:11434/api/show");
});

test("fromEnv: scans any family prefix for *.context_length", async () => {
    mockShow({ model_info: { "llama.context_length": 131072, "other.field": "ignored" } });
    const p = await Ollama.fromEnv({ ...baseEnv }, "llama3:latest");
    assert.equal(p.contextSize, 131072);
});

test("fromEnv: throws when /api/show has no context_length", async () => {
    mockShow({ model_info: { "some.other.field": 1 } });
    await assert.rejects(
        () => Ollama.fromEnv({ ...baseEnv }, "unknown:latest"),
        /no \*\.context_length key for "unknown:latest"/,
    );
});

test("fromEnv: throws when /api/show returns non-2xx", async () => {
    mock.method(globalThis, "fetch", async () => new Response("model not found", { status: 404 }));
    await assert.rejects(() => Ollama.fromEnv({ ...baseEnv }, "missing:latest"), /\/api\/show returned 404/);
});

test("fromEnv: trailing slash on base URL is stripped before /api/show", async () => {
    const calls = mockShow({ model_info: { "phi.context_length": 8192 } });
    await Ollama.fromEnv({ ...baseEnv, OLLAMA_BASE_URL: "http://192.168.1.17:11434/" }, "phi:latest");
    assert.equal(calls[0], "http://192.168.1.17:11434/api/show");
});

// — tokenizer dispatch on the constructed Provider —

test("fromEnv: dispatches to llama tokenizer when details.family is llama (hello world = 3)", async () => {
    mockShow({ model_info: { "llama.context_length": 131072 }, details: { family: "llama" } });
    const p = await Ollama.fromEnv({ ...baseEnv }, "llama3:latest");
    assert.equal(p.countTokens("hello world"), 3);
});

test("fromEnv: falls back to heuristic when family is unknown (ceil(len/4))", async () => {
    mockShow({ model_info: { "qwen35.context_length": 262144 }, details: { family: "qwen35" } });
    const p = await Ollama.fromEnv({ ...baseEnv }, "qwenzel:latest");
    assert.equal(p.countTokens(""), 0);
    assert.equal(p.countTokens("12345678"), 2);
});

test("fromEnv: heuristic when details block is absent", async () => {
    mockShow({ model_info: { "phi.context_length": 8192 } });
    const p = await Ollama.fromEnv({ ...baseEnv }, "phi:latest");
    assert.equal(p.countTokens("abcde"), 2); // ceil(5/4)
});

test("fromEnv: costFor returns 0 (local models are free)", async () => {
    mockShow({ model_info: { "phi.context_length": 8192 } });
    const p = await Ollama.fromEnv({ ...baseEnv }, "phi:latest");
    assert.equal(p.costFor({ prompt: 100000, completion: 50000, cached: 10000, total: 160000 }), 0);
});
