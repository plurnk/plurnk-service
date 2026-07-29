import test from "node:test";
import assert from "node:assert/strict";
import { withProviderDefaults } from "./defaults.ts";

test("withProviderDefaults supplies the package-owned operational floor", () => {
    const env = withProviderDefaults({});
    assert.equal(env.PLURNK_PROVIDERS_PROMPT_CACHE_KEY, "1");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "600000");
    assert.equal(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "3");
    assert.equal(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "512");
});

test("withProviderDefaults preserves every explicit operator value", () => {
    const env = withProviderDefaults({
        PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "malformed",
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "42",
    });
    assert.equal(env.PLURNK_PROVIDERS_PROMPT_CACHE_KEY, "malformed");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "42");
});
