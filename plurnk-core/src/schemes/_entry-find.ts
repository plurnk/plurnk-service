// FIND helper for entry-bearing schemes (SPEC {§find}; plurnk.md FIND row).
// FIND resolves one of two questions from the target shape. A broad target
// returns catalog resources; an exact matcher target returns flat addressable
// match locations. The content itself remains a READ.
//
// FIND slot semantics (contracts SPEC §4/§7):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath/~semantic/@graph). A content matcher
//             runs against the addressed channel's CONTENT (Matcher.matchAgainstContent
//             → the mimetypes plugin) and INCLUDES/EXCLUDES the entry — e.g.
//             log FIND over `log:///**/error` with `/timeout/i` keeps matching rows.
//   signal  — classifies the durable FIND log item; never filters resources
//   <L>     — result pagination: resource or match-location positions N..M

import { DEFAULT_RETRIEVAL_LIMIT, PathSyntax, renderJsonResult, type FindStatement, type RangeExtent, type TextRegion } from "@plurnk/plurnk-contracts";
import { LineMarkerOps } from "../content/index.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import type { SourceCandidateMatch } from "../content/matcher.ts";
import { entryPathnameOf } from "../core/plurnk-uri.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryManifest, { type CatalogChannel, type CatalogDefaultChannel } from "./_entry-manifest.ts";
import Owner from "../core/Owner.ts";
import EntrySemantic from "./_entry-semantic.ts";
import Results, { type ProblemDetails, type SchemeResultBase } from "../core/results.ts";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { pathFolderSummaries, pathScope, pathScopeMatches, type PathScope } from "./_path-scope.ts";

export interface Match { pathname: string; matches: MatchEvidence[]; }
export type CatalogScope = {
    path: string;
    items: number;
    weight: number;
    matchLocationCount?: never;
    locator?: never;
    region?: never;
};
export type CatalogMatch = [
    CatalogDefaultChannel & { items?: never; locator?: string; region?: TextRegion; matchLocationCount?: number },
    ...CatalogChannel[],
];
export type CatalogScopeGroup = [CatalogScope];
export type CatalogResource = CatalogMatch | CatalogScopeGroup;
export type MatchLocation = MatchEvidence & {
    path?: never;
    items?: never;
    weight?: never;
    matchLocationCount?: never;
};
export type MatchItem = CatalogResource | MatchLocation;

export const findItemWeight = (item: CatalogResource): number => "items" in item[0]
    ? item[0].weight
    : item.reduce((sum, channel) => sum + channel.weight, 0);

export interface FindFields {
    readonly [field: string]: unknown;
    content: string | null;
    mimetype: string | null;
    results: MatchItem[];
    itemsWeightTotal: number;
    returnedItemsWeightTotal: number;
    matchingPathCount: number;
    matchLocationCount: number;
    range?: RangeExtent;
}

export interface FindResult extends SchemeResultBase, FindFields {}

export interface FindProjectionResource {
    readonly item: CatalogMatch;
    readonly match: Match;
}

interface FindAddress {
    readonly ownerId?: number;
    readonly pathname?: string;
}

export const emptyFindFields = (): FindFields => ({
    content: null,
    mimetype: null,
    results: [],
    itemsWeightTotal: 0,
    returnedItemsWeightTotal: 0,
    matchingPathCount: 0,
    matchLocationCount: 0,
});

const uniqueMatchLocations = (locations: readonly MatchEvidence[]): MatchLocation[] => {
    const seen = new Set<string>();
    const unique: MatchLocation[] = [];
    for (const location of locations) {
        const key = JSON.stringify(location);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(location);
    }
    return unique;
};

// Scheme results retain model-independent curation `weight`. The generated
// JSON body is the final model-facing boundary, where the familiar `tokens`
// label intentionally describes the same OPEN/FOLD cost shown in the packet.
const renderFindContent = (items: readonly MatchItem[]): string => renderJsonResult(
    items.map((item) => Array.isArray(item)
        ? item.map((row) => {
            if (!Object.hasOwn(row, "weight") || Object.hasOwn(row, "tokens")) {
                throw new TypeError("a FIND catalog row requires exactly one internal weight field");
            }
            return Object.fromEntries(
                Object.entries(row).map(([key, value]) => [key === "weight" ? "tokens" : key, value]),
            );
        })
        : item),
);

