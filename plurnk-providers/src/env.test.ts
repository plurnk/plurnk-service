import test from "node:test";
import { strict as assert } from "node:assert";
import { parseRequiredInt, parseOptionalInt, requireEnv, reasoningFromEnv } from "./env.ts";

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

test("reasoningFromEnv: activation modes parse; budget required IFF on; fail-hard on everything else (#33)", () => {
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "off" }, "openai"), { mode: "off", budget: null });
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"), { mode: "adaptive", budget: null });
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "4096" }, "openai"), { mode: "on", budget: 4096 });
    assert.throws(() => reasoningFromEnv({}, "openai"), /PLURNK_PROVIDERS_REASONING must be set/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "8192" }, "openai"), /must be one of "off", "adaptive", "on"/); // the old numeric habit fails loudly
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on" }, "openai"), /PLURNK_PROVIDERS_REASONING_BUDGET must be set when/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "0" }, "openai"), /positive integer/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "1.5" }, "openai"), /positive integer/);
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
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_REASONING_turboderp: "on",
        PLURNK_PROVIDERS_REASONING_BUDGET_TURBODERP: "4096", // case-folds like PLURNK_MODEL_ keys
        PLURNK_PROVIDERS_CONTEXT_SIZE_other: "1",
    } as NodeJS.ProcessEnv;
    const scoped = scopeEnvToAlias(env, "turboderp");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING, "on");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_BUDGET, "4096");
    assert.equal(scoped.PLURNK_PROVIDERS_CONTEXT_SIZE, undefined); // other alias's override never bleeds
    assert.equal(scopeEnvToAlias(env, "plain").PLURNK_PROVIDERS_REASONING, "off"); // fallback intact
});

test("scopeEnvToAlias: aliases with underscores resolve; a bare knob is never mistaken for a suffix", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_my_box: "5000",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_REASONING_BUDGET: "4096", // bare budget — NOT a "_capacity" alias override of REASONING
    } as NodeJS.ProcessEnv;
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_FETCH_TIMEOUT, "5000");
    assert.equal(scopeEnvToAlias(env, "budget").PLURNK_PROVIDERS_REASONING, "off"); // collision guard
});

test("#36 dataCaptureFromEnv: both knobs OFF by default, ON when set (LOGPROB = top_logprobs count)", async () => {
    const { dataCaptureFromEnv } = await import("./env.ts");
    assert.deepEqual(dataCaptureFromEnv({} as NodeJS.ProcessEnv, "x"), { logprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_RAWBODY: "0" } as NodeJS.ProcessEnv, "x"), { logprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_LOGPROB: "3", PLURNK_PROVIDERS_RAWBODY: "1" } as NodeJS.ProcessEnv, "x"), { logprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_LOGPROB: "0" } as NodeJS.ProcessEnv, "x"), { logprobs: 0, rawBody: false }); // set-to-0 = on, chosen-token only
});

test("scopeEnvToAlias: a caller-supplied knob list scopes CONSUMER vars (service window partition)", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const SERVICE_KNOBS = ["PLURNK_SERVICE_CTX", "PLURNK_SERVICE_REASONING", "PLURNK_SERVICE_ASSISTANT", "PLURNK_SERVICE_SAFETY"];
    const env = {
        PLURNK_SERVICE_CTX: "163840", PLURNK_SERVICE_REASONING: "16384", PLURNK_SERVICE_ASSISTANT: "49152", PLURNK_SERVICE_SAFETY: "1024",
        PLURNK_SERVICE_CTX_turboderp: "78848", PLURNK_SERVICE_REASONING_turboderp: "4096", PLURNK_SERVICE_ASSISTANT_TURBODERP: "8192", // case-folds
    } as NodeJS.ProcessEnv;
    const gemma = scopeEnvToAlias(env, "turboderp", SERVICE_KNOBS);
    assert.equal(gemma.PLURNK_SERVICE_CTX, "78848");
    assert.equal(gemma.PLURNK_SERVICE_REASONING, "4096");
    assert.equal(gemma.PLURNK_SERVICE_ASSISTANT, "8192");
    assert.equal(gemma.PLURNK_SERVICE_SAFETY, "1024"); // bare fallback intact
    const cloud = scopeEnvToAlias(env, "fireslow", SERVICE_KNOBS);
    assert.equal(cloud.PLURNK_SERVICE_REASONING, "16384"); // 64k envelope untouched by gemma overrides
    assert.equal(cloud.PLURNK_SERVICE_ASSISTANT, "49152");
    // custom list does NOT scope providers-family knobs (closed-list isolation both ways)
    const mixed = scopeEnvToAlias({ PLURNK_PROVIDERS_REASONING: "off", PLURNK_PROVIDERS_REASONING_turboderp: "on" } as NodeJS.ProcessEnv, "turboderp", SERVICE_KNOBS);
    assert.equal(mixed.PLURNK_PROVIDERS_REASONING, "off");
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

// Reader-declares (#44 ecosystem standard): every knob the code reads appears in
// the shipped .env.defaults — set (the floor) or commented (documented optional).
// The file IS the operator documentation; this keeps it from drifting off the code.
test("#44: every PROVIDERS_KNOBS entry appears in the shipped .env.defaults", async () => {
    const { readFileSync } = await import("node:fs");
    const { PROVIDERS_KNOBS } = await import("./env.ts");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    const missing = PROVIDERS_KNOBS.filter((k) => !defaults.includes(k));
    assert.deepEqual([...missing], [], "knobs read by code but undeclared in .env.defaults");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_GBNF="), "GBNF (service-read, providers-namespace) must be declared with its default");
});

// #399: the family word is REASONING (industry standard). Old names fail hard
// with the migration pointer — never silently coexist with the new floor.
test("#399: still-set old THINKING names fail hard with the rename pointer", () => {
    assert.throws(
        () => reasoningFromEnv({ PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"),
        /PLURNK_PROVIDERS_THINKING was renamed to PLURNK_PROVIDERS_REASONING \(#399\)/,
    );
    assert.throws(
        () => reasoningFromEnv({ PLURNK_PROVIDERS_THINKING_CAPACITY: "4096", PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"),
        /PLURNK_PROVIDERS_THINKING_CAPACITY was renamed to PLURNK_PROVIDERS_REASONING_BUDGET \(#399\)/,
    );
});

test("#399: the shipped floor activates reasoning by default (adaptive — owner ruling)", async () => {
    const { readFileSync } = await import("node:fs");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_REASONING=adaptive"), "floor must ship REASONING=adaptive");
    assert.ok(!defaults.match(/^PLURNK_PROVIDERS_REASONING_BUDGET=/m), "no shipped magnitude — budget is on-mode only");
});
