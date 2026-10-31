import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { scopeEnvToAlias, dataCaptureFromEnv, costOverrideFromEnv, cacheAffinityFromEnv, cacheWritePolicyFromEnv, generationEnvelopeFromEnv, resolveGenerationEnvelopeFromEnv, parseRequiredInt, parseOptionalInt, parseTimeoutMs, requireEnv, effortFromEnv, reasoningResponseStyleFromEnv } from "./env.ts";
import { withProviderDefaults } from "./defaults.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookupProvider } from "@plurnk/plurnk-models";
import { adaptiveEffortFromEnv } from "./reasoning-effort.ts";
import { emitWarningOnce, resetEmittedWarnings } from "./warnings.ts";

test("{§provider-configuration} parseRequiredInt: parses a non-negative integer", () => {
    assert.equal(parseRequiredInt("600000", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), 600000);
    assert.equal(parseRequiredInt("0", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), 0);
});

test("{§provider-configuration} parseRequiredInt: rejects non-numeric, fractional, and negative values", () => {
    assert.throws(() => parseRequiredInt("abc", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "abc"\)/);
    assert.throws(() => parseRequiredInt("1.5", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "1\.5"\)/);
    assert.throws(() => parseRequiredInt("-1", "PLURNK_PROVIDERS_FETCH_TIMEOUT", "openai"), /must be a non-negative integer \(got "-1"\)/);
});

test("{§provider-failure-normalization} parseTimeoutMs accepts disabled deadlines and rejects timer overflow", () => {
    assert.equal(parseTimeoutMs("0", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"), 0);
    assert.equal(parseTimeoutMs("2147483647", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"), 2_147_483_647);
    assert.throws(
        () => parseTimeoutMs("2147483648", "PLURNK_PROVIDERS_OPERATION_TIMEOUT", "openai"),
        /must be at most 2147483647 milliseconds/,
    );
});

test("{§provider-configuration} parseOptionalInt: absent → null, present → integer", () => {
    assert.equal(parseOptionalInt(undefined, "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), null);
    assert.equal(parseOptionalInt("", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), null);
    assert.equal(parseOptionalInt("131072", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), 131072);
});

test("{§provider-configuration} parseOptionalInt: rejects fractional and negative values", () => {
    assert.throws(() => parseOptionalInt("3.14", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), /must be a non-negative integer/);
    assert.throws(() => parseOptionalInt("-8", "PLURNK_PROVIDERS_CONTEXT_WINDOW", "openai"), /must be a non-negative integer/);
});

test("{§provider-effort} effortFromEnv: durable policy is independent from an optional explicit budget", () => {
    assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "off" }, "openai"), { mode: "off", budget: null });
    assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "adaptive" }, "openai"), { mode: "adaptive", budget: null });
    assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "high" }, "openai"), { mode: "high", budget: null });
    assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "high" }, "openai", 4096), { mode: "high", budget: 4096 });
    assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "adaptive" }, "openai", 4096), { mode: "adaptive", budget: 4096 });
    assert.throws(() => effortFromEnv({}, "openai"), /PLURNK_PROVIDERS_EFFORT must be set/);
    assert.throws(() => effortFromEnv({ PLURNK_PROVIDERS_EFFORT: "8192" }, "openai"), /must be one of "off", "adaptive", "low", "medium", "high", "xhigh", "max"/);
});

test("{§provider-interface} response style is explicit and invalid values fail at the provider boundary", () => {
    assert.equal(reasoningResponseStyleFromEnv({}, "cloudflare-workers-ai"), "verbatim");
    assert.equal(reasoningResponseStyleFromEnv({
        PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "think-tags",
    }, "cloudflare-workers-ai"), "think-tags");
    assert.throws(
        () => reasoningResponseStyleFromEnv({
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "auto",
        }, "cloudflare-workers-ai"),
        /cloudflare-workers-ai provider: PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE must be "verbatim" or "think-tags" \(got "auto"\)/,
    );
});

test("{§provider-configuration} requireEnv: returns the value or throws a named error", () => {
    assert.equal(requireEnv("sk-x", "OPENAI_API_KEY", "openai"), "sk-x");
    assert.throws(() => requireEnv(undefined, "GROQ_API_KEY", "groq"), /groq provider: GROQ_API_KEY must be set/);
    assert.throws(() => requireEnv("", "GROQ_API_KEY", "groq"), /must be set/);
});