// {§find-result-projection} — selection remains grouped internally because
// schemes and curation operate on resources. This one public projection owns
// target-shape mode, pagination, counts, and rendering for every FIND source.
export const projectFindResult = (
    statement: FindStatement,
    scope: PathScope,
    resources: readonly FindProjectionResource[],
    scopes: readonly CatalogScope[] = [],
): FindResult => {
    const resourcePaths = new Set<string>();
    for (const { item } of resources) {
        const path = item[0].path;
        if (resourcePaths.has(path)) {
            throw new Error(`FIND selection contains duplicate resource ${JSON.stringify(path)}`);
        }
        resourcePaths.add(path);
    }

    const matchingPathCount = resources.length;
    const matchLocationCount = resources.reduce((sum, { match }) => sum + uniqueMatchLocations(match.matches).length, 0);
    const itemsWeightTotal = resources.reduce((sum, { item }) => sum + findItemWeight(item), 0)
        + scopes.reduce((sum, item) => sum + item.weight, 0);
    const fields = {
        content: null,
        mimetype: null,
        results: [] as MatchItem[],
        itemsWeightTotal,
        returnedItemsWeightTotal: 0,
        matchingPathCount,
        matchLocationCount,
    };

    const locationMode = statement.body !== null && scope.kind === "exact";
    let completeItems: MatchItem[];
    if (locationMode) {
        completeItems = uniqueMatchLocations(resources.flatMap(({ match }) => match.matches));
    } else {
        const resourceItems: CatalogResource[] = [
            ...resources.map(({ item, match }): CatalogMatch => {
                if (statement.body === null) return item;
                const locations = uniqueMatchLocations(match.matches);
                const single = locations.length === 1 ? locations[0] : undefined;
                return [
                    {
                        ...item[0],
                        matchLocationCount: locations.length,
                        ...(single?.locator === undefined ? {} : { locator: single.locator }),
                        ...(single?.region === undefined ? {} : { region: single.region }),
                    },
                    ...item.slice(1),
                ];
            }),
            ...scopes.map((item): CatalogScopeGroup => [item]),
        ];
        if (scopes.length > 0) {
            resourceItems.sort((a, b) => a[0].path.localeCompare(b[0].path));
        }
        completeItems = resourceItems;
    }

    const marker = statement.body?.dialect === "semantic"
        ? EntrySemantic.resultSelection(statement.lineMarker).page
        : statement.lineMarker ?? { marks: [1, DEFAULT_RETRIEVAL_LIMIT] };
    const unit = locationMode ? "matchLocation" : "resource";
    const page = LineMarkerOps.page(completeItems, marker, {
        unit,
        allowEmpty: statement.body !== null || statement.lineMarker === null,
    });
    if (page.status !== 200) {
        if (page.problem === undefined) throw new Error("FIND pagination failed without Problem Details");
        return Results.assert({ status: page.status, problem: page.problem, ...fields, range: page.range }) as FindResult;
    }

    if (statement.body !== null && matchingPathCount === 0) {
        return {
            status: 204,
            ...fields,
            ...(page.range === undefined ? {} : { range: page.range }),
        };
    }

    const results = page.items ?? [];
    const returnedItemsWeightTotal = locationMode
        ? itemsWeightTotal
        : results.reduce((sum, item) => sum + findItemWeight(item as CatalogResource), 0);
    return {
        status: 200,
        content: renderFindContent(results), // {§find-result-projection} {§json-result-rendering}
        mimetype: "application/json",
        results,
        itemsWeightTotal,
        returnedItemsWeightTotal,
        matchingPathCount,
        matchLocationCount,
        ...(page.range === undefined ? {} : { range: page.range }),
    };
};

