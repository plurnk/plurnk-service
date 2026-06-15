import test from "node:test";
import { strict as assert } from "node:assert";
import { parseRequiredInt, parseOptionalInt, requireEnv, reasoningBudgetFromEnv } from "./env.ts";

test("parseRequiredInt: parses a non-negative integer", () => {
    assert.equal(parseRequiredInt("600000", "PLURNK_FETCH_TIMEOUT", "openai"), 600000);
    assert.equal(parseRequiredInt("0", "PLURNK_FETCH_TIMEOUT", "openai"), 0);
});

test("parseRequiredInt: missing value names the env var and provider", () => {
    assert.throws(() => parseRequiredInt(undefined, "PLURNK_FETCH_TIMEOUT", "groq"), /groq provider: PLURNK_FETCH_TIMEOUT must be set/);
    assert.throws(() => parseRequiredInt("", "PLURNK_FETCH_TIMEOUT", "groq"), /must be set/);
});

test("parseRequiredInt: rejects non-numeric, fractional, and negative values", () => {
    assert.throws(() => parseRequiredInt("abc", "PLURNK_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "abc"\)/);
    assert.throws(() => parseRequiredInt("1.5", "PLURNK_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "1\.5"\)/);
    assert.throws(() => parseRequiredInt("-1", "PLURNK_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "-1"\)/);
});

test("parseOptionalInt: absent → null, present → integer", () => {
    assert.equal(parseOptionalInt(undefined, "PLURNK_PROVIDER_CONTEXT_SIZE", "openai"), null);
    assert.equal(parseOptionalInt("", "PLURNK_PROVIDER_CONTEXT_SIZE", "openai"), null);
    assert.equal(parseOptionalInt("131072", "PLURNK_PROVIDER_CONTEXT_SIZE", "openai"), 131072);
});

test("parseOptionalInt: rejects fractional and negative values", () => {
    assert.throws(() => parseOptionalInt("3.14", "PLURNK_PROVIDER_CONTEXT_SIZE", "openai"), /must be a non-negative integer/);
    assert.throws(() => parseOptionalInt("-8", "PLURNK_PROVIDER_CONTEXT_SIZE", "openai"), /must be a non-negative integer/);
});

test("reasoningBudgetFromEnv: 0 off, -1 adaptive, N capped; required; rejects < -1 and non-int", () => {
    assert.equal(reasoningBudgetFromEnv({ PLURNK_PROVIDERS_REASONING_BUDGET: "0" }, "openai"), 0);
    assert.equal(reasoningBudgetFromEnv({ PLURNK_PROVIDERS_REASONING_BUDGET: "-1" }, "openai"), -1);
    assert.equal(reasoningBudgetFromEnv({ PLURNK_PROVIDERS_REASONING_BUDGET: "4096" }, "openai"), 4096);
    assert.throws(() => reasoningBudgetFromEnv({}, "openai"), /PLURNK_PROVIDERS_REASONING_BUDGET must be set/);
    assert.throws(() => reasoningBudgetFromEnv({ PLURNK_PROVIDERS_REASONING_BUDGET: "-2" }, "openai"), /integer >= -1/);
    assert.throws(() => reasoningBudgetFromEnv({ PLURNK_PROVIDERS_REASONING_BUDGET: "1.5" }, "openai"), /integer >= -1/);
});

test("requireEnv: returns the value or throws a named error", () => {
    assert.equal(requireEnv("sk-x", "OPENAI_API_KEY", "openai"), "sk-x");
    assert.throws(() => requireEnv(undefined, "GROQ_API_KEY", "groq"), /groq provider: GROQ_API_KEY must be set/);
    assert.throws(() => requireEnv("", "GROQ_API_KEY", "groq"), /must be set/);
});
