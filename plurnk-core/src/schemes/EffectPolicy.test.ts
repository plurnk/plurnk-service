// {§exec-lifetime} — one knob per effect and the panel is the whole map; an invalid value
// fails loudly at validation.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import EffectPolicy from "./EffectPolicy.ts";

const KNOBS = ["PLURNK_SERVICE_EFFECT_HOST", "PLURNK_SERVICE_EFFECT_READ", "PLURNK_SERVICE_EFFECT_PURE"] as const;
const shipped = Object.fromEntries(KNOBS.map((name) => [name, process.env[name]]));

afterEach(() => {
    for (const name of KNOBS) {
        if (shipped[name] === undefined) delete process.env[name]; else process.env[name] = shipped[name];
    }
});

test("{§exec-lifetime} the shipped panel reviews host and accepts read and pure", () => {
    assert.equal(EffectPolicy.decide("host"), "review");
    assert.equal(EffectPolicy.decide("read"), "accept");
    assert.equal(EffectPolicy.decide("pure"), "accept");
    EffectPolicy.validateConfiguration();
});

test("{§exec-lifetime} every effect is its own knob across review, accept, and reject", () => {
    process.env.PLURNK_SERVICE_EFFECT_READ = "review";
    assert.equal(EffectPolicy.decide("read"), "review", "a high-security deployment reviews even reads");
    assert.equal(EffectPolicy.decide("host"), "review", "and says nothing about the others by doing so");
    process.env.PLURNK_SERVICE_EFFECT_HOST = "accept";
    process.env.PLURNK_SERVICE_EFFECT_PURE = "reject";
    assert.equal(EffectPolicy.decide("host"), "accept");
    assert.equal(EffectPolicy.decide("pure"), "reject");
    EffectPolicy.validateConfiguration();
});

test("{§exec-lifetime} an invalid or missing knob fails validation by its name", () => {
    process.env.PLURNK_SERVICE_EFFECT_READ = "maybe";
    assert.throws(() => EffectPolicy.validateConfiguration(), /PLURNK_SERVICE_EFFECT_READ must be one of review, accept, reject; got "maybe"/u);
    process.env.PLURNK_SERVICE_EFFECT_READ = "accept";
    delete process.env.PLURNK_SERVICE_EFFECT_PURE;
    assert.throws(() => EffectPolicy.validateConfiguration(), /PLURNK_SERVICE_EFFECT_PURE is missing from the assembled environment floor/u);
});
