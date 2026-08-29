import {
    RESERVED_AUTHORITIES,
    WORKER_NAME,
    type CapabilityPolicy,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

export type WorkerNameRejection = "invalid" | "reserved";
export type WorkerOrigin = "model" | "client" | "_plurnk";

export interface WorkerNameClaim {
    id: number;
    name: string;
}

interface AutoWorkerOptions {
    workspaceId: number;
    prefix: string;
    qualifier?: string;
    parentWorkerId?: number;
    origin: WorkerOrigin;
    forkSnapshot?: boolean;
    capabilityBound?: CapabilityPolicy;
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

    // Preserve the semantic suffix and shorten only the inherited prefix until
    // the contracts predicate admits the generated ordinal. {§worker-auto-name}
    static ordinal(prefix: string, ordinal: number, qualifier?: string): string {
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
            throw new Error(`Worker ordinal must be a positive safe integer; received ${ordinal}.`);
        }
        const suffix = `${qualifier === undefined ? "" : `-${qualifier}`}-${ordinal}`;
        for (let length = prefix.length; length > 0; length--) {
            const candidate = `${prefix.slice(0, length)}${suffix}`;
            if (WorkerName.rejection(candidate) === null) return candidate;
        }
        throw new Error(`Worker ordinal suffix '${suffix}' leaves no mintable name prefix.`);
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
            prefix,
            qualifier,
            parentWorkerId,
            origin,
            forkSnapshot = false,
            capabilityBound = {},
        } = options;
        const namePrefix = `${prefix}${qualifier === undefined ? "" : `-${qualifier}`}-%`;
        const count = await db.worker_name_count.get<{ n: number }>({
            workspace_id: workspaceId,
            name_prefix: namePrefix,
        });
        let ordinal = (count?.n ?? 0) + 1;

        while (true) {
            const claimed = await db.worker_name_claim.get<WorkerNameClaim>({
                workspace_id: workspaceId,
                name: WorkerName.ordinal(prefix, ordinal, qualifier),
                parent_worker_id: parentWorkerId ?? null,
                origin,
                default_conversation: defaultConversation ? 1 : 0,
                fork_snapshot: forkSnapshot ? 1 : 0,
                capability_bound: JSON.stringify(capabilityBound),
            });
            if (claimed !== undefined) return claimed;

            if (defaultConversation) {
                const existing = await WorkerName.#defaultConversation(db, workspaceId);
                if (existing !== undefined) return existing;
            }
            ordinal++;
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
        options: Omit<AutoWorkerOptions, "parentWorkerId" | "qualifier" | "origin">,
    ): Promise<WorkerNameClaim> {
        const existing = await WorkerName.#defaultConversation(db, options.workspaceId);
        if (existing !== undefined) return existing;
        return await WorkerName.#claimAuto(db, { ...options, origin: "model" }, true);
    }
}
