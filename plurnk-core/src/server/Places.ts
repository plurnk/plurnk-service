// {§place-hiding} Hiding and showing workspaces and workers: a durable mark, never a deletion.
import type { ApplicationWorkerHiding, ApplicationWorkspaceHiding } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { daemonFailure } from "./daemon-results.ts";

// The gates of one workspace, each naming the worker that waits on it.
export type PlaceGates = (workspaceId: number) => Promise<{
    readonly proposals: ReadonlyArray<{ readonly workerId: number }>;
    readonly questions: ReadonlyArray<{ readonly workerId: number }>;
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

// The workers a call marked or cleared, in id order.
const ids = (rows: ReadonlyArray<{ readonly id: number }>): number[] => rows.map(({ id }) => id).toSorted((a, b) => a - b);

const described = (live: LiveWork): string => WORK.filter(([key]) => live[key] > 0)
    .map(([key, what]) => `${live[key]} ${what}${live[key] === 1 ? "" : "s"}`).join(", ");

export default class Places {
    // What the scope holds, a worker and every worker beneath it, or every worker of the workspace.
    static async #liveWork(db: Db, gates: PlaceGates, workspaceId: number, workerId: number | null): Promise<LiveWork> {
        const scope = await db.place_scope.all<{ workerId: number; loops: number; streams: number }>({ workspace_id: workspaceId, worker_id: workerId });
        const covered = new Set(scope.map((row) => row.workerId));
        const pending = await gates(workspaceId);
        return {
            loops: scope.reduce((sum, row) => sum + row.loops, 0),
            streams: scope.reduce((sum, row) => sum + row.streams, 0),
            proposals: pending.proposals.filter((gate) => covered.has(gate.workerId)).length,
            questions: pending.questions.filter((gate) => covered.has(gate.workerId)).length,
        };
    }

    static #refuse(owner: string, live: LiveWork, detail: string, extensions: Readonly<Record<string, unknown>>): void {
        if (WORK.every(([key]) => live[key] === 0)) return;
        throw daemonFailure(owner, "live-work", 409, `${detail} ${described(live)}.`, {
            ...extensions, ...live, recovery: "Conclude or cancel the work, then hide it.", retryable: false,
        });
    }

    static async setWorkspaceHidden(db: Db, gates: PlaceGates, workspaceId: number, hidden: boolean): Promise<{ readonly hiding: ApplicationWorkspaceHiding; readonly changed: boolean }> {
        const mark = async () => {
            const row = await db.place_workspace_mark.get<{ hidden_at: string | null }>({ workspace_id: workspaceId });
            if (row === undefined) throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, { workspaceId });
            return row.hidden_at;
        };
        if (!hidden) {
            const shown = await db.place_workspace_show.get<{ id: number }>({ workspace_id: workspaceId });
            if (shown === undefined) await mark();
            return { hiding: { id: workspaceId, hidden_at: null }, changed: shown !== undefined };
        }
        // The hide's own statement refuses a loop or a stream that started after the read; the read then names it.
        for (;;) {
            const before = await mark();
            if (before !== null) return { hiding: { id: workspaceId, hidden_at: before }, changed: false };
            Places.#refuse("daemon:workspace", await Places.#liveWork(db, gates, workspaceId, null), `Workspace ${workspaceId} holds`, { workspaceId });
            const row = await db.place_workspace_hide.get<{ hidden_at: string }>({ workspace_id: workspaceId });
            if (row !== undefined) return { hiding: { id: workspaceId, hidden_at: row.hidden_at }, changed: true };
        }
    }

    static async setWorkerHidden(db: Db, gates: PlaceGates, workspaceId: number, workerId: number, hidden: boolean): Promise<ApplicationWorkerHiding> {
        const mark = async () => {
            const row = await db.place_worker_mark.get<{ hidden_at: string | null }>({ workspace_id: workspaceId, worker_id: workerId });
            if (row === undefined) throw daemonFailure("daemon:worker", "worker-not-found", 404,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`, { workspaceId, workerId });
            return row.hidden_at;
        };
        if (!hidden) {
            await mark();
            const shown = await db.place_worker_show.all<{ id: number }>({ workspace_id: workspaceId, worker_id: workerId });
            return { id: workerId, hidden_at: null, workerIds: ids(shown) };
        }
        for (;;) {
            const before = await mark();
            if (before !== null) return { id: workerId, hidden_at: before, workerIds: [] };
            Places.#refuse("daemon:worker", await Places.#liveWork(db, gates, workspaceId, workerId),
                `Worker ${workerId} and the workers beneath it hold`, { workspaceId, workerId });
            const rows = await db.place_worker_hide.all<{ id: number; hidden_at: string }>({ workspace_id: workspaceId, worker_id: workerId });
            if (rows.length > 0) return { id: workerId, hidden_at: rows[0].hidden_at, workerIds: ids(rows) };
        }
    }
}
