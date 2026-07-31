// Body-matcher filtering. The mimetypes plugin owns dialect dispatch,
// projection, and honest locator/TextRegion evidence. We hand it the matcher
// the grammar already parsed plus the content; no second parser reclassifies
// the dialect. Matching is a resource predicate: locations are evidence for a
// later surgical READ, not an instruction to replace the resource with an
// extracted value.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed matcher
// expression; 203 = source unparseable for its mimetype → raw bytes as text so the model
// can fall back to regex/visual parsing (SPEC §matcher-dispatch).

import type { MatcherBody } from "@plurnk/plurnk-grammar";
import { TextCoordinates, type Mimetypes } from "@plurnk/plurnk-mimetypes";
import {
    Matcher as SchemeMatcher,
    type MatchEvidence,
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

    // Project relation findings into honest text regions a scoped READ accepts,
    // then group every finding on its resource.
    static addTextRegions(
        matches: readonly SourceCandidateMatch[],
        candidates: ReadonlyArray<{ key: string; content: string }>,
    ): CandidateMatch[] {
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
            const candidate = byKey.get(key);
            if (candidate === undefined) throw new Error(`Matcher.addTextRegions: matched candidate ${key} has no readable projection`);
            resolved.push({
                key,
                matches: findings.flatMap((match): MatchEvidence[] => {
                    if (match.span === null) {
                        return match.path === undefined ? [] : [{ path: match.path }];
                    }
                    const region = TextCoordinates.lineRegion(
                        candidate.content,
                        match.span.lineStart,
                        match.span.lineEnd,
                    );
                    if (region === null) {
                        throw new Error(
                            `Matcher.addTextRegions: ${key} span ${match.span.lineStart}-${match.span.lineEnd} is outside the readable text`,
                        );
                    }
                    return [{
                        ...(match.path === undefined ? {} : { path: match.path }),
                        region,
                    }];
                }),
            });
        }
        return resolved;
    }
}

// One selected resource, keyed by the caller's identity (pathname for entries,
// coordinate for log), with every addressable finding grouped on it.
export interface CandidateMatch { key: string; matches: MatchEvidence[]; }

// Relation matchers initially provide source coordinates only.
export interface SourceCandidateMatch {
    key: string;
    span: { lineStart: number; lineEnd: number } | null;
    path?: string;
}
