import test from "node:test";
import assert from "node:assert/strict";
import { isZeroPinTuning, scrubZeroPinTuning } from "../../test/zero-pin.ts";

test("[#510] operator model tuning is stripped; the fresh-user config is kept", () => {
    // STRIPPED — box tuning a fresh install would not have:
    for (const k of [
        "PLURNK_PROVIDERS_CONTEXT_WINDOW",           // bare window pin → force the probe
        "PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", // per-alias window pin
        "PLURNK_PROVIDERS_REASONING_RESERVE_turboderp",
        "PLURNK_PROVIDERS_COMPLETION_RESERVE_gbuild",
        "PLURNK_SERVICE_SAFETY_turboderp",
        "PLURNK_SERVICE_PROMPT_BUDGET",
        "PLURNK_SERVICE_PROMPT_BUDGET_glm",
    ]) assert.equal(isZeroPinTuning(k), true, `${k} must be stripped (operator tuning)`);

    // KEPT — the fresh-user config: model selection + shipped percent defaults:
    for (const k of [
        "PLURNK_MODEL", "PLURNK_MODEL_turboderp",
        "PLURNK_PROVIDERS_REASONING_RESERVE",   // BARE percent default — the fresh-user reserve
        "PLURNK_PROVIDERS_COMPLETION_RESERVE",
        "PLURNK_SERVICE_SAFETY",                // BARE safety default
        "PLURNK_PROVIDERS_BASE_URL_turboderp",
    ]) assert.equal(isZeroPinTuning(k), false, `${k} must be KEPT (fresh-user config)`);
});

test("[#510] scrubZeroPinTuning deletes in place and reports what it stripped", () => {
    const env = {
        PLURNK_MODEL: "turboderp",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp: "49152",
        PLURNK_PROVIDERS_REASONING_RESERVE: "10%",       // bare — stays
        PLURNK_SERVICE_SAFETY_turboderp: "1024",         // per-alias — stripped
        PLURNK_SERVICE_PROMPT_BUDGET_glm: "128000",       // virtual operator pressure — stripped
    } as NodeJS.ProcessEnv;
    const stripped = scrubZeroPinTuning(env);
    assert.deepEqual(stripped.sort(), ["PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp", "PLURNK_SERVICE_PROMPT_BUDGET_glm", "PLURNK_SERVICE_SAFETY_turboderp"]);
    assert.equal(env.PLURNK_MODEL, "turboderp", "model selection survives");
    assert.equal(env.PLURNK_PROVIDERS_REASONING_RESERVE, "10%", "the bare percent reserve survives");
    assert.equal(env.PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp, undefined, "the window pin is gone → probe forced");
});
