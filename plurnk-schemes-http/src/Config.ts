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