test("{§provider-sdk-boundary} cache policy keeps cost-neutral affinity separate from paid cache writes", () => {
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

// — per-alias knob scoping ({§provider-configuration}) —

test("{§provider-configuration} scopeEnvToAlias: each projection reads one fresh environment snapshot", () => {
    const values: NodeJS.ProcessEnv = {
        PLURNK_PROVIDERS_EFFORT: "low",
        PLURNK_PROVIDERS_EFFORT_sample: "high",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_sample: "",
        UNRELATED: "preserved",
    };
    const reads = new Map<string, number>();
    const environment = new Proxy(values, {
        get(target, key: string) {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return target[key];
        },
    });
    const first = scopeEnvToAlias(environment, "sample");
    assert.deepEqual(first, { ...values, PLURNK_PROVIDERS_EFFORT: "high" });
    assert.deepEqual(reads, new Map(Object.keys(values).map((key) => [key, 1])),
        "scoping cannot reread the host environment once per knob");
    assert.equal(values.PLURNK_PROVIDERS_EFFORT, "low", "the source is not mutated");
    values.PLURNK_PROVIDERS_EFFORT_sample = "medium";
    assert.equal(scopeEnvToAlias(environment, "sample").PLURNK_PROVIDERS_EFFORT, "medium");
    assert.equal(first.PLURNK_PROVIDERS_EFFORT, "high", "a later change cannot rewrite the earlier view");
    assert.deepEqual(reads, new Map(Object.keys(values).map((key) => [key, 2])),
        "each invocation takes its own snapshot; there is no persistent cache");
});

test("{§provider-configuration} scopeEnvToAlias: suffixed knob wins, bare is the fallback, other aliases ignored", async () => {
    const env = {
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_EFFORT_turboderp: "high",
        PLURNK_PROVIDERS_REASONING_BUDGET_TURBODERP: "4096", // case-folds like PLURNK_MODEL_ keys
        PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE_TURBODERP: "think-tags",
        PLURNK_PROVIDERS_REASONING_EFFORTS_turboderp: "low,medium,xhigh",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_turboderp: "8000",
        PLURNK_PROVIDERS_OUTPUT_BUDGET_turboderp: "4096",
        PLURNK_PROVIDERS_CONTEXT_WINDOW_other: "1",
    } as NodeJS.ProcessEnv;
    const scoped = scopeEnvToAlias(env, "turboderp");
    assert.equal(scoped.PLURNK_PROVIDERS_EFFORT, "high");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_BUDGET, "4096");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE, "think-tags");
    assert.equal(scoped.PLURNK_PROVIDERS_REASONING_EFFORTS, "low,medium,xhigh");
    assert.equal(scoped.PLURNK_PROVIDERS_CONTEXT_WINDOW, "8000");
    assert.equal(scoped.PLURNK_PROVIDERS_OUTPUT_BUDGET, "4096");
    assert.equal(scopeEnvToAlias(env, "plain").PLURNK_PROVIDERS_EFFORT, "off"); // fallback intact
    assert.equal(scopeEnvToAlias(env, "plain").PLURNK_PROVIDERS_REASONING_EFFORTS, undefined, "another alias's projection never leaks");
});

test("{§provider-configuration} scopeEnvToAlias: aliases with underscores resolve; a bare knob is never mistaken for a suffix", async () => {
    const env = {
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
        PLURNK_PROVIDERS_FETCH_TIMEOUT_my_box: "5000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT: "2700000",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT_my_box: "15000",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_EFFORT_FALLBACK: "high", // a bare knob — NOT a "_fallback" alias override of EFFORT
    } as NodeJS.ProcessEnv;
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_FETCH_TIMEOUT, "5000");
    assert.equal(scopeEnvToAlias(env, "my_box").PLURNK_PROVIDERS_OPERATION_TIMEOUT, "15000");
    assert.equal(scopeEnvToAlias(env, "fallback").PLURNK_PROVIDERS_EFFORT, "off"); // collision guard
});

test("{§provider-failure-normalization} dataCaptureFromEnv: both knobs OFF by default, ON when set (TOP_LOGPROBS = the OpenAI top_logprobs count)", async () => {
    assert.deepEqual(dataCaptureFromEnv({}, "x"), { topLogprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_RAWBODY: "0" }, "x"), { topLogprobs: null, rawBody: false });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "3", PLURNK_PROVIDERS_RAWBODY: "1" }, "x"), { topLogprobs: 3, rawBody: true });
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "0" }, "x"), { topLogprobs: 0, rawBody: false }); // set-to-0 = on, chosen-token only
    assert.deepEqual(dataCaptureFromEnv({ PLURNK_PROVIDERS_TOP_LOGPROBS: "off" }, "x"), { topLogprobs: null, rawBody: false });
});

