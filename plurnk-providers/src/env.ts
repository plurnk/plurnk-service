// Env-parsing helpers shared by provider construction. `label` keeps failures
// local to the selected provider.

import { REASONING_POLICIES, Validator, type ReasoningPolicy } from "@plurnk/plurnk-contracts";

export const parseRequiredInt = (raw: string | undefined, name: string, label: string): number => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} provider: ${name} must be a non-negative integer (got "${raw}")`);
    return n;
};

export const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

export const parseTimeoutMs = (raw: string | undefined, name: string, label: string): number => {
    const timeoutMs = parseRequiredInt(raw, name, label);
    if (timeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
        throw new Error(`${label} provider: ${name} must be at most ${MAX_PROVIDER_TIMEOUT_MS} milliseconds (got "${raw}")`);
    }
    return timeoutMs;
};

export const parseOptionalInt = (raw: string | undefined, name: string, label: string): number | null => {
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} provider: ${name} must be a non-negative integer (got "${raw}")`);
    return n;
};

export const parseRequiredFloat = (raw: string | undefined, name: string, label: string, min: number): number => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${label} provider: ${name} must be a finite number >= ${min} (got "${raw}")`);
    return n;
};

export const parseOptionalFloat = (raw: string | undefined, name: string, label: string, min: number): number | null => {
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${label} provider: ${name} must be a finite number >= ${min} (got "${raw}")`);
    return n;
};

export const requireEnv = (raw: string | undefined, name: string, label: string): string => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    return raw;
};

// {§provider-configuration} A still-set retired knob fails
// hard pointing at its successor — never silently coexists with the new floor.
// The retired names appear ONLY as this function's ARGUMENTS at the call sites
// (each lexicon-allow), never as a live identifier.
const shedRenamed = (env: NodeJS.ProcessEnv, oldName: string, newName: string, label: string, ref: string): void => {
    const stale = env[oldName];
    if (stale !== undefined && stale.length > 0) throw new Error(`${label} provider: ${oldName} was renamed to ${newName} (${ref}); update the env`);
};

export type CacheWritePolicy = "off" | "stable-system";

export const cacheAffinityFromEnv = (env: NodeJS.ProcessEnv, label: string): boolean => {
    const name = "PLURNK_PROVIDERS_CACHE_AFFINITY";
    shedRenamed(env, "PLURNK_PROVIDERS_PROMPT_CACHE_KEY", name, label, "{§provider-cache-affinity}"); // lexicon-allow
    const value = env[name];
    if (value !== "0" && value !== "1") {
        throw new Error(`${label} provider: ${name} must be "0" or "1"`);
    }
    return value === "1";
};

export const cacheWritePolicyFromEnv = (env: NodeJS.ProcessEnv, label: string): CacheWritePolicy => {
    const name = "PLURNK_PROVIDERS_CACHE_WRITE_POLICY";
    const value = env[name];
    if (value !== "off" && value !== "stable-system") {
        throw new Error(`${label} provider: ${name} must be "off" or "stable-system"`);
    }
    return value;
};

// {§provider-evidence} Data-capture knobs are read identically by every provider
// (standard AND
// plugin) so the opt-in surface is one source of truth. Both OFF by default —
// the flag is the isolation, so serving turns request and carry nothing.
//   PLURNK_PROVIDERS_TOP_LOGPROBS   "off" or a non-negative int = the OpenAI
//     `top_logprobs` count (0 captures the chosen token only). Unset -> off.
//     Per-alias-scopable, so "off" can override process-wide capture.
//   PLURNK_PROVIDERS_RAWBODY   truthy (not ""/"0") → attach the verbatim wire
//     body to response.rawBody. Per-alias-scopable.
export const dataCaptureFromEnv = (env: NodeJS.ProcessEnv, label: string): { topLogprobs: number | null; rawBody: boolean } => {
    shedRenamed(env, "PLURNK_PROVIDERS_LOGPROB", "PLURNK_PROVIDERS_TOP_LOGPROBS", label, "the OpenAI wire term"); // lexicon-allow
    const topLogprobs = env.PLURNK_PROVIDERS_TOP_LOGPROBS === "off"
        ? null
        : parseOptionalInt(env.PLURNK_PROVIDERS_TOP_LOGPROBS, "PLURNK_PROVIDERS_TOP_LOGPROBS", label);
    return {
        topLogprobs,
        rawBody: env.PLURNK_PROVIDERS_RAWBODY !== undefined && env.PLURNK_PROVIDERS_RAWBODY !== "" && env.PLURNK_PROVIDERS_RAWBODY !== "0",
    };
};

