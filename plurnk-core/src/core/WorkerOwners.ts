import { Validator, type WorkerOwner } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import Results, { OperationFailureError } from "./results.ts";

type OwnerRow = { address: string; tools: string; interactive: number };

// {§worker-ownership} Presence is deliberately absent: disconnect does not erase capabilities.
export default class WorkerOwners {
    static async register(db: Db, workspaceId: number, owner: WorkerOwner): Promise<void> {
        const exact = Validator.assertWorkerOwner(owner);
        if (exact.address === "_plurnk") throw new OperationFailureError(Results.failure(
            "worker:owner", "runtime-owner-reserved", 409, "The runtime owner cannot be registered by a client.",
        ));
        await db.worker_owner_register.run({
            workspace_id: workspaceId, address: exact.address, tools: JSON.stringify(exact.tools), interactive: exact.interactive ? 1 : 0,
        });
    }

    static #project(row: OwnerRow | undefined, identity: string): WorkerOwner {
        if (row === undefined) throw new Error(`${identity} has no owner.`);
        return Validator.assertWorkerOwner({ address: row.address, tools: JSON.parse(row.tools) as string[], interactive: row.interactive === 1 });
    }

    static async read(db: Db, workerId: number): Promise<WorkerOwner> {
        return WorkerOwners.#project(await db.worker_owner_read.get<OwnerRow>({ worker_id: workerId }), `Worker ${workerId}`);
    }

    static async forLoop(db: Db, loopId: number): Promise<WorkerOwner> {
        return WorkerOwners.#project(await db.worker_owner_for_loop.get<OwnerRow>({ loop_id: loopId }), `Loop ${loopId}`);
    }

    // {§worker-ownership} A person attends the loop's owner: a park only a person can end may wait for it.
    static async interactive(db: Db, loopId: number): Promise<boolean> {
        return (await WorkerOwners.forLoop(db, loopId)).interactive;
    }

    // {§client-interaction-routing} Only a person answers: the owner must be attended and declare the tool.
    static receives(owner: WorkerOwner, toolName: string): boolean {
        return owner.interactive && owner.tools.includes(toolName);
    }

    static async registered(db: Db, workspaceId: number, address: string): Promise<WorkerOwner> {
        const row = await db.worker_owner_registered.get<OwnerRow>({ workspace_id: workspaceId, address });
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
