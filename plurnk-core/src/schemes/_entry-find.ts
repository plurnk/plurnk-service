// FIND helper for entry-bearing schemes (SPEC §find; plurnk.md FIND row).
// FIND resolves to the scheme's CATALOG ROWS — the very rows the manifest catalogs —
// filtered to the statement's matches. A matcher (glob/regex/jsonpath/xpath/~semantic/
// @graph) decides WHICH entries appear. A CONTENT matcher also stamps each row with
// `matchLines` — the source line(s) where it hit (plurnk.md:31: FIND returns the matching
// rows with the match lines in the metadata; the line CONTENT is a READ). The result is a
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
import { decodePathParens } from "../core/path-decode.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryManifest, { type CatalogEntry } from "./_entry-manifest.ts";
import Owner from "../core/Owner.ts";
import EntrySemantic from "./_entry-semantic.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";

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
export type MatchItem = CatalogEntry & { matchSpan?: MatchSpan; matchPath?: string };

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
        if (path.kind === "regex") return path.raw; // regex source — parens are syntax, never encoded
        return decodePathParens(path.kind === "url" ? path.pathname : path.raw); // #239 item 4
    }

    static #paginate<T>(items: T[], marker: { first: number; last: number | null }): { status: number; items?: T[] } {
        const total = items.length;
        const { first, last } = marker;
        // #209 — a fractional marker is a semantic similarity threshold; on a
        // non-semantic (paginated) result it's nonsense → 416, never floored.
        if (!Number.isInteger(first) || (last !== null && !Number.isInteger(last))) return { status: 416 };
        if (last === null) {
            if (first === 0 || first === -1) return { status: 200, items: [] };
            if (first > 0 && first <= total) return { status: 200, items: [items[first - 1]] };
            return { status: 416 };
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1) m = total;
        if (n < 1 || n > total) return { status: 416 };
        if (m < 1 || m > total) return { status: 416 };
        if (n > m) return { status: 416 };
        return { status: 200, items: items.slice(n - 1, m) };
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
    ): Promise<{ status: number; matches: SourceMatch[]; error?: string }> {
        if (statement.target === null) return { status: 400, matches: [] };
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);
        const scopePathname = EntryFind.#scopePathnameOf(statement);
        // {§fs-errno} — the green-lie pin (#545): a FIND whose target is an EXACT path (no glob,
        // no folder scope) that resolves to NO entry is ENOENT with its fact — certifying empty
        // over nothing taught run59's model that a real function did not exist. A glob/folder
        // scope with zero matches stays the blessed orienting empty (§render-rule, owner: an
        // empty survey says "don't look here").
        if (statement.target.kind !== "regex" && scopePathname !== null && scopePathname.length > 0
            && !scopePathname.includes("*") && !scopePathname.endsWith("/")) {
            const exact = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: explicitOwnerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme, pathname: scopePathname,
            });
            if (exact === undefined) return { status: 404, matches: [], error: `No entry exists at ${EntryManifest.toPath(scheme, scopePathname)}.` };
        }
        // The target's GLOB scope. A FOLDER (trailing slash, incl. the scheme root `/`) expands to
        // its contents — append `*`; a bare ENTRY path stays exact (one entry); an explicit glob
        // passes through literally. The `*` is folderhood, not a blanket prefix — so FIND(README.md)
        // is the one entry, uniform with READ's target contract (#286). grammar 0.46 regex-in-path:
        // a `#pattern#flags` target filters by regex over the pathname (below), no scope glob.
        // §find-scope-prefix-filter
        const scopeGlob = statement.target.kind === "regex" || scopePathname === null || scopePathname.length === 0
            ? null
            : (scopePathname.endsWith("/") ? `${scopePathname}*` : scopePathname);
        const tags = Array.isArray(statement.signal) ? statement.signal : []; // tag filter, AND semantics — §find-tag-filter-and-semantics
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, workspaceId } = ctx;
        // Candidates are workspace-scoped — a FIND never reaches across workspaces (§find-scoped-isolation)
        // — and owner-keyed ({§entry-owner}): an owner-carved face passes its resolved owner; every
        // other scheme draws from the commons.
        type Candidate = { entry_id: number; pathname: string; content?: string; mimetype?: string };
        const semantic = statement.body?.dialect === "semantic";
        let candidates = await db[semantic ? "find_workspace_entry_candidate_ids" : "find_workspace_entry_candidates"].all<Candidate>({
            workspace_id: workspaceId,
            owner_id: explicitOwnerId ?? await Owner.commonsId(db, workspaceId),
            scheme,
            ...(semantic ? {} : { channel: manifest.defaultChannel }),
            scope_pathname: scopeGlob,
            tags: tagsParam,
        });

        // grammar 0.46 regex-in-path — a `#pattern#flags` target narrows candidates by regex
        // over their pathname (in TS; SQLite has no regex). Malformed pattern → 400, parallel
        // to a malformed body matcher.
        if (statement.target.kind === "regex") {
            let re: RegExp;
            try { re = new RegExp(statement.target.pattern, statement.target.flags || undefined); }
            catch { return { status: 400, matches: [] }; }
            candidates = candidates.filter((c) => re.test(c.pathname));
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
            const ranked = await EntrySemantic.rankSemantic(
                ctx.db,
                ctx.workspaceId,
                scheme,
                candidates.map(({ entry_id }) => entry_id),
                mimetypes,
                statement.body.raw,
                marker,
            );
            if (ranked.status !== 200) return { status: ranked.status, matches: [] };
            matches = ranked.results.map((x) => ({ pathname: x.pathname, span: { lineStart: x.lineStart, lineEnd: x.lineEnd } }));
        } else if (statement.body === null) {
            matches = candidates.map((c) => ({ pathname: c.pathname, span: null }));
        } else if (statement.body.dialect === "graph") {
            // @graph (plurnk-service#186): body is `@<sym` / `@>sym` / `@sym`. EntryGraph resolves
            // the relation across (workspace, scheme), each as a (file, span); intersect with the
            // in-scope candidates (target glob + tags) for the final set.
            const inScope = new Set(candidates.map((c) => c.pathname));
            const graph = await EntryGraph.match(ctx.db, ctx.workspaceId, scheme, statement.body.raw);
            if (graph.status !== 200) return { status: graph.status, matches: [] };
            matches = graph.matches.filter((m) => inScope.has(m.pathname)).map((m) => ({ pathname: m.pathname, span: { lineStart: m.lineStart, lineEnd: m.lineEnd } }));
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

        if (statement.lineMarker !== null && statement.body?.dialect !== "semantic") {
            const page = EntryFind.#paginate(matches, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return { status: page.status, matches: [] };
            matches = page.items ?? [];
        }
        return { status: 200, matches };
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
        const grouped = new Map<string, number[]>();
        for (let index = 0; index < matches.length; index += 1) {
            const match = matches[index];
            if (match.span === null) continue;
            const indices = grouped.get(match.pathname) ?? [];
            indices.push(index);
            grouped.set(match.pathname, indices);
        }
        const resolved: Match[] = matches.map((match) => ({ ...match, span: null }));
        for (const [pathname, indices] of grouped) {
            const row = await ctx.db.ops_read_channel.get<{ content: string; mimetype: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: ownerId,
                scheme,
                pathname,
                channel: manifest.defaultChannel,
            });
            if (row === undefined) throw new Error(`EntryFind.#addReadableRows: matched entry ${pathname} has no default channel`);
            const rows = await ctx.mimetypes!.rowsForLines(
                { content: row.content, hint: row.mimetype },
                indices.map((index) => ({
                    line: matches[index].span!.lineStart,
                    endLine: matches[index].span!.lineEnd,
                })),
            );
            if (rows.length !== indices.length) throw new Error(`EntryFind.#addReadableRows: ${pathname} returned ${rows.length} rows for ${indices.length} spans`);
            for (let offset = 0; offset < indices.length; offset += 1) {
                const index = indices[offset];
                const match = matches[index];
                const readable = rows[offset];
                resolved[index] = {
                    ...match,
                    span: {
                        ...match.span!,
                        rowStart: readable.row,
                        rowEnd: readable.endRow,
                    },
                };
            }
        }
        return resolved;
    }

    // FIND result = the scheme's catalog rows, filtered to the matched entries and kept in
    // match order. A catalog row is exactly what the manifest catalogs (path + per-channel
    // {mimetype, tokens, lines}, tags, seconds) — FIND is the filtered, navigable slice of
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
        const results: MatchItem[] = [];
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
        // §find-count-not-contents (#418) — a repo-scale FIND(**) over a 19k-entry workspace can't
        // enumerate: materializing every match overflows the window (a clean grind should not be a
        // crash-and-recover). Over the render budget, the result is a COUNT + narrow steer instead
        // of the rows — the model sees "N match, too broad, narrow it" and adapts. INDEPENDENT of
        // the window size: even a 256k window shouldn't render a whole repo's catalog into a turn.
        // The meta line's count + itemsTokenTotal still self-describe the hit set. Budget is a knob
        // (reader-declared); 0/unset = no gate (small workspaces enumerate as before).
        const budget = Number.parseInt(process.env.PLURNK_SERVICE_FIND_MAX_MATCHES ?? "0", 10);
        if (budget > 0 && results.length > budget) {
            const steer = `${results.length} entries match, exceeding the render budget (${budget}) — not enumerated.`;
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
