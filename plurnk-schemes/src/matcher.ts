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
    body?: string;          // N:\t<value> lines (status 200) or raw fallback content (status 203)
    matches?: number;       // hit count (status 200 or 204); omitted on 203
    error?: string;         // status >= 400 paths (framework dialect errors; not a scheme TelemetryEvent)
    mimetype?: string;      // overrides default text/markdown on the 203 fallback path
    reason?: string;        // 203 fallback: framework's parse-failure reason for the model
}

export default class Matcher {
    // Render one match's value for the model-facing line. Bare for a single-
    // line string; JSON-encoded otherwise so the one-match-per-line invariant
    // holds (a multi-line value would otherwise break the `<L><K>` pick-Kth
    // composition that matcher-then-slice depends on).
    static #renderValue(value: unknown): string {
        return typeof value === "string" && !value.includes("\n") ? value : JSON.stringify(value);
    }

    // Render matches as the model-facing line-numbered form `<source-line>:\t<value>`,
    // one match per line — the same `N:\t` convention READ emits. The structured
    // `{matched, matching}` wrapper was a legibility barrier (schemes#12: a gemma
    // demo couldn't see `Alice` inside it and re-emitted the READ five times).
    // `matching` (the resolved query path) is dropped from the rendering; the
    // grammar `QueryMatch` keeps it, we just don't surface it.
    //
    // The hit's source footprint is `lines[]` (mimetypes #41: a span list, since
    // a structural hit can cover several source lines). We anchor on the first
    // span's start line. A footprint-less match — an xpath computed scalar
    // (count()/string()/sum()/…) that lives nowhere in the source — renders BARE
    // (no `N:\t`); the framework never fakes a line for it, and neither do we.
    static #renderMatches(matches: readonly QueryMatch[]): string {
        return matches.map((m) => {
            const value = Matcher.#renderValue(m.matched);
            const anchor = m.lines?.[0]?.line;
            return anchor === undefined ? value : `${anchor}:\t${value}`;
        }).join("\n");
    }

    // Apply a `<L>`-slice baseLine offset to per-match line footprints. The
    // framework returns lines relative to the content it received; when the
    // matcher runs inside an `<L>` slice, every span shifts back to
    // original-source coordinates. A footprint-less match has nothing to shift.
    static #shiftLines(matches: readonly QueryMatch[], baseLine: number): QueryMatch[] {
        if (baseLine === 1) return [...matches];
        const offset = baseLine - 1;
        return matches.map((m) => m.lines === undefined ? m : {
            ...m,
            lines: m.lines.map((s) => ({ line: s.line + offset, endLine: s.endLine + offset })),
        });
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
        baseLine: number = 1,
    ): Promise<MatchResult> {
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
            const adjusted = Matcher.#shiftLines(rawMatches, baseLine);
            return {
                status: 200,
                body: Matcher.#renderMatches(adjusted),
                matches: adjusted.length,
            };
        } catch (err) {
            // Name-based dispatch tolerates dup-copy node_modules layouts where
            // `instanceof` against the framework's exported classes can fail
            // because the consumer loads a different physical copy. The framework
            // sets each error subclass's `.name` to its class name.
            const name = err instanceof Error ? err.name : "";
            if (name === "UnsupportedDialectError" || err instanceof UnsupportedDialectError) {
                return { status: 415, error: err instanceof Error ? err.message : String(err) };
            }
            if (name === "InvalidExpressionError" || err instanceof InvalidExpressionError) {
                return { status: 400, error: err instanceof Error ? err.message : String(err) };
            }
            if (name === "QueryParseFailureError" || err instanceof QueryParseFailureError) {
                // 203 soft fallback: return raw content as text so the model
                // can fall back to regex/visual parsing or fix the source.
                return {
                    status: 203,
                    body: content,
                    mimetype: TEXT_PRIMITIVE_MIMETYPE,
                    reason: err instanceof Error ? err.message : String(err),
                };
            }
            // Unexpected — let it propagate so the engine logs it as a 500.
            throw err;
        }
    }
}
