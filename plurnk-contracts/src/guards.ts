// {§text-region} Guards over a JSON value crossing a boundary: what a parsed document, a stored column or a
// caller's `unknown` is proved to be before a field is read from it. A guard narrows; no `as` stands in for one.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

// The code a thrown system error carries (`ENOENT`, `ABORT_ERR`): read from any object naming one, undefined for anything
// else. Node's `ErrnoException` is this shape; the guard needs no Node type to say so.
export const errnoCode = (cause: unknown): string | undefined =>
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
