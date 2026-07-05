import test from "node:test";
import { strict as assert } from "node:assert";
import { parseRequiredInt, parseOptionalInt, requireEnv, thinkingFromEnv } from "./env.ts";

test("parseRequiredInt: parses a non-negative integer", () => {
    assert.equal(parseRequiredInt("600000", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), 600000);
    assert.equal(parseRequiredInt("0", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), 0);
});

test("parseRequiredInt: missing value names the env var and provider", () => {
    assert.throws(() => parseRequiredInt(undefined, "PLURNK_PROVIDERS_FETCH_TIMEOUT", "groq"), /groq provider: PLURNK_PROVIDERS_FETCH_TIMEOUT must be set/);
    assert.throws(() => parseRequiredInt("", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "groq"), /must be set/);
});

test("parseRequiredInt: rejects non-numeric, fractional, and negative values", () => {
    assert.throws(() => parseRequiredInt("abc", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "abc"\)/);
    assert.throws(() => parseRequiredInt("1.5", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "1\.5"\)/);
    assert.throws(() => parseRequiredInt("-1", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "-1"\)/);
});

test("parseOptionalInt: absent → null, present → integer", () => {
    assert.equal(parseOptionalInt(undefined, "PLURNK_PROVIDERS_CONTEXT_SIZE", "openai"), null);
    assert.equal(parseOptionalInt("", "PLURNK_PROVIDERS_CONTEXT_SIZE", "openai"), null);
    assert.equal(parseOptionalInt("131072", "PLURNK_PROVIDERS_CONTEXT_SIZE", "openai"), 131072);
});

test("parseOptionalInt: rejects fractional and negative values", () => {
    assert.throws(() => parseOptionalInt("3.14", "PLURNK_PROVIDERS_CONTEXT_SIZE", "openai"), /must be a non-negative integer/);
    assert.throws(() => parseOptionalInt("-8", "PLURNK_PROVIDERS_CONTEXT_SIZE", "openai"), /must be a non-negative integer/);
});

test("thinkingFromEnv: activation modes parse; capacity required IFF on; fail-hard on everything else (#33)", () => {
    assert.deepEqual(thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "off" }, "openai"), { mode: "off", capacity: null });
    assert.deepEqual(thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "adaptive" }, "openai"), { mode: "adaptive", capacity: null });
    assert.deepEqual(thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_THINKING_CAPACITY: "4096" }, "openai"), { mode: "on", capacity: 4096 });
    assert.throws(() => thinkingFromEnv({}, "openai"), /PLURNK_PROVIDERS_THINKING must be set/);
    assert.throws(() => thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "8192" }, "openai"), /must be one of "off", "adaptive", "on"/); // the old numeric habit fails loudly
    assert.throws(() => thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "on" }, "openai"), /PLURNK_PROVIDERS_THINKING_CAPACITY must be set when/);
    assert.throws(() => thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_THINKING_CAPACITY: "0" }, "openai"), /positive integer/);
    assert.throws(() => thinkingFromEnv({ PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_THINKING_CAPACITY: "1.5" }, "openai"), /positive integer/);
});

test("requireEnv: returns the value or throws a named error", () => {
    assert.equal(requireEnv("sk-x", "OPENAI_API_KEY", "openai"), "sk-x");
    assert.throws(() => requireEnv(undefined, "GROQ_API_KEY", "groq"), /groq provider: GROQ_API_KEY must be set/);
    assert.throws(() => requireEnv("", "GROQ_API_KEY", "groq"), /must be set/);
});

// — per-alias knob scoping (per-alias scoping doctrine, user 2026-07-03) —

test("scopeEnvToAlias: suffixed knob wins, bare is the fallback, other aliases ignored", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_THINKING: "off",
        PLURNK_PROVIDERS_THINKING_turboderp: "on",
        PLURNK_PROVIDERS_THINKING_CAPACITY_TURBODERP: "4096", // case-folds like PLURNK_MODEL_ keys
        PLURNK_PROVIDERS_CONTEXT_SIZE_other: "1",
    } as NodeJS.ProcessEnv;
    const scoped = scopeEnvToAlias(env, "turboderp");
    assert.equal(scoped.PLURNK_PROVIDERS_THINKING, "on");
    assert.equal(scoped.PLURNK_PROVIDERS_THINKING_CAPACITY, "4096");
    assert.equal(scoped.PLURNK_PROVIDERS_CONTEXT_SIZE, undefined); // other alias's override never bleeds
    assert.equal(scopeEnvToAlias(env, "plain").PLURNK_PROVIDERS_THINKING, "off"); // fallback intact
});

test("scopeEnvToAlias: aliases with underscores resolve; a bare knob is never mistaken for a suffix", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_my_box: "5000",
        PLURNK_PROVIDERS_THINKING: "off",
        PLURNK_PROVIDERS_THINKING_CAPACITY: "4096", // bare capacity — NOT a "_capacity" alias override of THINKING
    } as NodeJS.ProcessEnv;
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_FETCH_TIMEOUT, "5000");
    assert.equal(scopeEnvToAlias(env, "capacity").PLURNK_PROVIDERS_THINKING, "off"); // collision guard
});

test("#36 dataCaptureFromEnv: both knobs OFF by default, ON when set (LOGPROB = top_logprobs count)", async () => {
    const { dataCaptureFromEnv } = await import("./env.ts");
    assert.deepEqual(dataCaptureFromEnv({} as NodeJS.ProcessEnv, "x"), { logprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_RAWBODY: "0" } as NodeJS.ProcessEnv, "x"), { logprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_LOGPROB: "3", PLURNK_PROVIDERS_RAWBODY: "1" } as NodeJS.ProcessEnv, "x"), { logprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_LOGPROB: "0" } as NodeJS.ProcessEnv, "x"), { logprobs: 0, rawBody: false }); // set-to-0 = on, chosen-token only
});

test("#36 capture knobs are per-alias scopable: enable on a scraping alias, serving alias stays clean", async () => {
    const { scopeEnvToAlias, dataCaptureFromEnv } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_LOGPROB_fireslow: "3",
        PLURNK_PROVIDERS_RAWBODY_fireslow: "1",
    } as NodeJS.ProcessEnv;
    assert.deepEqual(dataCaptureFromEnv(scopeEnvToAlias(env, "fireslow"), "x"), { logprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv(scopeEnvToAlias(env, "grokfast"), "x"), { logprobs: null, rawBody: false });
});
