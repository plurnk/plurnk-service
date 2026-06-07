// FIND helper for entry-bearing schemes (SPEC §6.6; plurnk.md FIND row).
// Shared by FIND and multi-entry SHOW/HIDE (EntryOps.#setSessionEntryVisibility).
//
// Slot semantics (plurnk.md §"Body matcher dispatch (FIND, READ, SHOW, HIDE)"):
//   target  — required scope (path or glob); selects which entries are candidates
//   body    — matcher (glob/regex/jsonpath/xpath). Runs against the entry's
//             default-channel CONTENT, NOT the pathname — the same content match
//             READ performs (Matcher.matchAgainstContent → the mimetypes
//             daughter). e.g. `FIND(log://**/error):/timeout/i` selects logs
//             whose content matches; `SHOW(countries/**):Paris*` selects entries
//             whose content matches. The path-glob is the (target).
//   signal  — tag filter: candidate entry must have ALL listed tags
//   <L>     — results pagination: select results N..M from the matched list

import type { FindStatement, HideStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";

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
    // matched session pathnames. Candidate selection (scope + tags) runs in SQL
    // (find_session_entry_candidates); the body matcher then runs against each
    // candidate's default-channel CONTENT via the mimetypes daughter
    // (Matcher.matchAgainstContent) — 200 (hit) includes the entry, 204/415/203
    // exclude it (no content hit), 400 (malformed matcher) fails the whole op.
    // Path-scoping stays in the (target). Shared with EntryOps's multi-entry
    // visibility.
    static async matchPathnames(
        statement: FindStatement | ShowStatement | HideStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
    ): Promise<{ status: number; pathnames: string[] }> {
        if (statement.target === null) return { status: 400, pathnames: [] };

        const scopePathname = EntryFind.#scopePathnameOf(statement);
        const scopeGlob = scopePathname !== null && scopePathname.length > 0 ? `${scopePathname}*` : null;
        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

        const { db, sessionId } = ctx;
        const candidates = await (db.find_session_entry_candidates as PrepMethod).all<{ pathname: string; content: string; mimetype: string }>({
            session_id: sessionId,
            scheme: manifest.name,
            channel: manifest.defaultChannel,
            scope_pathname: scopeGlob,
            tags: tagsParam,
        });

        let pathnames: string[];
        if (statement.body === null) {
            pathnames = candidates.map((c) => c.pathname);
        } else {
            const { mimetypes } = ctx;
            if (mimetypes === undefined) throw new Error("EntryFind.matchPathnames: body matcher requires the mimetypes capability in ctx");
            pathnames = [];
            for (const cand of candidates) {
                const match = await Matcher.matchAgainstContent(statement.body, cand.content, cand.mimetype, mimetypes);
                if (match.status === 400) return { status: 400, pathnames: [] };
                if (match.status === 200) pathnames.push(cand.pathname);
                // 204 (no match) / 415 (dialect unsupported for this entry) /
                // 203 (parse fallback) → not a content hit → excluded.
            }
        }

        if (statement.lineMarker !== null) {
            const page = EntryFind.#paginate(pathnames, statement.lineMarker);
            if (page.status !== 200) return { status: page.status, pathnames: [] };
            pathnames = page.items ?? [];
        }
        return { status: 200, pathnames };
    }

    static async findSessionEntries(statement: FindStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<FindResult> {
        const match = await EntryFind.matchPathnames(statement, ctx, manifest);
        if (match.status !== 200) return { status: match.status, content: null, mimetype: null, results: [] };
        const results = match.pathnames.map((p) => `${manifest.name}://${p}`);
        return { status: 200, content: results.join("\n"), mimetype: "text/plain", results };
    }
}
