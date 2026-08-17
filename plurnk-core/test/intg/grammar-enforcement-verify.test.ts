// {§grammar-configuration-admission} / {§gbnf-requires-reasoning}.

import test from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";

const fakeProvider = (
    calls: string[],
    constrainsOutput: boolean = true,
): Provider => ({
    model: "fake",
    contextWindow: 1000,
    constrainsOutput,
    generate: async () => {
        calls.push("generate");
        throw new Error("startup generated tokens");
    },
    countPromptTokens: async () => ({ kind: "exact", tokens: 1, source: "test:exact" }),
}) as unknown as Provider;

test("configured GBNF admission performs no model generation", () => {
    const calls: string[] = [];
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls), {
        PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf",
    });
    assert.deepEqual(calls, [], "daemon admission has no authority to generate tokens");
});

test("GBNF with reasoning explicitly off is an invalid composed PLURNK configuration", () => {
    const calls: string[] = [];
    assert.throws(
        () => ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls), {
            PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf",
            PLURNK_PROVIDERS_REASONING: "off",
        }),
        /GBNF requires reasoning to be adaptive or on/,
    );
    assert.deepEqual(calls, [], "invalid configuration fails without model activity");
});

test("no grammar requested makes admission a no-op", () => {
    const calls: string[] = [];
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {});
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {
        PLURNK_PROVIDERS_GBNF: "0",
    });
    assert.deepEqual(calls, []);
});

test("configured GBNF requires a provider that advertises local transport", () => {
    const calls: string[] = [];
    assert.throws(
        () => ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls, false), {
            PLURNK_PROVIDERS_GBNF: "plurnk.gemma.gbnf",
        }),
        /does not advertise GBNF transport/,
    );
    assert.deepEqual(calls, []);
});

test("per-alias GBNF admission resolves when the bare setting is empty", () => {
    const calls: string[] = [];
    ProviderInstantiate.validateGrammarConfiguration(fakeProvider(calls), {
        PLURNK_PROVIDERS_GBNF: "",
        PLURNK_MODEL: "rig",
        PLURNK_MODEL_rig: "openai/local",
        PLURNK_PROVIDERS_GBNF_rig: "plurnk.gemma.gbnf",
    });
    assert.deepEqual(calls, []);
});
