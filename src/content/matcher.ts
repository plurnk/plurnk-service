// Body-matcher filtering. plurnk-service owns the filtering: the mimetypes
// daughter PROJECTS every entry (process() → deepJson + deepXml, for ANY source
// type); we FILTER here by running the matcher's dialect against the right
// channel:
//
//   glob / regex  → the raw default content (line filter; daughter primitives)
//   jsonpath      → deepJson  (daughter's queryJsonpathObject)
//   xpath         → deepXml   (daughter's queryXpathString — recovers source
//                              lines from the projection's pk:line attrs)
//
// Cross-dialect (xpath over a JSON doc, jsonpath over an XML doc) works because
// process() yields BOTH projections for any type. Matches render as the
// model-facing `<source-line>:\t<value>` form, the same as a READ slice.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed
// matcher expression; 203 = source unparseable for its mimetype → raw bytes as
// text so the model can fall back to regex/visual parsing (SPEC §16.1).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch } from "@plurnk/plurnk-mimetypes";
import { queryGlob, queryRegex, queryJsonpathObject, queryXpathString } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "./mimetype-binary.ts";

export interface MatchResult {
    status: number;
    body?: string;          // N:\t<value> lines (200) or raw fallback content (203)
    matches?: number;       // hit count (status 200 / 204)
    error?: string;         // status 400 — malformed matcher expression
    mimetype?: string;      // 203 fallback mimetype
    reason?: string;        // 203 fallback: the parse-failure reason for the model
}

export default class Matcher {
    // Render matches as the model-facing line-numbered form `<source-line>:\t<value>`,
    // one match per line — the same N:\t convention READ emits. Value is bare for a
    // single-line string, JSON-encoded otherwise so the one-match-per-line invariant
    // holds and `<L>` can still page the result set.
    static #renderValue(v: unknown): string {
        return typeof v === "string" && !v.includes("\n") ? v : JSON.stringify(v);
    }

    static #renderMatches(matches: readonly QueryMatch[]): string {
        return matches.map((m) => `${m.line}:\t${Matcher.#renderValue(m.matched)}`).join("\n");
    }

    // Apply an `<L>`-slice baseLine offset to per-match line numbers — match lines
    // are relative to the content received; when matching inside a slice they shift
    // back to original-source coordinates.
    static #shiftLines(matches: readonly QueryMatch[], baseLine: number): QueryMatch[] {
        if (baseLine === 1) return [...matches];
        const offset = baseLine - 1;
        return matches.map((m) => ({ ...m, line: m.line + offset }));
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
        baseLine: number = 1,
    ): Promise<MatchResult> {
        if (body.dialect === "rag") {
            // Semantic similarity (grammar 0.21.0: `~query`, top-K via <L>). A
            // service-side feature needing its own embedding/vector design — the
            // resolution mechanism is ours, not the grammar's to prescribe. Parked.
            return { status: 501, error: "rag matcher not yet implemented (semantic similarity — parked, needs its own embedding/vector design)" };
        }
        let matches: QueryMatch[];
        if (body.dialect === "glob") {
            matches = queryGlob(content, body.raw);
        } else if (body.dialect === "regex") {
            matches = queryRegex(content, body.pattern, body.flags);
        } else {
            // Structural dialects query a projected channel, not the raw text.
            let deepJson: unknown;
            let deepXml: string;
            try {
                ({ deepJson, deepXml } = await mimetypes.process({ content, hint: mimetype }));
            } catch (err) {
                // The SOURCE couldn't be parsed for its mimetype → 203 soft fallback:
                // hand back the raw bytes as text so the model can regex/visual-parse.
                return {
                    status: 203,
                    body: content,
                    mimetype: MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE,
                    reason: err instanceof Error ? err.message : String(err),
                };
            }
            try {
                matches = body.dialect === "jsonpath"
                    ? queryJsonpathObject(deepJson, body.raw)
                    : queryXpathString(deepXml, body.raw, mimetype);
            } catch (err) {
                // A throw from the QUERY is a malformed matcher expression the grammar
                // didn't catch (model-facing → 400, not a system 500).
                return { status: 400, error: err instanceof Error ? err.message : String(err) };
            }
        }
        if (matches.length === 0) return { status: 204, matches: 0 };
        const adjusted = Matcher.#shiftLines(matches, baseLine);
        return { status: 200, body: Matcher.#renderMatches(adjusted), matches: adjusted.length };
    }
}
