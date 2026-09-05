import type { Db } from "../src/core/Db.ts";
import Envelope from "../src/server/envelope.ts";

export const readWorkerTopology = async (db: Db, workspaceId: number) => {
    const workers = await Envelope.listWorkersForWorkspace(db, workspaceId);
    const delegatedWorkers = workers.filter(({ origin, parentWorkerId }) => origin === "model" && parentWorkerId !== null).length;
    return { workers, delegatedWorkers };
};
