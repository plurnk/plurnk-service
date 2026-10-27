import test from "node:test";
import assert from "node:assert/strict";
import Mock from "./Mock.ts";
import Pool from "./Pool.ts";
import LeadingReasoning from "./LeadingReasoning.ts";
import { assessRequestCapacity, effectiveInputCapacity, effectiveInputWall, effectiveOutputBudget, effectiveOutputFloor, effectiveReasoningBudget, flexedResponseMax } from "./capacity.ts";
import { inputModalitiesOf } from "./catalogProvider.ts";
import { estimatePromptTokens } from "./promptTokens.ts";
import { chatMessageText, type ChatMessage, type PromptTokenMeasurement } from "./types.ts";

test("{§provider-configuration} effective output budget is caller-tightenable and physically capped", () => {
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

test("{§provider-configuration} call-specific output tightening also tightens its reasoning subset", () => {
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

test("{§provider-capacity-admission} a known combined context must leave positive input capacity", () => {
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

test("{§provider-capacity-admission} the input wall is min(maxInputTokens, window − floor)", () => {
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: null, outputFloor: 10_000 }), 90_000);
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: 70_000, outputFloor: 10_000 }), 70_000);
    assert.equal(effectiveInputWall({ contextWindow: 100_000, maxInputTokens: null, outputFloor: null }), null, "no floor, no wall");
    assert.throws(
        () => effectiveInputWall({ contextWindow: 10, maxInputTokens: null, outputFloor: 10 }),
        /must leave positive input room/,
    );
});

test("{§provider-capacity-admission} a call that tightens the budget below the floor tightens the floor with it", () => {
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

test("{§provider-capacity-admission} an estimate over the wall defers with the grant at the floor", () => {
    const capacity = assessRequestCapacity({ ...packed, measurement: { kind: "estimate", tokens: 44_000, source: "t", detail: "chars/2 test estimate" } });
    assert.equal(capacity.decision, "defer");
    assert.equal(capacity.responseMax, 4_800);
});

test("{§provider-capacity-admission} the grant flexes up with an exact small prompt, never past the model's limit", () => {
    const base = { contextWindow: 48_000, maxInputTokens: null, maxOutputTokens: null, outputBudget: 8_000, outputFloor: 2_000, reasoningBudget: null };
    const exact = assessRequestCapacity({ ...base, measurement: { kind: "exact", tokens: 1_000, source: "t" } });
    assert.equal(exact.responseMax, 48_000 - 1_000 - 256, "an exact prompt harvests the window's remainder");
    const capped = assessRequestCapacity({ ...base, maxOutputTokens: 16_000, measurement: { kind: "exact", tokens: 1_000, source: "t" } });
    assert.equal(capped.responseMax, 16_000, "the model's own output limit caps the flex");
    const estimate = assessRequestCapacity({ ...base, measurement: { kind: "estimate", tokens: 1_000, source: "t", detail: "chars/2 test estimate" } });
    assert.equal(estimate.responseMax, 8_000, "an estimate keeps the reservation — it proves nothing about the remainder");
});

test("{§provider-capacity-admission} an estimate's grant is the reservation bounded by the remainder its count leaves", () => {
    const envelope = { contextWindow: 48_000, maxOutputTokens: null, outputBudget: 8_000, outputFloor: 2_000, margin: 256, exact: false } as const;
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: 42_000 }), 48_000 - 42_000 - 256, "the wire never asks the window for more than it has");
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: 47_000 }), 2_000, "never below the floor");
    assert.equal(flexedResponseMax({ ...envelope, promptTokens: null }), 8_000, "no count, the reservation stands");
    assert.equal(flexedResponseMax({ ...envelope, contextWindow: null, promptTokens: 42_000 }), 8_000, "no window, the reservation stands");
});

