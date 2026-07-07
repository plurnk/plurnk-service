// Body-matcher filtering. The mimetypes daughter owns dialect dispatch, projection, AND
// source-line provenance: we hand it the matcher the GRAMMAR already parsed (as a
// ParsedBodyMatcher — no second parser, mimetypes#42) plus the content, and it returns
// QueryMatch[] with each hit's source span(s). READ returns the LINE at each match
// (plurnk.md:31) — a matcher SELECTS, it never extracts a value. We never reach into the
// internal deepJson/deepXml projections; that's the daughter's layer.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed matcher
// expression; 203 = source unparseable for its mimetype → raw bytes as text so the model
// can fall back to regex/visual parsing (SPEC §matcher-dispatch).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import { InvalidExpressionError, QueryParseFailureError, UnsupportedDialectError, GrammarNotInstalledError } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "./mimetype-binary.ts";

export interface MatchResult {
    status: number;
    body?: string;          // N:\t<line> rows (200) or raw fallback content (203)
    matches?: number;       // hit count (status 200 / 204)
    // §matcher-selection-signal — each hit's canonical location in the DAUGHTER's own coordinate
    // system (jsonpath: $['users'][0]['name']; xpath: the node path), when the dialect provides
    // one. The SELECTION SIGNAL that survives the degenerate single-line case: the payload stays
    // the source line (the tent pole — line-oriented matching composes FIND↔READ↔EDIT and admits
    // no exception), while matches+paths tell the model its query HIT, how many times, and where
    // (run30: two hits collapsed to one whole-file line read as failure; 17 retries).
    paths?: string[];
    lines?: number[];       // matched source line numbers (status 200) — Project Findings extent substrate
    spans?: { lineStart: number; lineEnd: number }[]; // one per match — the (file, span) unit FIND emits + READ delivers (#286)
    error?: string;         // status 400 — malformed matcher expression
    mimetype?: string;      // 203 fallback mimetype
    reason?: string;        // 203 fallback: the parse-failure reason for the model
}

export default class Matcher {
    static #renderValue(v: unknown): string {
        return typeof v === "string" && !v.includes("\n") ? v : JSON.stringify(v);
    }

    // READ returns LINES of content (plurnk.md:31): a matcher SELECTS, READ delivers the
    // source line(s) at each match — not the extracted value. `m.lines` is each hit's source
    // span(s), uniform across dialects (the daughter self-provides them). One source-line
    // prefix `N:\t` (plurnk.md:32), deduped by source line; baseLine shifts slice-relative
    // spans back to source coordinates. A hit with no span (e.g. an xpath computed scalar —
    // count()/sum(), which has no source node) falls back to the matched value.
    static #renderRows(matches: readonly QueryMatch[], content: string, baseLine: number): { body: string; lines: number[]; spans: { lineStart: number; lineEnd: number }[] } {
        const lines = content.split("\n");
        const offset = baseLine - 1;
        const seen = new Set<number>();
        const seenSpan = new Set<string>();
        const rows: string[] = [];
        const sourceLines: number[] = [];
        const spans: { lineStart: number; lineEnd: number }[] = [];  // one (deduped) range per match — the (file, span) unit (#286)
        for (const m of matches) {
            const ranges = m.lines ?? [];
            if (ranges.length === 0) { rows.push(Matcher.#renderValue(m.matched)); continue; }
            for (const range of ranges) {
                const lineStart = range.line + offset;
                const lineEnd = range.endLine + offset;
                const spanKey = `${lineStart}\0${lineEnd}`;
                if (!seenSpan.has(spanKey)) { seenSpan.add(spanKey); spans.push({ lineStart, lineEnd }); }
                for (let ln = range.line; ln <= range.endLine; ln++) {
                    const src = ln + offset;
                    sourceLines.push(src);
                    if (seen.has(src)) continue;
                    seen.add(src);
                    rows.push(`${src}:\t${lines[ln - 1] ?? Matcher.#renderValue(m.matched)}`);
                }
            }
        }
        return { body: rows.join("\n"), lines: sourceLines, spans };
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
        baseLine: number = 1,
    ): Promise<MatchResult> {
        // Invariant (#286): ~semantic and @graph resolve to (file, span) items via FIND
        // (rankSemantic / EntryGraph) — never the content matcher. A matcher READ fans out through
        // FIND, and the per-match read carries the span with no body. So matchAgainstContent only
        // ever sees content dialects; reaching here with a relation dialect is a routing bug, not a
        // user error — fail hard rather than silently mis-handle.
        if (body.dialect === "semantic" || body.dialect === "graph") throw new Error(`matchAgainstContent is content-only; ${body.dialect} must resolve through FIND`);
        // Hand the daughter the matcher the GRAMMAR parsed — no second parser (mimetypes#42).
        const parsedMatcher: ParsedBodyMatcher = body.dialect === "regex"
            ? { dialect: "regex", pattern: body.pattern, flags: body.flags }
            : { dialect: body.dialect, pattern: body.raw };
        let matches: QueryMatch[];
        try {
            matches = await mimetypes.query({ content, hint: mimetype }, parsedMatcher);
        } catch (err) {
            // A malformed matcher EXPRESSION is the model's fault → 400. Source/projection
            // failures (unparseable for the mimetype, unsupported dialect for this type, grammar
            // not installed, no handler) → 203 soft fallback: raw bytes as text so the model
            // can regex/visual-parse (§matcher-dispatch-203-soft-fallback).
            if (err instanceof InvalidExpressionError) return { status: 400, error: err.message };
            if (err instanceof QueryParseFailureError || err instanceof UnsupportedDialectError || err instanceof GrammarNotInstalledError || err instanceof ReferenceError) {
                return { status: 203, body: content, mimetype: MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE, reason: err instanceof Error ? err.message : String(err) };
            }
            throw err;
        }
        if (matches.length === 0) return { status: 204, matches: 0 };
        const rendered = Matcher.#renderRows(matches, content, baseLine);
        const paths = matches.map((m) => (m as { matching?: unknown }).matching).filter((x): x is string => typeof x === "string" && x.length > 0);
        return { status: 200, body: rendered.body, matches: matches.length, lines: rendered.lines, spans: rendered.spans, ...(paths.length > 0 ? { paths } : {}) };
    }
}
