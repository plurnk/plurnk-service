import test from "node:test";
import { strict as assert } from "node:assert";
import {
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    parseRequiredInt,
    parseOptionalInt,
    parseTimeoutMs,
    requireEnv,
    reasoningFromEnv,
    reasoningResponseStyleFromEnv,
} from "./env.ts";

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

test("parseTimeoutMs accepts disabled deadlines and rejects timer overflow", () => {
    assert.equal(parseTimeoutMs("0", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"), 0);
    assert.equal(parseTimeoutMs("2147483647", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"), 2_147_483_647);
    assert.throws(
        () => parseTimeoutMs("2147483648", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"),
        /must be at most 2147483647 milliseconds/,
    );
});

test("parseOptionalInt: absent → null, present → integer", () => {
    assert.equal(parseOptionalInt(undefined, "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), null);
    assert.equal(parseOptionalInt("", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), null);
    assert.equal(parseOptionalInt("131072", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), 131072);
});

test("parseOptionalInt: rejects fractional and negative values", () => {
    assert.throws(() => parseOptionalInt("3.14", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), /must be a non-negative integer/);
    assert.throws(() => parseOptionalInt("-8", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), /must be a non-negative integer/);
});

test("reasoningFromEnv: activation modes parse; budget required IFF on; fail-hard on everything else", () => {
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "off" }, "openai"), { mode: "off", budget: null });
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"), { mode: "adaptive", budget: null });
    assert.deepEqual(reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "4096" }, "openai"), { mode: "on", budget: 4096 });
    assert.throws(() => reasoningFromEnv({}, "openai"), /PLURNK_PROVIDERS_REASONING must be set/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "8192" }, "openai"), /must be one of "off", "adaptive", "on"/); // the old numeric habit fails loudly
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on" }, "openai"), /PLURNK_PROVIDERS_REASONING_BUDGET must be set when/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "0" }, "openai"), /positive integer/);
    assert.throws(() => reasoningFromEnv({ PLURNK_PROVIDERS_REASONING: "on", PLURNK_PROVIDERS_REASONING_BUDGET: "1.5" }, "openai"), /positive integer/);
});

test("{§provider-tagged-reasoning} response style is explicit and invalid values fail at the provider boundary", () => {
    assert.equal(reasoningResponseStyleFromEnv({}, "cloudflare"), "verbatim");
    assert.equal(reasoningResponseStyleFromEnv({
        PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "think-tags",
    }, "cloudflare"), "think-tags");
    assert.throws(
        () => reasoningResponseStyleFromEnv({
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "auto",
        }, "cloudflare"),
        /cloudflare provider: PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE must be "verbatim" or "think-tags" \(got "auto"\)/,
    );
});

test("requireEnv: returns the value or throws a named error", () => {
    assert.equal(requireEnv("sk-x", "OPENAI_API_KEY", "openai"), "sk-x");
    assert.throws(() => requireEnv(undefined, "GROQ_API_KEY", "groq"), /groq provider: GROQ_API_KEY must be set/);
    assert.throws(() => requireEnv("", "GROQ_API_KEY", "groq"), /must be set/);
});

