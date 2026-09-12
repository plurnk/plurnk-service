// Fork a worker — branch the log, share the workspace (SPEC {§machine-processes}).
// The branch's claimed row is the fork: workers_fork_copies_history copies the parent's
// history inside that INSERT ({§worker-fork-trigger}, fork.sql).

import type { Db } from "./Db.ts";
import WorkerName, { type WorkerOrigin } from "./WorkerName.ts";

export default class Fork {
    static async fork(db: Db, parentWorkerId: number, name: string | undefined): Promise<number> {
        const parent = await db.worker_get.get<{ workspace_id: number; origin: WorkerOrigin }>({ id: parentWorkerId });
        if (parent === undefined) throw new Error(`fork: worker ${parentWorkerId} not found`);
        // {§worker-auto-name} The same allocator serves addressless WORK and FORK.
        const options = { workspaceId: parent.workspace_id, parentWorkerId, origin: parent.origin, forkSnapshot: true } as const;
        const branch = name === undefined
            ? await WorkerName.claimAuto(db, options)
            : await WorkerName.claimNamed(db, name, options);
        return branch.id;
    }
}
