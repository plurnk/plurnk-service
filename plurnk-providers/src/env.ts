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
