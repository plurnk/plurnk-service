import {
    RESERVED_AUTHORITIES,
    WORKER_NAME,
} from "@plurnk/plurnk-contracts";
import { randomBytes } from "node:crypto";
import type { Db } from "./Db.ts";

export type WorkerNameRejection = "invalid" | "reserved";
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

export class WorkerNameError extends Error {
    readonly workerName: string;
    readonly rejection: WorkerNameRejection;
    readonly code: "name-invalid" | "name-reserved";
    readonly recovery: string;

    constructor(workerName: string, rejection: WorkerNameRejection) {
        const reserved = rejection === "reserved";
        super(reserved
            ? `Worker name '${workerName}' is reserved.`
            : `Worker name '${workerName}' must match the lowercase DNS-label contract.`);
        this.name = "WorkerNameError";
        this.workerName = workerName;
        this.rejection = rejection;
        this.code = reserved ? "name-reserved" : "name-invalid";
        this.recovery = reserved
            ? "Choose another worker name."
            : "Choose a lowercase DNS-label worker name.";
    }
}

// {§worker-name-minting} Model/client minting only; internal reserved actors and
// generic URI ingestion have their own contracts.
export default class WorkerName {
    static readonly #RESERVED = new Set<string>([...RESERVED_AUTHORITIES, "~"]);

    static rejection(workerName: string): WorkerNameRejection | null {
        if (WorkerName.#RESERVED.has(workerName.toLowerCase())) return "reserved";
        return WORKER_NAME.test(workerName) ? null : "invalid";
    }

    static assert(workerName: string): string {
        const rejection = WorkerName.rejection(workerName);
        if (rejection !== null) throw new WorkerNameError(workerName, rejection);
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
