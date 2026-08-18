// {§effect-policy-tunable} — the default admission map plus the deployment
// override knob: operator entries win, unlisted effects keep the default, and
// invalid configuration fails loudly at validation.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import EffectPolicy, { EFFECT_POLICY_ENV } from "./EffectPolicy.ts";

afterEach(() => {
    delete process.env[EFFECT_POLICY_ENV];
});

test("the default map proposes host and auto-runs read/pure", () => {
    assert.equal(EffectPolicy.decide("host"), "propose");
    assert.equal(EffectPolicy.decide("read"), "auto");
    assert.equal(EffectPolicy.decide("pure"), "auto");
});

test("operator entries override their effects; unlisted effects keep the default", () => {
    process.env[EFFECT_POLICY_ENV] = "read:propose";
    assert.equal(EffectPolicy.decide("read"), "propose", "a high-security deployment proposes even reads");
    assert.equal(EffectPolicy.decide("host"), "propose");
    assert.equal(EffectPolicy.decide("pure"), "auto");
});

test("every effect is independently overridable, including proposing host and auto-running pure", () => {
    process.env[EFFECT_POLICY_ENV] = "pure:propose,host:auto,read:auto";
    assert.equal(EffectPolicy.decide("pure"), "propose");
    assert.equal(EffectPolicy.decide("host"), "auto");
    assert.equal(EffectPolicy.decide("read"), "auto");
});

test("invalid configuration fails validation with the offending entry", () => {
    for (const [raw, pattern] of [
        ["read:maybe", /unknown policy "maybe"/],
        ["banana:propose", /unknown effect "banana"/],
        ["read", /must be <effect>:<policy>/],
        [":propose", /must be <effect>:<policy>/],
    ] as const) {
        process.env[EFFECT_POLICY_ENV] = raw;
        assert.throws(() => EffectPolicy.validateConfiguration(), pattern, `raw ${JSON.stringify(raw)}`);
    }
});

test("validation passes for a well-formed list and an empty value", () => {
    EffectPolicy.validateConfiguration();
    process.env[EFFECT_POLICY_ENV] = "read:propose,pure:auto,host:propose";
    EffectPolicy.validateConfiguration();
});
