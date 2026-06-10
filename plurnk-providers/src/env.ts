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
