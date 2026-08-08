// {§matcher-dispatch} Body-matcher operation adapter. Mimetypes owns handler
// resolution, dialect execution, and evidence; this layer maps its typed
// outcomes to the universal scheme-result contract. PLURNK callers pass the
// grammar's parsed dialect, while standalone raw strings retain framework
// classification.
//
// Status 203 preserves readable content when its requested structural
// projection cannot be parsed; the owning mapping lives in {§matcher-dispatch}.

import type { MatcherBody } from "@plurnk/plurnk-contracts";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import {
    UnsupportedDialectError,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import { TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";
import Results, { type MatchEvidence, type SchemeResult } from "./Results.ts";

export interface MatchResult extends SchemeResult {
    body?: string;                         // raw fallback content (status 203)
    matches?: ReadonlyArray<MatchEvidence>;  // addressable evidence (status 200 or 204)
    mimetype?: string;                    // overrides default text/markdown on the 203 fallback path
    reason?: string;                      // 203 fallback: framework's parse-failure reason for the model
}

export default class Matcher {
    static #evidence(matches: readonly QueryMatch[]): MatchEvidence[] {
        const evidence: MatchEvidence[] = [];
        const seen = new Set<string>();
        for (const match of matches) {
            const regions = match.regions ?? [];
            if (regions.length === 0 && match.matching !== undefined) {
                const item = Results.assertMatchEvidence({ locator: match.matching });
                const key = JSON.stringify(item);
                if (!seen.has(key)) {
                    seen.add(key);
                    evidence.push(item);
                }
                continue;
            }
            for (const region of regions) {
                const item = Results.assertMatchEvidence({
                    ...(match.matching === undefined ? {} : { locator: match.matching }),
                    region,
                });
                const key = JSON.stringify(item);
                if (seen.has(key)) continue;
                seen.add(key);
                evidence.push(item);
            }
        }
        return evidence;
    }

    // {§matcher-dispatch} Hand the framework the ALREADY-PARSED matcher, not the raw
    // string — the grammar owns the matcher syntax, so re-classifying `raw`
    // inside mimetypes is a second parser for one syntax and a silent drift
    // surface (a body the grammar parsed as regex that re-classifies as xpath:
    // `#//foo#`). The declared dialect is authoritative; mimetypes dispatches it
    // verbatim. Only the four query dialects map; `semantic`/`graph` aren't
    // QueryDialects in mimetypes, so we pass `raw` and let it surface the same
    // UnsupportedDialectError (415) it does today.
    static #parsedMatcher(body: MatcherBody): string | ParsedBodyMatcher {
        switch (body.dialect) {
            case "regex": return { dialect: "regex", pattern: body.pattern, flags: body.flags };
            case "glob":
            case "xpath":
            case "jsonpath": return { dialect: body.dialect, pattern: body.raw };
            default: return body.raw;
        }
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
    ): Promise<MatchResult> {
        try {
            // Pass the parsed matcher (declared dialect authoritative) + `hint`
            // (source mimetype, so the framework picks the right per-mimetype
            // handler without re-detecting from content). No re-parse, no drift.
            const rawMatches: QueryMatch[] = await mimetypes.query(
                { content, hint: mimetype },
                Matcher.#parsedMatcher(body),
            );
            if (rawMatches.length === 0) {
                return { status: 204, matches: [] };
            }
            return {
                status: 200,
                matches: Matcher.#evidence(rawMatches),
            };
        } catch (err) {
            // Name-based dispatch tolerates dup-copy node_modules layouts where
            // `instanceof` against the framework's exported classes can fail
            // because the consumer loads a different physical copy. The framework
            // sets each error subclass's `.name` to its class name.
            const name = err instanceof Error ? err.name : "";
            if (name === "UnsupportedDialectError" || err instanceof UnsupportedDialectError) {
                const unsupportedMimetype = typeof (err as { mimetype?: unknown }).mimetype === "string"
                    ? (err as { mimetype: string }).mimetype
                    : mimetype;
                return Results.failure(
                    "schemes:matcher",
                    "unsupported-dialect",
                    415,
                    `The ${body.dialect} matcher is not supported for ${unsupportedMimetype}.`,
                    {},
                    {
                        stage: "matcher",
                        dialect: body.dialect,
                        mimetype: unsupportedMimetype,
                        recovery: "Use a matcher supported by the resource mimetype.",
                        retryable: false,
                    },
                );
            }
            if (name === "InvalidExpressionError" || err instanceof InvalidExpressionError) {
                return Results.failure(
                    "schemes:matcher",
                    "invalid-expression",
                    400,
                    `The ${body.dialect} matcher expression is invalid.`,
                    {},
                    {
                        stage: "matcher",
                        dialect: body.dialect,
                        recovery: "Correct or remove the matcher.",
                        retryable: false,
                    },
                );
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
