// FIND helper for entry-bearing schemes (SPEC §find; plurnk.md FIND row).
// FIND resolves to the scheme's CATALOG ROWS — the very rows the manifest catalogs —
// filtered to the statement's matches. A matcher (glob/regex/jsonpath/xpath/~semantic/
// @graph) decides WHICH entries appear. A CONTENT matcher also stamps each row with
// `matchSpan` — the source and readable coordinates where it hit (plurnk.md:31: FIND returns
// matching rows with compact coordinates; the content itself remains a READ). The result is a
// JSON array of catalog rows: the per-scheme slice of the catalog (§find-result-catalog-rows).
//
// Slot semantics (plurnk.md §"Body matcher dispatch (FIND, READ, OPEN, FOLD)"):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath/~semantic/@graph). A content matcher
//             runs against the entry's default-channel CONTENT (Matcher.matchAgainstContent
//             → the mimetypes plugin) and INCLUDES/EXCLUDES the entry — e.g.
//             `FIND(log:///**/error):/timeout/i` keeps logs whose content matches.
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import { entryPathnameOf } from "../core/plurnk-uri.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryManifest, { type CatalogEntry } from "./_entry-manifest.ts";
import Owner from "../core/Owner.ts";
import EntrySemantic from "./_entry-semantic.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { RangeExtent } from "@plurnk/plurnk-schemes";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { pathFolderSummaries, pathScope, pathScopeMatches, type PathScope } from "./_path-scope.ts";

// A FIND match: an entry and the (file, span) where the matcher hit — ONE per match, so a
// file with N matches yields N items. span === null for a body-less FIND (the whole entry). #286
// §matcher-selection-signal — `path` is the hit's canonical coordinate in the plugin's own
// dialect ($['users'][0]['name']; an xpath node path), when the dialect provides one. The
// selection signal that survives the degenerate single-line case: source lines preserve
// provenance, readable rows compose into scoped READ, and the path tells the model WHICH hit
// each otherwise-identical span was.
export interface MatchSpan { lineStart: number; lineEnd: number; rowStart: number; rowEnd: number; }
interface SourceSpan { lineStart: number; lineEnd: number; }
interface SourceMatch { pathname: string; span: SourceSpan | null; path?: string; }
export interface Match { pathname: string; span: MatchSpan | null; path?: string; }
// A FIND result row: the entry's catalog row plus the span it matched at (absent for body-less).
export type CatalogScope = {
    path: string;
    items: number;
    tokens: number;
    channels?: never;
    matchSpan?: undefined;
    matchPath?: undefined;
};
export type CatalogMatch = CatalogEntry & { matchSpan?: MatchSpan; matchPath?: string; items?: never; tokens?: never };
export type MatchItem = CatalogMatch | CatalogScope;

