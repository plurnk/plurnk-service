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

// The single side-channel reasoning knob (SPEC §4): one integer carries the
// whole {off, adaptive, capped} space, so no separate on/off gate is needed.
//   0   → native side-channel reasoning OFF.
//   -1  → ON, adaptive (no cap — the model/backend decides depth).
//   N>0 → ON, capped at N (→ effort tier for cloud, budget_tokens for Anthropic).
// The provider maps this one intent to the backend's mechanism (llama-server
// `enable_thinking`, cloud `reasoning_effort`, relay `include_reasoning`) — the
// consumer states intent, never mechanism. REQUIRED, no in-code default. (In-DSL
// PLAN reasoning is a prompt/grammar concern, not a provider knob.)
export const reasoningBudgetFromEnv = (env: NodeJS.ProcessEnv, label: string): number => {
    const name = "PLURNK_PROVIDERS_REASONING_BUDGET";
    const raw = env[name];
    if (raw === undefined || raw.length === 0) throw new Error(`${label} provider: ${name} must be set`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < -1) throw new Error(`${label} provider: ${name} must be an integer >= -1 (0 off, -1 adaptive, N capped) (got "${raw}")`);
    return n;
};
