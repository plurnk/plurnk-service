// {§machine-processes} Archiving, unarchiving, deleting, and titling workspaces and sessions.
import type {
    ApplicationSessionArchiving,
    ApplicationSessionDeletion,
    ApplicationSessionTitling,
    ApplicationWorkspaceArchiving,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { daemonFailure } from "./daemon-results.ts";

// The gates of one workspace, each naming the session that waits on it.
export type PlaceGates = (workspaceId: number) => Promise<{
    readonly proposals: ReadonlyArray<{ readonly sessionId: number }>;
    readonly questions: ReadonlyArray<{ readonly sessionId: number }>;
}>;

interface LiveWork {
    readonly loops: number;
    readonly streams: number;
    readonly proposals: number;
    readonly questions: number;
}

const WORK: ReadonlyArray<readonly [keyof LiveWork, string]> = [
    ["loops", "live loop"], ["streams", "open stream"], ["proposals", "pending proposal"], ["questions", "pending question"],
];

// The sessions a call marked or cleared, in id order.
const ids = (rows: ReadonlyArray<{ readonly id: number }>): number[] => rows.map(({ id }) => id).toSorted((a, b) => a - b);

const described = (live: LiveWork): string => WORK.filter(([key]) => live[key] > 0)
    .map(([key, what]) => `${live[key]} ${what}${live[key] === 1 ? "" : "s"}`).join(", ");

export default class Places {
    // What the scope holds, a session and every session beneath it, or every session of the workspace.
    static async #liveWork(db: Db, gates: PlaceGates, workspaceId: number, sessionId: number | null): Promise<LiveWork> {
        const scope = await db.place_scope.all<{ sessionId: number; loops: number; streams: number }>({ workspace_id: workspaceId, session_id: sessionId });
        const covered = new Set(scope.map((row) => row.sessionId));
        const pending = await gates(workspaceId);
        return {
            loops: scope.reduce((sum, row) => sum + row.loops, 0),
            streams: scope.reduce((sum, row) => sum + row.streams, 0),
            proposals: pending.proposals.filter((gate) => covered.has(gate.sessionId)).length,
            questions: pending.questions.filter((gate) => covered.has(gate.sessionId)).length,
        };
    }

    static #refuse(owner: string, live: LiveWork, detail: string, verb: string, extensions: Readonly<Record<string, unknown>>): void {
        if (WORK.every(([key]) => live[key] === 0)) return;
        throw daemonFailure(owner, "live-work", 409, `${detail} ${described(live)}.`, {
            ...extensions, ...live, recovery: `Conclude or cancel the work, then ${verb} it.`, retryable: false,
        });
    }

    static async setWorkspaceArchived(
        db: Db,
        gates: PlaceGates,
        workspaceId: number,
        archived: boolean,
    ): Promise<{ readonly archiving: ApplicationWorkspaceArchiving; readonly changed: boolean }> {
        const mark = async () => {
            const row = await db.place_workspace_mark.get<{ archived_at: string | null }>({ workspace_id: workspaceId });
            if (row === undefined) throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, { workspaceId });
            return row.archived_at;
        };
        if (!archived) {
            const unarchived = await db.place_workspace_unarchive.get<{ id: number }>({ workspace_id: workspaceId });
            if (unarchived === undefined) await mark();
            return { archiving: { id: workspaceId, archived_at: null }, changed: unarchived !== undefined };
        }
        // The archive's own statement refuses a loop or a stream that started after the read; the read then names it.
        for (;;) {
            const before = await mark();
            if (before !== null) return { archiving: { id: workspaceId, archived_at: before }, changed: false };
            Places.#refuse("daemon:workspace", await Places.#liveWork(db, gates, workspaceId, null), `Workspace ${workspaceId} holds`, "archive", { workspaceId });
            const row = await db.place_workspace_archive.get<{ archived_at: string }>({ workspace_id: workspaceId });
            if (row !== undefined) return { archiving: { id: workspaceId, archived_at: row.archived_at }, changed: true };
        }
    }

    static async setSessionArchived(
        db: Db,
        gates: PlaceGates,
        workspaceId: number,
        sessionId: number,
        archived: boolean,
    ): Promise<ApplicationSessionArchiving> {
        const mark = async () => {
            const row = await db.place_session_mark.get<{ archived_at: string | null; origin: string }>({ workspace_id: workspaceId, session_id: sessionId });
            if (row === undefined) throw daemonFailure("daemon:session", "session-not-found", 404,
                `Session ${sessionId} does not belong to workspace ${workspaceId}.`, { workspaceId, sessionId });
            return row.archived_at;
        };
        if (!archived) {
            await mark();
            const unarchived = await db.place_session_unarchive.all<{ id: number }>({ workspace_id: workspaceId, session_id: sessionId });
            return { id: sessionId, archived_at: null, sessionIds: ids(unarchived) };
        }
        for (;;) {
            const before = await mark();
            if (before !== null) return { id: sessionId, archived_at: before, sessionIds: [] };
            Places.#refuse("daemon:session", await Places.#liveWork(db, gates, workspaceId, sessionId),
                `Session ${sessionId} and the sessions beneath it hold`, "archive", { workspaceId, sessionId });
            const rows = await db.place_session_archive.all<{ id: number; archived_at: string }>({ workspace_id: workspaceId, session_id: sessionId });
            if (rows.length > 0) return { id: sessionId, archived_at: rows[0].archived_at, sessionIds: ids(rows) };
        }
    }

    static async deleteSession(
        db: Db,
        gates: PlaceGates,
        workspaceId: number,
        sessionId: number,
    ): Promise<ApplicationSessionDeletion> {
        for (;;) {
            const row = await db.place_session_mark.get<{ archived_at: string | null; origin: string }>({
                workspace_id: workspaceId,
                session_id: sessionId,
            });
            if (row === undefined) {
                throw daemonFailure(
                    "daemon:session",
                    "session-not-found",
                    404,
                    `Session ${sessionId} does not belong to workspace ${workspaceId}.`,
                    { workspaceId, sessionId },
                );
            }
            if (row.origin !== "model") {
                throw daemonFailure(
                    "daemon:session",
                    "model-session-required",
                    409,
                    `Session ${sessionId} is not a model session.`,
                    { workspaceId, sessionId, origin: row.origin, retryable: false },
                );
            }
            Places.#refuse(
                "daemon:session",
                await Places.#liveWork(db, gates, workspaceId, sessionId),
                `Session ${sessionId} and the sessions beneath it hold`,
                "delete",
                { workspaceId, sessionId },
            );
            const subtree = await db.place_session_subtree.all<{ id: number }>({
                workspace_id: workspaceId,
                session_id: sessionId,
            });
            const deleted = await db.place_session_delete.get<{ id: number }>({
                workspace_id: workspaceId,
                session_id: sessionId,
            });
            if (deleted !== undefined) {
                return { id: sessionId, sessionIds: ids(subtree) };
            }
        }
    }

    static async setSessionTitle(
        db: Db,
        workspaceId: number,
        sessionId: number,
        title: string,
    ): Promise<{ readonly titling: ApplicationSessionTitling; readonly changed: boolean }> {
        if (typeof title !== "string" || !title.isWellFormed()) {
            throw daemonFailure(
                "daemon:session",
                "title-invalid",
                400,
                "title must be a well-formed non-empty string.",
                { field: "title", retryable: false },
            );
        }
        const normalized = title.trim();
        if (normalized.length === 0) {
            throw daemonFailure(
                "daemon:session",
                "title-invalid",
                400,
                "title must not be empty after trimming whitespace.",
                { field: "title", retryable: false },
            );
        }
        const row = await db.place_session_mark.get<{ archived_at: string | null; origin: string; title: string | null }>({
            workspace_id: workspaceId,
            session_id: sessionId,
        });
        if (row === undefined) {
            throw daemonFailure(
                "daemon:session",
                "session-not-found",
                404,
                `Session ${sessionId} does not belong to workspace ${workspaceId}.`,
                { workspaceId, sessionId },
            );
        }
        if (row.origin !== "model") {
            throw daemonFailure(
                "daemon:session",
                "model-session-required",
                409,
                `Session ${sessionId} is not a model session.`,
                { workspaceId, sessionId, origin: row.origin, retryable: false },
            );
        }
        if (row.title === normalized) {
            return { titling: { id: sessionId, title: normalized }, changed: false };
        }
        await db.place_session_title.get<{ id: number; title: string }>({
            workspace_id: workspaceId,
            session_id: sessionId,
            title: normalized,
        });
        return { titling: { id: sessionId, title: normalized }, changed: true };
    }
}