test("{§model-fact-resolution} contextWindowFromEnv: reads PLURNK_PROVIDERS_CONTEXT_WINDOW, null when unset", async () => {
    const { contextWindowFromEnv } = await import("./env.ts");
    assert.equal(contextWindowFromEnv({ PLURNK_PROVIDERS_CONTEXT_WINDOW: "131072" }, "openai"), 131072);
    assert.equal(contextWindowFromEnv({}, "openai"), null);
});

test("{§provider-configuration} scopeEnvToAlias: a caller's knob list scopes only that caller's knobs", async () => {
    const SERVICE_KNOBS = ["PLURNK_SERVICE_MAX_TURNS", "PLURNK_SERVICE_LOOP_TIMEOUT", "PLURNK_SERVICE_EXEC_HOLD_MS", "PLURNK_SERVICE_BUDGET_LARGEST_ITEMS"];
    const env = {
        PLURNK_SERVICE_MAX_TURNS: "163840", PLURNK_SERVICE_LOOP_TIMEOUT: "16384", PLURNK_SERVICE_EXEC_HOLD_MS: "49152", PLURNK_SERVICE_BUDGET_LARGEST_ITEMS: "5",
        PLURNK_SERVICE_MAX_TURNS_turboderp: "78848", PLURNK_SERVICE_LOOP_TIMEOUT_turboderp: "4096", PLURNK_SERVICE_EXEC_HOLD_MS_TURBODERP: "8192", // case-folds
    } as NodeJS.ProcessEnv;
    const gemma = scopeEnvToAlias(env, "turboderp", SERVICE_KNOBS);
    assert.equal(gemma.PLURNK_SERVICE_MAX_TURNS, "78848");
    assert.equal(gemma.PLURNK_SERVICE_LOOP_TIMEOUT, "4096");
    assert.equal(gemma.PLURNK_SERVICE_EXEC_HOLD_MS, "8192");
    assert.equal(gemma.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS, "5"); // bare fallback intact
    const cloud = scopeEnvToAlias(env, "fireslow", SERVICE_KNOBS);
    assert.equal(cloud.PLURNK_SERVICE_LOOP_TIMEOUT, "16384"); // 64k envelope untouched by gemma overrides
    assert.equal(cloud.PLURNK_SERVICE_EXEC_HOLD_MS, "49152");
    // custom list does NOT scope the providers' knobs (closed-list isolation both ways)
    const mixed = scopeEnvToAlias({ PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_EFFORT_turboderp: "high" }, "turboderp", SERVICE_KNOBS);
    assert.equal(mixed.PLURNK_PROVIDERS_EFFORT, "off");
});

