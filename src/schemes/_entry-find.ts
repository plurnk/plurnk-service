// FIND helper for entry-bearing schemes (SPEC §6.6).
// v0: glob matcher over pathname + tag filter via signal.
// Other matcher dialects (regex, xpath, jsonpath) return 501.

import type { FindStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";

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

export const findSessionEntries = async (statement: FindStatement, ctx: PlurnkSchemeContext, scheme: string): Promise<FindResult> => {
    if (statement.path === null) return { status: 400, content: null, mimetype: null, results: [] };
    if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null, results: [] };

    let pathnamePattern: string | null = null;
    if (statement.body !== null) {
        if (statement.body.dialect !== "glob") {
            return { status: 501, content: null, mimetype: null, results: [] };
        }
        pathnamePattern = statement.body.raw;
    }

    const scopePathname = scopePathnameOf(statement);
    const scopeGlob = scopePathname !== null && scopePathname.length > 0 ? `${scopePathname}*` : null;
    const tags = Array.isArray(statement.signal) ? statement.signal : [];
    // SqlRite auto-stringifies arrays passed as params; SQL side uses json_each.
    const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

    const { db, sessionId } = ctx;
    const rows = await (db.find_session_entries as PrepMethod).all<{ pathname: string }>({
        session_id: sessionId,
        scheme,
        scope_pathname: scopeGlob,
        pathname_pattern: pathnamePattern,
        tags: tagsParam,
    });
    const results = rows.map((r) => `${scheme}://${r.pathname}`);
    const content = results.join("\n");
    return { status: 200, content, mimetype: "text/plain", results };
};