test("cache policy keeps cost-neutral affinity separate from paid cache writes", () => {
    assert.equal(cacheAffinityFromEnv({ PLURNK_PROVIDERS_CACHE_AFFINITY: "1" }, "openai"), true);
    assert.equal(cacheAffinityFromEnv({ PLURNK_PROVIDERS_CACHE_AFFINITY: "0" }, "openai"), false);
    assert.equal(cacheWritePolicyFromEnv({ PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system" }, "anthropic"), "stable-system");
    assert.equal(cacheWritePolicyFromEnv({ PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "off" }, "anthropic"), "off");
    assert.throws(
        () => cacheAffinityFromEnv({ PLURNK_PROVIDERS_CACHE_AFFINITY: "auto" }, "openai"),
        /PLURNK_PROVIDERS_CACHE_AFFINITY must be "0" or "1"/,
    );
    assert.throws(
        () => cacheWritePolicyFromEnv({ PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "everything" }, "anthropic"),
        /PLURNK_PROVIDERS_CACHE_WRITE_POLICY must be "off" or "stable-system"/,
    );
});

test("the generic prompt-cache-key knob is retired rather than retained as a compatibility path", () => {
    assert.throws(
        () => cacheAffinityFromEnv({
            PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "1",
            PLURNK_PROVIDERS_CACHE_AFFINITY: "1",
        }, "fireworks"),
        /PLURNK_PROVIDERS_PROMPT_CACHE_KEY was renamed to PLURNK_PROVIDERS_CACHE_AFFINITY/,
    );
});

// — per-alias knob scoping (per-alias scoping doctrine, user 2026-07-03) —

test("scopeEnvToAlias: suffixed knob wins, bare is the fallback, other aliases ignored", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_REASONING_turboderp: "on",
        PLURNK_PROVIDERS_REASONING_BUDGET_TURBODERP: "4096", // case-folds like PLURNK_MODEL_ keys
        PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE_TURBODERP: "think-tags",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp: "8000",
        PLURNK_PROVIDERS_COMPLETION_RESERVE_turboderp: "4096",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_other: "1",
    } as NodeJS.ProcessEnv;
    const scoped = scopeEnvToAlias(env, "turboderp");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING, "on");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_BUDGET, "4096");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE, "think-tags");
    assert.equal(scoped.PLURNK_PROVIDERS_CONTEXT_WINDOW, "8000");
    assert.equal(scoped.PLURNK_PROVIDERS_COMPLETION_RESERVE, "4096");
    assert.equal(scopeEnvToAlias(env, "plain").PLURNK_PROVIDERS_REASONING, "off"); // fallback intact
});

test("scopeEnvToAlias: aliases with underscores resolve; a bare knob is never mistaken for a suffix", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_my_box: "5000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT: "2700000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT_my_box: "15000",
        PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT: "600000",
        PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT_my_box: "2500",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_REASONING_BUDGET: "4096", // bare budget — NOT a "_capacity" alias override of REASONING
    } as NodeJS.ProcessEnv;
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_FETCH_TIMEOUT, "5000");
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_OPERATION_TIMEOUT, "15000");
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT, "2500");
    assert.equal(scopeEnvToAlias(env, "budget").PLURNK_PROVIDERS_REASONING, "off"); // collision guard
});

test("dataCaptureFromEnv: both knobs OFF by default, ON when set (TOP_LOGPROBS = the OpenAI top_logprobs count)", async () => {
    const { dataCaptureFromEnv } = await import("./env.ts");
    assert.deepEqual(dataCaptureFromEnv({} as NodeJS.ProcessEnv, "x"), { topLogprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_RAWBODY: "0" } as NodeJS.ProcessEnv, "x"), { topLogprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "3", PLURNK_PROVIDERS_RAWBODY: "1" } as NodeJS.ProcessEnv, "x"), { topLogprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "0" } as NodeJS.ProcessEnv, "x"), { topLogprobs: 0, rawBody: false }); // set-to-0 = on, chosen-token only
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "off" } as NodeJS.ProcessEnv, "x"), { topLogprobs: null, rawBody: false });
});

test("OpenAI-lexicon shed: a still-set PLURNK_PROVIDERS_LOGPROB fails hard with the rename pointer", async () => {
    const { dataCaptureFromEnv } = await import("./env.ts");
    assert.throws(
        () => dataCaptureFromEnv({ PLURNK_PROVIDERS_LOGPROB: "3" } as NodeJS.ProcessEnv, "openai"),
        /PLURNK_PROVIDERS_LOGPROB was renamed to PLURNK_PROVIDERS_TOP_LOGPROBS/,
    );
});

