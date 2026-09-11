// {§scheme-metadata-modifier} The heading's `[metadata]` block, read with its
// brackets, is one JSON array of option objects merged left to right with later
// keys winning. The language keeps the inner text opaque; this is the one
// reader every owner (scheme or executor) uses before interpreting its keys,
// so malformed content fails the same way everywhere: the owner's 400.
import Results, { type SchemeResult } from "./Results.ts";

export type MetadataOptionsParsed =
    | { readonly options: Readonly<Record<string, unknown>> }
    | { readonly failure: SchemeResult };

export default class MetadataOptions {
    // `source` names the owner in the Problem (`executor:metadata`, `http`, …).
    static parse(blocks: readonly string[] | null | undefined, source: string, extra: Record<string, unknown> = {}): MetadataOptionsParsed {
        const fail = (code: string, detail: string): MetadataOptionsParsed => ({
            failure: Results.failure(source, code, 400, detail, {}, { ...extra, retryable: false }),
        });
        const list = blocks ?? [];
        if (list.length === 0) return { options: {} };
        if (list.length > 1) return fail("metadata-repeated", "One [metadata] block per operand; merge the options into one JSON array.");
        let parsed: unknown;
        try {
            parsed = JSON.parse(`[${list[0]}]`);
        } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            // Never echo the parser message: V8 quotes the input, and metadata may hold credentials.
            return fail("metadata-invalid", "[metadata] must be a JSON array of option objects.");
        }
        const options: Record<string, unknown> = {};
        for (const element of parsed as unknown[]) {
            if (typeof element !== "object" || element === null || Array.isArray(element)) {
                return fail("metadata-invalid", "[metadata] must be a JSON array of option objects; every element is an object.");
            }
            Object.assign(options, element);
        }
        return { options };
    }
}
