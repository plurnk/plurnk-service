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
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import {
    Matcher as SchemeMatcher,
    type MatchRange,
    type MatchResult,
    type ProblemDetails,
} from "@plurnk/plurnk-schemes";

export type { MatchResult };

export default class Matcher {
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
        return SchemeMatcher.matchAgainstContent(body, content, mimetype, mimetypes);
    }

    // §find-source-agnostic — apply a content matcher to a list of candidates from ANY source
    // (entries, log rows, ...), returning one selection per resource keyed by the
    // caller's own identity, with all addressable evidence grouped on it. The
    // matcher never cares what table content came from; this is
    // the shared primitive both EntryFind and Log.find run, so every dialect works uniformly by
    // construction rather than being re-implemented per scheme. A 4xx matcher
    // failure ends the whole operation; 204 no-match and 203 unlocated-match
    // candidates simply drop out.
    static async matchCandidates(
        body: MatcherBody,
        candidates: ReadonlyArray<{ key: string; content: string; mimetype: string }>,
        mimetypes: Mimetypes,
    ): Promise<{ status: number; matches: CandidateMatch[]; problem?: ProblemDetails }> {
        const matches: CandidateMatch[] = [];
        let queryable = 0;
        let unsupported: ProblemDetails | undefined;
        for (const cand of candidates) {
            const match = await Matcher.matchAgainstContent(body, cand.content, cand.mimetype, mimetypes);
            if (match.status === 415) {
                if (match.problem === undefined) {
                    throw new Error("Matcher.matchCandidates: status 415 has no Problem Details");
                }
                unsupported ??= match.problem;
                continue;
            }
            if (match.status >= 400) {
                if (match.problem === undefined) {
                    throw new Error(`Matcher.matchCandidates: status ${match.status} has no Problem Details`);
                }
                return { status: match.status, matches: [], problem: match.problem };
            }
            queryable += 1;
            if (match.status !== 200) continue;
            matches.push({ key: cand.key, matches: [...(match.matches ?? [])] });
        }
        if (queryable === 0 && unsupported !== undefined) {
            return { status: 415, matches: [], problem: unsupported };
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