test("contextWindowFromEnv: reads the new name, sheds CONTEXT_SIZE hard, null when unset", async () => {
    const { contextWindowFromEnv } = await import("./env.ts");
    assert.equal(contextWindowFromEnv({ PLURNK_PROVIDERS_CONTEXT_WINDOW: "131072" } as NodeJS.ProcessEnv, "openai"), 131072);
    assert.equal(contextWindowFromEnv({} as NodeJS.ProcessEnv, "openai"), null);
    assert.throws(
        () => contextWindowFromEnv({ PLURNK_PROVIDERS_CONTEXT_SIZE: "131072" } as NodeJS.ProcessEnv, "openai"),
        /PLURNK_PROVIDERS_CONTEXT_SIZE was renamed to PLURNK_PROVIDERS_CONTEXT_WINDOW/,
    );
});

test("scopeEnvToAlias: a caller-supplied knob list scopes consumer-owned vars", async () => {
    const { scopeEnvToAlias } = await import("./env.ts");
    const SERVICE_KNOBS = ["PLURNK_SERVICE_MAX_TURNS", "PLURNK_SERVICE_LOOP_TIMEOUT", "PLURNK_SERVICE_EXEC_HOLD_MS", "PLURNK_SERVICE_SAFETY"];
    const env = {
        PLURNK_SERVICE_MAX_TURNS: "163840", PLURNK_SERVICE_LOOP_TIMEOUT: "16384", PLURNK_SERVICE_EXEC_HOLD_MS: "49152", PLURNK_SERVICE_SAFETY: "1024",
        PLURNK_SERVICE_MAX_TURNS_turboderp: "78848", PLURNK_SERVICE_LOOP_TIMEOUT_turboderp: "4096", PLURNK_SERVICE_EXEC_HOLD_MS_TURBODERP: "8192", // case-folds
    } as NodeJS.ProcessEnv;
    const gemma = scopeEnvToAlias(env, "turboderp", SERVICE_KNOBS);
    assert.equal(gemma.PLURNK_SERVICE_MAX_TURNS, "78848");
    assert.equal(gemma.PLURNK_SERVICE_LOOP_TIMEOUT, "4096");
    assert.equal(gemma.PLURNK_SERVICE_EXEC_HOLD_MS, "8192");
    assert.equal(gemma.PLURNK_SERVICE_SAFETY, "1024"); // bare fallback intact
    const cloud = scopeEnvToAlias(env, "fireslow", SERVICE_KNOBS);
    assert.equal(cloud.PLURNK_SERVICE_LOOP_TIMEOUT, "16384"); // 64k envelope untouched by gemma overrides
    assert.equal(cloud.PLURNK_SERVICE_EXEC_HOLD_MS, "49152");
    // custom list does NOT scope providers-family knobs (closed-list isolation both ways)
    const mixed = scopeEnvToAlias({ PLURNK_PROVIDERS_REASONING: "off", PLURNK_PROVIDERS_REASONING_turboderp: "on" } as NodeJS.ProcessEnv, "turboderp", SERVICE_KNOBS);
    assert.equal(mixed.PLURNK_PROVIDERS_REASONING, "off");
});

test("capture knobs are per-alias scopable: enable on a scraping alias, serving alias stays clean", async () => {
    const { scopeEnvToAlias, dataCaptureFromEnv } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_TOP_LOGPROBS_fireslow: "3",
        PLURNK_PROVIDERS_RAWBODY_fireslow: "1",
    } as NodeJS.ProcessEnv;
    assert.deepEqual(dataCaptureFromEnv(scopeEnvToAlias(env, "fireslow"), "x"), { topLogprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv(scopeEnvToAlias(env, "grokfast"), "x"), { topLogprobs: null, rawBody: false });
});

// Every knob the code reads appears in
// the shipped .env.defaults — set (the floor) or commented (documented optional).
// The file IS the operator documentation; this keeps it from drifting off the code.
test("every PROVIDERS_KNOBS entry appears in the shipped .env.defaults", async () => {
    const { readFileSync } = await import("node:fs");
    const { PROVIDERS_KNOBS } = await import("./env.ts");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    const missing = PROVIDERS_KNOBS.filter((k) => !defaults.includes(k));
    assert.deepEqual([...missing], [], "knobs read by code but undeclared in .env.defaults");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_GBNF="), "GBNF (service-read, providers-namespace) must be declared with its default");
});

