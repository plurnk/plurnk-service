// Body-matcher filtering. plurnk-service owns the filtering: the mimetypes
// daughter PROJECTS every entry (process() → deepJson + deepXml, for ANY source
// type); we FILTER here by running the matcher's dialect against the right
// channel:
//
//   glob / regex  → the raw default content (line filter; daughter primitives)
//   jsonpath      → deepJson  (daughter's queryJsonpathObject)
//   xpath         → deepXml   (our own xpath engine — the daughter exports no
//                              xpath primitive; we own the xml dependency)
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
import { queryGlob, queryRegex, queryJsonpathObject } from "@plurnk/plurnk-mimetypes";
import { DOMParser } from "@xmldom/xmldom";
import { select } from "xpath";
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
                    : Matcher.#queryXpath(deepXml, body.raw);
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

    // XPath over the daughter's deepXml projection — our own engine. An element
    // node renders as its XML serialization, a text/attribute node its value. Line
    // comes from the matched node's `line` attr (its parent's, for `text()`),
    // defaulting to 1 where the projection carries no source lines (JSON's deepXml).
    // The projection's inline `line`/`endLine` bookkeeping currently pollutes
    // element serialization (and is invalid XML on a content-attr collision) — the
    // daughter's to fix (plurnk-mimetypes#12), not ours to strip.
    static #queryXpath(deepXml: string, expression: string): QueryMatch[] {
        const doc = new DOMParser().parseFromString(deepXml, "text/xml");
        const selected = select(expression, doc as never);
        const nodes = Array.isArray(selected) ? selected : [selected];
        return nodes.map((node) => {
            const el = node as {
                nodeType?: number;
                nodeValue?: string;
                getAttribute?: (name: string) => string | null;
                parentNode?: { getAttribute?: (name: string) => string | null };
            };
            const line = el.getAttribute?.("line") ?? el.parentNode?.getAttribute?.("line");
            const matched = el.nodeType === 1 ? String(node) : el.nodeValue ?? String(node);
            return {
                line: line !== undefined && line !== null ? Number(line) : 1,
                matched,
                matching: expression,
            };
        });
    }
}
