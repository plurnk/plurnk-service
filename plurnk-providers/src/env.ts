// Env-parsing helpers shared by provider construction. `label` keeps failures
// local to the selected provider.

export const parseRequiredInt = (raw: string | undefined, name: string, label: string): number => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} provider: ${name} must be a non-negative integer (got "${raw}")`);
    return n;
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

export const promptCacheKeyFromEnv = (env: NodeJS.ProcessEnv, label: string): boolean => {
    const name = "PLURNK_PROVIDERS_PROMPT_CACHE_KEY";
    const value = env[name];
    if (value !== "0" && value !== "1") {
        throw new Error(`${label} provider: ${name} must be "0" or "1"`);
    }
    return value === "1";
};

// {§provider-configuration} A still-set retired knob fails
// hard pointing at its successor — never silently coexists with the new floor.
// The retired names appear ONLY as this function's ARGUMENTS at the call sites
// (each lexicon-allow), never as a live identifier.
const shedRenamed = (env: NodeJS.ProcessEnv, oldName: string, newName: string, label: string, ref: string): void => {
    const stale = env[oldName];
    if (stale !== undefined && stale.length > 0) throw new Error(`${label} provider: ${oldName} was renamed to ${newName} (${ref}); update the env`);
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

// {§model-fact-resolution} — an operator value caps known model physics and
// declares the window only when no natural value is known.
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number): number;
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number | null): number | null;
export function effectiveContextWindow(operatorCap: number | null, naturalWindow: number | null): number | null {
    return operatorCap === null
        ? naturalWindow
        : naturalWindow === null
            ? operatorCap
            : Math.min(operatorCap, naturalWindow);
}

export type ProviderTokenRates = { input: number; cached: number; output: number };

// {§model-fact-resolution} — any explicit rate opts into one complete operator
// estimate; cached input alone may default to the explicit input rate.
export const tokenRatesFromEnv = (env: NodeJS.ProcessEnv, label: string): ProviderTokenRates | null => {
    const inputName = "PLURNK_PROVIDERS_INPUT_USD_PER_MILLION";
    const cachedName = "PLURNK_PROVIDERS_CACHE_READ_USD_PER_MILLION";
    const outputName = "PLURNK_PROVIDERS_OUTPUT_USD_PER_MILLION";
    const configured = [inputName, cachedName, outputName]
        .some((name) => env[name] !== undefined && env[name] !== "");
    if (!configured) return null;
    const input = parseRequiredFloat(env[inputName], inputName, label, 0);
    return {
        input,
        cached: env[cachedName] === undefined || env[cachedName] === ""
            ? input
            : parseRequiredFloat(env[cachedName], cachedName, label, 0),
        output: parseRequiredFloat(env[outputName], outputName, label, 0),
    };
};

// {§provider-generation-envelope} How much of a
// DETECTED context window is reserved for reasoning and for completion — the
// remainder (minus the consumer's own packing-safety margin) is the prompt
// budget. Provider-owned: the window is a provider fact and these are amounts OF
// it. Each knob accepts a percentage of the window
// ("10%") or an absolute token count ("4096"); the floor ships percentages so
// every window-advertising endpoint (llama-server n_ctx, the plurnk.ai router,
// a cataloged cloud model) arrives at sane defaults with ZERO operator tuning.
// Per-alias suffixes override for measured envelopes; absolutes win over the
// window derivation entirely.
export type ReserveSpec = { percent: number } | { tokens: number };

const parseReserve = (raw: string | undefined, name: string, label: string): ReserveSpec => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set (a percentage of the window like "10%", or an absolute token count)`);
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

export const envelopeFromEnv = (env: NodeJS.ProcessEnv, label: string): { reasoningReserve: ReserveSpec; completionReserve: ReserveSpec } => ({
    reasoningReserve: parseReserve(env.PLURNK_PROVIDERS_REASONING_RESERVE, "PLURNK_PROVIDERS_REASONING_RESERVE", label),
    completionReserve: parseReserve(env.PLURNK_PROVIDERS_COMPLETION_RESERVE, "PLURNK_PROVIDERS_COMPLETION_RESERVE", label),
});

// Resolve a ReserveSpec against a known window: absolutes stand alone; a
// percentage needs the window (null when unknown — the underivable/no-cap case).
export const resolveReserve = (spec: ReserveSpec, window: number | null): number | null =>
    "tokens" in spec ? spec.tokens : window === null ? null : Math.round(spec.percent * window);

