import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveEffortFromEnv } from "./reasoning-effort.ts";
import { scopeEnvToAlias } from "./env.ts";
import { withProviderDefaults } from "./defaults.ts";

test("{§provider-effort} adaptive fallback has one environment owner and follows alias scoping", () => {
    const env = withProviderDefaults({});
    assert.equal(env.PLURNK_PROVIDERS_EFFORT_FALLBACK, "high");
    assert.equal(adaptiveEffortFromEnv(env, ["low", "high", "xhigh", "max"]), "high");
    assert.equal(adaptiveEffortFromEnv(env, ["low", "medium", "xhigh"]), undefined);
    assert.equal(adaptiveEffortFromEnv(scopeEnvToAlias({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK_sample: "medium",
    }, "sample"), ["low", "medium", "high"]), "medium");
    assert.equal(adaptiveEffortFromEnv(scopeEnvToAlias({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK_sample: "",
    }, "sample"), ["high"]), "high", "empty alias overrides inherit the bare knob");
    assert.equal(adaptiveEffortFromEnv({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK: "",
    }, ["high"]), undefined);
});

test("{§provider-effort} missing or invalid fallback configuration fails by name", () => {
    assert.throws(() => adaptiveEffortFromEnv({}, ["high"]), /PLURNK_PROVIDERS_EFFORT_FALLBACK must be set/);
    for (const invalid of ["off", "adaptive", "minimal", "turbo"]) {
        assert.throws(() => adaptiveEffortFromEnv({
            PLURNK_PROVIDERS_EFFORT_FALLBACK: invalid,
        }, ["high"]), /PLURNK_PROVIDERS_EFFORT_FALLBACK must be empty or one of low, medium, high, xhigh, max/);
    }
});
