// §grammar-enforcement-verified-at-boot — the rails are useless if silently OFF. When the operator
// requests a grammar (PLURNK_PROVIDERS_GBNF), boot verifies the backend ACTUALLY constrains a
// forcing grammar; anything else fails hard rather than run unconstrained (which reads as model
// failure and hides that the grammar contract is dark — weeks of "gemma strokes" were this).

import test from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";

const fakeProvider = (content: string): Provider => ({
    model: "fake", contextSize: 1000,
    generate: async () => ({ assistant: { content, reasoning: null, usage: { prompt: 1, completion: 3, reasoning: 0, cached: 0, total: 4 }, finishReason: "stop", model: "fake" }, assistantRaw: null }),
    countTokens: () => 1, costFor: () => 0,
}) as unknown as Provider;

test("[§grammar-enforcement-verified-at-boot] an enforcing backend passes verification", async () => {
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("PLURNK-RAILS-LIVE"), { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" });
    // no throw = pass
});

test("[§grammar-enforcement-verified-at-boot] an UNCONSTRAINED backend fails hard — never a silent unconstrained boot", async () => {
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("hello, I am unconstrained"), { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        (err: Error) => /grammar enforcement is OFF/.test(err.message) && /never transported|grammarStyle/.test(err.message),
        "the boot refuses to run with dark rails, with a legible cause",
    );
});

test("[§grammar-enforcement-verified-at-boot] no grammar requested → verification is a no-op", async () => {
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything at all"), {});
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything"), { PLURNK_PROVIDERS_GBNF: "0" });
    // no throw = unconstrained is a legitimate deliberate mode
});

test("[§grammar-enforcement-verified-at-boot] a NON-CLAIMING backend (constrainsOutput:false) boots with a notice — the global default is safe (#336)", async () => {
    // A grammarStyle-'none' provider drops the grammar cleanly (never on the wire), so a global
    // GBNF default must not refuse boot against it. The probe is SKIPPED entirely — generate()
    // here would return garbage, proving the gate fired before any probe.
    const nonClaiming = { ...fakeProvider("garbage the probe would reject"), constrainsOutput: false } as unknown as Provider;
    await ProviderInstantiate.verifyGrammarEnforcement(nonClaiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" });
    // no throw = boots unconstrained on this alias, with the stderr notice

    // And the claim gates HARD the other way: constrainsOutput true (or absent — the legacy
    // interface) still runs the end-to-end probe and refuses on unconstrained output (#34).
    const claiming = { ...fakeProvider("unconstrained ramble"), constrainsOutput: true } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(claiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        /grammar enforcement is OFF/,
        "a CLAIMING backend that returns unconstrained output still fails hard",
    );
});
