// {§operator-config-only-home} — the panel states the value; an unset key is a broken floor.
export const requireTextEnv = (key: string): string => {
    const raw = process.env[key];
    if (raw === undefined || raw.trim().length === 0) {
        throw new Error(`${key} is unset.`);
    }
    return raw;
};

// The house switch: exactly 0 or 1.
export const requireFlagEnv = (key: string): boolean => {
    const raw = process.env[key];
    if (raw !== "0" && raw !== "1") throw new Error(`${key} must be 0 or 1; got ${JSON.stringify(raw)}.`);
    return raw === "1";
};

export const requireNonNegativeIntegerEnv = (key: string): number => {
    const raw = process.env[key];
    if (raw === undefined || raw.trim().length === 0) {
        throw new Error(`${key} is unset.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${key} must be a non-negative integer.`);
    }
    return value;
};

export const requirePositiveIntegerEnv = (key: string): number => {
    const value = requireNonNegativeIntegerEnv(key);
    if (value === 0) throw new Error(`${key} must be a positive integer.`);
    return value;
};
