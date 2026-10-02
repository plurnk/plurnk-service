// {§matcher-dispatch} {§matcher-selection-signal} {§matcher-index-readiness} Core candidate-set composition over the public schemes
// matcher adapter. Mimetypes owns content-dialect execution and evidence; the
// adapter owns operation-result mapping; this layer preserves caller identity
// across heterogeneous entry/log candidate sets.
//
// Status: 200 = matches; 204 = matcher applied, zero results; 400 = malformed matcher
// expression; 203 = source unparseable for its mimetype → raw bytes as text so the model
// can fall back to regex/visual parsing (SPEC {§matcher-dispatch}).

import { Problems, type MatcherBody, type ParsedPath } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import {
    Matcher as SchemeMatcher,
    type MatchEvidence,
    type MatchResult,
    type ProblemDetails,
} from "@plurnk/plurnk-schemes";
import ErrorDetail from "../core/ErrorDetail.ts";
import PatternEdits from "./pattern-edits.ts";
import SearchIndex from "../schemes/_search-index.ts";
import EntryFts from "../schemes/_entry-fts.ts";
import EntryGraph from "../schemes/_entry-graph.ts";
import { resolveSearchCandidates } from "../schemes/_search-candidate.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import LineSelection from "./line-selection.ts";

export type { MatchResult };

export default class Matcher {
    static async matchResource(
        body: MatcherBody,
        source: { content: string; mimetype: string; target: ParsedPath; visibleLines?: readonly number[] },
        ctx: PlurnkSchemeContext,
    ): Promise<MatchResult> {
        if (ctx.mimetypes === undefined) throw new Error("Resource matching requires mimetypes");
        const { target, mimetype, visibleLines } = source;
        const content = visibleLines === undefined ? source.content : LineSelection.retain(source.content, visibleLines).content;
        let result: MatchResult;
        if (body.dialect !== "fts" && body.dialect !== "graph") {
            result = await Matcher.matchAgainstContent(PatternEdits.lineAnchored(body), content, mimetype, ctx.mimetypes);
        } else {
            const scheme = target.kind === "url" ? target.scheme : "file";
            result = await SearchIndex.snapshot(ctx, {
                content, mimetype, scheme, pathname: target.kind === "url" ? target.pathname : target.raw,
            }, async (snapshot): Promise<MatchResult> => {
                if (snapshot.disposition === "excluded" || snapshot.disposition === "failed") {
                    return { status: 422, problem: Problems.create("schemes:matcher", "search-unavailable", 422,
                        `The selected representation is not indexed: ${snapshot.reason ?? snapshot.disposition}.`) };
                }
                const candidates = [{ key: target.raw, deepHash: snapshot.deepHash }];
                if (body.dialect === "fts") {
                    const ranked = await EntryFts.rankCandidates(ctx.db, candidates, body.raw.slice(1), ctx.signal);
                    return { ...ranked, matches: ranked.matches.flatMap(({ matches }) => matches) };
                } else {
                    await ctx.settleDerivations?.();
                    const rows = scheme === "log"
                        ? await ctx.db.log_find_candidates.all<{ coordinate: string; deep_hash: string | null }>({ worker_id: ctx.workerId, scope_prefix: null, max_id: null })
                        : scheme === "ops" || scheme === "reasoning" || scheme === "note"
                            ? await ctx.db.turn_source_candidates.all<{ pathname: string; deep_hash: string | null }>({ workspace_id: ctx.workspaceId, worker_name: target.kind === "url" ? target.hostname : null, kind: scheme })
                                .then((sources) => sources.filter(({ pathname }) => !/^\/\d+$/.test(pathname)))
                            : await ctx.db.find_workspace_derivation_candidates.all<{ key: string; deep_hash: string | null }>({ workspace_id: ctx.workspaceId });
                    const universe = resolveSearchCandidates(rows.map(({ deep_hash }, index) => ({ key: String(index), deepHash: deep_hash })));
                    if (universe.state !== "ready") return { status: 503, problem: Problems.create("schemes:matcher", "search-index-incomplete", 503,
                        "The relationship index is incomplete.", { retryable: true }) };
                    const graph = await EntryGraph.matchCandidates(ctx.db, [...universe.candidates, ...candidates], candidates, body.raw);
                    return { ...graph, matches: graph.matches.flatMap(({ matches }) => matches) };
                }
            });
        }
        if (result.status >= 300 || result.status === 203) return result;
        const matches = visibleLines === undefined ? result.matches : LineSelection.evidence(result.matches ?? [], visibleLines);
        return { ...result, status: matches?.length ? 200 : 204, matches };
    }

    static async matchAgainstContent(
        body: MatcherBody,
        content: string,
        mimetype: string,
        mimetypes: Mimetypes,
    ): Promise<MatchResult> {
        if (body.dialect === "fts" || body.dialect === "graph") throw new Error(`matchAgainstContent is content-only; ${body.dialect} requires the indexed matcher`);
        return SchemeMatcher.matchAgainstContent(body, content, mimetype, mimetypes, (value) => ErrorDetail.preview(value));
    }

    // {§find-source-agnostic} — apply a content matcher to a list of candidates from ANY source
    // (entries, log rows, ...), returning one selection per resource keyed by the
    // caller's own identity, with all addressable evidence grouped on it. The
    // matcher never cares what table content came from; this is
    // the shared primitive both EntryFind and Log.find run, so every dialect works uniformly by
    // construction rather than being re-implemented per scheme. A 4xx matcher
    // failure ends the whole operation; 204 no-match and 203 unlocated-match
    // candidates simply drop out. A regex anchors each line ({§find-line-anchors}).
    static async matchCandidates(
        body: MatcherBody,
        candidates: ReadonlyArray<{ key: string; content: string; mimetype: string }>,
        mimetypes: Mimetypes,
    ): Promise<{ status: number; matches: CandidateMatch[]; problem?: ProblemDetails }> {
        const lineBody = PatternEdits.lineAnchored(body);
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
                match = await Matcher.matchAgainstContent(lineBody, cand.content, cand.mimetype, mimetypes);
            } catch (cause) {
                console.error(`FIND candidate ${cand.key} (${cand.mimetype}) content handler crashed:`, cause);
                unsupported ??= Problems.create(
                    "mimetypes",
                    "handler-crashed",
                    415,
                    `The ${cand.mimetype} content handler failed on ${cand.key}: `
                        + (cause instanceof Error ? cause.message : String(cause)),
                    {},
                    { title: "Content handler crashed" },
                );
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

}

// One selected resource, keyed by the caller's identity (pathname for entries,
// coordinate for log), with every addressable finding grouped on it.
export interface CandidateMatch { key: string; matches: MatchEvidence[]; }