// The family word is REASONING (industry standard). Old names fail hard
// with the migration pointer — never silently coexist with the new floor.
test("still-set old THINKING names fail hard with the rename pointer", () => {
    assert.throws(
        () => reasoningFromEnv({ PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"),
        /PLURNK_PROVIDERS_THINKING was renamed to PLURNK_PROVIDERS_REASONING \(provider configuration contract\)/,
    );
    assert.throws(
        () => reasoningFromEnv({ PLURNK_PROVIDERS_THINKING_CAPACITY: "4096", PLURNK_PROVIDERS_REASONING: "adaptive" }, "openai"),
        /PLURNK_PROVIDERS_THINKING_CAPACITY was renamed to PLURNK_PROVIDERS_REASONING_BUDGET \(provider configuration contract\)/,
    );
});

test("the shipped floor activates reasoning by default (adaptive)", async () => {
    const { readFileSync } = await import("node:fs");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_REASONING=adaptive"), "floor must ship REASONING=adaptive");
    assert.ok(!defaults.match(/^PLURNK_PROVIDERS_REASONING_BUDGET=/m), "no shipped magnitude — budget is on-mode only");
});

test("the shipped DRY floor is off and claims no universally safe shape", async () => {
    const { readFileSync } = await import("node:fs");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.match(defaults, /^PLURNK_PROVIDERS_DRY_MULTIPLIER=0$/m, "a fidelity-corrupting sampler cannot be a portable floor");
    assert.doesNotMatch(defaults, /^PLURNK_PROVIDERS_DRY_BASE=/m);
    assert.doesNotMatch(defaults, /^PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH=/m);
});

// -- {§provider-generation-envelope} --

test("envelopeFromEnv: percentages and absolutes parse; missing/invalid fail hard", async () => {
    const { envelopeFromEnv } = await import("./env.ts");
    assert.deepEqual(
        envelopeFromEnv({ PLURNK_PROVIDERS_REASONING_RESERVE: "10%", PLURNK_PROVIDERS_COMPLETION_RESERVE: "4096" } as NodeJS.ProcessEnv, "x"),
        { reasoningReserve: { percent: 0.1 }, completionReserve: { tokens: 4096 } },
    );
    assert.throws(() => envelopeFromEnv({ PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%" } as NodeJS.ProcessEnv, "x"), /PLURNK_PROVIDERS_REASONING_RESERVE must be set/);
    assert.throws(() => envelopeFromEnv({ PLURNK_PROVIDERS_REASONING_RESERVE: "150%", PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%" } as NodeJS.ProcessEnv, "x"), /percentage must be in \(0, 100\)/);
    assert.throws(() => envelopeFromEnv({ PLURNK_PROVIDERS_REASONING_RESERVE: "-5", PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%" } as NodeJS.ProcessEnv, "x"), /positive integer token count/);
});

test("envelope knobs are per-alias scopable (measured envelope per box)", async () => {
    const { scopeEnvToAlias, envelopeFromEnv } = await import("./env.ts");
    const env = {
        PLURNK_PROVIDERS_REASONING_RESERVE: "10%", PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%",
        PLURNK_PROVIDERS_REASONING_RESERVE_turboderp: "4096", PLURNK_PROVIDERS_COMPLETION_RESERVE_turboderp: "8192",
    } as NodeJS.ProcessEnv;
    assert.deepEqual(envelopeFromEnv(scopeEnvToAlias(env, "turboderp"), "x"), { reasoningReserve: { tokens: 4096 }, completionReserve: { tokens: 8192 } });
    assert.deepEqual(envelopeFromEnv(scopeEnvToAlias(env, "jennifer"), "x"), { reasoningReserve: { percent: 0.1 }, completionReserve: { percent: 0.25 } });
});
