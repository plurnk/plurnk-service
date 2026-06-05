// FIND helper for entry-bearing schemes (SPEC §6.6; plurnk.md FIND row).
//
// Slot semantics:
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher dispatch (plurnk.md §"Body matcher dispatch"):
//               glob / regex → applied to pathname (path-like dialects)
//               xpath / jsonpath → applied to content (structure-like;
//                 501 pending plurnk-mimetypes#3)
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement, HideStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";

export interface FindResult {
    status: number;
    content: string | null;
    mimetype: string | null;
    results: string[];
}

export default class EntryFind {
    static #scopePathnameOf(statement: FindStatement | ShowStatement | HideStatement): string | null {
        const path = statement.target;
        if (path === null) return null;
        if (path.kind === "url") return path.pathname;
        return path.raw;
    }

    static #paginate<T>(items: T[], marker: { first: number; last: number | null }): { status: number; items?: T[] } {
        const total = items.length;
        const { first, last } = marker;
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

    // Resolve a matcher-bearing statement (FIND, or multi-entry SHOW/HIDE) to the
    // matched session pathnames: body-matcher parse (glob/regex → SQL predicates,
    // xpath/jsonpath → 501), scope + tag filters, then `<L>` pagination. The match
    // runs entirely in find_session_entries (GLOB / REGEXP / json_each); JS only
    // validates the regex compiles. Shared with EntryOps's multi-entry visibility.
    static async matchPathnames(
        statement: FindStatement | ShowStatement | HideStatement,
        ctx: PlurnkSchemeContext,
        scheme: string,
    ): Promise<{ status: number; pathnames: string[] }> {
        if (statement.target === null) return { status: 400, pathnames: [] };

        let pathnameRegex: string | null = null;
        let pathnameGlob: string | null = null;
        if (statement.body !== null) {
            if (statement.body.dialect === "glob") {
                pathnameGlob = statement.body.raw;
            } else if (statement.body.dialect === "regex") {
                const { pattern, flags } = statement.body;
                // Validate the pattern compiles; the match itself runs in SQL (REGEXP).
                try { new RegExp(pattern, flags); }
                catch { return { status: 400, pathnames: [] }; }
                pathnameRegex = flags ? `(?${flags})${pattern}` : pattern;
            } else {
                // xpath / jsonpath need per-mimetype content matching (plurnk-mimetypes#3).
                return { status: 501, pathnames: [] };
            }
        }

        const scopePathname = EntryFind.#scopePathnameOf(statement);
        const scopeGlob = scopePathname !== null && scopePathname.length > 0 ? `${scopePathname}*` : null;
        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, sessionId } = ctx;
        const rows = await (db.find_session_entries as PrepMethod).all<{ pathname: string }>({
            session_id: sessionId,
            scheme,
            scope_pathname: scopeGlob,
            pathname_pattern: pathnameGlob,
            pathname_regex: pathnameRegex,
            tags: tagsParam,
        });
        let pathnames = rows.map((r) => r.pathname);

        if (statement.lineMarker !== null) {
            const page = EntryFind.#paginate(pathnames, statement.lineMarker);
            if (page.status !== 200) return { status: page.status, pathnames: [] };
            pathnames = page.items ?? [];
        }
        return { status: 200, pathnames };
    }

    static async findSessionEntries(statement: FindStatement, ctx: PlurnkSchemeContext, scheme: string): Promise<FindResult> {
        const match = await EntryFind.matchPathnames(statement, ctx, scheme);
        if (match.status !== 200) return { status: match.status, content: null, mimetype: null, results: [] };
        const results = match.pathnames.map((p) => `${scheme}://${p}`);
        return { status: 200, content: results.join("\n"), mimetype: "text/plain", results };
    }
}
