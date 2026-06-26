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
    lines?: number[];       // matched source line numbers (status 200) — Project Findings extent substrate
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
    static #renderRows(matches: readonly QueryMatch[], content: string, baseLine: number): { body: string; lines: number[] } {
        const lines = content.split("\n");
        const offset = baseLine - 1;
        const seen = new Set<number>();
        const rows: string[] = [];
        const sourceLines: number[] = [];
        for (const m of matches) {
            const spans = m.lines ?? [];
            if (spans.length === 0) { rows.push(Matcher.#renderValue(m.matched)); continue; }
            for (const span of spans) {
                for (let ln = span.line; ln <= span.endLine; ln++) {
                    const src = ln + offset;
                    sourceLines.push(src);
                    if (seen.has(src)) continue;
                    seen.add(src);
                    rows.push(`${src}:\t${lines[ln - 1] ?? Matcher.#renderValue(m.matched)}`);
                }
            }
        }
        return { body: rows.join("\n"), lines: sourceLines };
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
        baseLine: number = 1,
    ): Promise<MatchResult> {
        if (body.dialect === "semantic") {
            // Semantic similarity (grammar `~query`, top-K via <L>). Service-side, parked.
            return { status: 501, error: "semantic matcher not yet implemented (similarity — parked, needs its own embedding/vector design)" };
        }
        if (body.dialect === "graph") {
            // @graph is a FIND-only symbol relation (EntryGraph), not a READ content matcher.
            return { status: 400, error: "@graph is a FIND relation, not a READ content matcher" };
        }
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
        return { status: 200, body: rendered.body, matches: matches.length, lines: rendered.lines };
    }
}
