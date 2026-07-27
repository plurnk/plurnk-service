// Body-matcher adapter — delegates to @plurnk/plurnk-mimetypes for the actual
// dialect dispatch. The framework parses the matcher's leading prefix internally
// (xpath `//`, jsonpath `$`, regex `/.../`, glob otherwise) and routes to
// per-mimetype handlers; this maps its typed errors to the HTTP-shaped status
// codes the model acts on.
//
// The full status mapping is the contract: SPEC §matcher-dispatch. One
// rationale that doesn't live there: 203 is HTTP-creative ("Non-Authoritative
// Information") — content was produced, but not in the structured form the
// matcher requested; the model sees raw text + a `reason` and chooses
// retry/fallback/fix-source. Choice ratified by user (#172).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import {
    UnsupportedDialectError,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import { TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";

export interface MatchResult {
    status: number;
    body?: string;          // N:\t<source-line> lines (status 200) or raw fallback content (status 203)
    matches?: number;       // hit count (status 200 or 204); omitted on 203
    error?: string;         // status >= 400 paths (framework dialect errors; not a scheme Notice)
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

    // Render matches as the model-facing `<source-line>:\t<line-content>` form,
    // one source line per entry — the `N:\t` convention READ emits. A matcher
    // SELECTS a location; READ returns the SOURCE LINE at that location, never an
    // extracted value (grammar contract plurnk.md:31, schemes#27). A regex hit on
    // `### §grinder …` renders that whole line, not the matched token `grinder`.
    //
    // The hit's source footprint is `lines[]` (mimetypes #41: structural dialects
    // self-provide it, symmetric with regex/glob). We anchor on the first span's
    // start line and emit the SOURCE line text there. Deduped by source line — a
    // line matched twice appears once (e.g. two regex hits on one line). A
    // footprint-less match — an xpath computed scalar (count()/string()/sum()/…)
    // that lives nowhere in the source — has no line to return, so it renders its
    // value bare; the framework never fakes a line for it, and neither do we.
    //
    // Line lookup uses SLICE coordinates (the `content` the matcher ran against),
    // while the displayed number is SOURCE coordinates (`+ baseLine - 1`) — so an
    // `<L>`-sliced match reports its original-source line but reads text from the
    // slice in hand. `matching` (the resolved query path) is never surfaced.
    static #renderMatches(matches: readonly QueryMatch[], content: string, baseLine: number): string[] {
        const sliceLines = content.split("\n");
        const offset = baseLine - 1;
        const seen = new Set<number>();
        const out: string[] = [];
        for (const m of matches) {
            const sliceLine = m.lines?.[0]?.line;
            if (sliceLine === undefined) { out.push(Matcher.#renderValue(m.matched)); continue; }
            const sourceLine = sliceLine + offset;
            if (seen.has(sourceLine)) continue; // dedup by source line
            seen.add(sourceLine);
            out.push(`${sourceLine}:\t${sliceLines[sliceLine - 1] ?? ""}`);
        }
        return out;
    }

    // Hand the framework the ALREADY-PARSED matcher (mimetypes#42), not the raw
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
        baseLine: number = 1,
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
                return { status: 204, matches: 0 };
            }
            // Render to deduped source lines; `matches` counts the lines the model
            // sees (post-dedup), not raw hits — a line matched twice is one result.
            const rendered = Matcher.#renderMatches(rawMatches, content, baseLine);
            return {
                status: 200,
                body: rendered.join("\n"),
                matches: rendered.length,
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
