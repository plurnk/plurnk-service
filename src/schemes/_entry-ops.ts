import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";

type Common = { db: DatabaseSync; sessionId: number; scheme: string };
type EditCtx = Common & { statement: EditStatement; runId: number };
type ReadCtx = Common & { statement: ReadStatement };
type ShowHideCtx = Common & { statement: ShowStatement | HideStatement; runId: number };

export type EditResult = { status: number; entryId: number | null };
export type ReadResult = { status: number; content: string | null; mimetype: string | null };
export type ShowHideResult = { status: number };

const pathnameOf = (statement: { path: EditStatement["path"] }): string => {
    const path = statement.path;
    if (path === null) throw new Error("unreachable");
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

export const editSessionEntry = async ({ db, statement, sessionId, runId, scheme }: EditCtx): Promise<EditResult> => {
    if (statement.path === null) return { status: 400, entryId: null };
    if (statement.lineMarker !== null) return { status: 501, entryId: null };

    const pathname = pathnameOf(statement);
    const existing = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;

    let entryId: number;
    let createdNow: boolean;
    if (existing === undefined) {
        const row = db
            .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, ?, ?) RETURNING id")
            .get(sessionId, scheme, pathname) as { id: number };
        entryId = row.id;
        createdNow = true;
    } else {
        entryId = existing.id;
        createdNow = false;
    }

    db.prepare(
        "INSERT OR REPLACE INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, 'body', ?, 'text/markdown', 0, 'static')",
    ).run(entryId, statement.body ?? "");

    if (Array.isArray(statement.signal)) {
        const insertTag = db.prepare("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)");
        for (const tag of statement.signal) insertTag.run(entryId, tag);
    }

    db.prepare("INSERT OR IGNORE INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 1)")
        .run(runId, entryId);

    return { status: createdNow ? 201 : 200, entryId };
};

export const readSessionEntry = async ({ db, statement, sessionId, scheme }: ReadCtx): Promise<ReadResult> => {
    if (statement.path === null) return { status: 400, content: null, mimetype: null };
    if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
    if (statement.body !== null) return { status: 501, content: null, mimetype: null };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

    const pathname = pathnameOf(statement);
    const row = db
        .prepare(
            "SELECT ec.content, ec.mimetype FROM entries e JOIN entry_channels ec ON ec.entry_id = e.id WHERE e.scope = 'session' AND e.session_id = ? AND e.scheme = ? AND e.pathname = ? AND ec.name = 'body'",
        )
        .get(sessionId, scheme, pathname) as { content: string; mimetype: string } | undefined;

    if (row === undefined) return { status: 404, content: null, mimetype: null };
    return { status: 200, content: row.content, mimetype: row.mimetype };
};

const setSessionEntryVisibility = async ({ db, statement, sessionId, runId, scheme }: ShowHideCtx, target: 0 | 1): Promise<ShowHideResult> => {
    if (statement.path === null) return { status: 400 };
    if (statement.lineMarker !== null) return { status: 501 };
    if (statement.body !== null) return { status: 501 };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501 };

    const pathname = pathnameOf(statement);
    const entry = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;
    if (entry === undefined) return { status: 404 };

    const current = db
        .prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = 'body'")
        .get(runId, entry.id) as { indexed: number } | undefined;
    if (current?.indexed === target) return { status: 304 };

    db.prepare(
        "INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', ?) ON CONFLICT (run_id, entry_id, channel) DO UPDATE SET indexed = excluded.indexed",
    ).run(runId, entry.id, target);
    return { status: 200 };
};

export const showSessionEntry = async (ctx: ShowHideCtx): Promise<ShowHideResult> => setSessionEntryVisibility(ctx, 1);

export const hideSessionEntry = async (ctx: ShowHideCtx): Promise<ShowHideResult> => setSessionEntryVisibility(ctx, 0);