// {§model-fact-resolution} — one context-window reader for every provider path;
// the retired CONTEXT_SIZE spelling fails visibly at the same boundary.
export const contextWindowFromEnv = (env: NodeJS.ProcessEnv, label: string): number | null => {
    shedRenamed(env, "PLURNK_PROVIDERS_CONTEXT_SIZE", "PLURNK_PROVIDERS_CONTEXT_WINDOW", label, "{§model-fact-resolution}"); // lexicon-allow
    return parseOptionalInt(env.PLURNK_PROVIDERS_CONTEXT_WINDOW, "PLURNK_PROVIDERS_CONTEXT_WINDOW", label);
};

// {§model-fact-resolution} — an operator value caps known natural model
// capacity and declares the envelope only when no natural value is known.
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number): number;
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number | null): number | null;
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number | null): number | null {
    return operatorCap === null
        ? naturalWindow
        : naturalWindow === null
            ? operatorCap
            : Math.min(operatorCap, naturalWindow);
}

// {§provider-generation-envelope} Generation has one total output budget. An
// optional reasoning budget is a subset, never an additive second reserve.
// Percentages are of the effective context window; absolutes remain useful for
// measured local deployments. Physical model limits always cap operator policy.
export type TokenBudgetSpec = { percent: number } | { tokens: number };

const parseTokenBudget = (raw: string | undefined, name: string, label: string): TokenBudgetSpec => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set (a percentage of the context window like "35%", or an absolute token count)`);
    const pct = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(raw);
    if (pct !== null) {
        const p = Number(pct[1]);
        if (!Number.isFinite(p) || p <= 0 || p >= 100) throw new Error(`${label} provider: ${name} percentage must be in (0, 100) (got "${raw}")`);
        return { percent: p / 100 };
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} provider: ${name} must be "<pct>%" or a positive integer token count (got "${raw}")`);
    return { tokens: n };
};

// Resolve a token budget against a known window: absolutes stand alone; a
// percentage needs the window (null when unknown — the underivable/no-cap case).
export const resolveTokenBudget = (spec: TokenBudgetSpec, window: number | null): number | null =>
    "tokens" in spec
        ? spec.tokens
        : window === null
            ? null
            : Math.max(1, Math.round(spec.percent * window));

export type GenerationEnvelope = {
    readonly outputBudget: number | null;
    readonly reasoningBudget: number | null;
};

const shedRetiredEnvelope = (env: NodeJS.ProcessEnv, label: string): void => {
    for (const name of ["PLURNK_PROVIDERS_REASONING_RESERVE", "PLURNK_PROVIDERS_COMPLETION_RESERVE"] as const) {
        if (env[name] !== undefined && env[name] !== "") {
            throw new Error(
                `${label} provider: ${name} is retired; reasoning is now a subset of the total generation envelope. Replace the old pair with PLURNK_PROVIDERS_OUTPUT_BUDGET and optional PLURNK_PROVIDERS_REASONING_BUDGET ({§provider-generation-envelope})`,
            );
        }
    }
};

const optionalTokenBudget = (
    raw: string | undefined,
    name: string,
    label: string,
): TokenBudgetSpec | null => raw === undefined || raw.length === 0
    ? null
    : parseTokenBudget(raw, name, label);

const resolveGeneration = (
    outputSpec: TokenBudgetSpec | null,
    reasoningSpec: TokenBudgetSpec | null,
    contextWindow: number | null,
    maxOutputTokens: number | null,
    label: string,
): GenerationEnvelope => {
    const requestedOutput = outputSpec === null ? null : resolveTokenBudget(outputSpec, contextWindow);
    const physicalCaps = [contextWindow, maxOutputTokens].filter((value): value is number => value !== null);
    const outputBudget = requestedOutput === null
        ? null
        : Math.min(requestedOutput, ...physicalCaps);
    if (contextWindow !== null && outputBudget !== null && outputBudget >= contextWindow) {
        throw new Error(
            `${label} provider: PLURNK_PROVIDERS_OUTPUT_BUDGET (${outputBudget}) must leave positive input capacity inside the context window (${contextWindow})`,
        );
    }
    const reasoningBudget = reasoningSpec === null
        ? null
        : resolveTokenBudget(reasoningSpec, contextWindow);
    if (reasoningBudget !== null && outputBudget === null) {
        throw new Error(
            `${label} provider: PLURNK_PROVIDERS_REASONING_BUDGET requires a resolved PLURNK_PROVIDERS_OUTPUT_BUDGET; reasoning is a subset of total output`,
        );
    }
    if (reasoningBudget !== null && outputBudget !== null && reasoningBudget >= outputBudget) {
        throw new Error(
            `${label} provider: PLURNK_PROVIDERS_REASONING_BUDGET (${reasoningBudget}) exceeds the effective PLURNK_PROVIDERS_OUTPUT_BUDGET (${outputBudget}); reasoning is a subset of total output`,
        );
    }
    return { outputBudget, reasoningBudget };
};

