// Integration harness: provider capacity fixtures and the test-only viable context window.

import { readFile } from "node:fs/promises";
import Paths from "../../src/Paths.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { assessRequestCapacity, resolveGenerationEnvelopeFromEnv, type ChatMessage, type ProviderRequestCapacity } from "@plurnk/plurnk-providers";

export const testProviderCapacity = (
    messages: readonly ChatMessage[],
    contextWindow: number | null,
    outputBudget = 1,
): ProviderRequestCapacity => assessRequestCapacity({
    contextWindow,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget,
    outputFloor: null,
    reasoningBudget: null,
    measurement: {
        kind: "exact",
        tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
        source: "core:test-fixture",
    },
});

export const testDeferredProviderCapacity = (source = "core:test-fixture"): ProviderRequestCapacity =>
    assessRequestCapacity({
        contextWindow: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: null,
        outputFloor: null,
        reasoningBudget: null,
        measurement: {
            kind: "unavailable",
            source,
            detail: "fixture has no physical model envelope",
        },
    });

// Test-only viable context ({§definition-table-projection}, {§tokenomics-window-partition}):
// preserve three times the current authored teaching as input under the provider-owned
// output policy. Conclusion fixtures stay viable as teaching grows; pressure
// tests pin their own envelopes. Resolve the shipped percentage or an operator's
// absolute through the production contract instead of reproducing its syntax.
const _testInputCapacity = contentWeight(await readFile(Paths.instructionsSystem, "utf8")) * 3;

let _viableWindow: number | undefined;

export const viableWindow = (): number => {
    if (_viableWindow !== undefined) return _viableWindow;
    const absoluteEnvelope = resolveGenerationEnvelopeFromEnv(process.env, null);
    let candidate = absoluteEnvelope.outputBudget === null
        ? Math.max(2, _testInputCapacity)
        : _testInputCapacity + absoluteEnvelope.outputBudget;
    while (true) {
        const { outputBudget } = resolveGenerationEnvelopeFromEnv(process.env, candidate);
        if (outputBudget === null) {
            throw new TypeError("integration setup requires PLURNK_PROVIDERS_OUTPUT_BUDGET");
        }
        if (candidate - outputBudget >= _testInputCapacity) break;
        if (candidate > Number.MAX_SAFE_INTEGER / 2) {
            throw new RangeError("integration setup could not derive a safe mock context window");
        }
        candidate *= 2;
    }
    _viableWindow = candidate;
    return candidate;
};
