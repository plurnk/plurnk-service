// {§grammar-enforcement-verified-at-boot} / {§gbnf-requires-reasoning}.

import test from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";

const reasoning = "verify";
const verifyToken = "PLURNK-RAILS-LIVE";
const envelope = (profile: "gemma" | "qwen"): string => profile === "qwen"
    ? `<think>\n${reasoning}</think>`
    : `<|channel>thought\n${reasoning}<channel|>`;
const accounting = {
    provider: "provider:fake",
    model: "fake",
    outcome: "response",
    usage: {
        inputTokens: 1,
        outputTokens: 4,
        totalTokens: 5,
        outputTokenDetails: { textTokens: 3, reasoningTokens: 1 },
    },
    cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "grammar verification fixture" },
} as const;

const fakeProvider = (content: string, calls: Array<{ grammar?: string }> = [], profile: "gemma" | "qwen" = "gemma"): Provider => ({
    model: "fake", contextWindow: 1000, constrainsOutput: true,
    generate: async ({ grammar, observeRequest }: Parameters<Provider["generate"]>[0]) => {
        calls.push({ grammar });
        const settle = await observeRequest?.({ provider: accounting.provider, model: accounting.model });
        await settle?.(accounting);
        return {
            assistant: { content, reasoning, finishReason: "stop", model: "fake" },
            assistantRaw: null,
            accounting: [accounting],
            grammarEvidence: {
                input: `${envelope(profile)}${content}`,
                contentStart: [...envelope(profile)].length,
                transported: true,
            },
        };
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
}) as unknown as Provider;

test("an enforcing backend proves the required raw reasoning-plus-content sentence", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken, calls), { PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf" });
    assert.equal(calls[0]?.grammar, `root ::= ${JSON.stringify(`${envelope("gemma")}${verifyToken}`)}`);
});

test("Qwen rail verifies a template-prefixed response from its sampled continuation", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken, calls, "qwen"), { PLURNK_PROVIDERS_GBNF: "plurnk.qwen.gbnf" });
    assert.equal(calls[0]?.grammar, `root ::= ${JSON.stringify(`${reasoning}</think>${verifyToken}`)}`);
});

test("GBNF with reasoning explicitly off is an invalid composed PLURNK configuration", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken, calls), {
            PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf",
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
            assistant: { content: verifyToken, reasoning: null, finishReason: "stop", model: "fake" },
            assistantRaw: null,
            accounting: [accounting],
        }),
    } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(provider, { PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf" }),
        /did not return grammar evidence/,
    );
});

test("an UNCONSTRAINED backend fails hard — never a silent unconstrained boot", async () => {
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("hello, I am unconstrained"), { PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf" }),
        (err: Error) => /GBNF enforcement failed/.test(err.message) && /unconstrained output/.test(err.message),
        "the boot refuses to run with dark rails, with a legible cause",
    );
});

test("no grammar requested → verification is a no-op", async () => {
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything at all"), {});
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("anything"), { PLURNK_PROVIDERS_GBNF: "0" });
    // no throw = unconstrained is a legitimate deliberate mode
});

test("{§grammar-enforcement-verified-at-boot} debug comparison skips the transport enforcement probe", async () => {
    const calls: Array<{ grammar?: string }> = [];
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("unconstrained native output", calls), {
        PLURNK_MODEL: "rig",
        PLURNK_MODEL_rig: "openai/local",
        PLURNK_PROVIDERS_GBNF_rig: "plurnk.gemma.gbnf",
        PLURNK_PROVIDERS_GBNF_DEBUG_rig: "1",
    });
    assert.deepEqual(calls, [], "debug mode withholds the forcing probe instead of demanding transported enforcement");
});

test("a configured GBNF fails hard when the provider does not advertise local transport", async () => {
    const nonClaiming = { ...fakeProvider("garbage the probe would reject"), constrainsOutput: false } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(nonClaiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf" }),
        /does not advertise GBNF transport/,
    );

    const claiming = { ...fakeProvider("unconstrained ramble"), constrainsOutput: true } as unknown as Provider;
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(claiming, { PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf" }),
        /GBNF enforcement failed/,
        "a CLAIMING backend that returns unconstrained output still fails hard",
    );
});

test("{§grammar-enforcement-verified-at-boot} a per-alias grammar verifies when the bare setting is empty", async () => {
    const env = { PLURNK_PROVIDERS_GBNF: "", PLURNK_MODEL: "rig", PLURNK_MODEL_rig: "openai/local", PLURNK_PROVIDERS_GBNF_rig: "plurnk.gemma.gbnf" };
    await assert.rejects(
        () => ProviderInstantiate.verifyGrammarEnforcement(fakeProvider("I am unconstrained"), env),
        /did not honor the forcing grammar|does not enforce|unconstrained/i,
        "per-alias GBNF resolves and the end-to-end verify RUNS — a non-enforcing backend fails hard, never silently skipped",
    );
    await ProviderInstantiate.verifyGrammarEnforcement(fakeProvider(verifyToken), env);
});
