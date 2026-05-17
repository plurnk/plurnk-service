import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";

type EditContext = { db: DatabaseSync; statement: EditStatement; sessionId: number; runId: number };
type EditResult = { status: number; entryId: number | null };

type ReadContext = { db: DatabaseSync; statement: ReadStatement; sessionId: number };
type ReadResult = { status: number; content: string | null; mimetype: string | null };

type ShowHideContext = { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number };
type ShowHideResult = { status: number };

export default class Known {
    async edit({ db, statement, sessionId, runId }: EditContext): Promise<EditResult> {
        if (statement.path === null) return { status: 400, entryId: null };
        if (statement.lineMarker !== null) return { status: 501, entryId: null };

        const pathname = this.#pathnameOf(statement);
        const existing = db
            .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = 'known' AND pathname = ?")
            .get(sessionId, pathname) as { id: number } | undefined;

        let entryId: number;
        let createdNow: boolean;
        if (existing === undefined) {
            const row = db
                .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, 'known', ?) RETURNING id")
                .get(sessionId, pathname) as { id: number };
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
    }

    async read({ db, statement, sessionId }: ReadContext): Promise<ReadResult> {
        if (statement.path === null) return { status: 400, content: null, mimetype: null };
        if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
        if (statement.body !== null) return { status: 501, content: null, mimetype: null };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

        const pathname = this.#pathnameOf(statement);
        const row = db
            .prepare(
                "SELECT ec.content, ec.mimetype FROM entries e JOIN entry_channels ec ON ec.entry_id = e.id WHERE e.scope = 'session' AND e.session_id = ? AND e.scheme = 'known' AND e.pathname = ? AND ec.name = 'body'",
            )
            .get(sessionId, pathname) as { content: string; mimetype: string } | undefined;

        if (row === undefined) return { status: 404, content: null, mimetype: null };
        return { status: 200, content: row.content, mimetype: row.mimetype };
    }

    async show(ctx: ShowHideContext): Promise<ShowHideResult> { return this.#setVisibility(ctx, 1); }

    async hide(ctx: ShowHideContext): Promise<ShowHideResult> { return this.#setVisibility(ctx, 0); }

    async #setVisibility({ db, statement, sessionId, runId }: ShowHideContext, target: 0 | 1): Promise<ShowHideResult> {
        if (statement.path === null) return { status: 400 };
        if (statement.lineMarker !== null) return { status: 501 };
        if (statement.body !== null) return { status: 501 };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501 };

        const pathname = this.#pathnameOf(statement);
        const entry = db
            .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = 'known' AND pathname = ?")
            .get(sessionId, pathname) as { id: number } | undefined;
        if (entry === undefined) return { status: 404 };

        const current = db
            .prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = 'body'")
            .get(runId, entry.id) as { indexed: number } | undefined;
        if (current?.indexed === target) return { status: 304 };

        db.prepare(
            "INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', ?) ON CONFLICT (run_id, entry_id, channel) DO UPDATE SET indexed = excluded.indexed",
        ).run(runId, entry.id, target);
        return { status: 200 };
    }

    #pathnameOf(statement: EditStatement | ReadStatement | ShowStatement | HideStatement): string {
        const path = statement.path;
        if (path === null) throw new Error("unreachable");
        if (path.kind === "url") return path.pathname;
        return path.raw;
    }
}
