// {§grammar-enforcement-verified-at-boot} / {§gbnf-requires-reasoning}.

import test from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";

const reasoning = "verify";
const reasoningPrefix = `<|channel>thought\n${reasoning}<channel|>`;
const verifyToken = "PLURNK-RAILS-LIVE";
const verifyInput = `${reasoningPrefix}${verifyToken}`;

const fakeProvider = (content: string, calls: Array<{ grammar?: string }> = []): Provider => ({
    model: "fake", contextWindow: 1000, constrainsOutput: true,
    generate: async ({ grammar }: Parameters<Provider["generate"]>[0]) => {
        calls.push({ grammar });
        return {
            assistant: { content, reasoning, usage: { prompt: 1, completion: 3, reasoning: 1, cached: 0, total: 5 }, finishReason: "stop", model: "fake" },
            assistantRaw: null,
            grammarEvidence: {
                input: `${reasoningPrefix}${content}`,
                contentStart: [...reasoningPrefix].length,
                transported: true,
            },
        };
    },
    countTokens: () => 1, calculateCost: () => 0,
}) as unknown as Provider;

test("an enforcing backend proves the required raw reasoning-plus-content sentence", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken, calls), { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" });
    assert.equal(calls[0]?.grammar, `root ::= ${JSON.stringify(verifyInput)}`);
});

test("GBNF with reasoning explicitly off is an invalid composed PLURNK configuration", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken, calls), {
            PLURNK_PROVIDERS_GBNF: "plurnk.gbnf",
            PLURNK_PROVIDERS_REASONING: "off",
        }),
        /GBNF requires reasoning to be adaptive or on/,
    );
    assert.equal(calls.length, 0, "the invalid configuration fails before probing the model");
});

test("boot verification rejects a provider that cannot represent its pre-projection grammar input", async () => {
    const provider = {
        ...fakeProvider(verifyToken),
        generate: async () => ({
            assistant: { content: verifyToken, reasoning: null, usage: { prompt: 1, completion: 3, reasoning: 0, cached: 0, total: 4 }, finishReason: "stop", model: "fake" },
            assistantRaw: null,
        }),
    } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(provider, { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        /did not return grammar evidence/,
    );
});

test("an UNCONSTRAINED backend fails hard — never a silent unconstrained boot", async () => {
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("hello, I am unconstrained"), { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        (err: Error) => /GBNF enforcement failed/.test(err.message) && /unconstrained output/.test(err.message),
        "the boot refuses to run with dark rails, with a legible cause",
    );
});

test("no grammar requested → verification is a no-op", async () => {
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything at all"), {});
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything"), { PLURNK_PROVIDERS_GBNF: "0" });
    // no throw = unconstrained is a legitimate deliberate mode
});

test("a configured GBNF fails hard when the provider does not advertise local transport", async () => {
    const nonClaiming = { ...fakeProvider("garbage the probe would reject"), constrainsOutput: false } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(nonClaiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        /does not advertise GBNF transport/,
    );

    const claiming = { ...fakeProvider("unconstrained ramble"), constrainsOutput: true } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(claiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gbnf" }),
        /GBNF enforcement failed/,
        "a CLAIMING backend that returns unconstrained output still fails hard",
    );
});

test("a per-alias grammar verifies when the bare setting is empty (#353)", async () => {
    const env = { PLURNK_PROVIDERS_GBNF: "", PLURNK_MODEL: "rig", PLURNK_MODEL_rig: "openai/local", PLURNK_PROVIDERS_GBNF_rig: "plurnk.gbnf" };
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("I am unconstrained"), env),
        /did not honor the forcing grammar|does not enforce|unconstrained/i,
        "per-alias GBNF resolves and the end-to-end verify RUNS — a non-enforcing backend fails hard, never silently skipped",
    );
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken), env);
});
