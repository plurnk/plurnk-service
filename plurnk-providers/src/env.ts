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

// The side-channel reasoning knobs (SPEC §4, #32/#33) — ACTIVATION and CAPACITY
// are separate vars, so a numeric budget can never silently flip wire flags:
//   PLURNK_PROVIDERS_THINKING           off | adaptive | on   (REQUIRED, fail-hard)
//   PLURNK_PROVIDERS_THINKING_CAPACITY  positive int, REQUIRED iff THINKING=on —
//     the magnitude for tier/budget mapping. On llama.cpp the ENFORCEMENT is the
//     box's --reasoning-budget launch flag (per-request numerics are ignored):
//     env capacity and launch flag are the same number, changed together.
// The provider maps intent to the backend's mechanism; the consumer states
// intent, never mechanism. (In-DSL PLAN reasoning is a grammar concern.)
export type ThinkingMode = "off" | "adaptive" | "on";
export type Thinking = { mode: ThinkingMode; capacity: number | null };

export const thinkingFromEnv = (env: NodeJS.ProcessEnv, label: string): Thinking => {
    const name = "PLURNK_PROVIDERS_THINKING";
    const raw = env[name];
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set (off | adaptive | on)`);
    if (raw !== "off" && raw !== "adaptive" && raw !== "on") throw new Error(`${label} provider: ${name} must be one of "off", "adaptive", "on" (got "${raw}")`);
    if (raw !== "on") return { mode: raw, capacity: null };
    const capName = "PLURNK_PROVIDERS_THINKING_CAPACITY";
    const capRaw = env[capName];
    if (capRaw === undefined || capRaw.length === 0) throw new Error(`${label} provider: ${capName} must be set when ${name}=on`);
    const n = Number(capRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} provider: ${capName} must be a positive integer (got "${capRaw}")`);
    return { mode: "on", capacity: n };
};

// ── Per-alias knob scoping (#35-doctrine): PLURNK_PROVIDERS_<KNOB>[_<alias>] ──
// Every plurnk-owned knob accepts a per-alias override — the suffixed form wins,
// the bare form is the fallback — so two aliases on one provider name (two boxes,
// two models) stop sharing one global setting. The knob list is CLOSED and parsed
// exact-prefix-first, so aliases containing underscores stay unambiguous. Vendor
// facts (API keys, canonical endpoints) remain vendor-named; the per-alias
// endpoint override stays PLURNK_BASEURL_<alias> (its existing precedent).
const PROVIDERS_KNOBS = Object.freeze([
    "PLURNK_PROVIDERS_THINKING_CAPACITY",
    "PLURNK_PROVIDERS_THINKING",
    "PLURNK_PROVIDERS_CONTEXT_SIZE",
    "PLURNK_PROVIDERS_RETRY_ATTEMPTS",
    "PLURNK_PROVIDERS_FETCH_TIMEOUT",
    "PLURNK_PROVIDERS_LLAMA_SERVER",
    "PLURNK_PROVIDERS_GRAMMAR_TEMPERATURE",
    "PLURNK_PROVIDERS_GRAMMAR_REPEAT_PENALTY",
    "PLURNK_PROVIDERS_GBNF_DEBUG",
]);

// Materialize an alias-scoped VIEW of env: for each known knob with a
// `_<alias>`-suffixed key (suffix case-folds to the alias, matching the
// PLURNK_MODEL_/PLURNK_BASEURL_ convention), overlay it onto the bare name.
// Providers keep reading plain vars — scoping is entirely the caller's overlay,
// so fromEnv implementations (and daughters) need zero changes.
export const scopeEnvToAlias = (env: NodeJS.ProcessEnv, alias: string): NodeJS.ProcessEnv => {
    const folded = alias.toLowerCase();
    const out: NodeJS.ProcessEnv = { ...env };
    for (const knob of PROVIDERS_KNOBS) {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined || value.length === 0) continue;
            if (!key.startsWith(knob + "_")) continue;
            // A bare knob can prefix another bare knob (_THINKING prefixes
            // _THINKING_CAPACITY): a key that IS a known knob is never a
            // suffixed override, whatever the alias is named.
            if ((PROVIDERS_KNOBS as readonly string[]).includes(key)) continue;
            if (key.slice(knob.length + 1).toLowerCase() !== folded) continue;
            out[knob] = value;
            break;
        }
    }
    return out;
};
