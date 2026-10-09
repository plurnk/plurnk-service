// {§scheme-metadata-modifier} The heading's `[metadata]` block, read with its
// brackets, is one JSON array. Object options merge left to right with later
// keys winning. The language keeps the inner text opaque; this is the one
// reader every owner uses before interpreting its elements,
// so malformed content fails the same way everywhere: the owner's 400.
import Results, { type SchemeResult } from "./Results.ts";

export type MetadataOptionsParsed =
    // The service's reserved keys ({§service-metadata-keys}): withheld from `options` so no owner
    // interprets them, surfaced raw for the service, which owns their shapes.
    | { readonly options: Readonly<Record<string, unknown>>; readonly env?: unknown; readonly lifetime?: unknown }
    | { readonly failure: SchemeResult };

export default class MetadataOptions {
    // {§service-metadata-keys} — the keys every owner's `options` is stripped of.
    static readonly SERVICE_KEYS = Object.freeze(["env", "lifetime"] as const);

    // `source` names the owner in the Problem (`executor:metadata`, `http`, …).
    static read(blocks: readonly string[] | null | undefined, source: string, extra: Record<string, unknown> = {}): { elements: unknown[] } | { failure: SchemeResult } {
        const fail = (code: string, detail: string): { failure: SchemeResult } => ({
            failure: Results.failure(source, code, 400, detail, {}, { ...extra, retryable: false }),
        });
        const list = blocks ?? [];
        if (list.length === 0) return { elements: [] };
        if (list.length > 1) return fail("metadata-repeated", "One [metadata] block per operand; merge the options into one JSON array.");
        let parsed: unknown;
        try {
            parsed = JSON.parse(`[${list[0]}]`);
        } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            // Never echo the parser message: V8 quotes the input, and metadata may hold credentials.
            return fail("metadata-invalid", "[metadata] must be a JSON array.");
        }
        return { elements: parsed as unknown[] };
    }

    static parse(blocks: readonly string[] | null | undefined, source: string, extra: Record<string, unknown> = {}): MetadataOptionsParsed {
        const read = MetadataOptions.read(blocks, source, extra);
        if ("failure" in read) return read;
        const options: Record<string, unknown> = {};
        for (const element of read.elements) {
            if (typeof element !== "object" || element === null || Array.isArray(element)) {
                return { failure: Results.failure(source, "metadata-invalid", 400,
                    "[metadata] must be a JSON array of option objects; every element is an object.", {}, { ...extra, retryable: false }) };
            }
            Object.assign(options, element);
        }
        // {§matcher-option} — `pattern` is the language's key: the parser lifts it into the
        // statement's matcher and leaves the block for its owner, who never interprets it.
        delete options.pattern;
        const reserved: { env?: unknown; lifetime?: unknown } = {};
        for (const key of MetadataOptions.SERVICE_KEYS) {
            if (!(key in options)) continue;
            reserved[key] = options[key];
            delete options[key];
        }
        return { options, ...reserved };
    }
}
