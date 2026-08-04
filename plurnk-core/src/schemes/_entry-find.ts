// FIND helper for entry-bearing schemes (SPEC {§find}; plurnk.md FIND row).
// FIND resolves to the scheme's CATALOG ROWS — the very rows the manifest catalogs —
// filtered to the statement's matches. A matcher (glob/regex/jsonpath/xpath/~semantic/
// @graph) decides WHICH entries appear. Each selected entry appears once; its
// optional `matches` metadata records every addressable source/readable range.
// The content itself remains a READ.
//
// FIND slot semantics (contracts SPEC §4/§7):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath/~semantic/@graph). A content matcher
//             runs against the entry's default-channel CONTENT (Matcher.matchAgainstContent
//             → the mimetypes plugin) and INCLUDES/EXCLUDES the entry — e.g.
//             `FIND(log:///**/error):/timeout/i` keeps logs whose content matches.
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement } from "@plurnk/plurnk-contracts";
import { LineMarkerOps } from "../content/index.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import type { SourceCandidateMatch } from "../content/matcher.ts";
import { entryPathnameOf } from "../core/plurnk-uri.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryManifest, { type CatalogEntry } from "./_entry-manifest.ts";
import Owner from "../core/Owner.ts";
import EntrySemantic from "./_entry-semantic.ts";
import Results, { type ProblemDetails, type SchemeResultBase } from "../core/results.ts";
import type { MatchEvidence, RangeExtent } from "@plurnk/plurnk-schemes";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { pathFolderSummaries, pathScope, pathScopeMatches, type PathScope } from "./_path-scope.ts";

export interface Match { pathname: string; matches: MatchEvidence[]; }
// A FIND result row: the entry's catalog row plus addressable match evidence
// (absent for a body-less or source-less match).
export type CatalogScope = {
    path: string;
    items: number;
    tokens: number;
    channels?: never;
    matches?: undefined;
};
export type CatalogMatch = CatalogEntry & { matches?: MatchEvidence[]; items?: never; tokens?: never };
export type MatchItem = CatalogMatch | CatalogScope;

// FIND result ordinals are also packet line coordinates. Keep each top-level
// item compact, adding only the boundary newline that makes row N addressable
// as line N while retaining one valid JSON array. {§find-result-catalog-rows}
export const renderFindContent = (results: readonly MatchItem[]): string =>
    `[${results.map((result) => JSON.stringify(result)).join(",\n")}]`;

export interface FindResult extends SchemeResultBase {
    content: string | null;
    mimetype: string | null;
    results: MatchItem[];     // one per selected resource; body-less -> no match evidence
    itemsTokenTotal: number;  // content weight of the matched set, summed per UNIQUE entry
    pathnames: string[];      // unique matched pathnames, in result order — the set a multi-file READ fans out over
    matches: Match[];         // one per selected resource, in result order
    omittedItems?: number;    // {§find-count-not-contents} - N selected items omitted from an over-budget result
    maximumItems?: number;
}

