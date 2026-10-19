// FIND helper for entry-bearing schemes (SPEC {§find}; plurnk.md FIND row).
// FIND resolves one of two questions from the target shape. A broad target
// returns catalog resources; an exact matcher target returns flat addressable
// match locations. The content itself remains a READ.
//
// FIND slot semantics (contracts SPEC §4/§7):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath/~full-text/&graph). A content matcher
//             runs against the addressed channel's CONTENT (Matcher.matchAgainstContent
//             → the mimetypes framework) and INCLUDES/EXCLUDES the entry — e.g.
//             log FIND over `log:///**/error` with `/timeout/i` keeps matching rows.
//   signal  — classifies the durable FIND log item; never filters resources
//   <L>     — result pagination: resource or match-location positions N..M

import { PathSyntax, renderJsonResult, type FindStatement, type RangeExtent, type TextRegion } from "@plurnk/plurnk-contracts";
import { LineMarkerOps, MimetypeBinary } from "../content/index.ts";
import BodyPreview from "../content/body-preview.ts";
import ScopeFormat from "../content/scope-format.ts";
import ByteView, { type ByteSource } from "../content/byte-view.ts";
import type { AdmissionProposal, AmbientMembers, PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import { entryCoordinateOf, missDetail, missExtensions } from "../core/plurnk-uri.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryManifest, { type CatalogChannel, type CatalogDefaultChannel, type CatalogEntry } from "./_entry-manifest.ts";
import EntryFts from "./_entry-fts.ts";
import Results, { type ProblemDetails, type SchemeResultBase } from "../core/results.ts";
import FileAddress from "../core/FileAddress.ts";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";
import { resolveSearchCandidates, type SearchCandidateSet } from "./_search-candidate.ts";
import { pathFolderSummaries, pathScope, pathScopeMatches, type PathScope, type PathFolderSummary } from "./_path-scope.ts";

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
type CatalogScopeGroup = [CatalogScope];
export type CatalogResource = CatalogMatch | CatalogScopeGroup;
export type MatchLocation = MatchEvidence & {
    path?: never;
    items?: never;
    weight?: never;
    matchLocationCount?: never;
};
export type MatchItem = CatalogResource | MatchLocation;

const findItemWeight = (item: CatalogResource): number => "items" in item[0]
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
    readonly authority?: string;
    readonly pathname?: string;
    readonly scope?: PathScope;
    // File keys are relative to this directory; other schemes have no filesystem base.
    readonly pathBase?: string;
    // {§worker-tool-admission} — per-asker visibility: a candidate is dropped
    // when this predicate returns false. Counts and weights stay consistent
    // because the filter runs before matching and rendering.
    readonly visible?: (pathname: string) => boolean | Promise<boolean>;
    // {§find-bytes} — the scheme's byte supplier, so a binary channel without a readable
    // projection is searched as bytes rather than skipped.
    readonly bytes?: (pathname: string, authority: string) => ByteSource;
    // {§membership-auto-add} — the model's universe beyond membership; file scheme, model dispatches only.
    readonly ambient?: AmbientMembers;
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

// Scheme results retain model-independent curation `weight` and typed regions. The generated
// JSON body is the final model-facing boundary ({§find-result-projection}): the familiar `tokens`
// label describes the same visible-body cost shown in the packet, a region reads in the one scope
// notation ({§packet-extent-metadata}), and a location names its channel only off the default.
const scoped = (key: string, value: unknown): unknown => key === "region" || key === "enclosingRegion"
    ? ScopeFormat.region(value as TextRegion)
    : value;
const renderFindContent = (items: readonly MatchItem[], defaultChannel: string | undefined): string => renderJsonResult(
    items.map((item) => Array.isArray(item)
        ? item.map((row) => {
            if (!Object.hasOwn(row, "weight") || Object.hasOwn(row, "tokens")) {
                throw new TypeError("a FIND catalog row requires exactly one internal weight field");
            }
            return Object.fromEntries(
                Object.entries(row).map(([key, value]) => [key === "weight" ? "tokens" : key, scoped(key, value)]),
            );
        })
        : Object.fromEntries(Object.entries(item)
            .filter(([key, value]) => key !== "channel" || value !== defaultChannel)
            .map(([key, value]) => [key, scoped(key, value)]))),
);

// {§find-result-projection} — selection remains grouped internally because
// schemes and curation operate on resources. This one public projection owns
// target-shape mode, pagination, counts, and rendering for every FIND source.
export const projectFindResult = (
    statement: FindStatement,
    scope: PathScope,
    resources: readonly FindProjectionResource[],
    scopes: readonly CatalogScope[] = [],
    defaultChannel?: string,
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

    const locationMode = statement.matcher !== null && scope.kind === "exact";
    let completeItems: MatchItem[];
    if (locationMode) {
        completeItems = uniqueMatchLocations(resources.flatMap(({ match }) => match.matches));
    } else {
        const resourceItems: CatalogResource[] = [
            ...resources.map(({ item, match }): CatalogMatch => {
                if (statement.matcher === null) return item;
                const locations = uniqueMatchLocations(match.matches);
                const single = locations.length === 1 ? locations[0] : undefined;
                return [
                    {
                        ...item[0],
                        matchLocationCount: locations.length,
                        ...(single?.locator === undefined ? {} : { locator: single.locator }),
                        ...(single?.region === undefined ? {} : { region: single.region }),
                        ...(single?.enclosingRegion === undefined ? {} : { enclosingRegion: single.enclosingRegion }),
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

    // {§markerless-first-page} — without a scope, every result; whether they fit is decided where the row lands.
    // {§markerless-first-page} — without a scope, the first page of results.
    const marker = statement.lineMarker ?? BodyPreview.firstPage();
    const unit = locationMode ? "matchLocation" : "resource";
    const page = LineMarkerOps.page(completeItems, marker, { unit });
    if (page.status !== 200) {
        if (page.problem === undefined) throw new Error("FIND pagination failed without Problem Details");
        return Results.assert({ status: page.status, problem: page.problem, ...fields, range: page.range });
    }

    if (statement.matcher !== null && matchingPathCount === 0) {
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
        content: renderFindContent(results, defaultChannel), // {§find-result-projection} {§json-result-rendering}
        mimetype: "application/json",
        results,
        itemsWeightTotal,
        returnedItemsWeightTotal,
        matchingPathCount,
        matchLocationCount,
        ...(page.range === undefined ? {} : { range: page.range }),
    };
};

// What a FIND selection resolves to, before the public projection: the matches with their channel, scope
// and folders, an admission proposal, or the refusal.
type MatchOutcome = {
    status: number;
    matches: Match[];
    channel?: string;
    scope?: PathScope;
    folders?: PathFolderSummary[];
    // {§membership-auto-add} — listed candidates that are not members: no catalog row, no admission.
    ambient?: ReadonlySet<string>;
    // {§membership-auto-add} — the text pattern matched inside candidates: their admission is proposed.
    proposal?: AdmissionProposal;
    code?: string;
    error?: string;
    problem?: ProblemDetails;
    extensions?: Readonly<Record<string, unknown>>;
};

// The scope a FIND target names, resolved once for every step after it.
type FindScope = {
    scheme: string;
    projectRoot: string | null;
    authority: string;
    multipleAuthorities: boolean;
    authorityScope: PathScope;
    scopePathname: string | null;
    scope: PathScope | null;
};

// {§find-scoped-isolation} A candidate row retains the selected workspace and literal authority.
type Candidate = { entry_id: number; authority: string; pathname: string; channel: string; deep_hash: string | null; content?: string; mimetype?: string };

// {§relation-indexed-dialects} An indexed dialect over candidates the index does not yet cover.
const incompleteIndex = (
    search: Extract<SearchCandidateSet, { state: "incomplete" }>,
    what: string,
): MatchOutcome => ({
    status: 503,
    matches: [],
    error: `The persistent search index covers ${search.indexed} of ${search.total} ${what}.`,
    extensions: {
        search,
        stage: "search-index",
        recovery: "Wait for search indexing to complete before repeating the search.",
        retryable: true,
    },
});

export default class EntryFind {
    static #targetPath(scheme: string, authority: string, pathname: string, fragment: string | null, projectRoot: string | null): string {
        const path = EntryManifest.toPath(scheme, authority, pathname, projectRoot);
        return fragment === null ? path : `${path}#${PathSyntax.escapeTarget(fragment)}`;
    }

    static #scopeCoordinateOf(statement: FindStatement, manifest: SchemeManifest): { authority: string; pathname: string } | null {
        const path = statement.target;
        if (path === null) return null;
        return entryCoordinateOf(path, manifest.authority ?? "namespace");
    }

    // Resolve a FIND to its matched workspace resources — entry-level, unique, in result
    // order (rank for ~full-text, candidate order otherwise). Candidate selection (scope +
    // scope) runs in SQL (find_workspace_entry_candidates); a content matcher then runs against
    // each candidate's addressed-channel CONTENT (Matcher.matchAgainstContent → the mimetypes
    // framework) and INCLUDES/EXCLUDES the entry - 200 keeps it, 204/203 drop it, and a
    // 4xx matcher failure ends the whole operation. Path-scoping stays in the (target). Match
    // locations remain grouped by resource internally until the target-shaped public projection.
    //
    // The steps run in the order their refusals are owed — the channel, the scope and its exact
    // miss, the candidates, the universe beyond membership, the scope filter, the matcher — and each
    // returns either the refusal or what the next step needs.
    static async #matchPathnames(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: FindAddress,
    ): Promise<MatchOutcome> {
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
        const fragment = statement.target.fragment ?? null;
        const unaddressed = EntryFind.#checkChannel(fragment, manifest);
        if (unaddressed !== null) return unaddressed;
        const found = await EntryFind.#resolveScope(statement, ctx, manifest, address, fragment);
        if ("status" in found) return found;
        const { scheme, authority, multipleAuthorities, scopePathname, scope } = found;
        const superset = await EntryFind.#selectCandidates(statement, ctx, address, fragment, found);
        if ("status" in superset) return superset;
        const coordinateByKey = new Map(superset.map((candidate) => [
            multipleAuthorities ? EntryManifest.toPath(scheme, candidate.authority, candidate.pathname) : candidate.pathname,
            { authority: candidate.authority, pathname: candidate.pathname },
        ]));
        const ambientKeys = await EntryFind.#ambientKeys(statement, address, found, superset);
        const folders = EntryFind.#folderSummaries(statement, address, found, coordinateByKey, ambientKeys);
        const inScope = EntryFind.#scopeCandidates(superset, found, address, fragment, ambientKeys);
        if ("status" in inScope) return inScope;
        const candidates = multipleAuthorities
            ? inScope.map((candidate) => ({ ...candidate, pathname: EntryManifest.toPath(scheme, candidate.authority, candidate.pathname) }))
            : inScope;
        const channels = new Map(candidates.map((candidate) => [candidate.pathname, candidate.channel]));
        const channelOf = (key: string): string => {
            const selected = channels.get(key);
            if (selected === undefined) throw new Error(`FIND candidate lost its selected channel: ${key}`);
            return selected;
        };
        const effectiveBytes = address.bytes === undefined ? undefined : (key: string): ByteSource => {
            const coordinate = coordinateByKey.get(key);
            if (coordinate === undefined) throw new Error(`FIND byte source lost coordinate ${key}`);
            return address.bytes!(coordinate.pathname, coordinate.authority);
        };

        const matches = await EntryFind.#selectMatches(statement, ctx, address, { candidates, ambientKeys, channelOf, effectiveBytes });
        if ("status" in matches) return matches;

        const projectedScope = multipleAuthorities && scopePathname !== null
            ? pathScope(EntryManifest.toPath(scheme, authority, scopePathname), manifest.folderScopes === true)
            : scope;
        return { status: 200, matches, channel: fragment ?? candidates[0]?.channel, ...(projectedScope === null ? {} : { scope: projectedScope }), folders,
            ...(ambientKeys.length === 0 ? {} : { ambient: new Set(ambientKeys) }) };
    }

    // The channel the FIND addresses, refused when the scheme has no default or does not declare it.
    static #checkChannel(fragment: string | null, manifest: SchemeManifest): MatchOutcome | null {
        const availableChannels = [...new Set([
            manifest.defaultChannel,
            ...Object.keys(manifest.channels),
        ])].filter((candidate) => candidate.length > 0);
        if (manifest.defaultChannel.length === 0 && Object.keys(manifest.channels).length > 0 && fragment === null) {
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
            && Object.keys(manifest.channels).length > 0
            && fragment !== manifest.defaultChannel
            && !Object.hasOwn(manifest.channels, fragment)
        ) {
            return {
                status: 404,
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
        return null;
    }

    // The scheme, authority and path scope the target names; an exact path that names nothing is the
    // scheme's miss ({§fs-errno}) unless the universe beyond membership holds it ({§membership-auto-add}).
    static async #resolveScope(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: FindAddress,
        fragment: string | null,
    ): Promise<FindScope | MatchOutcome> {
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);
        const projectRoot = scheme === "file" ? await FileAddress.projectRoot(ctx) : null;
        const authoredCoordinate = EntryFind.#scopeCoordinateOf(statement, manifest);
        const authority = address.authority ?? authoredCoordinate?.authority ?? "";
        const multipleAuthorities = PathSyntax.hasGlob(authority);
        const authorityScope = pathScope(authority, false);
        const scopePathname = address.pathname ?? authoredCoordinate?.pathname ?? null;
        const scope = address.scope ?? (address.pathname !== undefined
            ? { kind: "exact" as const, pathname: address.pathname, candidatePrefix: address.pathname }
            : scopePathname === null
            ? null
            : pathScope(scopePathname, manifest.folderScopes === true));
        // {§fs-errno} — an exact-path miss is ENOENT; an empty glob or folder
        // survey is a successful empty result.
        if (!multipleAuthorities && scope?.kind === "exact" && scope.pathname.length > 0) {
            const exact = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                scheme, authority, pathname: scope.pathname,
            });
            // {§membership-auto-add} — an exact miss on a candidate is a listing or a match, not a 404.
            const ambientExact = exact === undefined && address.ambient !== undefined && scheme === "file"
                && !scope.pathname.startsWith("../") && (await address.ambient.candidates(scope.pathname)).includes(scope.pathname);
            if (exact === undefined && !ambientExact) {
                const target = EntryFind.#targetPath(scheme, authority, scope.pathname, fragment, projectRoot);
                return {
                    status: 404,
                    matches: [],
                    code: "entry-not-found",
                    error: missDetail(scheme, target),
                    extensions: missExtensions(scheme, target),
                };
            }
        }
        return { scheme, projectRoot, authority, multipleAuthorities, authorityScope, scopePathname, scope };
    }

    // {§find-scope-prefix-filter} {§find-scoped-isolation} The candidate rows: SQL's safe superset on the
    // literal prefix, the authority glob applied, the asker's visibility applied, and derivation
    // settled before an indexed dialect reads it.
    static async #selectCandidates(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        address: FindAddress,
        fragment: string | null,
        found: FindScope,
    ): Promise<Candidate[] | MatchOutcome> {
        const { scheme, authority, multipleAuthorities, authorityScope, scope } = found;
        // SQL receives only the literal prefix and returns a safe superset. The
        // path matcher owns the shell-glob truth below: unlike SQLite GLOB, `*`
        // cannot cross `/`, while `**` can. A declared folder scope remains a
        // recursive prefix independent of glob syntax. {§find-scope-prefix-filter}
        const { db, workspaceId } = ctx;
        const fulltext = statement.matcher?.dialect === "fts";
        let candidates = await db[fulltext ? "find_workspace_entry_candidate_ids" : "find_workspace_entry_candidates"].all<Candidate>({
            workspace_id: workspaceId,
            scheme,
            authority: multipleAuthorities ? null : authority,
            channel: fragment,
            scope_prefix: address.pathBase !== undefined && scope?.candidatePrefix?.startsWith("../")
                ? null : scope?.candidatePrefix ?? null,
        });
        candidates = candidates.filter((candidate) => pathScopeMatches(authorityScope, candidate.authority));
        if (address.visible !== undefined) {
            candidates = (await Promise.all(candidates.map(async (candidate) => ({
                candidate,
                visible: await address.visible!(candidate.pathname),
            })))).filter(({ visible }) => visible).map(({ candidate }) => candidate);
        }
        if (ctx.settleDerivations !== undefined && candidates.some((candidate) => candidate.deep_hash === null)) {
            return { status: 503, matches: [], error: "Resource metadata is still being derived.", extensions: { stage: "search-index" } };
        }
        return candidates;
    }

    // {§membership-auto-add} The universe beyond membership that joins the listing and the text match.
    static async #ambientKeys(statement: FindStatement, address: FindAddress, found: FindScope, candidates: readonly Candidate[]): Promise<string[]> {
        const { scheme, multipleAuthorities, scope } = found;
        // {§membership-auto-add} — the universe beyond membership joins the listing and the text match;
        // the indexed dialects (`~`, `&`) see members only, since nothing unadmitted is indexed.
        let ambientKeys: string[] = [];
        if (address.ambient !== undefined && scheme === "file" && !multipleAuthorities
            && !(statement.matcher !== null && (statement.matcher.dialect === "fts" || statement.matcher.dialect === "graph"))
            && !(scope?.candidatePrefix?.startsWith("../") ?? false)) {
            const known = new Set(candidates.map((candidate) => candidate.pathname));
            try {
                ambientKeys = (await address.ambient.candidates(scope?.candidatePrefix ?? null))
                    .filter((key) => !known.has(key) && (scope === null || pathScopeMatches(scope, key, address.pathBase)));
            } catch {
                ambientKeys = [];   // a malformed glob is reported below, by the members' own filter
            }
        }
        return ambientKeys;
    }

    // A listing's folder rows, grouped by authority when the target spans several.
    static #folderSummaries(
        statement: FindStatement,
        address: FindAddress,
        found: FindScope,
        coordinateByKey: ReadonlyMap<string, { authority: string; pathname: string }>,
        ambientKeys: readonly string[],
    ): PathFolderSummary[] {
        const { scheme, authority, multipleAuthorities, scope } = found;
        return statement.matcher === null && scope !== null
            ? [...Map.groupBy([...coordinateByKey.entries(), ...ambientKeys.map((key) => [key, { authority, pathname: key }] as const)], ([, coordinate]) => coordinate.authority)]
                .flatMap(([groupAuthority, entries]) => pathFolderSummaries(scope, entries.map(([, coordinate]) => coordinate.pathname), address.pathBase)
                    .map((folder) => ({
                        selector: multipleAuthorities ? EntryManifest.toPath(scheme, groupAuthority, folder.selector) : folder.selector,
                        pathnames: folder.pathnames.map((pathname) => multipleAuthorities ? EntryManifest.toPath(scheme, groupAuthority, pathname) : pathname),
                    })))
            : [];
    }

    // The shell-glob truth over the candidates ({§find-scope-prefix-filter}): a malformed glob is refused by
    // name, and an exact path left with nothing is the scheme's miss.
    static #scopeCandidates(
        candidates: Candidate[],
        found: FindScope,
        address: FindAddress,
        fragment: string | null,
        ambientKeys: readonly string[],
    ): Candidate[] | MatchOutcome {
        const { scheme, projectRoot, authority, multipleAuthorities, scopePathname, scope } = found;
        let inScope = candidates;
        if (scope !== null) {
            try {
                inScope = candidates.filter((c) => pathScopeMatches(scope, c.pathname, address.pathBase));
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
        if (!multipleAuthorities && scope?.kind === "exact" && inScope.length === 0 && ambientKeys.length === 0) {
            const target = EntryFind.#targetPath(scheme, authority, scope.pathname, fragment, projectRoot);
            return {
                status: 404,
                matches: [],
                code: "entry-not-found",
                error: missDetail(scheme, target),
                extensions: missExtensions(scheme, target),
            };
        }
        return inScope;
    }

    // Every dialect resolves to one selection per resource: rank for ~full-text, the relation index for
    // &graph, every candidate for a bare listing, and the content matcher otherwise. Content dialects
    // already carry honest match evidence; relation dialects map their indexed source spans into readable
    // TextRegions.
    static async #selectMatches(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        address: FindAddress,
        selection: {
            candidates: Candidate[];
            ambientKeys: string[];
            channelOf: (key: string) => string;
            effectiveBytes: ((key: string) => ByteSource) | undefined;
        },
    ): Promise<Match[] | MatchOutcome> {
        const { candidates, ambientKeys, channelOf } = selection;
        let matches: Match[];
        if (statement.matcher !== null && statement.matcher.dialect === "fts") {
            const candidateSet = resolveSearchCandidates(
                candidates.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return incompleteIndex(candidateSet, "selected entries");
            const ranked = await EntryFts.rankCandidates(
                ctx.db, candidateSet.candidates, statement.matcher.raw.slice(1), ctx.signal,
            );
            if (ranked.status !== 200) return { status: ranked.status, matches: [], problem: ranked.problem };
            matches = ranked.matches.map(({ key, matches: locations }) => ({ pathname: key, matches: locations }));
        } else if (statement.matcher === null) {
            matches = [...candidates.map((c) => ({ pathname: c.pathname, matches: [] })), ...ambientKeys.map((pathname) => ({ pathname, matches: [] }))];
        } else if (statement.matcher.dialect === "graph") {
            // {§relation-indexed-dialects} Parser admission owns graph syntax;
            // this remains a defensive boundary for typed/programmatic callers.
            if (!/^&[<>]?[^\s<>]\S*$/.test(statement.matcher.raw)) return {
                status: 400,
                matches: [],
                error: "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
                extensions: {
                    stage: "matcher",
                    dialect: "graph",
                    retryable: false,
                },
            };
            // {§relation-indexed-dialects} Body is `&<sym` / `&>sym` / `&sym`. EntryGraph resolves
            // the relation across (workspace, scheme), each as a (file, span); intersect with the
            // in-scope candidates from the target glob for the final set.
            const scopedCandidates = resolveSearchCandidates(
                candidates.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            );
            if (scopedCandidates.state === "incomplete") return incompleteIndex(scopedCandidates, "selected entries");
            const universeRows = await ctx.db.find_workspace_derivation_candidates.all<{ key: string; deep_hash: string | null }>({
                workspace_id: ctx.workspaceId,
            });
            const universe = resolveSearchCandidates(
                universeRows.map(({ key, deep_hash }) => ({ key, deepHash: deep_hash })),
            );
            if (universe.state === "incomplete") return incompleteIndex(universe, "entries in the relationship universe");
            const graph = await EntryGraph.matchCandidates(
                ctx.db,
                universe.candidates,
                scopedCandidates.candidates,
                statement.matcher.raw,
            );
            if (graph.status !== 200) {
                return {
                    status: graph.status,
                    matches: [],
                    problem: graph.problem,
                    extensions: {
                        stage: "matcher",
                        dialect: "graph",
                        retryable: graph.status === 503,
                    },
                };
            }
            matches = graph.matches.map(({ key, matches: evidence }) => ({
                pathname: key, matches: evidence.map((item) => ({ channel: channelOf(key), ...item })),
            }));
        } else {
            const content = await EntryFind.#matchContent(statement.matcher, ctx, address, selection);
            if ("status" in content) return content;
            matches = content;
        }
        return matches;
    }

    // {§find-source-agnostic} The content matcher over the candidates' text and bytes, and over the universe
    // beyond membership: a hit there proposes admission instead of showing content ({§membership-auto-add}).
    static async #matchContent(
        matcher: NonNullable<FindStatement["matcher"]>,
        ctx: PlurnkSchemeContext,
        address: FindAddress,
        selection: {
            candidates: Candidate[];
            ambientKeys: string[];
            channelOf: (key: string) => string;
            effectiveBytes: ((key: string) => ByteSource) | undefined;
        },
    ): Promise<Match[] | MatchOutcome> {
        const { candidates, ambientKeys, channelOf, effectiveBytes } = selection;
        const { mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("EntryFind.#matchContent: body matcher requires the mimetypes capability in ctx");
        // {§find-source-agnostic} — the shared content-matcher primitive (Log.find runs the same
        // one over log rows). Candidates key by pathname; each hit becomes a Match.
        const textCandidates: Array<{ key: string; content: string; mimetype: string }> = [];
        const byteCandidates: string[] = [];
        // {§find-bytes}/{§binary-parity} — a binary channel is searched as bytes, never as its stored
        // text form: from the scheme's byte supplier (a File member's disk) or, absent one, from the
        // bytes a DB entry keeps base64 in its content. It is never handed to the text matcher, so its
        // bytes cannot poison a text search; a binary channel with neither source has nothing to search.
        const contentBytes = new Map<string, ByteSource>();
        for (const c of candidates) {
            if (c.content === undefined || c.mimetype === undefined) throw new Error("EntryFind.#matchContent: content candidate is incomplete");
            if (await MimetypeBinary.isBinaryMimetype(c.mimetype, mimetypes)) {
                if (effectiveBytes !== undefined) byteCandidates.push(c.pathname);
                else if (c.content !== "") {
                    byteCandidates.push(c.pathname);
                    contentBytes.set(c.pathname, EntryCrud.contentByteSource(c.content));
                }
            } else textCandidates.push({ key: c.pathname, content: c.content, mimetype: c.mimetype });
        }
        // {§membership-auto-add} — a candidate's text is matched from disk; a match admits it, and the
        // selection runs again over members, so an unadmitted candidate never shows its content.
        const ambientSet = new Set(ambientKeys);
        for (const key of ambientKeys) {
            const text = await address.ambient!.text(key);
            if (text?.content != null) textCandidates.push({ key, content: text.content, mimetype: text.mimetype });
        }
        const byteSupplier = effectiveBytes ?? ((pathname: string): ByteSource => contentBytes.get(pathname)!);
        const r = textCandidates.length === 0
            ? { status: 200, matches: [] as Awaited<ReturnType<typeof Matcher.matchCandidates>>["matches"] }
            : await Matcher.matchCandidates(matcher, textCandidates, mimetypes);
        if (r.status !== 200) return {
            status: r.status,
            matches: [],
            problem: r.problem,
        };
        const ambientMatched = r.matches.filter((match) => ambientSet.has(match.key)).map((match) => match.key);
        if (ambientMatched.length > 0) {
            const proposal = await address.ambient!.propose(ambientMatched);
            if (proposal !== null) return { status: 202, matches: [], proposal };
        }
        r.matches = r.matches.filter((match) => !ambientSet.has(match.key));
        const bytesMatched = byteCandidates.length === 0
            ? { status: 200, matches: [] as Match[] }
            : await EntryFind.#matchBytes(matcher, byteCandidates, byteSupplier, mimetypes, channelOf);
        if (bytesMatched.status !== 200) return {
            status: bytesMatched.status,
            matches: [],
            problem: bytesMatched.problem,
        };
        return [
            ...r.matches.map((match) => ({
                pathname: match.key,
                matches: match.matches.map((evidence) => ({ channel: channelOf(match.key), ...evidence })),
            })),
            ...bytesMatched.matches,
        ];
    }

    // {§membership-auto-add} — a candidate's listing row: its type, weight and extent from disk, marked
    // untracked; a binary or oversized candidate lists with no weight until a READ admits it.
    static async #ambientItem(ambient: AmbientMembers, key: string, path: string, weigh: PlurnkSchemeContext["weigh"]): Promise<CatalogEntry | null> {
        const text = await ambient.text(key);
        if (text === null) return null;
        const content = text.content;
        return [{
            path,
            mimetype: text.mimetype,
            weight: content === null || weigh === undefined ? 0 : weigh(content),
            lines: content === null ? 0 : content.split("\n").length,
            aside: "untracked",
        }];
    }

    // {§find-bytes} — the matcher runs over the bytes as one character each, so a text pattern
    // finds strings and `\xNN` escapes find byte sequences; every hit is re-expressed in byte
    // coordinates that paste into a byte READ. The load is bounded by the mimetypes binary input
    // ceiling; a larger resource fails by name rather than being skipped.
    static async #matchBytes(
        body: NonNullable<FindStatement["matcher"]>,
        pathnames: readonly string[],
        bytesOf: (pathname: string) => ByteSource,
        mimetypes: NonNullable<PlurnkSchemeContext["mimetypes"]>,
        channelOf: (key: string) => string,
    ): Promise<{ status: number; matches: Match[]; problem?: ProblemDetails }> {
        const matches: Match[] = [];
        for (const pathname of pathnames) {
            const source = bytesOf(pathname);
            const loaded = await ByteView.load(source, pathname);
            if (!("bytes" in loaded)) {
                if (loaded.status === 404) continue;
                return { status: loaded.status, matches: [], problem: loaded.problem };
            }
            const match = await ByteView.match(body, loaded.bytes);
            if (match.status >= 400) return { status: match.status, matches: [], problem: match.problem };
            if (match.status !== 200 || match.matches === undefined) continue;
            matches.push({ pathname, matches: match.matches.map((evidence) => ({ channel: channelOf(pathname), ...evidence })) });
        }
        return { status: 200, matches };
    }

    // FIND result = the scheme's default-first channel groups, filtered to the matched
    // entries and kept in match order. FIND is the filtered, navigable slice of that
    // catalog, rendered as a JSON array (application/json). {§find-result-projection}
    static async findWorkspaceEntries(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: FindAddress,
    ): Promise<FindResult> {
        let match = await EntryFind.#matchPathnames(statement, ctx, manifest, address);
        // {§relation-indexed-dialects} — a still-deriving index is settled once and the
        // selection re-run, so the model gets an answer, not a wait.
        if (match.status === 503 && match.extensions?.stage === "search-index" && ctx.settleDerivations !== undefined) {
            await ctx.settleDerivations();
            match = await EntryFind.#matchPathnames(statement, ctx, manifest, address);
        }
        const empty = emptyFindFields();
        // {§membership-auto-add} — the FIND proposes the admission of the candidates its pattern matched.
        if (match.status === 202 && match.proposal !== undefined) return { ...empty, ...match.proposal };
        if (match.status !== 200) {
            if (match.problem !== undefined) {
                return Results.assert({
                    status: match.status,
                    problem: match.problem,
                    ...empty,
                });
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
            );
        }
        const scheme = EntryCrud.identityScheme(manifest);
        const projectRoot = scheme === "file" ? await FileAddress.projectRoot(ctx) : null;
        const authoredCoordinate = EntryFind.#scopeCoordinateOf(statement, manifest);
        const authority = address.authority ?? authoredCoordinate?.authority ?? "";
        const multipleAuthorities = PathSyntax.hasGlob(authority);
        const addressOf = (pathname: string): string => multipleAuthorities
            ? pathname
            : EntryManifest.toPath(scheme, authority, pathname, projectRoot);
        // The catalog group's default channel carries its bare addressable path;
        // align each selected resource through the same EntryManifest.toPath the catalog
        // uses. Resource order is preserved (rank for ~full-text).
        // {§entry-owner} A match and its catalog row must have the same full resource identity.
        const byPath = new Map((await EntryManifest.catalogRowsFor(
            { ...ctx, defaultChannelFor: (name) => name === scheme ? manifest.defaultChannel : ctx.defaultChannelFor?.(name) ?? "body" },
            scheme,
            multipleAuthorities ? undefined : authority,
        )).map((r) => [r[0].path, r] as const));
        const resources: FindProjectionResource[] = [];
        for (const m of match.matches) {
            const row = byPath.get(addressOf(m.pathname));
            if (row !== undefined) {
                resources.push({ item: row, match: m });
                continue;
            }
            // {§membership-auto-add} — a listed candidate has no catalog row; its row is read from disk.
            if (match.ambient?.has(m.pathname) && address.ambient !== undefined) {
                const item = await EntryFind.#ambientItem(address.ambient, m.pathname, addressOf(m.pathname), ctx.weigh);
                if (item !== null) resources.push({ item, match: m });
            }
        }
        // A terminal single-star catalog is a one-level map. Keep real entries
        // at that level and collapse deeper descendants into exact, actionable
        // `dir/**` scopes. The summaries are navigation metadata, not hidden
        // resource matches.
        const scopes: CatalogScope[] = [];
        if (statement.matcher === null) {
            for (const folder of match.folders ?? []) {
                let weight = 0;
                let items = 0;
                for (const pathname of folder.pathnames) {
                    const row = byPath.get(addressOf(pathname));
                    if (row === undefined) {
                        if (match.ambient?.has(pathname)) items++;
                        continue;
                    }
                    items++;
                    weight += row.reduce((sum, channel) => sum + channel.weight, 0);
                }
                if (items > 0) {
                    scopes.push({ path: `${addressOf(folder.selector.slice(0, -2))}**`, items, weight });
                }
            }
        }
        if (match.scope === undefined) throw new Error("FIND selection succeeded without a path scope");
        const projected = projectFindResult(statement, match.scope, resources, scopes, manifest.defaultChannel);
        // {§membership-auto-add} — a listed candidate has no stored representation to consume.
        if (address.pathname === undefined || match.ambient?.has(address.pathname)) return projected;

        // Exact FIND consumes the same selected canonical producer as exact
        // READ. Query projection remains core-owned, while the durable selected-
        // channel outcome survives cold and warm acquisition identically.
        const stored = await EntryCrud.readEntry(
            { authority, pathname: address.pathname },
            ctx,
            scheme,
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
            });
    }
}
