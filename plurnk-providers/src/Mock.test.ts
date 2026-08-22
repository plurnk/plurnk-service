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
    assert.equal(m.inputCapacity, null);
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
    const reasoning: string[] = [];
    const { assistant, assistantRaw, accounting } = await m.generate({
        messages: [],
        observeReasoning: (delta) => reasoning.push(delta),
    });
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
    assert.deepEqual(reasoning, ["cot"]);
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

test("the generation-envelope getters are on the Provider interface", () => {
    const previous = {
        output: process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET,
        reasoning: process.env.PLURNK_PROVIDERS_REASONING_BUDGET,
    };
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "35%";
        process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "10%";
        const p: Provider = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(p.outputBudget, 17_203);
        assert.equal(p.reasoningBudget, 4_915);
        assert.equal(p.inputCapacity, 31_949);
    } finally {
        if (previous.output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previous.output;
        if (previous.reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previous.reasoning;
    }
});

test("Mock resolves percentage and absolute generation budgets against its window", () => {
    const previous = {
        output: process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET,
        reasoning: process.env.PLURNK_PROVIDERS_REASONING_BUDGET,
    };
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "35%";
        process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "8192";
        const m = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(m.outputBudget, 17_203);
        assert.equal(m.reasoningBudget, 8_192);
    } finally {
        if (previous.output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previous.output;
        if (previous.reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previous.reasoning;
    }
});

test("no generation-budget env leaves a bare Mock unbounded", () => {
    const m = new Mock({ contextWindow: 49152, responses: [] });
    assert.equal(m.outputBudget, null);
    assert.equal(m.reasoningBudget, null);
    assert.equal(m.inputCapacity, null);
});
