import test from "node:test";
import assert from "node:assert/strict";
import { assessRequestCapacity, effectiveInputCapacity, effectiveOutputBudget, effectiveReasoningBudget } from "./capacity.ts";

test("effective output budget is caller-tightenable and physically capped", () => {
    assert.equal(effectiveOutputBudget({
        requested: undefined,
        configured: 40_000,
        maxOutputTokens: 32_000,
        contextWindow: 128_000,
    }), 32_000);
    assert.equal(effectiveOutputBudget({
        requested: 8_000,
        configured: 40_000,
        maxOutputTokens: 32_000,
        contextWindow: 128_000,
    }), 8_000);
});

test("call-specific output tightening also tightens its reasoning subset", () => {
    assert.equal(effectiveReasoningBudget({ configured: 8_000, outputBudget: 4_000 }), 3_999);
    assert.equal(effectiveReasoningBudget({ configured: 2_000, outputBudget: 4_000 }), 2_000);
    assert.equal(effectiveReasoningBudget({ configured: null, outputBudget: 1 }), null);
    assert.throws(
        () => effectiveReasoningBudget({ configured: 1, outputBudget: 1 }),
        /leave at least one token outside the reasoning budget/,
    );
});

test("capacity applies independent input and combined-context limits", () => {
    assert.equal(effectiveInputCapacity({
        contextWindow: 100_000,
        maxInputTokens: 70_000,
        outputBudget: 20_000,
    }), 70_000);
    const capacity = assessRequestCapacity({
        contextWindow: 100_000,
        maxInputTokens: 70_000,
        maxOutputTokens: 40_000,
        outputBudget: 20_000,
        reasoningBudget: null,
        measurement: { kind: "exact", tokens: 70_001, source: "fixture" },
    });
    assert.equal(capacity.inputCapacity, 70_000);
    assert.equal(capacity.decision, "reject");
});

test("a known combined context must leave positive input capacity", () => {
    assert.equal(effectiveInputCapacity({
        contextWindow: 2,
        maxInputTokens: null,
        outputBudget: 1,
    }), 1);
    assert.throws(
        () => effectiveInputCapacity({
            contextWindow: 1,
            maxInputTokens: null,
            outputBudget: 1,
        }),
        /must leave positive input capacity/,
    );
});

test("only exact overflow rejects before provider I/O", () => {
    const base = {
        contextWindow: 100,
        maxInputTokens: null,
        maxOutputTokens: 40,
        outputBudget: 40,
        reasoningBudget: null,
    } as const;
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "exact", tokens: 61, source: "exact" },
    }).decision, "reject");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "upper_bound", tokens: 61, source: "bound" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "estimate", tokens: 61, source: "estimate", detail: "heuristic" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "unavailable", source: "fixture", detail: "no request tokenizer" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "upper_bound", tokens: 60, source: "bound" },
    }).decision, "admit");
});
