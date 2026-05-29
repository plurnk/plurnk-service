// Body-matcher adapter — delegates to @plurnk/plurnk-mimetypes for the
// actual dialect dispatch. The framework parses the matcher's leading
// prefix internally (xpath `//`, jsonpath `$`, regex `/.../`, glob
// otherwise) and routes to per-mimetype handlers. plurnk-service catches
// the framework's typed errors and maps them to HTTP-shaped status codes
// the model can act on.
//
// Status mapping (per plurnk-service#172 + plurnk-grammar#19):
//   UnsupportedDialectError  → 415  (dialect not supported for mimetype, or binary content)
//   InvalidExpressionError   → 400  (model authored a malformed matcher body)
//   QueryParseFailureError   → 203  (source can't be parsed for the dialect;
//                                    returns raw content as text/markdown with
//                                    `reason` so the model can fall back to
//                                    regex/visual parsing on the bytes)
//   Empty match array        → 204  (matcher applied, zero results)
//   Match array              → 200  (matcher applied, results in body)
//
// 203 is HTTP-creative ("Non-Authoritative Information") — the runtime
// produced content but not in the structured form the matcher requested.
// Model sees the raw text plus a reason field and decides whether to
// retry, fall back, or fix source. Choice ratified by user (#172).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch } from "@plurnk/plurnk-mimetypes";
import {
    UnsupportedDialectError,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import { TEXT_PRIMITIVE_MIMETYPE } from "./mimetype-binary.ts";

export interface MatchResult {
    status: number;
    body?: string;          // JSON-array of matches (status 200) or raw fallback content (status 203)
    matches?: number;       // hit count (status 200 or 204); omitted on 203
    error?: string;         // status >= 400 paths
    mimetype?: string;      // overrides default application/json on the 203 fallback path
    reason?: string;        // 203 fallback: framework's parse-failure reason for the model
}

const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2);

// Apply a `<L>`-slice baseLine offset to per-match line numbers. The
// framework returns line numbers relative to the content it received;
// when the matcher runs inside an `<L>` slice, those need to be shifted
// back to original-source coordinates.
const shiftLines = (matches: readonly QueryMatch[], baseLine: number): QueryMatch[] => {
    if (baseLine === 1) return [...matches];
    const offset = baseLine - 1;
    return matches.map((m) => ({ ...m, line: m.line + offset }));
};

export const matchAgainstContent = async (
    body: MatcherBody,
    content: string,
    mimetype: string,
    mimetypes: Mimetypes,
    baseLine: number = 1,
): Promise<MatchResult> => {
    try {
        // Framework dispatches dialect by leading prefix of `body.raw`.
        // `hint` carries the source mimetype so the framework selects the
        // right per-mimetype handler without re-detecting from content.
        const rawMatches: QueryMatch[] = await mimetypes.query(
            { content, hint: mimetype },
            body.raw,
        );
        if (rawMatches.length === 0) {
            return { status: 204, matches: 0 };
        }
        const adjusted = shiftLines(rawMatches, baseLine);
        return {
            status: 200,
            body: prettyJson(adjusted),
            matches: adjusted.length,
        };
    } catch (err) {
        if (err instanceof UnsupportedDialectError) {
            return { status: 415, error: err.message };
        }
        if (err instanceof InvalidExpressionError) {
            return { status: 400, error: err.message };
        }
        if (err instanceof QueryParseFailureError) {
            // 203 soft fallback: return raw content as text so the model
            // can fall back to regex/visual parsing or fix the source.
            return {
                status: 203,
                body: content,
                mimetype: TEXT_PRIMITIVE_MIMETYPE,
                reason: err.message,
            };
        }
        // Unexpected — let it propagate so the engine logs it as a 500.
        throw err;
    }
};
