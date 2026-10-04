import test from "node:test";
import assert from "node:assert/strict";
import { assessRequestCapacity, effectiveInputCapacity, effectiveInputWall, effectiveOutputBudget, effectiveOutputFloor, effectiveReasoningBudget, flexedResponseMax } from "./capacity.ts";

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

test("{§provider-capacity-admission} capacity applies independent input and combined-context limits", () => {
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
        outputFloor: 10_000,
        reasoningBudget: null,
        measurement: { kind: "exact", tokens: 70_001, source: "fixture" },
    });
    assert.equal(capacity.inputCapacity, 70_000);
    assert.equal(capacity.inputWall, 70_000, "the independent input limit bounds the wall as it bounds the reservation");
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

test("{§provider-output-floor} the input wall is min(maxInputTokens, window − floor)", () => {
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: null, outputFloor: 10_000 }), 90_000);
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: 70_000, outputFloor: 10_000 }), 70_000);
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: null, outputFloor: null }), null, "no floor, no wall");
    assert.throws(
        () => effectiveInputWall({ contextWindow: 10, maxInputTokens: null, outputFloor: 10 }),
        /must leave positive input room/,
    );
});

test("{§provider-output-floor} a call that tightens the budget below the floor tightens the floor with it", () => {
    assert.equal(effectiveOutputFloor({ configured: 4_800, outputBudget: 16_800 }), 4_800);
    assert.equal(effectiveOutputFloor({ configured: 4_800, outputBudget: 1_000 }), 1_000);
    assert.equal(effectiveOutputFloor({ configured: 4_800, outputBudget: null }), 4_800);
    const tightened = assessRequestCapacity({
        contextWindow: 48_000,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: 1_000,
        outputFloor: 4_800,
        reasoningBudget: null,
        measurement: { kind: "exact", tokens: 100, source: "fixture" },
    });
    assert.equal(tightened.outputFloor, 1_000);
    assert.equal(tightened.inputWall, 47_000, "the wall follows the tightened floor");
});

test("{§provider-capacity-admission} only exact overflow of the wall rejects before provider I/O", () => {
    const base = {
        contextWindow: 100,
        maxInputTokens: null,
        maxOutputTokens: 40,
        outputBudget: 40,
        outputFloor: 10,
        reasoningBudget: null,
    } as const;
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "exact", tokens: 91, source: "exact" },
    }).decision, "reject");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "upper_bound", tokens: 91, source: "bound" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "estimate", tokens: 91, source: "estimate", detail: "heuristic" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "unavailable", source: "fixture", detail: "no request tokenizer" },
    }).decision, "defer");
    assert.equal(assessRequestCapacity({
        ...base,
        measurement: { kind: "upper_bound", tokens: 90, source: "bound" },
    }).decision, "admit");
});

// A 48k window packed against a 35% reservation (16,800) with a 10% floor (4,800):
// the reservation's line is 31,200 and the wall 43,200.
const packed = {
    contextWindow: 48_000,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget: 16_800,
    outputFloor: 4_800,
    reasoningBudget: null,
} as const;

test("{§provider-capacity-admission} a prompt between the reservation and the wall is admitted with its grant flexed down to the remainder, never below the floor", () => {
    const into = assessRequestCapacity({ ...packed, measurement: { kind: "exact", tokens: 40_000, source: "t" } });
    assert.equal(into.inputCapacity, 31_200);
    assert.equal(into.inputWall, 43_200);
    assert.equal(into.decision, "admit");
    assert.equal(into.responseMax, 48_000 - 40_000 - 256, "the grant is the window's remainder");
    const atWall = assessRequestCapacity({ ...packed, measurement: { kind: "exact", tokens: 43_200, source: "t" } });
    assert.equal(atWall.decision, "admit");
    assert.equal(atWall.responseMax, 4_800, "the floor is kept even where the margin would eat it");
});

test("{§provider-output-floor} an estimate over the wall defers with the grant at the floor", () => {
    const capacity = assessRequestCapacity({ ...packed, measurement: { kind: "estimate", tokens: 44_000, source: "t", detail: "chars/2 test estimate" } });
    assert.equal(capacity.decision, "defer");
    assert.equal(capacity.responseMax, 4_800);
});

test("{§provider-flexed-allowance} the grant flexes up with an exact small prompt, never past the model's limit", () => {
    const base = { contextWindow: 48_000, maxInputTokens: null, maxOutputTokens: null, outputBudget: 8_000, outputFloor: 2_000, reasoningBudget: null };
    const exact = assessRequestCapacity({ ...base, measurement: { kind: "exact", tokens: 1_000, source: "t" } });
    assert.equal(exact.responseMax, 48_000 - 1_000 - 256, "an exact prompt harvests the window's remainder");
    const capped = assessRequestCapacity({ ...base, maxOutputTokens: 16_000, measurement: { kind: "exact", tokens: 1_000, source: "t" } });
    assert.equal(capped.responseMax, 16_000, "the model's own output limit caps the flex");
    const estimate = assessRequestCapacity({ ...base, measurement: { kind: "estimate", tokens: 1_000, source: "t", detail: "chars/2 test estimate" } });
    assert.equal(estimate.responseMax, 8_000, "an estimate keeps the reservation — it proves nothing about the remainder");
});

test("{§provider-flexed-allowance} an estimate's grant is the reservation bounded by the remainder its count leaves", () => {
    const envelope = { contextWindow: 48_000, maxOutputTokens: null, outputBudget: 8_000, outputFloor: 2_000, margin: 256, exact: false } as const;
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: 42_000 }), 48_000 - 42_000 - 256, "the wire never asks the window for more than it has");
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: 47_000 }), 2_000, "never below the floor");
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: null }), 8_000, "no count, the reservation stands");
    assert.equal(flexedResponseMax({ ...envelope, contextWindow: null, promptTokens: 42_000 }), 8_000, "no window, the reservation stands");
});