// TOLERANT envelope read for fixtures + consumers that resolve reserves against
// a known window and treat ABSENCE as "no claim" (null), never fail-hard —
// unlike envelopeFromEnv (the REQUIRED provider path, fed by the shipped floor).
// Mock uses this so the service's partition/budget suite drives the SAME
// env→reserve resolution a real provider does, without the floor. An invalid
// value still throws (a malformed reserve is an error, not an absence).
export const resolveEnvelopeFromEnv = (env: NodeJS.ProcessEnv, window: number | null): { reasoningReserve: number | null; completionReserve: number | null } => {
    const one = (raw: string | undefined, name: string): number | null =>
        raw === undefined || raw.length === 0 ? null : resolveReserve(parseReserve(raw, name, "mock"), window);
    return {
        reasoningReserve: one(env.PLURNK_PROVIDERS_REASONING_RESERVE, "PLURNK_PROVIDERS_REASONING_RESERVE"),
        completionReserve: one(env.PLURNK_PROVIDERS_COMPLETION_RESERVE, "PLURNK_PROVIDERS_COMPLETION_RESERVE"),
    };
};

// {§provider-configuration} The side-channel reasoning knobs — activation and budget
// are separate vars, so a numeric budget can never silently flip wire flags:
//   PLURNK_PROVIDERS_REASONING           off | adaptive | on   (REQUIRED, fail-hard)
//   PLURNK_PROVIDERS_REASONING_BUDGET  positive int, REQUIRED iff REASONING=on —
//     the magnitude for tier/budget mapping. On llama-server it is the explicit
//     request-scoped allowance and cannot exceed the physical reasoning reserve.
// The provider maps intent to the backend's mechanism; the consumer states
// intent, never mechanism. PLAN is a separate public intended-goals record.
export type ReasoningMode = "off" | "adaptive" | "on";
export type Reasoning = { mode: ReasoningMode; budget: number | null };

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

export const reasoningFromEnv = (env: NodeJS.ProcessEnv, label: string): Reasoning => {
    shedRenamed(env, "PLURNK_PROVIDERS_THINKING", "PLURNK_PROVIDERS_REASONING", label, "provider configuration contract"); // lexicon-allow
    shedRenamed(env, "PLURNK_PROVIDERS_THINKING_CAPACITY", "PLURNK_PROVIDERS_REASONING_BUDGET", label, "provider configuration contract"); // lexicon-allow
    const name = "PLURNK_PROVIDERS_REASONING";
    const raw = env[name];
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set (off | adaptive | on)`);
    if (raw !== "off" && raw !== "adaptive" && raw !== "on") throw new Error(`${label} provider: ${name} must be one of "off", "adaptive", "on" (got "${raw}")`);
    if (raw !== "on") return { mode: raw, budget: null };
    const capName = "PLURNK_PROVIDERS_REASONING_BUDGET";
    const capRaw = env[capName];
    if (capRaw === undefined || capRaw.length === 0) throw new Error(`${label} provider: ${capName} must be set when ${name}=on`);
    const n = Number(capRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} provider: ${capName} must be a positive integer (got "${capRaw}")`);
    return { mode: "on", budget: n };
};

// ── Per-alias knob scoping (per-alias scoping doctrine, user 2026-07-03): PLURNK_PROVIDERS_<KNOB>[_<alias>] ──
// Every plurnk-owned knob accepts a per-alias override — the suffixed form wins,
// the bare form is the fallback — so two aliases on one provider name (two boxes,
// two models) stop sharing one global setting. The knob list is CLOSED and parsed
// exact-prefix-first, so aliases containing underscores stay unambiguous. Vendor
// facts (API keys, canonical endpoints) remain vendor-named; the per-alias
// endpoint override stays PLURNK_BASEURL_<alias> (its existing precedent).
export const PROVIDERS_KNOBS = Object.freeze([
    "PLURNK_PROVIDERS_REASONING_RESERVE",
    "PLURNK_PROVIDERS_COMPLETION_RESERVE",
    "PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE",
    "PLURNK_PROVIDERS_REASONING_BUDGET",
    "PLURNK_PROVIDERS_REASONING",
    "PLURNK_PROVIDERS_CONTEXT_WINDOW",
    "PLURNK_PROVIDERS_INPUT_USD_PER_MILLION",
    "PLURNK_PROVIDERS_CACHE_READ_USD_PER_MILLION",
    "PLURNK_PROVIDERS_OUTPUT_USD_PER_MILLION",
    "PLURNK_PROVIDERS_RETRY_ATTEMPTS",
    "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT",
    "PLURNK_PROVIDERS_FETCH_TIMEOUT",
    "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT",
    "PLURNK_PROVIDERS_LLAMA_SERVER",
    "PLURNK_PROVIDERS_TEMPERATURE",
    "PLURNK_PROVIDERS_REPEAT_PENALTY",
    "PLURNK_PROVIDERS_FREQUENCY_PENALTY",
    "PLURNK_PROVIDERS_SERVICE_TIER",
    "PLURNK_PROVIDERS_PROMPT_CACHE_KEY",
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
// same parser — e.g. the service's window-partition vars (PLURNK_SERVICE_CONTEXT_WINDOW/
// MAX_TURNS/...), so a 64k cloud envelope and a 12k gemma envelope
// coexist per-alias without the service reimplementing the suffix/collision
// rules. Default stays the providers-family list; my call sites pass nothing.
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
