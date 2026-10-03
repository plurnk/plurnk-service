import test from "node:test";
import assert from "node:assert/strict";
import { withProviderDefaults } from "./defaults.ts";

test("withProviderDefaults supplies the package-owned operational floor", () => {
    const env = withProviderDefaults({});
    assert.equal(env.PLURNK_PROVIDERS_CACHE_AFFINITY, "1");
    assert.equal(env.PLURNK_PROVIDERS_CACHE_WRITE_POLICY, "stable-system");
    assert.equal(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "2700000");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "600000");
    assert.deepEqual(Object.keys(env).filter((key) => key.endsWith("_TIMEOUT")).sort(), [
        "PLURNK_PROVIDERS_FETCH_TIMEOUT",
        "PLURNK_PROVIDERS_OPERATION_TIMEOUT",
    ]);
    assert.equal(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "3");
    assert.equal(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "512");
});

test("withProviderDefaults preserves every explicit operator value", () => {
    const env = withProviderDefaults({
        PLURNK_PROVIDERS_CACHE_AFFINITY: "malformed",
        PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "off",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT: "84",
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "42",
    });
    assert.equal(env.PLURNK_PROVIDERS_CACHE_AFFINITY, "malformed");
    assert.equal(env.PLURNK_PROVIDERS_CACHE_WRITE_POLICY, "off");
    assert.equal(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "84");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "42");
});
