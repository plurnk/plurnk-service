import test from "node:test";
import { strict as assert } from "node:assert";
import { parseRequiredInt, parseOptionalInt, parseRequiredFlag, requireEnv, reasoningKnobsFromEnv } from "./env.ts";

test("parseRequiredInt: parses a non-negative integer", () => {
    assert.equal(parseRequiredInt("600000", "PLURNK_FETCH_TIMEOUT", "openai"), 600000);
    assert.equal(parseRequiredInt("0", "PLURNK_REASON", "openai"), 0);
});

test("parseRequiredInt: missing value names the env var and provider", () => {
    assert.throws(() => parseRequiredInt(undefined, "PLURNK_REASON", "groq"), /groq provider: PLURNK_REASON must be set/);
    assert.throws(() => parseRequiredInt("", "PLURNK_REASON", "groq"), /must be set/);
});

test("parseRequiredInt: rejects non-numeric, fractional, and negative values", () => {
    assert.throws(() => parseRequiredInt("abc", "PLURNK_REASON", "openai"), /must be a non-negative integer \(got "abc"\)/);
    assert.throws(() => parseRequiredInt("1.5", "PLURNK_REASON", "openai"), /must be a non-negative integer \(got "1\.5"\)/);
    assert.throws(() => parseRequiredInt("-1", "PLURNK_REASON", "openai"), /must be a non-negative integer \(got "-1"\)/);
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

test("parseRequiredFlag: strict 0/1, named errors on missing or junk", () => {
    assert.equal(parseRequiredFlag("1", "PLURNK_PROVIDERS_THINKING", "openai"), true);
    assert.equal(parseRequiredFlag("0", "PLURNK_PROVIDERS_REASONING", "openai"), false);
    assert.throws(() => parseRequiredFlag(undefined, "PLURNK_PROVIDERS_THINKING", "openai"), /openai provider: PLURNK_PROVIDERS_THINKING must be set/);
    assert.throws(() => parseRequiredFlag("true", "PLURNK_PROVIDERS_THINKING", "openai"), /must be "0" or "1" \(got "true"\)/);
});

test("reasoningKnobsFromEnv: requires both gates — no in-code defaults", () => {
    assert.deepEqual(
        reasoningKnobsFromEnv({ PLURNK_PROVIDERS_THINKING: "0", PLURNK_PROVIDERS_REASONING: "1" }, "openai"),
        { nativeThinking: false, reasoningEnabled: true },
    );
    assert.throws(() => reasoningKnobsFromEnv({ PLURNK_PROVIDERS_REASONING: "1" }, "openai"), /PLURNK_PROVIDERS_THINKING must be set/);
    assert.throws(() => reasoningKnobsFromEnv({ PLURNK_PROVIDERS_THINKING: "0" }, "openai"), /PLURNK_PROVIDERS_REASONING must be set/);
});

test("requireEnv: returns the value or throws a named error", () => {
    assert.equal(requireEnv("sk-x", "OPENAI_API_KEY", "openai"), "sk-x");
    assert.throws(() => requireEnv(undefined, "GROQ_API_KEY", "groq"), /groq provider: GROQ_API_KEY must be set/);
    assert.throws(() => requireEnv("", "GROQ_API_KEY", "groq"), /must be set/);
});
