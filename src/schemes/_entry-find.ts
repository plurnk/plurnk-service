// FIND helper for entry-bearing schemes (SPEC §find; plurnk.md FIND row).
// Used by FIND (the body-matcher candidate selector).
//
// Slot semantics (plurnk.md §"Body matcher dispatch (FIND, READ, OPEN, FOLD)"):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath). Runs against the entry's
//             default-channel CONTENT, NOT the pathname — the same content match
//             READ performs (Matcher.matchAgainstContent → the mimetypes
//             daughter). e.g. `FIND(log:///**/error):/timeout/i` selects logs
//             whose content matches; `OPEN(countries/**):Paris*` selects entries
//             whose content matches. The path-glob is the (target).
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement, FoldStatement, OpenStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import { decodePathParens } from "../core/path-decode.ts";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic from "./_entry-semantic.ts";

export interface FindResult {
    status: number;
    content: string | null;
    mimetype: string | null;
    results: Finding[];
}

// Project Findings — a finding IS its enclosing structural unit, not a bare pathname.
// `extent` is the <L> line span — the enclosing symbol's range, the match line itself when
// no symbol covers it, or null for a whole-entry match. `symbol` names that unit when
// known; `content` is opt-in (OPEN curates body into context).
export interface Finding {
    path: string;
    extent: { first: number; last: number } | null;
    symbol?: string;
    content?: string;
}

export default class EntryFind {
    static #scopePathnameOf(statement: FindStatement | OpenStatement | FoldStatement): string | null {
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

    // Resolve a matcher-bearing statement (FIND, or multi-entry OPEN/FOLD) to the
    // matched session pathnames. Candidate selection (scope + tags) runs in SQL
    // (find_session_entry_candidates); the body matcher then runs against each
    // candidate's default-channel CONTENT via the mimetypes daughter
    // (Matcher.matchAgainstContent) — 200 (hit) includes the entry, 204/415/203
    // exclude it (no content hit), 400 (malformed matcher) fails the whole op.
    // Path-scoping stays in the (target). Used by FIND.
    static async matchFindings(
        statement: FindStatement | OpenStatement | FoldStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
    ): Promise<{ status: number; findings: Finding[] }> {
        if (statement.target === null) return { status: 400, findings: [] };
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File sets storedScheme=null — bare rows.
        const scheme = manifest.storedScheme === undefined ? manifest.name : manifest.storedScheme;
        const addr = (pathname: string): string => `${manifest.name}://${pathname}`;
        if (statement.body !== null && statement.body.dialect === "semantic") {
            // ~query: embed the query text, FTS-narrow by its terms, cosine-rank the
            // narrowed set, top-K. 501 when no embeddings handler is installed (the
            // channel degrades to empty bytes). <L> carries K.
            const { mimetypes } = ctx;
            if (mimetypes === undefined) return { status: 501, findings: [] };
            if (statement.lineMarker === null) return { status: 400, findings: [] };  // ~query needs a top-K, e.g. ~query<10>
            const ranked = await EntrySemantic.rankSemantic(ctx.db, ctx.sessionId, scheme, mimetypes, statement.body.raw, LineMarkerOps.firstLast(statement.lineMarker));
            if (ranked.status !== 200) return { status: ranked.status, findings: [] };
            // Semantic findings are whole-entry (extent null) — chunk-extent enrichment is a later phase.
            return { status: 200, findings: ranked.pathnames.map((p) => ({ path: addr(p), extent: null })) };
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
            catch { return { status: 400, findings: [] }; }
            candidates = candidates.filter((c) => re.test(c.pathname));
        }

        let findings: Finding[];
        if (statement.body === null) {
            // No body matcher — the whole entry is the finding (extent null).
            findings = candidates.map((c) => ({ path: addr(c.pathname), extent: null }));
        } else if (statement.body.dialect === "graph") {
            // @graph (plurnk-service#186): body is `@<sym` / `@>sym` / `@sym`.
            // EntryGraph resolves the relation across (session, scheme); intersect
            // with the in-scope candidates (target glob + tags) for the final set.
            const inScope = new Set(candidates.map((c) => c.pathname));
            const graph = await EntryGraph.match(ctx.db, ctx.sessionId, scheme, statement.body.raw);
            if (graph.status !== 200) return { status: graph.status, findings: [] };
            findings = graph.pathnames.filter((p) => inScope.has(p)).map((p) => ({ path: addr(p), extent: null }));
        } else {
            const { mimetypes } = ctx;
            if (mimetypes === undefined) throw new Error("EntryFind.matchFindings: body matcher requires the mimetypes capability in ctx");
            findings = [];
            for (const cand of candidates) {
                const match = await Matcher.matchAgainstContent(statement.body, cand.content, cand.mimetype, mimetypes); // matcher runs on content — §find-glob-filter-on-content
                if (match.status === 400) return { status: 400, findings: [] };
                if (match.status !== 200) continue; // 204 no-match / 415 unsupported / 203 fallback → not a content hit
                // Each hit line resolves to its enclosing structural unit (findingsForMatch).
                findings.push(...await EntryFind.findingsForMatch(db, cand.entry_id, addr(cand.pathname), match.lines ?? []));
            }
        }

        if (statement.lineMarker !== null) {
            const page = EntryFind.#paginate(findings, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return { status: page.status, findings: [] };
            findings = page.items ?? [];
        }
        return { status: 200, findings };
    }

    // Project Findings — resolve a matched entry's hit lines to findings: each line maps to
    // its smallest enclosing symbol (the structural unit it belongs to), or to the line
    // itself when no symbol covers it. Deduped by extent — many hits in one function
    // collapse to one finding. Phase 2b wires this into the FIND result shape.
    static async findingsForMatch(db: Db, entryId: number, path: string, lines: readonly number[]): Promise<Finding[]> {
        const findings: Finding[] = [];
        const seen = new Set<string>();
        for (const line of lines) {
            const sym = await EntryGraph.enclosingSymbol(db, entryId, line);
            const extent = sym === null ? { first: line, last: line } : { first: sym.line, last: sym.endLine };
            const key = `${extent.first}-${extent.last}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push(sym === null ? { path, extent } : { path, extent, symbol: sym.name });
        }
        return findings;
    }

    static async findSessionEntries(statement: FindStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<FindResult> {
        const match = await EntryFind.matchFindings(statement, ctx, manifest);
        if (match.status !== 200) return { status: match.status, content: null, mimetype: null, results: [] };
        const content = match.findings.map(EntryFind.#renderFinding).join("\n");
        return { status: 200, content, mimetype: "text/plain", results: match.findings };
    }

    // Project Findings — a finding renders as a usable address: path + its <L> extent
    // (the grammar's <n> / <first,last> range), plus the enclosing symbol's name when known.
    static #renderFinding(f: Finding): string {
        const ext = f.extent === null ? "" : f.extent.first === f.extent.last ? `<${f.extent.first}>` : `<${f.extent.first},${f.extent.last}>`;
        return `${f.path}${ext}${f.symbol === undefined ? "" : ` (${f.symbol})`}`;
    }
}