{
const tokensOf = (measurement: PromptTokenMeasurement): number => "tokens" in measurement ? measurement.tokens : -1;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const parts: ChatMessage = {
    role: "user",
    content: [
        { type: "text", text: "look at this" },
        { type: "file", data: PNG, mediaType: "image/png" },
        { type: "file", data: PDF, mediaType: "application/pdf" },
        { type: "file", data: new Uint8Array([82, 73, 70, 70]), mediaType: "audio/wav" },
    ],
};

test("{§provider-interface} message text is the text parts alone; native file parts count nothing here", () => {
    assert.equal(chatMessageText(parts), "look at this");
    assert.equal(chatMessageText({ content: "plain" }), "plain");
    assert.equal(tokensOf(estimatePromptTokens([parts])), Math.ceil("look at this".length / 2));
});

test("{§provider-interface} the catalog's modalities are kept to the wire vocabulary; unknown models declare none", () => {
    assert.deepEqual([...inputModalitiesOf(["text", "image", "video", "pdf"])], ["image", "video", "pdf"]);
    assert.deepEqual([...inputModalitiesOf(["text", "audio", "hologram"])], ["audio"]);
    assert.deepEqual([...inputModalitiesOf(undefined)], []);
});

test("{§provider-interface} the Mock declares modalities by option and records what it received", async () => {
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.deepEqual([...blind.inputModalities], []);
    const seeing = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image", "pdf"] });
    assert.ok(seeing.inputModalities.has("image") && seeing.inputModalities.has("pdf") && !seeing.inputModalities.has("audio"));
    assert.equal(tokensOf(await seeing.countPromptTokens([parts])), Math.ceil("look at this".length / 2));
    await assert.rejects(seeing.generate({ messages: [parts], maxOutputTokens: 16, sessionId: "1", callKind: "bare" } as never));
    assert.equal(seeing.received.length, 1, "the request was recorded before the empty queue refused it");
    const received = seeing.received[0]?.[0]?.content;
    assert.ok(Array.isArray(received) && received[1]?.type === "file" && received[1].mediaType === "image/png" && received[2]?.type === "file" && received[2].mediaType === "application/pdf");
});

test("{§provider-interface} a pool accepts a modality only when every backend does", () => {
    const both = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image", "pdf"] });
    const imageOnly = new Mock({ contextWindow: 200000, responses: [], inputModalities: ["image"] });
    const blind = new Mock({ contextWindow: 200000, responses: [] });
    assert.deepEqual([...new Pool([both, both]).inputModalities], ["image", "pdf"]);
    assert.deepEqual([...new Pool([both, imageOnly]).inputModalities], ["image"]);
    assert.deepEqual([...new Pool([both, blind]).inputModalities], []);
});
}

{
test("{§provider-interface}: every delimiter split preserves exact reasoning and the suffix", () => {
    for (const envelopes of [LeadingReasoning.THINK, LeadingReasoning.TEMPLATE]) {
        for (const [opening, closing] of envelopes) {
            const thought = "Decision 🧠\nA < B.\n";
            const suffix = "Answer with literal <think>tags</think>.";
            for (const ended of [true, false]) {
                const input = `${opening}${thought}${ended ? closing + suffix : closing.slice(0, 3)}`;
                const expected = thought + (ended ? "" : closing.slice(0, 3));
                for (let split = 0; split <= input.length; split++) {
                    const parser = new LeadingReasoning(envelopes);
                    const observed = parser.push(input.slice(0, split)) + parser.push(input.slice(split)) + parser.finish();
                    assert.equal(observed, expected, `${opening}: split ${split}`);
                }
                const settled = LeadingReasoning.project(input, "", envelopes);
                assert.equal(settled.reasoning, expected);
                assert.equal(settled.content, ended ? suffix : "");
                assert.equal(settled.contentStart, Array.from(input).length - Array.from(settled.content).length);
            }
        }
    }
});

test("{§provider-interface}: an incomplete opener, later tags, and structured reasoning stay literal", () => {
    for (const input of ["<thi", " <think>text</think>", "prefix <think>text</think>", ""]) {
        assert.deepEqual(LeadingReasoning.project(input, "", LeadingReasoning.THINK), { content: input, reasoning: "", projected: false, contentStart: 0 });
    }
    assert.deepEqual(LeadingReasoning.project("<think>literal</think>", "native", LeadingReasoning.THINK), {
        content: "<think>literal</think>", reasoning: "native", projected: false, contentStart: 0,
    });
});
}
