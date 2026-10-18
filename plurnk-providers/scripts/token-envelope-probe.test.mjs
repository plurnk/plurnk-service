import assert from "node:assert/strict";
import test from "node:test";

import {
    resolveProbeMaxOutputTokens,
    selectProbeAliases,
} from "./token-envelope-probe.mjs";

test("#242: token probe selects only explicit aliases", () => {
    const routes = selectProbeAliases({
        PLURNK_MODEL_fast: "deepseek/deepseek-v4-flash",
        PLURNK_MODEL_slow: "deepseek/deepseek-v4-pro",
    }, ["slow"]);

    assert.deepEqual(routes.map(({ alias, provider, model }) => ({ alias, provider, model })), [{
        alias: "slow",
        provider: "deepseek",
        model: "deepseek-v4-pro",
    }]);
    assert.throws(
        () => selectProbeAliases({ PLURNK_MODEL_fast: "deepseek/model" }, ["missing"]),
        /unknown provider alias/,
    );
});

test("#242: output-token modes distinguish configured policy from model physics", () => {
    const provider = { outputBudget: 350, maxOutputTokens: 500 };

    assert.equal(resolveProbeMaxOutputTokens("configured", provider), 350);
    assert.equal(resolveProbeMaxOutputTokens("model", provider), 500);
    assert.equal(resolveProbeMaxOutputTokens("42", provider), 42);
    assert.throws(() => resolveProbeMaxOutputTokens("configured", {}), /requires a resolved output budget/);
    assert.throws(() => resolveProbeMaxOutputTokens("0", provider), /safe integer >= 1/);
});

