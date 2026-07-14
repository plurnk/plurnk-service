// Env-parsing helpers shared by every provider's fromEnv factory. Each was
// copy-pasted per sibling with only the error-message prefix differing; the
// `label` parameter (the provider name) restores that prefix from one source.

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

export const requireEnv = (raw: string | undefined, name: string, label: string): string => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    return raw;
};

// Data-capture knobs (#36), read identically by every provider (standard AND
// daughter) so the opt-in surface is one source of truth. Both OFF by default —
// the flag is the isolation, so serving turns request and carry nothing.
//   PLURNK_PROVIDERS_LOGPROB   non-negative int = top_logprobs (set → request
//     per-token logprobs; unset → off). Per-alias-scopable.
//   PLURNK_PROVIDERS_RAWBODY   truthy (not ""/"0") → attach the verbatim wire
//     body to response.rawBody. Per-alias-scopable.
export const dataCaptureFromEnv = (env: NodeJS.ProcessEnv, label: string): { logprobs: number | null; rawBody: boolean } => ({
    logprobs: parseOptionalInt(env.PLURNK_PROVIDERS_LOGPROB, "PLURNK_PROVIDERS_LOGPROB", label),
    rawBody: env.PLURNK_PROVIDERS_RAWBODY !== undefined && env.PLURNK_PROVIDERS_RAWBODY !== "" && env.PLURNK_PROVIDERS_RAWBODY !== "0",
});

// The side-channel reasoning knobs (SPEC §4, #32/#33) — ACTIVATION and BUDGET
// are separate vars, so a numeric budget can never silently flip wire flags:
//   PLURNK_PROVIDERS_REASONING           off | adaptive | on   (REQUIRED, fail-hard)
//   PLURNK_PROVIDERS_REASONING_BUDGET  positive int, REQUIRED iff REASONING=on —
//     the magnitude for tier/budget mapping. On llama.cpp the ENFORCEMENT is the
//     box's --reasoning-budget launch flag (per-request numerics are ignored):
//     env budget and launch flag are the same number, changed together.
// The provider maps intent to the backend's mechanism; the consumer states
// intent, never mechanism. (In-DSL PLAN reasoning is a grammar concern.)
export type ReasoningMode = "off" | "adaptive" | "on";
export type Reasoning = { mode: ReasoningMode; budget: number | null };

export const reasoningFromEnv = (env: NodeJS.ProcessEnv, label: string): Reasoning => {
    // Old-name shed (#399, industry-standard ruling): the family word is
    // REASONING — the wire standard we actually speak. A still-set old name
    // fails hard with the pointer, never silently coexists with the new floor.
    if (env.PLURNK_PROVIDERS_THINKING !== undefined && env.PLURNK_PROVIDERS_THINKING.length > 0) {
        throw new Error(`${label} provider: PLURNK_PROVIDERS_THINKING was renamed to PLURNK_PROVIDERS_REASONING (#399); update the env`);
    }
    if (env.PLURNK_PROVIDERS_THINKING_CAPACITY !== undefined && env.PLURNK_PROVIDERS_THINKING_CAPACITY.length > 0) {
        throw new Error(`${label} provider: PLURNK_PROVIDERS_THINKING_CAPACITY was renamed to PLURNK_PROVIDERS_REASONING_BUDGET (#399); update the env`);
    }
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
    "PLURNK_PROVIDERS_REASONING_BUDGET",
    "PLURNK_PROVIDERS_REASONING",
    "PLURNK_PROVIDERS_CONTEXT_SIZE",
    "PLURNK_PROVIDERS_RETRY_ATTEMPTS",
    "PLURNK_PROVIDERS_FETCH_TIMEOUT",
    "PLURNK_PROVIDERS_LLAMA_SERVER",
    "PLURNK_PROVIDERS_TEMPERATURE",
    "PLURNK_PROVIDERS_REPEAT_PENALTY",
    "PLURNK_PROVIDERS_FREQUENCY_PENALTY",
    "PLURNK_PROVIDERS_RETRY_DELAY",
    "PLURNK_PROVIDERS_PROBE_ATTEMPTS",
    "PLURNK_PROVIDERS_PROBE_DELAY",
    "PLURNK_PROVIDERS_GBNF_DEBUG",
    "PLURNK_PROVIDERS_LOGPROB",
    "PLURNK_PROVIDERS_RAWBODY",
]);

// Materialize an alias-scoped VIEW of env: for each known knob with a
// `_<alias>`-suffixed key (suffix case-folds to the alias, matching the
// PLURNK_MODEL_/PLURNK_BASEURL_ convention), overlay it onto the bare name.
// Providers keep reading plain vars — scoping is entirely the caller's overlay,
// so fromEnv implementations (and daughters) need zero changes.
//
// `knobs` (optional) lets a CONSUMER scope its OWN closed knob list with this
// same parser — e.g. the service's window-partition vars (PLURNK_SERVICE_CTX/
// REASONING/ASSISTANT/SAFETY), so a 64k cloud envelope and a 12k gemma envelope
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
            // _REASONING_BUDGET, _CTX prefixes a hypothetical _CTX_SIZE): a key
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
