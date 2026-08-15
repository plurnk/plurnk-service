import test from "node:test";
import assert from "node:assert/strict";
import { isZeroPinTuning, scrubZeroPinTuning } from "../../test/zero-pin.ts";

test("{§operator-config-zero-pin-gate}: operator tuning is stripped and provider configuration remains", () => {
    // STRIPPED — box tuning a fresh install would not have:
    for (const k of [
        "PLURNK_PROVIDERS_CONTEXT_WINDOW",           // bare window pin → force the probe
        "PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", // per-alias window pin
        "PLURNK_PROVIDERS_OUTPUT_BUDGET_turboderp",
        "PLURNK_PROVIDERS_REASONING_BUDGET_gbuild",
        "PLURNK_SERVICE_PROMPT_PROJECTION_turboderp",
    ]) assert.equal(isZeroPinTuning(k), true, `${k} must be stripped (operator tuning)`);

    // KEPT — the fresh-user config: model selection + shipped percent defaults:
    for (const k of [
        "PLURNK_MODEL", "PLURNK_MODEL_turboderp",
        "PLURNK_PROVIDERS_OUTPUT_BUDGET",       // BARE percent default
        "PLURNK_PROVIDERS_REASONING_BUDGET",    // optional bare subset
        "PLURNK_SERVICE_PROMPT_PROJECTION",      // BARE percentage default
        "PLURNK_PROVIDERS_BASE_URL_turboderp",
    ]) assert.equal(isZeroPinTuning(k), false, `${k} must be KEPT (fresh-user config)`);
});

test("{§operator-config-zero-pin-gate}: scrubbing mutates the gate environment and reports every removed key", () => {
    const env = {
        PLURNK_MODEL: "turboderp",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp: "49152",
        PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",           // bare — stays
        PLURNK_PROVIDERS_REASONING_BUDGET_turboderp: "4096", // per-alias — stripped
        PLURNK_SERVICE_PROMPT_PROJECTION_turboderp: "10%", // per-alias — stripped
    } as NodeJS.ProcessEnv;
    const stripped = scrubZeroPinTuning(env);
    assert.deepEqual(stripped.sort(), ["PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", "PLURNK_PROVIDERS_REASONING_BUDGET_turboderp", "PLURNK_SERVICE_PROMPT_PROJECTION_turboderp"]);
    assert.equal(env.PLURNK_MODEL, "turboderp", "model selection survives");
    assert.equal(env.PLURNK_PROVIDERS_OUTPUT_BUDGET, "35%", "the bare percentage envelope survives");
    assert.equal(env.PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp, undefined, "the window pin is gone → probe forced");
});
