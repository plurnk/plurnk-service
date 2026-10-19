// {§wire-entrypoint} Guards over a JSON value crossing a boundary: what a parsed document, a stored column or a
// caller's `unknown` is proved to be before a field is read from it. A guard narrows; no `as` stands in for one.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