export default class EntryFind {
    static #scopePathnameOf(statement: FindStatement): string | null {
        const path = statement.target;
        if (path === null) return null;
        // FIND addresses the same canonical entry identity as READ and direct
        // CRUD. Both namespace authorities and network hosts are part of that
        // identity and must survive the exact-entry lookup.
        return entryPathnameOf(path);
    }

    static #unique(xs: string[]): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
        return out;
    }

    // Resolve a FIND to its matched workspace PATHNAMES — entry-level, unique, in result
    // order (rank for ~semantic, candidate order otherwise). Candidate selection (scope +
    // tags) runs in SQL (find_workspace_entry_candidates); a content matcher then runs against
    // each candidate's default-channel CONTENT (Matcher.matchAgainstContent → the mimetypes
    // plugin) and INCLUDES/EXCLUDES the entry - 200 keeps it, 204/203 drop it, and a
    // 4xx matcher failure ends the whole operation. Path-scoping stays in the (target). Returns the
    // matched pathnames plus `locations` — each content hit's source line(s), keyed by pathname.
    static async #matchPathnames(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        explicitOwnerId?: number,
    ): Promise<{
        status: number;
        matches: Match[];
        scope?: PathScope;
        candidatePathnames?: string[];
        error?: string;
        problem?: ProblemDetails;
        range?: RangeExtent;
        extensions?: Readonly<Record<string, unknown>>;
    }> {
        if (statement.target === null) {
            return {
                status: 400,
                matches: [],
                error: "FIND requires a target.",
                extensions: {
                    recovery: "Provide the FIND target.",
                    retryable: false,
                },
            };
        }
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);
        const scopePathname = EntryFind.#scopePathnameOf(statement);
        const scope = scopePathname === null
            ? null
            : pathScope(scopePathname, manifest.folderScopes === true);
        // {§fs-errno} — an exact-path miss is ENOENT; an empty glob or folder
        // survey is a successful empty result.
        if (scope?.kind === "exact" && scope.pathname.length > 0) {
            const exact = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme, pathname: scope.pathname,
            });
            if (exact === undefined) {
                return {
                    status: 404,
                    matches: [],
                    error: `No entry exists at ${EntryManifest.toPath(scheme, scope.pathname)}.`,
                    extensions: { target: EntryManifest.toPath(scheme, scope.pathname) },
                };
            }
        }
        // SQL receives only the literal prefix and returns a safe superset. Node's
        // path matcher owns the shell-glob truth below: unlike SQLite GLOB, `*`
        // cannot cross `/`, while `**` can. A declared folder scope remains a
        // recursive prefix independent of glob syntax. {§find-scope-prefix-filter}
        const tags = Array.isArray(statement.signal) ? statement.signal : []; // tag filter, AND semantics — {§find-tag-filter-and-semantics}
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, workspaceId } = ctx;
        // Candidates are workspace-bounded — a FIND never reaches across workspaces ({§find-scoped-isolation})
        // — and owner-keyed ({§entry-owner}): an owner-carved face passes its resolved owner; every
        // other scheme draws from the commons.
        type Candidate = { entry_id: number; pathname: string; deep_hash: string | null; content?: string; mimetype?: string };
        const semantic = statement.body?.dialect === "semantic";
        let candidates = await db[semantic ? "find_workspace_entry_candidate_ids" : "find_workspace_entry_candidates"].all<Candidate>({
            workspace_id: workspaceId,
            owner_id: explicitOwnerId ?? await Owner.commonsId(db, workspaceId),
            scheme,
            ...(semantic ? {} : { channel: manifest.defaultChannel }),
            scope_prefix: scope?.candidatePrefix ?? null,
            tags: tagsParam,
        });
        const candidatePathnames = statement.body === null && scope?.kind === "glob" && scope.shallowPrefix !== null
            ? candidates.map((candidate) => candidate.pathname)
            : undefined;

        if (scope !== null) {
            try {
                candidates = candidates.filter((c) => pathScopeMatches(scope, c.pathname));
            } catch {
                return {
                    status: 400,
                    matches: [],
                    error: `The path glob '${scopePathname ?? ""}' is malformed.`,
                    extensions: {
                        target: scopePathname ?? "",
                        recovery: "Correct the target glob.",
                        retryable: false,
                    },
                };
            }
        }

        // Every dialect resolves to one selection per resource. Content
        // dialects already carry honest match evidence; relation dialects map
        // their indexed source spans into readable TextRegions below.
        let matches: Match[];
        if (statement.body !== null && statement.body.dialect === "semantic") {
            // Semantic rank is exhaustive within the SAME target/tag candidate set as every
            // other matcher. Passing entry identities into the ranker preserves ranking meaning:
            // constrain first, then rank, never rank the corpus and discard out-of-scope hits.
            const { mimetypes } = ctx;
            if (mimetypes === undefined) {
                return {
                    status: 501,
                    matches: [],
                    error: "Semantic search requires the mimetypes capability.",
                    extensions: {
                        stage: "semantic-search",
                        retryable: false,
                    },
                };
            }
            const selection = EntrySemantic.resultSelection(statement.lineMarker);
            const candidateSet = resolveSearchCandidates(
                candidates.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return {
                status: 503,
                matches: [],
                error: `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected entries.`,
                extensions: {
                    search: candidateSet,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            };
            const ranked = await EntrySemantic.rankCandidates(
                ctx.db,
                candidateSet.candidates,
                mimetypes,
                statement.body.raw,
                selection,
            );
            if (ranked.status !== 200) {
                return {
                    status: ranked.status,
                    matches: [],
                    error: ranked.status === 501
                        ? "Similarity-threshold search requires an embedding provider."
                        : "The requested similarity threshold is outside the supported range.",
                    extensions: {
                        stage: "semantic-search",
                        ...(selection.threshold === null ? {} : { threshold: selection.threshold }),
                        recovery: ranked.status === 501
                            ? "Remove the decimal similarity threshold while embeddings are unavailable."
                            : "Use a similarity threshold greater than zero and less than one.",
                        retryable: false,
                    },
                };
            }
            let selected = ranked.results;
            if (selection.page !== null) {
                const page = LineMarkerOps.page(selected, selection.page);
                if (page.status !== 200) {
                    return {
                        status: page.status,
                        matches: [],
                        problem: page.problem,
                        range: page.range,
                    };
                }
                selected = page.items ?? [];
            }
            matches = await EntryFind.#addTextRegions(
                selected.map((x): SourceCandidateMatch => ({
                    key: x.key,
                    span: { lineStart: x.lineStart, lineEnd: x.lineEnd },
                })),
                ctx,
                manifest,
                explicitOwnerId,
            );
        } else if (statement.body === null) {
            matches = candidates.map((c) => ({ pathname: c.pathname, matches: [] }));
        } else if (statement.body.dialect === "graph") {
            // @graph (plurnk-service#186): body is `@<sym` / `@>sym` / `@sym`. EntryGraph resolves
            // the relation across (workspace, scheme), each as a (file, span); intersect with the
            // in-scope candidates (target glob + tags) for the final set.
            const scopedCandidates = resolveSearchCandidates(
                candidates.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            );
            if (scopedCandidates.state === "incomplete") return {
                status: 503,
                matches: [],
                error: `The persistent search index covers ${scopedCandidates.indexed} of ${scopedCandidates.total} selected entries.`,
                extensions: {
                    search: scopedCandidates,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            };
            const universeRows = await ctx.db.find_workspace_derivation_candidates.all<{ key: string; deep_hash: string | null }>({
                workspace_id: ctx.workspaceId,
            });
            const universe = resolveSearchCandidates(
                universeRows.map(({ key, deep_hash }) => ({ key, deepHash: deep_hash })),
            );
            if (universe.state === "incomplete") return {
                status: 503,
                matches: [],
                error: `The persistent search index covers ${universe.indexed} of ${universe.total} entries in the relationship universe.`,
                extensions: {
                    search: universe,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            };
            const graph = await EntryGraph.matchCandidates(
                ctx.db,
                universe.candidates,
                scopedCandidates.candidates,
                statement.body.raw,
            );
            if (graph.status !== 200) {
                return {
                    status: graph.status,
                    matches: [],
                    error: `The graph matcher '${statement.body.raw}' is malformed.`,
                    extensions: {
                        stage: "matcher",
                        dialect: "graph",
                        recovery: "Correct or remove the matcher.",
                        retryable: false,
                    },
                };
            }
            matches = await EntryFind.#addTextRegions(
                graph.matches.map((m): SourceCandidateMatch => ({
                    key: m.key,
                    span: { lineStart: m.lineStart, lineEnd: m.lineEnd },
                })),
                ctx,
                manifest,
                explicitOwnerId,
            );
        } else {
            const { mimetypes } = ctx;
            if (mimetypes === undefined) throw new Error("EntryFind.#matchPathnames: body matcher requires the mimetypes capability in ctx");
            // {§find-source-agnostic} — the shared content-matcher primitive (Log.find runs the same
            // one over log rows). Candidates key by pathname; each hit becomes a Match.
            const r = await Matcher.matchCandidates(statement.body, candidates.map((c) => {
                if (c.content === undefined || c.mimetype === undefined) throw new Error("EntryFind.#matchPathnames: content candidate is incomplete");
                return { key: c.pathname, content: c.content, mimetype: c.mimetype };
            }), mimetypes);
            if (r.status !== 200) return {
                status: r.status,
                matches: [],
                problem: r.problem,
            };
            matches = r.matches.map((match) => ({ pathname: match.key, matches: match.matches }));
        }

        if (statement.lineMarker !== null && statement.body?.dialect !== "semantic" && candidatePathnames === undefined) {
            const page = LineMarkerOps.page(matches, statement.lineMarker);
            if (page.status !== 200) {
                if (statement.body !== null && matches.length === 0) {
                    const failure = Results.failure(
                        `scheme:${manifest.name}`,
                        "selection-range-unavailable",
                        416,
                        `The ${statement.body.dialect} matcher selected 0 resources; <${statement.lineMarker.marks.join(",")}> cannot select from an empty result set.`,
                        {
                            matches: [],
                            range: page.range,
                        },
                        {
                            stage: "selection",
                            dialect: statement.body.dialect,
                            matchedResources: 0,
                            range: page.range,
                            recovery: "Correct or remove the matcher before choosing a range.",
                            retryable: false,
                        },
                    );
                    if (failure.problem === undefined) {
                        throw new Error("FIND selection range failure has no Problem Details");
                    }
                    return {
                        status: failure.status,
                        matches: [],
                        problem: failure.problem,
                        range: page.range,
                    };
                }
                return {
                    status: page.status,
                    matches: [],
                    problem: page.problem,
                    range: page.range,
                };
            }
            matches = page.items ?? [];
        }
        return { status: 200, matches, ...(scope === null ? {} : { scope }), ...(candidatePathnames === undefined ? {} : { candidatePathnames }) };
    }

    static async #addTextRegions(
        matches: readonly SourceCandidateMatch[],
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        explicitOwnerId?: number,
    ): Promise<Match[]> {
        if (matches.every(({ span }) => span === null)) {
            return [...new Set(matches.map(({ key }) => key))].map((pathname) => ({ pathname, matches: [] }));
        }
        const scheme = EntryCrud.identityScheme(manifest);
        const ownerId = explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId);
        const candidates: Array<{ key: string; content: string; mimetype: string }> = [];
        for (const pathname of new Set(matches.filter(({ span }) => span !== null).map(({ key }) => key))) {
            const row = await ctx.db.ops_read_channel.get<{ content: string; mimetype: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: ownerId,
                scheme,
                pathname,
                channel: manifest.defaultChannel,
            });
            if (row === undefined) throw new Error(`EntryFind.#addTextRegions: matched entry ${pathname} has no default channel`);
            candidates.push({ key: pathname, ...row });
        }
        const resolved = Matcher.addTextRegions(matches, candidates);
        return resolved.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
    }

    // FIND result = the scheme's catalog rows, filtered to the matched entries and kept in
    // match order. A catalog row is exactly what the manifest catalogs (path + per-channel
    // {mimetype, tokens, lines}, tags, stream lifecycle) — FIND is the filtered, navigable slice of
    // that catalog, rendered as a JSON array (application/json). {§find-result-catalog-rows}
    static async findWorkspaceEntries(statement: FindStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<FindResult> {
        const match = await EntryFind.#matchPathnames(statement, ctx, manifest, explicitOwnerId);
        if (match.status !== 200) {
            const empty = { content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
            if (match.problem !== undefined) {
                return Results.assert({
                    status: match.status,
                    problem: match.problem,
                    ...empty,
                }) as FindResult;
            }
            if (match.error === undefined) {
                throw new Error(`EntryFind selection failed with status ${match.status} without Problem Details or a diagnostic.`);
            }
            return Results.failure(
                `scheme:${manifest.name}`,
                match.status === 404 ? "entry-not-found" : match.status === 416 ? "range-not-satisfiable" : "find-failed",
                match.status,
                match.error,
                empty,
                {
                    ...(match.range === undefined ? {} : { range: match.range }),
                    ...match.extensions,
                },
            ) as FindResult;
        }
        const scheme = EntryCrud.identityScheme(manifest);
        // The catalog row is keyed by its addressable path; align each selected
        // resource to its row through the same EntryManifest.toPath the catalog
        // uses. Resource order is preserved (rank for ~semantic).
        // {§entry-owner} — the alignment draws from the SAME owner the candidates matched, so a
        // match never pairs with a coordinate-twin sibling's catalog metadata.
        const byPath = new Map((await EntryManifest.catalogRowsFor(ctx, scheme, explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId))).map((r) => [r.path, r] as const));
        let results: MatchItem[] = [];
        const matches: Match[] = [];
        let itemsTokenTotal = 0;
        for (const m of match.matches) {
            const row = byPath.get(EntryManifest.toPath(scheme, m.pathname));
            if (row === undefined) continue;
            results.push(m.matches.length > 0 ? { ...row, matches: m.matches } : row);
            matches.push(m);
            itemsTokenTotal += Object.values(row.channels).reduce((sum, channel) => sum + channel.tokens, 0);
        }
        // A terminal single-star catalog is a one-level map. Keep real entries
        // at that level and collapse deeper descendants into exact, actionable
        // `dir/**` scopes. The summaries are navigation metadata, not hidden
        // matches: READ(*) still fans out only over the direct real entries.
        if (statement.body === null && match.scope !== undefined && match.candidatePathnames !== undefined) {
            for (const folder of pathFolderSummaries(match.scope, match.candidatePathnames)) {
                let tokens = 0;
                let items = 0;
                for (const pathname of folder.pathnames) {
                    const row = byPath.get(EntryManifest.toPath(scheme, pathname));
                    if (row === undefined) continue;
                    items++;
                    tokens += Object.values(row.channels).reduce((sum, channel) => sum + channel.tokens, 0);
                }
                if (items > 0) {
                    results.push({ path: EntryManifest.toPath(scheme, folder.selector), items, tokens });
                    itemsTokenTotal += tokens;
                }
            }
            results.sort((a, b) => a.path.localeCompare(b.path));

            // `<L>` pages the catalog the model actually sees, folder summaries
            // included. Only retained real-entry rows remain fan-out matches.
            if (statement.lineMarker !== null) {
                const page = LineMarkerOps.page(results, statement.lineMarker);
                if (page.status !== 200) {
                    if (page.problem === undefined) {
                        throw new Error("FIND pagination failed without Problem Details");
                    }
                    return Results.assert({
                        status: page.status,
                        problem: page.problem,
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsTokenTotal: 0,
                        pathnames: [],
                        matches: [],
                    }) as FindResult;
                }
                results = page.items ?? [];
                const retained = new Set(results.filter((item) => item.items === undefined).map((item) => item.path));
                for (let i = matches.length - 1; i >= 0; i--) {
                    if (!retained.has(EntryManifest.toPath(scheme, matches[i].pathname))) matches.splice(i, 1);
                }
                itemsTokenTotal = results.reduce((sum, item) => sum + (
                    item.items === undefined
                        ? Object.values(item.channels).reduce((channelSum, channel) => channelSum + channel.tokens, 0)
                        : item.tokens ?? 0
                ), 0);
            }
        }
        // {§find-count-not-contents} (#418) — a repo-scale FIND(**) over a 19k-entry workspace can't
        // enumerate: materializing every match overflows the window (a clean grind should not be a
        // crash-and-recover). Over the render budget, the result is a COUNT + narrow steer instead
        // of the rows — the model sees "N match, too broad, narrow it" and adapts. INDEPENDENT of
        // the window size: even a 256k window shouldn't render a whole repo's catalog into a turn.
        // The meta line's count + itemsTokenTotal still self-describe the hit set. Budget is a knob
        // (reader-declared); 0/unset = no gate (small workspaces enumerate as before).
        const budget = Number.parseInt(process.env.PLURNK_SERVICE_FIND_MAX_MATCHES ?? "0", 10);
        if (budget > 0 && results.length > budget) {
            const noun = results.some((item) => item.items !== undefined) ? "catalog items" : "entries";
            const steer = `${results.length} ${noun} match, exceeding the render budget (${budget}) — not enumerated.`;
            // Count-forward means COUNT ONLY. Retaining the enumerated arrays behind a
            // terse rendered steer defeated the contract twice: callers could still fan
            // every hidden match into work, and the full objects stayed resident. The
            // Omitted count + aggregate weight are the complete bounded result.
            return {
                status: 200,
                content: steer,
                mimetype: "text/markdown",
                results: [],
                itemsTokenTotal,
                pathnames: [],
                matches: [],
                omittedItems: results.length,
                maximumItems: budget,
            };
        }
        // Compact within rows; the single top-level boundary newline makes
        // result ordinal N the universally numbered packet line N.
        return {
            status: 200,
            content: renderFindContent(results),
            mimetype: "application/json",
            results,
            itemsTokenTotal,
            pathnames: matches.map(({ pathname }) => pathname),
            matches,
        };
    }
}
