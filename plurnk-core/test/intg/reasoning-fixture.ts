import assert from "node:assert/strict";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";

export const statement = (source: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseClient(source);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.unparsedTail, undefined);
    const item = parsed.items[0];
    assert.equal(item?.kind, "statement");
    if (item?.kind !== "statement") throw new Error("Missing statement");
    return item.statement as PlurnkStatement;
};

export type Resource = { pathname: string; content: string };
export type Read = { id: number; turn_id: number; sequence: number; origin: string; ambient_event_id: number | null; pathname: string; lineMarker: string; rx: string; active: number; folded: string; loop_seq: number; turn_seq: number };
export const original = Array.from({ length: 30 }, (_, index) => `Finding ${index + 1}: evidence ${index + 1}.`).join("\n");
export const provider = (reasoning: string | null = null) => new Mock({ contextWindow: 100_000, responses: [{ assistant: {
    content: "## PLAN0\n[]\n### SEND0 (TERM)\nReady.", reasoning,
} }] });

export const providerWithCapacity = (capacity: number, responses: MockResponse[]): Mock => {
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new Mock({ contextWindow: 1_000_000, responses });
    } finally {
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
};
