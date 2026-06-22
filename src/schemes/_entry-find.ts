// FIND helper for entry-bearing schemes (SPEC §find; plurnk.md FIND row).
// FIND resolves to the scheme's CATALOG ROWS — the very rows the manifest catalogs —
// filtered to the statement's matches. A matcher (glob/regex/jsonpath/xpath/~semantic/
// @graph) decides WHICH entries appear; it never reshapes a row (there is no per-match
// extent — match-location is a READ, not a FIND field). The result is a JSON array of
// catalog rows: the per-scheme slice of the catalog (§find-result-catalog-rows).
//
// Slot semantics (plurnk.md §"Body matcher dispatch (FIND, READ, OPEN, FOLD)"):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath/~semantic/@graph). A content matcher
//             runs against the entry's default-channel CONTENT (Matcher.matchAgainstContent
//             → the mimetypes daughter) and INCLUDES/EXCLUDES the entry — e.g.
//             `FIND(log:///**/error):/timeout/i` keeps logs whose content matches.
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import { decodePathParens } from "../core/path-decode.ts";
import EntryGraph from "./_entry-graph.ts";
import EntryManifest, { type CatalogEntry } from "./_entry-manifest.ts";
import EntrySemantic from "./_entry-semantic.ts";

export interface FindResult {
    status: number;
    content: string | null;
    mimetype: string | null;
    results: CatalogEntry[];
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

