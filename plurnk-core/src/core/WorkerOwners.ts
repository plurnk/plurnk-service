import { Validator, type WorkerOwner } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import Results, { OperationFailureError } from "./results.ts";

// {§worker-ownership} Presence is deliberately absent: disconnect does not erase capabilities.
export default class WorkerOwners {
    static async register(db: Db, workspaceId: number, owner: WorkerOwner): Promise<void> {
        const exact = Validator.assertWorkerOwner(owner);
        if (exact.address === "_plurnk") throw new OperationFailureError(Results.failure(
            "worker:owner", "runtime-owner-reserved", 409, "The runtime owner cannot be registered by a client.",
        ));
        await db.worker_owner_register.run({ workspace_id: workspaceId, address: exact.address, tools: JSON.stringify(exact.tools) });
    }

    static #project(row: { address: string; tools: string } | undefined, identity: string): WorkerOwner {
        if (row === undefined) throw new Error(`${identity} has no owner.`);
        return Validator.assertWorkerOwner({ address: row.address, tools: JSON.parse(row.tools) as string[] });
    }

    static async read(db: Db, workerId: number): Promise<WorkerOwner> {
        return WorkerOwners.#project(await db.worker_owner_read.get<{ address: string; tools: string }>({ worker_id: workerId }), `Worker ${workerId}`);
    }

    static async forLoop(db: Db, loopId: number): Promise<WorkerOwner> {
        return WorkerOwners.#project(await db.worker_owner_for_loop.get<{ address: string; tools: string }>({ loop_id: loopId }), `Loop ${loopId}`);
    }

    static async hasReviewer(db: Db, loopId: number): Promise<boolean> {
        return (await WorkerOwners.forLoop(db, loopId)).tools.includes("request_approval");
    }

    static async registered(db: Db, workspaceId: number, address: string): Promise<WorkerOwner> {
        const row = await db.worker_owner_registered.get<{ address: string; tools: string }>({ workspace_id: workspaceId, address });
        if (row === undefined) throw new OperationFailureError(Results.failure(
            "worker:owner", "owner-not-found", 404, `Owner '${address}' is not registered in workspace ${workspaceId}.`,
            {}, { workspaceId, owner: address },
        ));
        return WorkerOwners.#project(row, `Owner '${address}'`);
    }

    static async claim(db: Db, workspaceId: number, workerId: number, owner: string): Promise<WorkerOwner> {
        await WorkerOwners.registered(db, workspaceId, owner);
        await db.worker_owner_claim.run({ workspace_id: workspaceId, worker_id: workerId, owner });
        return WorkerOwners.read(db, workerId);
    }
}
