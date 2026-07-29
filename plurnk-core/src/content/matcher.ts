// Body-matcher filtering. The mimetypes plugin owns dialect dispatch, projection, AND
// source-line provenance: we hand it the matcher the GRAMMAR already parsed (as a
// ParsedBodyMatcher — no second parser, mimetypes#42) plus the content, and it returns
// QueryMatch[] with source and readable-row coordinates. Matching is a resource
// predicate: locations are evidence for a later surgical READ, not an
// instruction to replace the selected resource with extracted lines.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed matcher
// expression; 203 = source unparseable for its mimetype → raw bytes as text so the model
// can fall back to regex/visual parsing (SPEC §matcher-dispatch).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import type { MatchRange } from "@plurnk/plurnk-schemes";
import { InvalidExpressionError, QueryParseFailureError, UnsupportedDialectError, GrammarNotInstalledError } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "./mimetype-binary.ts";

export interface MatchResult {
    status: number;
    body?: string;                         // raw fallback content (203)
    matches?: ReadonlyArray<MatchRange>;  // addressable evidence (200 / 204)
    error?: string;         // status 400 — malformed matcher expression
    mimetype?: string;      // 203 fallback mimetype
    reason?: string;        // 203 fallback: the parse-failure reason for the model
}

export default class Matcher {
    static #ranges(matches: readonly QueryMatch[]): MatchRange[] {
        const ranges: MatchRange[] = [];
        const seen = new Set<string>();
        for (const match of matches) {
            const lines = match.lines ?? [];
            const rows = match.rows ?? [];
            if (lines.length !== rows.length) {
                throw new Error(`Mimetypes.query returned ${lines.length} source ranges and ${rows.length} readable ranges for one match`);
            }
            for (let index = 0; index < lines.length; index += 1) {
                const range = {
                    lineStart: lines[index].line,
                    lineEnd: lines[index].endLine,
                    rowStart: rows[index].row,
                    rowEnd: rows[index].endRow,
                    ...(match.matching === undefined ? {} : { path: match.matching }),
                };
                const key = `${range.lineStart}\0${range.lineEnd}\0${range.rowStart}\0${range.rowEnd}\0${range.path ?? ""}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    ranges.push(range);
                }
            }
        }
        return ranges;
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
    ): Promise<MatchResult> {
        // ~semantic and @graph resolve to resource selections with coordinate
        // evidence through FIND's persistent index, never through this content
        // matcher. Reaching here with a relation dialect is a routing bug.
        if (body.dialect === "semantic" || body.dialect === "graph") throw new Error(`matchAgainstContent is content-only; ${body.dialect} must resolve through FIND`);
        // Hand the plugin the matcher the GRAMMAR parsed — no second parser (mimetypes#42).
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
        if (matches.length === 0) return { status: 204, matches: [] };
        return { status: 200, matches: Matcher.#ranges(matches) };
    }

    // §find-source-agnostic — apply a content matcher to a list of candidates from ANY source
    // (entries, log rows, ...), returning one selection per resource keyed by the
    // caller's own identity, with all addressable evidence grouped on it. The
    // matcher never cares what table content came from; this is
    // the shared primitive both EntryFind and Log.find run, so every dialect works uniformly by
    // construction rather than being re-implemented per scheme. 400 (malformed matcher) fails the
    // whole op; a non-200 candidate (204 no-match / 415 / 203) simply drops out.
    static async matchCandidates(
        body: MatcherBody,
        candidates: ReadonlyArray<{ key: string; content: string; mimetype: string }>,
        mimetypes: Mimetypes,
    ): Promise<{ status: number; matches: CandidateMatch[] }> {
        const matches: CandidateMatch[] = [];
        for (const cand of candidates) {
            const match = await Matcher.matchAgainstContent(body, cand.content, cand.mimetype, mimetypes);
            if (match.status === 400) return { status: 400, matches: [] };
            if (match.status !== 200) continue;
            matches.push({ key: cand.key, matches: [...(match.matches ?? [])] });
        }
        return { status: 200, matches };
    }

    // Project relation findings into the row coordinates a scoped READ accepts,
    // then group every finding on its resource. Content matchers already receive
    // both coordinate systems from Mimetypes.query.
    static async addReadableRows(
        matches: readonly SourceCandidateMatch[],
        candidates: ReadonlyArray<{ key: string; content: string; mimetype: string }>,
        mimetypes: Mimetypes,
    ): Promise<CandidateMatch[]> {
        const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate] as const));
        const grouped = new Map<string, SourceCandidateMatch[]>();
        const order: string[] = [];
        for (const match of matches) {
            if (!grouped.has(match.key)) order.push(match.key);
            const findings = grouped.get(match.key) ?? [];
            findings.push(match);
            grouped.set(match.key, findings);
        }
        const resolved: CandidateMatch[] = [];
        for (const key of order) {
            const findings = grouped.get(key) ?? [];
            const located = findings.filter((match) => match.span !== null);
            if (located.length === 0) {
                resolved.push({ key, matches: [] });
                continue;
            }
            const candidate = byKey.get(key);
            if (candidate === undefined) throw new Error(`Matcher.addReadableRows: matched candidate ${key} has no readable projection`);
            const rows = await mimetypes.rowsForLines(
                { content: candidate.content, hint: candidate.mimetype },
                located.map((match) => ({
                    line: match.span!.lineStart,
                    endLine: match.span!.lineEnd,
                })),
            );
            if (rows.length !== located.length) {
                throw new Error(`Matcher.addReadableRows: ${key} returned ${rows.length} rows for ${located.length} source ranges`);
            }
            resolved.push({
                key,
                matches: located.map((match, index) => ({
                    lineStart: match.span!.lineStart,
                    lineEnd: match.span!.lineEnd,
                    rowStart: rows[index].row,
                    rowEnd: rows[index].endRow,
                    ...(match.path === undefined ? {} : { path: match.path }),
                })),
            });
        }
        return resolved;
    }
}

// One selected resource, keyed by the caller's identity (pathname for entries,
// coordinate for log), with every addressable finding grouped on it.
export interface CandidateMatch { key: string; matches: MatchRange[]; }

// Relation matchers initially provide source coordinates only.
export interface SourceCandidateMatch {
    key: string;
    span: { lineStart: number; lineEnd: number } | null;
    path?: string;
}