    // Resolve a FIND to its matched session PATHNAMES — entry-level, unique, in result
    // order (rank for ~semantic, candidate order otherwise). Candidate selection (scope +
    // tags) runs in SQL (find_session_entry_candidates); a content matcher then runs against
    // each candidate's default-channel CONTENT (Matcher.matchAgainstContent → the mimetypes
    // daughter) and INCLUDES/EXCLUDES the entry — 200 keeps it, 204/415/203 drop it, 400
    // (malformed matcher) fails the whole op. Path-scoping stays in the (target). The matched
    // SET is what FIND returns; the match LOCATION (which line/symbol) is a READ concern.
    static async #matchPathnames(
        statement: FindStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
    ): Promise<{ status: number; pathnames: string[] }> {
        if (statement.target === null) return { status: 400, pathnames: [] };
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File sets storedScheme=null — bare rows.
        const scheme = manifest.storedScheme === undefined ? manifest.name : manifest.storedScheme;
        if (statement.body !== null && statement.body.dialect === "semantic") {
            // ~query: embed the query text, FTS-narrow by its terms, cosine-rank the
            // narrowed set, top-K. 501 when no embeddings handler is installed (the
            // channel degrades to empty bytes). <L> carries K.
            const { mimetypes } = ctx;
            if (mimetypes === undefined) return { status: 501, pathnames: [] };
            if (statement.lineMarker === null) return { status: 400, pathnames: [] };  // ~query needs a top-K, e.g. ~query<10>
            const ranked = await EntrySemantic.rankSemantic(ctx.db, ctx.sessionId, scheme, mimetypes, statement.body.raw, LineMarkerOps.firstLast(statement.lineMarker));
            if (ranked.status !== 200) return { status: ranked.status, pathnames: [] };
            // Rank order; a chunk-ranked list can repeat an entry across chunks → dedupe,
            // keeping the highest-ranked occurrence. The winning chunk's span is a READ.
            return { status: 200, pathnames: EntryFind.#unique(ranked.results.map((x) => x.pathname)) };
        }

        const scopePathname = EntryFind.#scopePathnameOf(statement);
        // grammar 0.46 regex-in-path: a `#pattern#flags` target filters by regex over the pathname (below), so it takes no scope-prefix glob.
        const scopeGlob = statement.target.kind !== "regex" && scopePathname !== null && scopePathname.length > 0 ? `${scopePathname}*` : null;  // scope prefix filter — §find-scope-prefix-filter
        const tags = Array.isArray(statement.signal) ? statement.signal : []; // tag filter, AND semantics — §find-tag-filter-and-semantics
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, sessionId } = ctx;
        // Candidates are session-scoped — a FIND never reaches across sessions. §find-scoped-isolation
        let candidates = await (db.find_session_entry_candidates as PrepMethod).all<{ entry_id: number; pathname: string; content: string; mimetype: string }>({
            session_id: sessionId,
            scheme,
            channel: manifest.defaultChannel,
            scope_pathname: scopeGlob,
            tags: tagsParam,
        });

        // grammar 0.46 regex-in-path — a `#pattern#flags` target narrows candidates by regex
        // over their pathname (in TS; SQLite has no regex). Malformed pattern → 400, parallel
        // to a malformed body matcher.
        if (statement.target.kind === "regex") {
            let re: RegExp;
            try { re = new RegExp(statement.target.pattern, statement.target.flags || undefined); }
            catch { return { status: 400, pathnames: [] }; }
            candidates = candidates.filter((c) => re.test(c.pathname));
        }

        let pathnames: string[];
        if (statement.body === null) {
            // No body matcher — every in-scope candidate is in the result.
            pathnames = candidates.map((c) => c.pathname);
        } else if (statement.body.dialect === "graph") {
            // @graph (plurnk-service#186): body is `@<sym` / `@>sym` / `@sym`.
            // EntryGraph resolves the relation across (session, scheme); intersect
            // with the in-scope candidates (target glob + tags) for the final set.
            const inScope = new Set(candidates.map((c) => c.pathname));
            const graph = await EntryGraph.match(ctx.db, ctx.sessionId, scheme, statement.body.raw);
            if (graph.status !== 200) return { status: graph.status, pathnames: [] };
            pathnames = graph.pathnames.filter((p) => inScope.has(p));
        } else {
            const { mimetypes } = ctx;
            if (mimetypes === undefined) throw new Error("EntryFind.#matchPathnames: body matcher requires the mimetypes capability in ctx");
            pathnames = [];
            for (const cand of candidates) {
                const match = await Matcher.matchAgainstContent(statement.body, cand.content, cand.mimetype, mimetypes); // matcher runs on content — §find-glob-filter-on-content
                if (match.status === 400) return { status: 400, pathnames: [] };
                if (match.status !== 200) continue; // 204 no-match / 415 unsupported / 203 fallback → not a content hit
                pathnames.push(cand.pathname); // a content hit includes the entry — entry-level, no extent
            }
        }

        if (statement.lineMarker !== null) {
            const page = EntryFind.#paginate(pathnames, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return { status: page.status, pathnames: [] };
            pathnames = page.items ?? [];
        }
        return { status: 200, pathnames };
    }

    // FIND result = the scheme's catalog rows, filtered to the matched entries and kept in
    // match order. A catalog row is exactly what the manifest catalogs (path + per-channel
    // {mimetype, tokens, lines}, tags, seconds) — FIND is the filtered, navigable slice of
    // that catalog, rendered as a JSON array (application/json). §find-result-catalog-rows
    static async findSessionEntries(statement: FindStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<FindResult> {
        const match = await EntryFind.#matchPathnames(statement, ctx, manifest);
        if (match.status !== 200) return { status: match.status, content: null, mimetype: null, results: [] };
        const scheme = manifest.storedScheme === undefined ? manifest.name : manifest.storedScheme;
        // The catalog row is keyed by its addressable path; align each matched pathname to
        // its row through the same EntryManifest.toPath the catalog uses (single source of
        // truth). Match order is preserved (rank for ~semantic); a pathname with no row
        // (e.g. the self-excluded manifest) drops out.
        const byPath = new Map((await EntryManifest.catalogRowsFor(ctx, scheme)).map((r) => [r.path, r] as const));
        const results: CatalogEntry[] = [];
        for (const pathname of match.pathnames) {
            const row = byPath.get(EntryManifest.toPath(scheme, pathname));
            if (row !== undefined) results.push(row);
        }
        return { status: 200, content: JSON.stringify(results, null, 2), mimetype: "application/json", results };
    }
}
