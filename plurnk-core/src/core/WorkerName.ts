import { WORKER_NAME } from "@plurnk/plurnk-contracts";
import { randomBytes } from "node:crypto";
import type { Db } from "./Db.ts";

export type WorkerOrigin = "model" | "client" | "_plurnk";

export interface WorkerNameClaim {
    id: number;
    name: string;
}

interface AutoWorkerOptions {
    workspaceId: number;
    parentWorkerId?: number;
    origin: WorkerOrigin;
    forkSnapshot?: boolean;
}

export class WorkerNameConflictError extends Error {
    readonly workerName: string;

    constructor(workerName: string) {
        super(`Worker '${workerName}' already exists in this workspace.`);
        this.name = "WorkerNameConflictError";
        this.workerName = workerName;
    }
}

export class WorkerNameError extends Error {
    readonly workerName: string;
    readonly code = "name-invalid";
    readonly recovery = "Choose a lowercase DNS-label worker name.";

    constructor(workerName: string) {
        super(`Worker name '${workerName}' must match the lowercase DNS-label contract.`);
        this.name = "WorkerNameError";
        this.workerName = workerName;
    }
}

// {§worker-name-minting} Model/client minting only; the runtime actor
// ({§actor-boundary-self-hosting}) and generic URI ingestion have their own contracts.
export default class WorkerName {
    static async forId(db: Db, workerId: number): Promise<string> {
        const row = await db.worker_name_by_id.get<{ name: string }>({ worker_id: workerId });
        if (row === undefined) throw new Error(`Worker ${workerId} does not exist.`);
        return row.name;
    }

    static assert(workerName: string): string {
        if (!WORKER_NAME.test(workerName)) throw new WorkerNameError(workerName);
        return workerName;
    }

    static short(): string {
        return randomBytes(4).toString("hex");
    }

    static async #defaultConversation(
        db: Db,
        workspaceId: number,
    ): Promise<WorkerNameClaim | undefined> {
        return await db.worker_name_get_default_conversation.get<WorkerNameClaim>({
            workspace_id: workspaceId,
        });
    }

    static async #claimAuto(
        db: Db,
        options: AutoWorkerOptions,
        defaultConversation: boolean,
    ): Promise<WorkerNameClaim> {
        const {
            workspaceId,
            parentWorkerId,
            origin,
            forkSnapshot = false,
        } = options;
        while (true) {
            const claimed = await db.worker_name_claim.get<WorkerNameClaim>({
                workspace_id: workspaceId,
                name: WorkerName.short(),
                parent_worker_id: parentWorkerId ?? null,
                origin,
                default_conversation: defaultConversation ? 1 : 0,
                fork_snapshot: forkSnapshot ? 1 : 0,
            });
            if (claimed !== undefined) return claimed;

            if (defaultConversation) {
                const existing = await WorkerName.#defaultConversation(db, workspaceId);
                if (existing !== undefined) return existing;
            }
        }
    }

    // A generated name is not minted until this atomic claim creates its worker.
    // Competing allocators retry only after losing the claim. {§worker-auto-name}
    static async claimAuto(db: Db, options: AutoWorkerOptions): Promise<WorkerNameClaim> {
        return await WorkerName.#claimAuto(db, options, false);
    }

    static async claimNamed(db: Db, name: string, options: AutoWorkerOptions): Promise<WorkerNameClaim> {
        const claimed = await db.worker_name_claim.get<WorkerNameClaim>({
            workspace_id: options.workspaceId,
            name: WorkerName.assert(name),
            parent_worker_id: options.parentWorkerId ?? null,
            origin: options.origin,
            default_conversation: 0,
            fork_snapshot: options.forkSnapshot ? 1 : 0,
        });
        if (claimed === undefined) throw new WorkerNameConflictError(name);
        return claimed;
    }

    // The stable default conversation is both an auto-name allocation and the
    // workspace's one durable default role; both predicates share one write.
    static async ensureDefaultConversation(
        db: Db,
        options: Pick<AutoWorkerOptions, "workspaceId">,
    ): Promise<WorkerNameClaim> {
        const existing = await WorkerName.#defaultConversation(db, options.workspaceId);
        if (existing !== undefined) return existing;
        return await WorkerName.#claimAuto(db, { ...options, origin: "model" }, true);
    }
}
