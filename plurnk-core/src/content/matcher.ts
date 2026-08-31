// {§matcher-dispatch} Core candidate-set composition over the public schemes
// matcher adapter. Mimetypes owns content-dialect execution and evidence; the
// adapter owns operation-result mapping; this layer preserves caller identity
// across heterogeneous entry/log candidate sets.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed matcher
// expression; 203 = source unparseable for its mimetype → raw bytes as text so the model
// can fall back to regex/visual parsing (SPEC {§matcher-dispatch}).

import type { MatcherBody } from "@plurnk/plurnk-contracts";
import { TextCoordinates, type Mimetypes } from "@plurnk/plurnk-mimetypes";
import {
    Matcher as SchemeMatcher,
    type MatchEvidence,
    type MatchResult,
    type ProblemDetails,
} from "@plurnk/plurnk-schemes";
import ErrorDetail from "../core/ErrorDetail.ts";

export type { MatchResult };

export default class Matcher {
    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
    ): Promise<MatchResult> {
        // ~semantic and &graph resolve to resource selections with coordinate
        // evidence through FIND's persistent index, never through this content
        // matcher. Reaching here with a relation dialect is a routing bug.
        if (body.dialect === "semantic" || body.dialect === "graph") throw new Error(`matchAgainstContent is content-only; ${body.dialect} must resolve through FIND`);
        return SchemeMatcher.matchAgainstContent(body, content, mimetype, mimetypes, ErrorDetail.preview);
    }

    // {§find-source-agnostic} — apply a content matcher to a list of candidates from ANY source
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
            // {§find-candidate-containment} (#449) — arbitrary member content can crash a
            // mimetype handler (a template partial crashed Readability and killed a
            // 1,916-file FIND as a blank 500). One candidate's crash is that candidate's
            // unqueryability, never the operation's: it drops out like unsupported
            // content, the cause goes to daemon stderr, and only an all-crash FIND
            // reports the 415.
            let match;
            try {
                match = await Matcher.matchAgainstContent(body, cand.content, cand.mimetype, mimetypes);
            } catch (cause) {
                console.error(`FIND candidate ${cand.key} (${cand.mimetype}) content handler crashed:`, cause);
                unsupported ??= {
                    type: "https://problems.plurnk.xyz/mimetypes/handler-crashed",
                    title: "Content handler crashed",
                    status: 415,
                    detail: `The ${cand.mimetype} content handler failed on ${cand.key}: `
                        + (cause instanceof Error ? cause.message : String(cause)),
                };
                continue;
            }
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
                        return match.locator === undefined ? [] : [{ locator: match.locator }];
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
                        ...(match.locator === undefined ? {} : { locator: match.locator }),
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
    locator?: string;
}
