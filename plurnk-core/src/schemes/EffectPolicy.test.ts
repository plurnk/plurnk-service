// {§effect-policy-tunable} — one knob per effect and the panel is the whole map; an invalid value
// and the retired composite both fail loudly at validation.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import EffectPolicy from "./EffectPolicy.ts";

const KNOBS = ["PLURNK_SERVICE_EFFECT_HOST", "PLURNK_SERVICE_EFFECT_READ", "PLURNK_SERVICE_EFFECT_PURE", "PLURNK_SERVICE_EFFECT_POLICY"] as const;
const shipped = Object.fromEntries(KNOBS.map((name) => [name, process.env[name]]));

afterEach(() => {
    for (const name of KNOBS) {
        if (shipped[name] === undefined) delete process.env[name]; else process.env[name] = shipped[name];
    }
});

test("{§effect-policy-tunable} the shipped panel proposes host and auto-runs read and pure", () => {
    assert.equal(EffectPolicy.decide("host"), "propose");
    assert.equal(EffectPolicy.decide("read"), "auto");
    assert.equal(EffectPolicy.decide("pure"), "auto");
    EffectPolicy.validateConfiguration();
});

test("{§effect-policy-tunable} every effect is its own knob, including proposing reads and auto-running host", () => {
    process.env.PLURNK_SERVICE_EFFECT_READ = "propose";
    assert.equal(EffectPolicy.decide("read"), "propose", "a high-security deployment proposes even reads");
    assert.equal(EffectPolicy.decide("host"), "propose", "and says nothing about the others by doing so");
    process.env.PLURNK_SERVICE_EFFECT_HOST = "auto";
    process.env.PLURNK_SERVICE_EFFECT_PURE = "propose";
    assert.equal(EffectPolicy.decide("host"), "auto");
    assert.equal(EffectPolicy.decide("pure"), "propose");
});

test("{§effect-policy-tunable} an invalid or missing knob fails validation by its name", () => {
    process.env.PLURNK_SERVICE_EFFECT_READ = "maybe";
    assert.throws(() => EffectPolicy.validateConfiguration(), /PLURNK_SERVICE_EFFECT_READ must be one of propose, auto; got "maybe"/u);
    process.env.PLURNK_SERVICE_EFFECT_READ = "auto";
    delete process.env.PLURNK_SERVICE_EFFECT_PURE;
    assert.throws(() => EffectPolicy.validateConfiguration(), /PLURNK_SERVICE_EFFECT_PURE is missing from the assembled environment floor/u);
});

test("{§effect-policy-tunable} the retired composite fails hard, naming its successors", () => {
    process.env.PLURNK_SERVICE_EFFECT_POLICY = "read:propose";
    assert.throws(
        () => EffectPolicy.validateConfiguration(),
        /PLURNK_SERVICE_EFFECT_POLICY is retired: state PLURNK_SERVICE_EFFECT_HOST, PLURNK_SERVICE_EFFECT_READ, PLURNK_SERVICE_EFFECT_PURE instead/u,
    );
});