export default class EntryFind {
    static #targetPath(scheme: string, pathname: string, fragment: string | null): string {
        const path = EntryManifest.toPath(scheme, pathname);
        return fragment === null ? path : `${path}#${PathSyntax.escapeTarget(fragment)}`;
    }

    static #scopePathnameOf(statement: FindStatement): string | null {
        const path = statement.target;
        if (path === null) return null;
        // FIND addresses the same canonical entry identity as READ and direct
        // CRUD. Both namespace authorities and network hosts are part of that
        // identity and must survive the exact-entry lookup.
        return entryPathnameOf(path);
    }

    // Resolve a FIND to its matched workspace resources — entry-level, unique, in result
    // order (rank for ~semantic, candidate order otherwise). Candidate selection (scope +
    // scope) runs in SQL (find_workspace_entry_candidates); a content matcher then runs against
    // each candidate's addressed-channel CONTENT (Matcher.matchAgainstContent → the mimetypes
    // plugin) and INCLUDES/EXCLUDES the entry - 200 keeps it, 204/203 drop it, and a
    // 4xx matcher failure ends the whole operation. Path-scoping stays in the (target). Match
    // locations remain grouped by resource internally until the target-shaped public projection.
    static async #matchPathnames(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: FindAddress,
    ): Promise<{
        status: number;
        matches: Match[];
        channel?: string;
        scope?: PathScope;
        candidatePathnames?: string[];
        code?: string;
        error?: string;
        problem?: ProblemDetails;
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
        const fragment = statement.target.kind === "url" ? statement.target.fragment : null;
        const channel = fragment ?? manifest.defaultChannel;
        const availableChannels = [...new Set([
            manifest.defaultChannel,
            ...Object.keys(manifest.channels),
        ])].filter((candidate) => candidate.length > 0);
        if (channel.length === 0) {
            return {
                status: 400,
                matches: [],
                code: "channel-required",
                error: `The '${manifest.name}' scheme has no default channel.`,
                extensions: {
                    scheme: manifest.name,
                    recovery: "Address a named channel with a URI fragment.",
                    retryable: false,
                },
            };
        }
        if (
            fragment !== null
            && fragment !== manifest.defaultChannel
            && !Object.hasOwn(manifest.channels, fragment)
        ) {
            return {
                status: 400,
                matches: [],
                code: "channel-not-found",
                error: `Channel #${fragment} is not declared by the '${manifest.name}' scheme.`,
                extensions: {
                    requestedChannel: fragment,
                    availableChannels,
                    ...(availableChannels.length === 0
                        ? {}
                        : {
                            recovery: `Use one of the available channels: ${availableChannels
                                .map((candidate) => `#${candidate}`)
                                .join(", ")}.`,
                        }),
                    retryable: false,
                },
            };
        }
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);
        const scopePathname = address.pathname ?? EntryFind.#scopePathnameOf(statement);
        const scope = scopePathname === null
            ? null
            : pathScope(scopePathname, manifest.folderScopes === true);
        // {§fs-errno} — an exact-path miss is ENOENT; an empty glob or folder
        // survey is a successful empty result.
        if (scope?.kind === "exact" && scope.pathname.length > 0) {
            const exact = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: address.ownerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme, pathname: scope.pathname,
            });
            if (exact === undefined) {
                const target = EntryFind.#targetPath(scheme, scope.pathname, fragment);
                return {
                    status: 404,
                    matches: [],
                    code: "entry-not-found",
                    error: `No entry exists at ${target}.`,
                    extensions: { target },
                };
            }
        }
        // SQL receives only the literal prefix and returns a safe superset. Node's
        // path matcher owns the shell-glob truth below: unlike SQLite GLOB, `*`
        // cannot cross `/`, while `**` can. A declared folder scope remains a
        // recursive prefix independent of glob syntax. {§find-scope-prefix-filter}
        const { db, workspaceId } = ctx;
        // Candidates are workspace-bounded — a FIND never reaches across workspaces ({§find-scoped-isolation})
        // — and owner-keyed ({§entry-owner}): an owner-carved face passes its resolved owner; every
        // other scheme draws from the commons.
        type Candidate = { entry_id: number; pathname: string; deep_hash: string | null; content?: string; mimetype?: string };
        const semantic = statement.body?.dialect === "semantic";
        let candidates = await db[semantic ? "find_workspace_entry_candidate_ids" : "find_workspace_entry_candidates"].all<Candidate>({
            workspace_id: workspaceId,
            owner_id: address.ownerId ?? await Owner.commonsId(db, workspaceId),
            scheme,
            channel,
            scope_prefix: scope?.candidatePrefix ?? null,
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
        if (scope?.kind === "exact" && candidates.length === 0) {
            const target = EntryFind.#targetPath(scheme, scope.pathname, fragment);
            return {
                status: 404,
                matches: [],
                code: "entry-not-found",
                error: `No entry exists at ${target}.`,
                extensions: { target },
            };
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
            matches = await EntryFind.#addTextRegions(
                ranked.results.map((x): SourceCandidateMatch => ({
                    key: x.key,
                    span: { lineStart: x.lineStart, lineEnd: x.lineEnd },
                })),
                ctx,
                manifest,
                channel,
                address.ownerId,
            );
        } else if (statement.body === null) {
            matches = candidates.map((c) => ({ pathname: c.pathname, matches: [] }));
        } else if (statement.body.dialect === "graph") {
            // {§relation-indexed-dialects} Body is `@<sym` / `@>sym` / `@sym`. EntryGraph resolves
            // the relation across (workspace, scheme), each as a (file, span); intersect with the
            // in-scope candidates from the target glob for the final set.
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
                channel,
                address.ownerId,
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

        return { status: 200, matches, channel, ...(scope === null ? {} : { scope }), ...(candidatePathnames === undefined ? {} : { candidatePathnames }) };
    }

    static async #addTextRegions(
        matches: readonly SourceCandidateMatch[],
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        channel: string,
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
                channel,
            });
            if (row === undefined) throw new Error(`EntryFind.#addTextRegions: matched entry ${pathname} has no selected channel ${channel}`);
            candidates.push({ key: pathname, ...row });
        }
        const resolved = Matcher.addTextRegions(matches, candidates);
        return resolved.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
    }

    // FIND result = the scheme's default-first channel groups, filtered to the matched
    // entries and kept in match order. FIND is the filtered, navigable slice of that
    // catalog, rendered as a JSON array (application/json). {§find-result-projection}
    static async findWorkspaceEntries(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: FindAddress = {},
    ): Promise<FindResult> {
        const match = await EntryFind.#matchPathnames(statement, ctx, manifest, address);
        const empty = emptyFindFields();
        if (match.status !== 200) {
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
                match.code ?? (match.status === 404 ? "entry-not-found" : match.status === 416 ? "range-not-satisfiable" : "find-failed"),
                match.status,
                match.error,
                empty,
                match.extensions,
            ) as FindResult;
        }
        const scheme = EntryCrud.identityScheme(manifest);
        // The catalog group's default channel carries its bare addressable path;
        // align each selected resource through the same EntryManifest.toPath the catalog
        // uses. Resource order is preserved (rank for ~semantic).
        // {§entry-owner} — the alignment draws from the SAME owner the candidates matched, so a
        // match never pairs with a coordinate-twin sibling's catalog metadata.
        const byPath = new Map((await EntryManifest.catalogRowsFor(ctx, scheme, address.ownerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId))).map((r) => [r[0].path, r] as const));
        const resources: FindProjectionResource[] = [];
        for (const m of match.matches) {
            const row = byPath.get(EntryManifest.toPath(scheme, m.pathname));
            if (row === undefined) continue;
            resources.push({ item: row, match: m });
        }
        // A terminal single-star catalog is a one-level map. Keep real entries
        // at that level and collapse deeper descendants into exact, actionable
        // `dir/**` scopes. The summaries are navigation metadata, not hidden
        // resource matches.
        const scopes: CatalogScope[] = [];
        if (statement.body === null && match.scope !== undefined && match.candidatePathnames !== undefined) {
            for (const folder of pathFolderSummaries(match.scope, match.candidatePathnames)) {
                let weight = 0;
                let items = 0;
                for (const pathname of folder.pathnames) {
                    const row = byPath.get(EntryManifest.toPath(scheme, pathname));
                    if (row === undefined) continue;
                    items++;
                    weight += row.reduce((sum, channel) => sum + channel.weight, 0);
                }
                if (items > 0) {
                    scopes.push({ path: EntryManifest.toPath(scheme, folder.selector), items, weight });
                }
            }
        }
        if (match.scope === undefined) throw new Error("FIND selection succeeded without a path scope");
        const projected = projectFindResult(statement, match.scope, resources, scopes);
        if (address.pathname === undefined) return projected;

        // Exact FIND consumes the same selected canonical producer as exact
        // READ. Query projection remains core-owned, while the durable selected-
        // channel outcome survives cold and warm acquisition identically.
        const stored = await EntryCrud.readEntry(
            address.pathname,
            ctx,
            scheme,
            address.ownerId,
        );
        if (stored.status !== 200 || stored.entry === null) {
            throw new Error(
                `EntryFind projected exact entry ${address.pathname} but could not read its canonical representation.`,
            );
        }
        if (match.channel === undefined) throw new Error("FIND selection succeeded without a selected channel");
        const producerResult = stored.entry.channels[match.channel]?.producerResult;
        return producerResult === undefined
            ? projected
            : Results.assert({
                ...producerResult,
                ...projected,
                status: producerResult.status,
            }) as FindResult;
    }
}
