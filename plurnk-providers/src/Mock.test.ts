import test from "node:test";
import { strict as assert } from "node:assert";
import Mock from "./Mock.ts";
import type { MockResponse } from "./Mock.ts";

const build = (responses: MockResponse[] = [{ assistant: { content: "hi", reasoning: null } }]) =>
    new Mock({ contextSize: 100000, responses });

// — Identity (SPEC §10.2, §10.6) —

test("Mock: contextSize and model are stable across reads", () => {
    const m = build();
    assert.equal(m.contextSize, 100000);
    assert.equal(m.contextSize, 100000);
    assert.equal(m.model, "mock");
    assert.equal(m.model, "mock");
});

test("Mock: contextSize passes null through", () => {
    const m = new Mock({ contextSize: null, responses: [] });
    assert.equal(m.contextSize, null);
});

// — Tokenomics (SPEC §10.3, §10.4, §10.5) —

test("Mock: countTokens('') is 0; non-empty is a positive integer", () => {
    const m = build();
    assert.equal(m.countTokens(""), 0);
    const n = m.countTokens("four");
    assert.ok(Number.isInteger(n) && n > 0);
});

test("Mock: costFor zero usage is 0 (free)", () => {
    const m = build();
    assert.equal(m.costFor({ prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 }), 0);
});

// — Transport (SPEC §10.7, §10.10) —

test("Mock: generate resolves a valid ProviderResponse shape", async () => {
    const m = build([{ assistant: { content: "hello", reasoning: "cot" } }]);
    const { assistant, assistantRaw } = await m.generate({ messages: [] });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.reasoning, "cot");
    assert.deepEqual(assistant.usage, { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 });
    assert.equal(assistant.finishReason, "stop");
    assert.equal(assistant.model, "mock");
    assert.equal(assistantRaw, null); // present, defaulted
});

test("Mock: generate applies caller-supplied overrides", async () => {
    const m = build([{
        assistant: {
            content: "x",
            reasoning: null,
            usage: { prompt: 1, completion: 2, reasoning: 0, cached: 0, total: 3 },
            finishReason: "length",
            model: "mock-xl",
        },
        assistantRaw: { wire: true },
    }]);
    const { assistant, assistantRaw } = await m.generate({ messages: [] });
    assert.equal(assistant.finishReason, "length");
    assert.equal(assistant.model, "mock-xl");
    assert.deepEqual(assistant.usage, { prompt: 1, completion: 2, reasoning: 0, cached: 0, total: 3 });
    assert.deepEqual(assistantRaw, { wire: true });
});

test("Mock: ops escape hatch passes through when provided", async () => {
    const ops = [{ kind: "send" }] as never;
    const m = build([{ assistant: { content: "x", reasoning: null, ops } }]);
    const { assistant } = await m.generate({ messages: [] });
    assert.deepEqual(assistant.ops, ops);
});

test("Mock: ops absent when not provided", async () => {
    const m = build();
    const { assistant } = await m.generate({ messages: [] });
    assert.equal("ops" in assistant, false);
});

// — Abort (SPEC §10.8) —

test("Mock: generate with a pre-aborted signal rejects and consumes no response", async () => {
    const m = build([{ assistant: { content: "untouched", reasoning: null } }]);
    const signal = AbortSignal.abort(new Error("boom"));
    await assert.rejects(() => m.generate({ messages: [], signal }), /boom/);
    assert.equal(m.remaining, 1); // queue untouched — no "wire call" made
});

// — Lifecycle —

test("Mock: remaining decrements as responses are consumed", async () => {
    const m = build([
        { assistant: { content: "a", reasoning: null } },
        { assistant: { content: "b", reasoning: null } },
    ]);
    assert.equal(m.remaining, 2);
    await m.generate({ messages: [] });
    assert.equal(m.remaining, 1);
});

test("Mock: exhausted queue throws a specific error", async () => {
    const m = build([]);
    await assert.rejects(() => m.generate({ messages: [] }), /exhausted/);
});
