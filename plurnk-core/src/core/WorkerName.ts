import { RESERVED_AUTHORITIES, WORKER_NAME } from "@plurnk/plurnk-contracts";

export type WorkerNameRejection = "invalid" | "reserved";

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
}
