import test from "node:test";
import { strict as assert } from "node:assert";
import Mock from "./Mock.ts";
import type { Provider } from "./types.ts";
import type { MockResponse } from "./Mock.ts";
import { ProviderError } from "./errors.ts";

const build = (responses: MockResponse[] = [{ assistant: { content: "hi", reasoning: null } }]) =>
    new Mock({ contextWindow: 100000, responses });

// — Identity ({§provider-interface}) —

test("Mock: contextWindow and model are stable across reads", () => {
    const m = build();
    assert.equal(m.contextWindow, 100000);
    assert.equal(m.contextWindow, 100000);
    assert.equal(m.model, "mock");
    assert.equal(m.model, "mock");
});

test("Mock: contextWindow passes null through", () => {
    const m = new Mock({ contextWindow: null, responses: [] });
    assert.equal(m.contextWindow, null);
});

// — Tokenomics ({§provider-interface}) —

test("Mock: prompt counting is exact for its declared mock vocabulary", async () => {
    const m = build();
    assert.deepEqual(await m.countPromptTokens([]), {
        kind: "exact", tokens: 0, source: "mock:chars2",
    });
    assert.deepEqual(await m.countPromptTokens([{ role: "user", content: "four" }]), {
        kind: "exact", tokens: 2, source: "mock:chars2",
    });
});

// — Transport ({§provider-interface}) —

test("Mock: generate resolves a valid ProviderResponse shape", async () => {
    const m = build([{ assistant: { content: "hello", reasoning: "cot" } }]);
    const { assistant, assistantRaw, accounting } = await m.generate({ messages: [] });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.reasoning, "cot");
    assert.deepEqual(accounting[0]?.usage, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
    });
    assert.deepEqual(accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "mock provider fixture",
    });
    assert.equal(assistant.finishReason, "stop");
    assert.equal(assistant.model, "mock");
    assert.equal(assistantRaw, null); // present, defaulted
});

test("Mock: generate applies caller-supplied overrides", async () => {
    const m = build([{
        assistant: {
            content: "x",
            reasoning: null,
            finishReason: "length",
            model: "mock-xl",
        },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        assistantRaw: { wire: true },
    }]);
    const { assistant, assistantRaw, accounting } = await m.generate({ messages: [] });
    assert.equal(assistant.finishReason, "length");
    assert.equal(assistant.model, "mock-xl");
    assert.deepEqual(accounting[0]?.usage, {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
    });
    assert.deepEqual(assistantRaw, { wire: true });
});

test("Mock: a supplied grammar produces unsplit evidence unless the fixture supplies exact evidence", async () => {
    const explicit = { input: "prefixx", contentStart: 6, transported: false } as const;
    const m = build([
        { assistant: { content: "x", reasoning: null } },
        { assistant: { content: "x", reasoning: null }, grammarEvidence: explicit },
    ]);
    const inferred = await m.generate({ messages: [], grammar: 'root ::= "x"' });
    const supplied = await m.generate({ messages: [], grammar: 'root ::= "prefixx"' });
    assert.deepEqual(inferred.grammarEvidence, { input: "x", contentStart: 0, transported: true });
    assert.deepEqual(supplied.grammarEvidence, explicit);
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

// — Abort ({§provider-failure-normalization}) —

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

test("Mock: exhausted queue throws a ProviderError carrying its settled accounting", async () => {
    const m = build([]);
    await assert.rejects(
        () => m.generate({ messages: [] }),
        (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.match(error.message, /exhausted/);
            assert.deepEqual(error.accounting, [{
                provider: "provider:mock",
                model: "mock",
                outcome: "error",
                cost: {
                    kind: "unknown",
                    reason: "mock provider exhausted before producing a response",
                },
            }]);
            return true;
        },
    );
});

// -- {§provider-generation-envelope} --

test("the reserve getters are on the Provider interface (not just the concrete class)", () => {
    // Typing against the contract catches a getter-only concrete surface.
    const prevR = process.env.PLURNK_PROVIDERS_REASONING_RESERVE;
    try {
        process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "10%";
        const p: Provider = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(p.reasoningReserve, 4915); // 10% of 49152, read through the interface type
    } finally {
        if (prevR === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_RESERVE; else process.env.PLURNK_PROVIDERS_REASONING_RESERVE = prevR;
    }
});

test("Mock resolves reserves from PLURNK_PROVIDERS_*_RESERVE against its window (the service partition path)", () => {
    const prevR = process.env.PLURNK_PROVIDERS_REASONING_RESERVE;
    const prevC = process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE;
    try {
        process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "10%";
        process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = "8192"; // mixed pct + absolute
        const m = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(m.reasoningReserve, 4915);  // 10% of 49152
        assert.equal(m.completionReserve, 8192); // absolute stands
    } finally {
        if (prevR === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_RESERVE; else process.env.PLURNK_PROVIDERS_REASONING_RESERVE = prevR;
        if (prevC === undefined) delete process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE; else process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = prevC;
    }
});

test("no reserve env → null (the no-cap path; bare Mocks unaffected)", () => {
    const m = new Mock({ contextWindow: 49152, responses: [] });
    assert.equal(m.reasoningReserve, null);
    assert.equal(m.completionReserve, null);
});
