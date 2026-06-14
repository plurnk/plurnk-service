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

export const parseRequiredFlag = (raw: string | undefined, name: string, label: string): boolean => {
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    if (raw !== "0" && raw !== "1") throw new Error(`${label} provider: ${name} must be "0" or "1" (got "${raw}")`);
    return raw === "1";
};

// The single side-channel reasoning gate (SPEC §4): does the model reason in a
// side channel at all? The provider picks the wire MECHANISM per backend —
// llama-server's `enable_thinking`, cloud `reasoning_effort`, relay
// `include_reasoning` — so the consumer states intent, never mechanism.
// REQUIRED — no in-code default; the operator's env is the single source of
// configuration truth. (In-DSL PLAN reasoning is a prompt/grammar concern, not
// a provider knob — it has no env var here.)
export const reasoningKnobsFromEnv = (env: NodeJS.ProcessEnv, label: string): { reasoningEnabled: boolean } => ({
    reasoningEnabled: parseRequiredFlag(env.PLURNK_PROVIDERS_REASONING, "PLURNK_PROVIDERS_REASONING", label),
});
