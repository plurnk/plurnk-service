import type { Db } from "./Db.ts";

// {§actor-boundary-self-hosting} The runtime has an actor for its actual operation turns: the
// workspace's one worker of origin `_plurnk`, named `_plurnk` — a spelling `WORKER_NAME` never
// admits, so no model or client can mint or resume it ({§worker-name-minting}).
export default class RuntimeWorker {
    static async ensure(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.runtime_worker_get.get<{ id: number }>({ workspace_id: workspaceId });
        if (existing !== undefined) return existing.id;
        const row = await db.runtime_worker_ensure.get<{ id: number }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error("Runtime worker creation returned no row.");
        return row.id;
    }
}