// Standard providers receive the shipped OUTPUT_BUDGET floor and fail hard if
// it is absent. Mock uses the tolerant sibling below so ordinary unit fixtures
// make no generation claim unless a test deliberately configures one.
export const generationEnvelopeFromEnv = (
    env: NodeJS.ProcessEnv,
    label: string,
    contextWindow: number | null,
    maxOutputTokens: number | null,
): GenerationEnvelope => {
    shedRetiredEnvelope(env, label);
    return resolveGeneration(
        parseTokenBudget(env.PLURNK_PROVIDERS_OUTPUT_BUDGET, "PLURNK_PROVIDERS_OUTPUT_BUDGET", label),
        optionalTokenBudget(env.PLURNK_PROVIDERS_REASONING_BUDGET, "PLURNK_PROVIDERS_REASONING_BUDGET", label),
        contextWindow,
        maxOutputTokens,
        label,
    );
};

export const resolveGenerationEnvelopeFromEnv = (
    env: NodeJS.ProcessEnv,
    contextWindow: number | null,
    maxOutputTokens: number | null = null,
): GenerationEnvelope => {
    shedRetiredEnvelope(env, "mock");
    return resolveGeneration(
        optionalTokenBudget(env.PLURNK_PROVIDERS_OUTPUT_BUDGET, "PLURNK_PROVIDERS_OUTPUT_BUDGET", "mock"),
        optionalTokenBudget(env.PLURNK_PROVIDERS_REASONING_BUDGET, "PLURNK_PROVIDERS_REASONING_BUDGET", "mock"),
        contextWindow,
        maxOutputTokens,
        "mock",
    );
};

// {§provider-configuration} The side-channel reasoning knobs — policy and budget
// are separate vars, so a numeric budget can never silently select an effort:
//   PLURNK_PROVIDERS_REASONING  off | adaptive | low | medium | high (REQUIRED, fail-hard)
//   PLURNK_PROVIDERS_REASONING_BUDGET  optional reasoning subset of the total
//     output budget, used for tier/budget mapping where the backend supports it.
// The provider maps intent to the backend's mechanism; the consumer states
// intent, never mechanism. PLAN is a separate public complete-Plan record.
export type Reasoning = { mode: ReasoningPolicy; budget: number | null };

export const parseReasoningPolicy = (value: unknown, label: string): ReasoningPolicy => {
    const result = Validator.validateReasoningPolicy(value);
    if (!result.valid) {
        throw new Error(`${label} must be one of ${REASONING_POLICIES.map((policy) => `"${policy}"`).join(", ")} (got "${String(value)}")`);
    }
    return value as ReasoningPolicy;
};

export type ReasoningResponseStyle = "verbatim" | "think-tags";

export const reasoningResponseStyleFromEnv = (
    env: NodeJS.ProcessEnv,
    label: string,
): ReasoningResponseStyle => {
    const name = "PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE";
    const raw = env[name];
    if (raw === undefined || raw.length === 0) return "verbatim";
    if (raw !== "verbatim" && raw !== "think-tags") {
        throw new Error(`${label} provider: ${name} must be "verbatim" or "think-tags" (got "${raw}")`);
    }
    return raw;
};