export interface FindResult extends SchemeResultBase {
    content: string | null;
    mimetype: string | null;
    results: MatchItem[];     // one per match (catalog row + span); body-less → one per entry, no span
    itemsTokenTotal: number;  // content weight of the matched set, summed per UNIQUE entry
    pathnames: string[];      // unique matched pathnames, in result order — the set a multi-file READ fans out over
    matches: Match[];         // per-match (pathname, span), in result order — READ honors these (#286)
    overflow?: number;        // §find-count-not-contents — over-budget: N matched but were NOT enumerated (content is a narrow-steer)
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
    // plugin) and INCLUDES/EXCLUDES the entry — 200 keeps it, 204/415/203 drop it, 400
    // (malformed matcher) fails the whole op. Path-scoping stays in the (target). Returns the
    // matched pathnames plus `locations` — each content hit's source line(s), keyed by pathname.
    static async #matchPathnames(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        explicitOwnerId?: number,
    ): Promise<{
        status: number;
        matches: SourceMatch[];
        scope?: PathScope;
        candidatePathnames?: string[];
        error?: string;
        range?: RangeExtent;
        extensions?: Readonly<Record<string, unknown>>;
    }> {
        if (statement.target === null) return { status: 400, matches: [] };
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);
        const scopePathname = EntryFind.#scopePathnameOf(statement);
        const scope = scopePathname === null
            ? null
            : pathScope(scopePathname, manifest.folderScopes === true);
        // {§fs-errno} — the green-lie pin (#545): a FIND whose target is an EXACT path (no glob,
        // no folder scope) that resolves to NO entry is ENOENT with its fact — certifying empty
        // over nothing taught run59's model that a real function did not exist. A glob/folder
        // scope with zero matches stays the blessed orienting empty (§render-rule, owner: an
        // empty survey says "don't look here").
        if (scope?.kind === "exact" && scope.pathname.length > 0) {
            const exact = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme, pathname: scope.pathname,
            });
            if (exact === undefined) return { status: 404, matches: [], error: `No entry exists at ${EntryManifest.toPath(scheme, scope.pathname)}.` };
        }
        // SQL receives only the literal prefix and returns a safe superset. Node's
        // path matcher owns the shell-glob truth below: unlike SQLite GLOB, `*`
        // cannot cross `/`, while `**` can. A declared folder scope remains a
        // recursive prefix independent of glob syntax. §find-scope-prefix-filter
        const tags = Array.isArray(statement.signal) ? statement.signal : []; // tag filter, AND semantics — §find-tag-filter-and-semantics
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, workspaceId } = ctx;
        // Candidates are workspace-scoped — a FIND never reaches across workspaces (§find-scoped-isolation)
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
                return { status: 400, matches: [], error: `Malformed path glob '${scopePathname ?? ""}'.` };
            }
        }

        // Every dialect resolves to (file, span) items — one per match (#286). A body-less FIND
        // selects the whole entry (span: null); a matcher selects spans within it.
        let matches: SourceMatch[];
        if (statement.body !== null && statement.body.dialect === "semantic") {
            // Semantic rank is exhaustive within the SAME target/tag candidate set as every
            // other matcher. Passing entry identities into the ranker preserves top-K meaning:
            // constrain first, then rank, never rank the corpus and discard out-of-scope hits.
            const { mimetypes } = ctx;
            if (mimetypes === undefined) return { status: 501, matches: [] };
            const marker = statement.lineMarker === null
                ? { first: EntrySemantic.defaultTopK(), last: null }
                : LineMarkerOps.firstLast(statement.lineMarker);
            const candidateSet = resolveSearchCandidates(
                candidates.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return {
                status: 503,
                matches: [],
                error: `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected entries.`,
                extensions: { search: candidateSet },
            };
            const ranked = await EntrySemantic.rankCandidates(
                ctx.db,
                candidateSet.candidates,
                mimetypes,
                statement.body.raw,
                marker,
            );
            if (ranked.status !== 200) return { status: ranked.status, matches: [] };
            matches = ranked.results.map((x) => ({ pathname: x.key, span: { lineStart: x.lineStart, lineEnd: x.lineEnd } }));
        } else if (statement.body === null) {
            matches = candidates.map((c) => ({ pathname: c.pathname, span: null }));
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
                extensions: { search: scopedCandidates },
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
                extensions: { search: universe },
            };
            const graph = await EntryGraph.matchCandidates(
                ctx.db,
                universe.candidates,
                scopedCandidates.candidates,
                statement.body.raw,
            );
            if (graph.status !== 200) return { status: graph.status, matches: [] };
            matches = graph.matches.map((m) => ({
                pathname: m.key,
                span: { lineStart: m.lineStart, lineEnd: m.lineEnd },
            }));
        } else {
            const { mimetypes } = ctx;
            if (mimetypes === undefined) throw new Error("EntryFind.#matchPathnames: body matcher requires the mimetypes capability in ctx");
            // §find-source-agnostic — the shared content-matcher primitive (Log.find runs the same
            // one over log rows). Candidates key by pathname; each hit becomes a Match.
            const r = await Matcher.matchCandidates(statement.body, candidates.map((c) => {
                if (c.content === undefined || c.mimetype === undefined) throw new Error("EntryFind.#matchPathnames: content candidate is incomplete");
                return { key: c.pathname, content: c.content, mimetype: c.mimetype };
            }), mimetypes);
            if (r.status !== 200) return { status: r.status, matches: [] };
            matches = r.matches.map((m) => ({ pathname: m.key, span: m.span, ...(m.path !== undefined ? { path: m.path } : {}) }));
        }

        if (statement.lineMarker !== null && statement.body?.dialect !== "semantic" && candidatePathnames === undefined) {
            const page = LineMarkerOps.page(matches, statement.lineMarker);
            if (page.status !== 200) return {
                status: page.status,
                matches: [],
                error: page.error,
                range: page.range,
            };
            matches = page.items ?? [];
        }
        return { status: 200, matches, ...(scope === null ? {} : { scope }), ...(candidatePathnames === undefined ? {} : { candidatePathnames }) };
    }

    static async #addReadableRows(
        matches: readonly SourceMatch[],
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        explicitOwnerId?: number,
    ): Promise<Match[]> {
        if (matches.every(({ span }) => span === null)) return matches.map((match) => ({ ...match, span: null }));
        if (ctx.mimetypes === undefined) throw new Error("EntryFind.#addReadableRows: matched entries require the mimetypes capability");
        const scheme = EntryCrud.identityScheme(manifest);
        const ownerId = explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId);
        const candidates: Array<{ key: string; content: string; mimetype: string }> = [];
        for (const pathname of new Set(matches.filter(({ span }) => span !== null).map(({ pathname }) => pathname))) {
            const row = await ctx.db.ops_read_channel.get<{ content: string; mimetype: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: ownerId,
                scheme,
                pathname,
                channel: manifest.defaultChannel,
            });
            if (row === undefined) throw new Error(`EntryFind.#addReadableRows: matched entry ${pathname} has no default channel`);
            candidates.push({ key: pathname, ...row });
        }
        const resolved = await Matcher.addReadableRows(
            matches.map(({ pathname, ...match }) => ({ key: pathname, ...match })),
            candidates,
            ctx.mimetypes,
        );
        return resolved.map(({ key, ...match }) => ({ pathname: key, ...match }));
    }

    // FIND result = the scheme's catalog rows, filtered to the matched entries and kept in
    // match order. A catalog row is exactly what the manifest catalogs (path + per-channel
    // {mimetype, tokens, lines}, tags, stream lifecycle) — FIND is the filtered, navigable slice of
    // that catalog, rendered as a JSON array (application/json). §find-result-catalog-rows
    static async findWorkspaceEntries(statement: FindStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<FindResult> {
        const match = await EntryFind.#matchPathnames(statement, ctx, manifest, explicitOwnerId);
        if (match.status !== 200) {
            const detail = match.error ?? `FIND could not resolve the requested selection (status ${match.status}).`;
            return Results.failure(
                `scheme:${manifest.name}`,
                match.status === 404 ? "entry-not-found" : match.status === 416 ? "range-not-satisfiable" : "find-failed",
                match.status,
                detail,
                { content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] },
                {
                    ...(match.range === undefined ? {} : { range: match.range }),
                    ...match.extensions,
                },
            ) as FindResult;
        }
        const readableMatches = await EntryFind.#addReadableRows(match.matches, ctx, manifest, explicitOwnerId);
        const scheme = EntryCrud.identityScheme(manifest);
        // The catalog row is keyed by its addressable path; align each match to its row through
        // the same EntryManifest.toPath the catalog uses (single source of truth). Match order is
        // preserved (rank for ~semantic); a match whose entry has no row (e.g. the self-excluded
        // manifest) drops out. Each match becomes ONE result item carrying its span (#286).
        // {§entry-owner} — the alignment draws from the SAME owner the candidates matched, so a
        // match never pairs with a coordinate-twin sibling's catalog metadata.
        const byPath = new Map((await EntryManifest.catalogRowsFor(ctx, scheme, explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId))).map((r) => [r.path, r] as const));
        let results: MatchItem[] = [];
        const matches: Match[] = [];
        const seenPath = new Set<string>();
        let itemsTokenTotal = 0;  // content weight summed per UNIQUE entry (items repeat a file across its matches)
        // Two granularities from one hit list (§matcher-selection-signal ÷ #286): `results` (the
        // rx the model reads) keeps EVERY hit — on a single-line document the per-hit matchPath is
        // the only thing distinguishing them; `matches` (the fan-out's delivery list) dedups by
        // (pathname, span) — N hits on one source line deliver that line ONCE, no identical-row noise.
        const seenSpan = new Set<string>();
        for (const m of readableMatches) {
            const row = byPath.get(EntryManifest.toPath(scheme, m.pathname));
            if (row === undefined) continue;
            results.push(m.span !== null ? { ...row, matchSpan: m.span, ...(m.path !== undefined ? { matchPath: m.path } : {}) } : row);
            const spanKey = `${m.pathname}\0${m.span === null ? "" : `${m.span.lineStart},${m.span.lineEnd}`}`;
            if (!seenSpan.has(spanKey)) { seenSpan.add(spanKey); matches.push(m); }
            if (!seenPath.has(m.pathname)) {
                seenPath.add(m.pathname);
                itemsTokenTotal += Object.values(row.channels).reduce((s, c) => s + c.tokens, 0);
            }
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
                    return Results.failure(
                        `scheme:${manifest.name}`,
                        "range-not-satisfiable",
                        page.status,
                        page.error ?? "The requested FIND result range is not satisfiable.",
                        { content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] },
                        page.range === undefined ? {} : { range: page.range },
                    ) as FindResult;
                }
                results = page.items ?? [];
                const retained = new Set(results.filter((item) => item.items === undefined).map((item) => item.path));
                for (let i = matches.length - 1; i >= 0; i--) {
                    if (!retained.has(EntryManifest.toPath(scheme, matches[i].pathname))) matches.splice(i, 1);
                }
                seenPath.clear();
                for (const item of results) {
                    if (item.items === undefined) {
                        const matched = matches.find((candidate) => EntryManifest.toPath(scheme, candidate.pathname) === item.path);
                        if (matched !== undefined) seenPath.add(matched.pathname);
                    }
                }
                itemsTokenTotal = results.reduce((sum, item) => sum + (
                    item.items === undefined
                        ? Object.values(item.channels).reduce((channelSum, channel) => channelSum + channel.tokens, 0)
                        : item.tokens ?? 0
                ), 0);
            }
        }
        // §find-count-not-contents (#418) — a repo-scale FIND(**) over a 19k-entry workspace can't
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
            // overflow count + aggregate weight are the complete bounded result.
            return { status: 200, content: steer, mimetype: "text/markdown", results: [], itemsTokenTotal, pathnames: [], matches: [], overflow: results.length };
        }
        // Compact JSON — the model parses it natively; the `null, 2` pretty-print was ~36%
        // whitespace of the catalog body, tokens the wire doesn't need.
        return { status: 200, content: JSON.stringify(results), mimetype: "application/json", results, itemsTokenTotal, pathnames: [...seenPath], matches };
    }
}
