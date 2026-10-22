// {§methods-worker-overview} {§application-worker-overview} The places in scope with what waits there: their lifecycle, the
// gates they wait on and their latest finished replies ({§worker-finished-reply}), most recently finished first.
import { excerptOf, type ApplicationOverviewWorker, type ApplicationWorkerOverview } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { projectWorkerRow } from "./envelope.ts";

export interface OverviewPlace {
    readonly id: number;
    readonly replyId: number | null;
}

export default class WorkerOverview {
    // Most recently finished first, by reply row; the places with no reply follow, newest first. The overview holds every
    // place waiting on a gate and the first `limit` in that order.
    static hold<T extends OverviewPlace>(places: readonly T[], gates: ReadonlyMap<number, number>, limit: number): { held: T[]; omitted: number } {
        const ranked = places.toSorted((a, b) => a.replyId !== null && b.replyId !== null ? b.replyId - a.replyId
            : a.replyId !== null ? -1 : b.replyId !== null ? 1 : b.id - a.id);
        const held = ranked.filter((place, index) => index < limit || (gates.get(place.id) ?? 0) > 0);
        return { held, omitted: ranked.length - held.length };
    }

    static async read(db: Db, scope: {
        readonly workspaceId: number | null;
        readonly limit: number;
        readonly excerptChars: number;
        // The gates of one workspace, each naming the worker that waits on it.
        readonly pending: (workspaceId: number) => Promise<ReadonlyArray<{ readonly workerId: number }>>;
        readonly projectLabel: (projectRoot: string | null) => string | null;
    }): Promise<ApplicationWorkerOverview> {
        const rows = await db.overview_places.all<{
            id: number; workspaceId: number; name: string; parentWorkerId: number | null; kind: ApplicationOverviewWorker["kind"];
            loopObservations: string; replyId: number | null; replyAt: string | null; replyCompletion: 200 | 499 | null; replyCoordinate: string | null;
        }>({ workspace_id: scope.workspaceId });
        const gates = new Map<number, number>();
        for (const workspaceId of new Set(rows.map((row) => row.workspaceId))) {
            for (const { workerId } of await scope.pending(workspaceId)) gates.set(workerId, (gates.get(workerId) ?? 0) + 1);
        }
        const { held, omitted } = WorkerOverview.hold(rows.map((row) => projectWorkerRow(row)), gates, scope.limit);
        const replies = held.flatMap(({ replyId }) => replyId === null ? [] : [replyId]);
        const words = new Map((await db.overview_reply_words.all<{ id: number; words: string | null }>({ ids: JSON.stringify(replies) }))
            .map(({ id, words: text }) => [id, text ?? ""]));
        const workspaces = await db.overview_workspaces.all<{ id: number; name: string; projectRoot: string | null }>({
            ids: JSON.stringify([...new Set(held.map(({ workspaceId }) => workspaceId))]),
        });
        return {
            workers: held.map((place) => ({
                workspaceId: place.workspaceId, id: place.id, name: place.name, parentWorkerId: place.parentWorkerId, kind: place.kind,
                lifecycle: place.lifecycle, gates: gates.get(place.id) ?? 0,
                reply: place.replyId === null || place.replyAt === null || place.replyCompletion === null || place.replyCoordinate === null ? null : {
                    id: place.replyId, coordinate: place.replyCoordinate, completion: place.replyCompletion, at: Date.parse(place.replyAt),
                    ...excerptOf(words.get(place.replyId) ?? "", scope.excerptChars),
                },
            })),
            workspaces: workspaces.map(({ id, name, projectRoot }) => ({ id, name, projectRoot, projectLabel: scope.projectLabel(projectRoot) })),
            omitted,
        };
    }
}