test("{§provider-failure-normalization} capture knobs are per-alias scopable: enable on a scraping alias, serving alias stays clean", async () => {
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
test("{§provider-configuration} every PROVIDERS_KNOBS entry appears in the shipped .env.defaults", async () => {
    const { PROVIDERS_KNOBS } = await import("./env.ts");
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    const missing = PROVIDERS_KNOBS.filter((k) => !defaults.includes(k));
    assert.deepEqual([...missing], [], "knobs read by code but undeclared in .env.defaults");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_GBNF="), "GBNF (service-read, providers-namespace) must be declared with its default");
});

test("{§capability-policy-cascade} effort accepts only the exact portable durable vocabulary", () => {
    for (const mode of ["off", "adaptive", "low", "medium", "high", "xhigh", "max"] as const) {
        assert.deepEqual(effortFromEnv({ PLURNK_PROVIDERS_EFFORT: mode }, "openai"), {
            mode,
            budget: null,
        });
    }
    for (const invalid of ["ultra", "HIGH", "medium-high"]) {
        assert.throws(
            () => effortFromEnv({ PLURNK_PROVIDERS_EFFORT: invalid }, "openai"),
            /must be one of "off", "adaptive", "low", "medium", "high", "xhigh", "max"/,
        );
    }
});

test("{§model-fact-resolution} the shipped floor defers reasoning posture to the provider by default (adaptive)", () => {
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.ok(defaults.includes("PLURNK_PROVIDERS_EFFORT=adaptive"), "floor must ship EFFORT=adaptive");
    assert.ok(!defaults.match(/^PLURNK_PROVIDERS_REASONING_BUDGET=/m), "no shipped magnitude — provider-adaptive depth remains unpinned");
});

test("{§provider-configuration} the shipped DRY floor is off and claims no universally safe shape", () => {
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.match(defaults, /^PLURNK_PROVIDERS_DRY_MULTIPLIER=0$/m, "a fidelity-corrupting sampler cannot be a portable floor");
    assert.doesNotMatch(defaults, /^PLURNK_PROVIDERS_DRY_BASE=/m);
    assert.doesNotMatch(defaults, /^PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH=/m);
});

// -- {§provider-configuration} --

const floor = { PLURNK_PROVIDERS_OUTPUT_FLOOR: "10%" } as const;

test("{§provider-configuration} generationEnvelopeFromEnv: output is total and reasoning is an optional subset", () => {
    assert.deepEqual(
        generationEnvelopeFromEnv({
            ...floor,
            PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
            PLURNK_PROVIDERS_REASONING_BUDGET: "4096",
        }, "x", 100_000, 32_000),
        { outputBudget: 32_000, outputFloor: 3_200, reasoningBudget: 4096 },
    );
    assert.throws(() => generationEnvelopeFromEnv({ ...floor }, "x", 100_000, null), /PLURNK_PROVIDERS_OUTPUT_BUDGET must be set/);
    assert.throws(() => generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "150%" }, "x", 100_000, null), /percentage must be in \(0, 100\)/);
    assert.throws(() => generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "-5" }, "x", 100_000, null), /positive integer token count/);
    assert.throws(() => generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "100000" }, "x", 100_000, null), /must leave positive input capacity/);
    assert.throws(() => generationEnvelopeFromEnv({
        ...floor,
        PLURNK_PROVIDERS_OUTPUT_BUDGET: "20%",
        PLURNK_PROVIDERS_REASONING_BUDGET: "25%",
    }, "x", 100_000, null), /reasoning is a subset of total output/);
    assert.deepEqual(
        generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "1%" }, "x", 2, null),
        { outputBudget: 1, outputFloor: 1, reasoningBudget: null },
        "a valid percentage always resolves to at least one whole token",
    );
    assert.throws(
        () => generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%" }, "x", 1, null),
        /must leave positive input capacity/,
    );
});

