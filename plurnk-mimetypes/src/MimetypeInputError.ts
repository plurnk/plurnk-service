function describeCause(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

// Expected rejection of the exact supplied content. Producers use this only
// for source validity; implementation, loading, and operational defects retain
// their original error identities ({§mimetype-error-policy}).
export default class MimetypeInputError extends Error {
    readonly mimetype: string;

    constructor(args: { mimetype: string; cause: unknown; reason?: string }) {
        super(
            `Invalid content for ${args.mimetype}: ${args.reason ?? describeCause(args.cause)}`,
            { cause: args.cause },
        );
        this.name = "MimetypeInputError";
        this.mimetype = args.mimetype;
    }
}

// Structural detection survives independently installed handler copies.
export function isMimetypeInputError(error: unknown): error is MimetypeInputError {
    if (error instanceof MimetypeInputError) return true;
    if (typeof error !== "object" || error === null) return false;
    const name = (error as { name?: unknown }).name;
    return name === "MimetypeInputError" || name === "QueryParseFailureError";
}
