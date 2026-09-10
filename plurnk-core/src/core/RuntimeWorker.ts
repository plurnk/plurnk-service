import type { Db } from "./Db.ts";

// {§actor-boundary} The runtime has an actor for its actual operation turns.
export default class RuntimeWorker {
    static async ensure(db: Db, workspaceId: number): Promise<number> {
        const row = await db.runtime_worker_ensure.get<{ id: number }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error("Runtime worker creation returned no row.");
        return row.id;
    }
}