export const reasoningFromEnv = (
    env: NodeJS.ProcessEnv,
    label: string,
    resolvedBudget: number | null = null,
): Reasoning => {
    shedRenamed(env, "PLURNK_PROVIDERS_THINKING", "PLURNK_PROVIDERS_REASONING", label, "provider configuration contract"); // lexicon-allow
    shedRenamed(env, "PLURNK_PROVIDERS_THINKING_CAPACITY", "PLURNK_PROVIDERS_REASONING_BUDGET", label, "provider configuration contract"); // lexicon-allow
    const name = "PLURNK_PROVIDERS_REASONING";
    const raw = env[name];
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set (${REASONING_POLICIES.join(" | ")})`);
    const mode = parseReasoningPolicy(raw, `${label} provider: ${name}`);
    return { mode, budget: mode === "off" ? null : resolvedBudget };
};

// ── Per-alias knob scoping (per-alias scoping doctrine, user 2026-07-03): PLURNK_PROVIDERS_<KNOB>[_<alias>] ──
// Every plurnk-owned knob accepts a per-alias override — the suffixed form wins,
// the bare form is the fallback — so two aliases on one provider name (two boxes,
// two models) stop sharing one global setting. The knob list is CLOSED and parsed
// exact-prefix-first, so aliases containing underscores stay unambiguous. Vendor
// facts (API keys, canonical endpoints) remain vendor-named; the per-alias
// endpoint override stays PLURNK_BASEURL_<alias> (its existing precedent).
export const PROVIDERS_KNOBS = Object.freeze([
    "PLURNK_PROVIDERS_OUTPUT_BUDGET",
    "PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE",
    "PLURNK_PROVIDERS_REASONING_BUDGET",
    "PLURNK_PROVIDERS_REASONING",
    "PLURNK_PROVIDERS_CONTEXT_WINDOW",
    "PLURNK_PROVIDERS_RETRY_ATTEMPTS",
    "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT",
    "PLURNK_PROVIDERS_OPERATION_TIMEOUT",
    "PLURNK_PROVIDERS_FETCH_TIMEOUT",
    "PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT",
    "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT",
    "PLURNK_PROVIDERS_LLAMA_SERVER",
    "PLURNK_PROVIDERS_TEMPERATURE",
    "PLURNK_PROVIDERS_REPEAT_PENALTY",
    "PLURNK_PROVIDERS_FREQUENCY_PENALTY",
    "PLURNK_PROVIDERS_SERVICE_TIER",
    "PLURNK_PROVIDERS_CACHE_WRITE_POLICY",
    "PLURNK_PROVIDERS_CACHE_AFFINITY",
    "PLURNK_PROVIDERS_REPEAT_LAST_N",
    "PLURNK_PROVIDERS_DRY_MULTIPLIER",
    "PLURNK_PROVIDERS_DRY_BASE",
    "PLURNK_PROVIDERS_DRY_ALLOWED_LENGTH",
    "PLURNK_PROVIDERS_PROBE_ATTEMPTS",
    "PLURNK_PROVIDERS_PROBE_DELAY",
    "PLURNK_PROVIDERS_GBNF_DEBUG",
    "PLURNK_PROVIDERS_TOP_LOGPROBS",
    "PLURNK_PROVIDERS_RAWBODY",
]);

// Materialize an alias-scoped VIEW of env: for each known knob with a
// `_<alias>`-suffixed key (suffix case-folds to the alias, matching the
// PLURNK_MODEL_/PLURNK_BASEURL_ convention), overlay it onto the bare name.
// Provider construction keeps reading plain vars; scoping is the registry's
// single overlay.
//
// `knobs` (optional) lets a CONSUMER scope its OWN closed knob list with this
// same parser — e.g. service loop policy or prompt projection — without
// reimplementing the suffix/collision rules. Default stays the
// providers-family list; provider call sites pass nothing.
export const scopeEnvToAlias = (env: NodeJS.ProcessEnv, alias: string, knobs: readonly string[] = PROVIDERS_KNOBS): NodeJS.ProcessEnv => {
    const folded = alias.toLowerCase();
    const out: NodeJS.ProcessEnv = { ...env };
    for (const knob of knobs) {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined || value.length === 0) continue;
            if (!key.startsWith(knob + "_")) continue;
            // A bare knob can prefix another bare knob (_REASONING prefixes
            // _REASONING_BUDGET, _CONTEXT prefixes a hypothetical _CONTEXT_WINDOW): a key
            // that IS a known knob is never a suffixed override, whatever the
            // alias is named.
            if (knobs.includes(key)) continue;
            if (key.slice(knob.length + 1).toLowerCase() !== folded) continue;
            out[knob] = value;
            break;
        }
    }
    return out;
};