test("{§provider-capacity-admission} PLURNK_PROVIDERS_OUTPUT_FLOOR parses like the output budget: percent or absolute, alias-scoped, required for a standard provider and optional for Mock", () => {
    const budget = { PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%" } as const;
    assert.equal(generationEnvelopeFromEnv({ ...budget, ...floor }, "x", 100_000, null).outputFloor, 10_000);
    assert.equal(generationEnvelopeFromEnv({ ...budget, PLURNK_PROVIDERS_OUTPUT_FLOOR: "2048" }, "x", 100_000, null).outputFloor, 2_048);
    assert.equal(generationEnvelopeFromEnv({ ...budget, ...floor }, "x", null, null).outputFloor, null, "a percentage of an unknown window resolves to null like the budget");
    assert.equal(
        generationEnvelopeFromEnv(scopeEnvToAlias({ ...budget, ...floor, PLURNK_PROVIDERS_OUTPUT_FLOOR_turboderp: "1024" }, "turboderp"), "x", 100_000, null).outputFloor,
        1_024,
    );
    assert.throws(() => generationEnvelopeFromEnv({ ...budget }, "x", 100_000, null), /PLURNK_PROVIDERS_OUTPUT_FLOOR must be set/);
    assert.throws(() => generationEnvelopeFromEnv({ ...budget, PLURNK_PROVIDERS_OUTPUT_FLOOR: "0" }, "x", 100_000, null), /PLURNK_PROVIDERS_OUTPUT_FLOOR must be "<pct>%" or a positive integer token count/);
    assert.deepEqual(
        resolveGenerationEnvelopeFromEnv({ ...budget }, 100_000),
        { outputBudget: 35_000, outputFloor: null, reasoningBudget: null },
        "the tolerant resolver reads the floor optionally",
    );
});

test("{§provider-capacity-admission} the floor resolves against the effective output ceiling and is capped by the output budget", () => {
    assert.deepEqual(
        generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "1000" }, "x", 1_000_000, null),
        { outputBudget: 1_000, outputFloor: 1_000, reasoningBudget: null },
        "a floor the budget cannot hold clamps to the budget, never refuses",
    );
    assert.deepEqual(
        generationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%" }, "x", 1_000_000, 65_536),
        { outputBudget: 65_536, outputFloor: 6_554, reasoningBudget: null },
        "a percentage floor resolves against min(contextWindow, maxOutputTokens), leaving positive curation room below the wall",
    );
    assert.equal(
        generationEnvelopeFromEnv({ PLURNK_PROVIDERS_OUTPUT_FLOOR: "100000", PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%" }, "x", 1_000_000, 65_536).outputFloor,
        65_536,
        "an absolute floor above the model's output limit still clamps to the physical cap and budget",
    );
    assert.equal(resolveGenerationEnvelopeFromEnv({ ...floor, PLURNK_PROVIDERS_OUTPUT_BUDGET: "1000" }, 1_000_000).outputFloor, 1_000);
});

test("{§provider-configuration} envelope knobs are per-alias scopable (measured envelope per box)", () => {
    const env = {
        ...floor,
        PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%",
        PLURNK_PROVIDERS_REASONING_BUDGET: "10%",
        PLURNK_PROVIDERS_OUTPUT_BUDGET_turboderp: "8192",
        PLURNK_PROVIDERS_REASONING_BUDGET_turboderp: "4096",
    } as NodeJS.ProcessEnv;
    assert.deepEqual(generationEnvelopeFromEnv(scopeEnvToAlias(env, "turboderp"), "x", 49_152, null), { outputBudget: 8192, outputFloor: 4915, reasoningBudget: 4096 });
    assert.deepEqual(generationEnvelopeFromEnv(scopeEnvToAlias(env, "jennifer"), "x", 100_000, null), { outputBudget: 35_000, outputFloor: 10_000, reasoningBudget: 10_000 });
});

test("{§provider-monetary-evidence} {§provider-configuration} costOverrideFromEnv parses the five scalar cost knobs and refuses invalid values", () => {
    assert.equal(costOverrideFromEnv({}, "x"), null);
    assert.deepEqual(
        costOverrideFromEnv(
            {
                PLURNK_PROVIDERS_COST_INPUT: "0.22",
                PLURNK_PROVIDERS_COST_OUTPUT: "0.66",
                PLURNK_PROVIDERS_COST_REASONING: "0.66",
                PLURNK_PROVIDERS_COST_CACHE_READ: "0.007",
                PLURNK_PROVIDERS_COST_CACHE_WRITE: "0.22",
            },
            "x",
        ),
        { input: 0.22, output: 0.66, reasoning: 0.66, cacheRead: 0.007, cacheWrite: 0.22 },
    );
    assert.throws(
        () => costOverrideFromEnv({ PLURNK_PROVIDERS_COST_INPUT: "invalid" }, "x"),
        /PLURNK_PROVIDERS_COST_INPUT must be a non-negative per-1M-token USD rate/,
    );
    assert.throws(
        () => costOverrideFromEnv({ PLURNK_PROVIDERS_COST_OUTPUT: "-1" }, "x"),
        /PLURNK_PROVIDERS_COST_OUTPUT must be a non-negative per-1M-token USD rate/,
    );
    // Alias-scoped like every provider knob.
    const scoped = scopeEnvToAlias(
        {
            PLURNK_PROVIDERS_COST_INPUT: "0.10",
            PLURNK_PROVIDERS_COST_INPUT_deepdumb: "0.44",
            PLURNK_PROVIDERS_COST_OUTPUT_deepdumb: "1.32",
        },
        "deepdumb",
    );
    assert.deepEqual(costOverrideFromEnv(scoped, "x"), { input: 0.44, output: 1.32 });
});

{
test("{§provider-configuration} withProviderDefaults supplies the package-owned operational floor", () => {
    const env = withProviderDefaults({});
    assert.equal(env.PLURNK_PROVIDERS_CACHE_AFFINITY, "1");
    assert.equal(env.PLURNK_PROVIDERS_CACHE_WRITE_POLICY, "stable-system");
    assert.equal(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "2700000");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "600000");
    assert.deepEqual(Object.keys(env).filter((key) => key.endsWith("_TIMEOUT")).toSorted(), [
        "PLURNK_PROVIDERS_FETCH_TIMEOUT",
        "PLURNK_PROVIDERS_OPERATION_TIMEOUT",
    ]);
    assert.equal(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "3");
    assert.equal(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "512");
});

test("{§provider-configuration} withProviderDefaults preserves every explicit operator value", () => {
    const env = withProviderDefaults({
        PLURNK_PROVIDERS_CACHE_AFFINITY: "malformed",
        PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "off",
        PLURNK_PROVIDERS_OPERATION_TIMEOUT: "84",
        PLURNK_PROVIDERS_FETCH_TIMEOUT: "42",
    });
    assert.equal(env.PLURNK_PROVIDERS_CACHE_AFFINITY, "malformed");
    assert.equal(env.PLURNK_PROVIDERS_CACHE_WRITE_POLICY, "off");
    assert.equal(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "84");
    assert.equal(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "42");
});
}

