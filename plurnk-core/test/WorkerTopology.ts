import type { Db } from "../src/core/Db.ts";
import Envelope, { type WorkerRow } from "../src/server/envelope.ts";

export const readWorkerTopology = async (db: Db, workspaceId: number): Promise<{ workers: WorkerRow[]; delegatedWorkers: number }> => {
    const workers = await Envelope.listWorkersForWorkspace(db, workspaceId);
    const delegatedWorkers = workers.filter(({ origin, parentWorkerId }) => origin === "model" && parentWorkerId !== null).length;
    return { workers, delegatedWorkers };
};
