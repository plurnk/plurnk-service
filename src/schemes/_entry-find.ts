// FIND helper for entry-bearing schemes (SPEC §6.6).
// v0: glob matcher over pathname + tag filter via signal.
// Other matcher dialects (regex, xpath, jsonpath) return 501.

import type { DatabaseSync } from "node:sqlite";
import type { FindStatement } from "@plurnk/plurnk-grammar";

interface FindCtx {
    db: DatabaseSync;
    statement: FindStatement;
    sessionId: number;
    scheme: string;
}

export interface FindResult {
    status: number;
    content: string | null;
    mimetype: string | null;
    results: string[];
}

const scopePathnameOf = (statement: FindStatement): string | null => {
    const path = statement.path;
    if (path === null) return null;
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

export const findSessionEntries = async ({ db, statement, sessionId, scheme }: FindCtx): Promise<FindResult> => {
    if (statement.path === null) return { status: 400, content: null, mimetype: null, results: [] };
    if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null, results: [] };

    // Matcher dispatch — only glob is supported in v0
    let pathnamePattern: string | null = null;
    if (statement.body !== null) {
        if (statement.body.dialect !== "glob") {
            return { status: 501, content: null, mimetype: null, results: [] };
        }
        pathnamePattern = statement.body.raw;
    }

    // Scope: scheme is required; pathname is optional prefix
    const scopePathname = scopePathnameOf(statement);
    const conditions: string[] = ["e.scope = 'session'", "e.session_id = ?", "e.scheme = ?"];
    const params: (string | number)[] = [sessionId, scheme];

    // Scope prefix on pathname — uses GLOB with a trailing `*` for prefix-match semantics
    if (scopePathname !== null && scopePathname.length > 0) {
        conditions.push("e.pathname GLOB ?");
        params.push(scopePathname + "*");
    }

    // Glob matcher on pathname
    if (pathnamePattern !== null) {
        conditions.push("e.pathname GLOB ?");
        params.push(pathnamePattern);
    }

    // Tag filter: AND semantics — entry must have all listed tags
    const tags = Array.isArray(statement.signal) ? statement.signal : [];
    if (tags.length > 0) {
        const placeholders = tags.map(() => "?").join(", ");
        conditions.push(`e.id IN (
            SELECT entry_id FROM entry_tags
            WHERE tag IN (${placeholders})
            GROUP BY entry_id
            HAVING COUNT(DISTINCT tag) = ?
        )`);
        for (const t of tags) params.push(t);
        params.push(tags.length);
    }

    const sql = `SELECT e.pathname FROM entries e WHERE ${conditions.join(" AND ")} ORDER BY e.pathname`;
    const rows = db.prepare(sql).all(...params) as Array<{ pathname: string }>;
    const results = rows.map((r) => `${scheme}://${r.pathname}`);
    const content = results.join("\n");
    return { status: 200, content, mimetype: "text/plain", results };
};