{
const defaultsPath = fileURLToPath(new URL("../.env.defaults", import.meta.url));
const declarations = readFileSync(defaultsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ key: match[1], value: match[2] }));

const providerFact = (key: string): { provider: string; fact: string } | null => {
    const match = /^PLURNK_PROVIDERS_PROVIDER_([A-Z0-9_]+)_(NPM|BASE_URL|API_KEY_ENV)$/.exec(key);
    return match === null ? null : { provider: match[1].toLowerCase(), fact: match[2] };
};

test("{§model-fact-resolution} package defaults never redefine cataloged provider facts", () => {
    // (#459) the env prefix IS the Models.dev id, underscored; probe both spellings.
    for (const { key, value } of declarations) {
        const fact = providerFact(key);
        if (fact === null) continue;
        for (const candidate of new Set([fact.provider, fact.provider.replaceAll("_", "-")])) {
            assert.equal(
                lookupProvider(candidate),
                null,
                `package default '${key}=${value}' redefines a Models.dev-cataloged provider fact (${candidate})`,
            );
        }
    }
});

test("{§model-fact-resolution} package defaults never ship ordered credential fallbacks", () => {
    for (const { key, value } of declarations) {
        if (!key.endsWith("_API_KEY_ENV")) continue;
        assert.ok(
            /^[A-Z0-9_]+$/.test(value),
            `package default '${key}' must hold one exact environment name, got '${value}'`,
        );
    }
});

test("{§provider-request-authority} the shipped floor identifies the public Plurnk application", () => {
    const values = new Map(declarations.map(({ key, value }) => [key, value]));
    assert.equal(values.get("PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_URL"), "https://github.com/plurnk/plurnk-service");
    assert.equal(values.get("PLURNK_PROVIDERS_PROVIDER_OPENROUTER_APP_NAME"), "Plurnk");
    assert.equal([...values.keys()].some((key) => key.startsWith("OPENROUTER_")), false);
});
}

{
test("{§provider-effort} adaptive fallback has one environment owner and follows alias scoping", () => {
    const env = withProviderDefaults({});
    assert.equal(env.PLURNK_PROVIDERS_EFFORT_FALLBACK, "high");
    assert.equal(adaptiveEffortFromEnv(env, ["low", "high", "xhigh", "max"]), "high");
    assert.equal(adaptiveEffortFromEnv(env, ["low", "medium", "xhigh"]), undefined);
    assert.equal(adaptiveEffortFromEnv(scopeEnvToAlias({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK_sample: "medium",
    }, "sample"), ["low", "medium", "high"]), "medium");
    assert.equal(adaptiveEffortFromEnv(scopeEnvToAlias({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK_sample: "",
    }, "sample"), ["high"]), "high", "empty alias overrides inherit the bare knob");
    assert.equal(adaptiveEffortFromEnv({
        ...env, PLURNK_PROVIDERS_EFFORT_FALLBACK: "",
    }, ["high"]), undefined);
});

test("{§provider-effort} missing or invalid fallback configuration fails by name", () => {
    assert.throws(() => adaptiveEffortFromEnv({}, ["high"]), /PLURNK_PROVIDERS_EFFORT_FALLBACK must be set/);
    for (const invalid of ["off", "adaptive", "minimal", "turbo"]) {
        assert.throws(() => adaptiveEffortFromEnv({
            PLURNK_PROVIDERS_EFFORT_FALLBACK: invalid,
        }, ["high"]), /PLURNK_PROVIDERS_EFFORT_FALLBACK must be empty or one of low, medium, high, xhigh, max/);
    }
});
}

{
test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); });

test("{§provider-capacity-admission} same (code, message) fires once per process", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    assert.deepEqual(seen, ["openai provider: estimate"]);
});

test("{§provider-capacity-admission} dedup is by (code, MESSAGE), not code — a second provider's surfacing is never suppressed", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("groq provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE"); // same code, different provider
    assert.deepEqual(seen, ["openai provider: estimate", "groq provider: estimate"]);
});
}
