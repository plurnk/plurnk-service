import test from "node:test";
import { strict as assert } from "node:assert";
import { providerModelOptions } from "./model-options.ts";

const rules = JSON.stringify([
    { models: ["family-a*"], options: { sdk: { first: true } } },
    { models: ["family-*", "~family-*"], options: { sdk: { second: true } } },
]);

test("{§provider-model-options} the first rule whose glob matches the model applies; none applies without a match", () => {
    const env = { PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTIVE_OPTIONS: rules };
    assert.deepEqual(providerModelOptions("acme", env, "ADAPTIVE_OPTIONS", "family-a-1"), { sdk: { first: true } });
    assert.deepEqual(providerModelOptions("acme", env, "ADAPTIVE_OPTIONS", "~family-b"), { sdk: { second: true } });
    assert.equal(providerModelOptions("acme", env, "ADAPTIVE_OPTIONS", "other"), undefined);
    assert.equal(providerModelOptions("other", env, "ADAPTIVE_OPTIONS", "family-a-1"), undefined);
});

test("{§provider-model-options} a route or alias declaration overrides the provider's; an empty one declares none", () => {
    const env = { PLURNK_PROVIDERS_PROVIDER_ACME_SYSTEM_CACHE_OPTIONS: rules, PLURNK_PROVIDERS_SYSTEM_CACHE_OPTIONS: "" };
    assert.equal(providerModelOptions("acme", env, "SYSTEM_CACHE_OPTIONS", "family-a-1"), undefined);
});

test("{§provider-model-options} a malformed declaration fails construction and names its key", () => {
    for (const value of ["{", "{}", "[]x", '[{"models":[],"options":{}}]', '[{"models":["a"],"options":[]}]', '[{"models":[""],"options":{}}]']) {
        assert.throws(() => providerModelOptions("acme", { PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTIVE_OPTIONS: value }, "ADAPTIVE_OPTIONS", "a"),
            { message: 'PLURNK_PROVIDERS_PROVIDER_ACME_ADAPTIVE_OPTIONS must be a JSON array of {"models":["<glob>",…],"options":{…}} rules' });
    }
});
