import {
    Validator,
    type ClientInteractionProjection,
    type ClientInteractionRequest,
    type ClientInteractionResolution,
    type ApplicationOwnerIdentity,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerOwners from "./WorkerOwners.ts";
import Results, { OperationFailureError } from "./results.ts";

export interface ClientInteractionPendingEvent extends ClientInteractionProjection {
    readonly workspaceId: number;
}

interface InteractionRow {
    readonly interactionId: number;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly recipient: string;
    readonly request: string;
}

interface Settlement {
    readonly resolution?: ClientInteractionResolution;
    readonly rejection?: unknown;
    readonly message?: { readonly body: string; readonly source: string; readonly envelope: Readonly<Record<string, unknown>> };
}

interface InteractionWaiter {
    readonly request: ClientInteractionRequest;
    settle(settlement: Settlement): Promise<unknown | null>;
}

const pendingFailure = (interactionId: number): OperationFailureError =>
    new OperationFailureError(Results.failure(
        "interaction:resolution",
        "interaction-not-pending",
        409,
        `Client interaction ${interactionId} is not pending.`,
        {},
        {
            interactionId,
            stage: "interaction-resolution",
            recovery: "Refresh pending interactions before resolving one.",
            retryable: false,
        },
    ));

const unsupportedInteraction = (loopId: number, toolName: string): OperationFailureError =>
    new OperationFailureError(Results.failure(
        "interaction:request",
        "interaction-unsupported",
        501,
        `No recipient implements '${toolName}' for this conversation.`,
        {},
        {
            loopId,
            toolName,
            stage: "interaction-request",
            retryable: false,
        },
    ));

export default class ClientInteractions {
    readonly #db: Db;
    readonly #pending = new Map<number, InteractionWaiter>();
    readonly #listeners: Array<(event: ClientInteractionPendingEvent) => void> = [];

    constructor(db: Db) {
        this.#db = db;
    }

    onPending(listener: (event: ClientInteractionPendingEvent) => void): void {
        this.#listeners.push(listener);
    }

    // {§client-interaction-routing} The worker's owner, while it receives the tool.
    async recipient(workerId: number, toolName: string): Promise<string | null> {
        const owner = await WorkerOwners.read(this.#db, workerId);
        return WorkerOwners.receives(owner, toolName) ? owner.address : null;
    }

    async request(
        request: ClientInteractionRequest,
        ids: { workspaceId: number; workerId: number; loopId: number; turnId: number },
        signal?: AbortSignal,
    ): Promise<ClientInteractionResolution> {
        const exact = structuredClone(Validator.assertClientInteractionRequest(request));
        signal?.throwIfAborted();
        const recipient = await this.recipient(ids.workerId, exact.toolName);
        if (recipient === null) throw unsupportedInteraction(ids.loopId, exact.toolName);
        const inserted = await this.#db.client_interaction_insert.get<{ id: number }>({
            workspace_id: ids.workspaceId,
            worker_id: ids.workerId,
            loop_id: ids.loopId,
            turn_id: ids.turnId,
            recipient,
            request: JSON.stringify(exact),
        });
        if (inserted === undefined) {
            throw new Error(
                `Client interaction coordinates do not identify one operation: worker ${ids.workerId}, loop ${ids.loopId}, turn ${ids.turnId}.`,
            );
        }

        const deferred = Promise.withResolvers<ClientInteractionResolution>();
        const interactionId = inserted.id;
        let settled = false;
        const onAbort = (): void => {
            void waiter.settle({
                rejection: signal?.reason ?? new DOMException("Operation aborted", "AbortError"),
            });
        };
        const waiter: InteractionWaiter = {
            request: exact,
            settle: async (settlement): Promise<unknown | null> => {
                if (settled) return pendingFailure(interactionId);
                settled = true;
                this.#pending.delete(interactionId);
                signal?.removeEventListener("abort", onAbort);
                try {
                    if (settlement.message !== undefined) {
                        const { body, source, envelope } = settlement.message;
                        const admitted = await this.#db.drain_enqueue_message.get<{ id: number }>({
                            loop_id: ids.loopId, body, source, open_paths: "[]", evidence: JSON.stringify({ envelope }), address: source,
                        });
                        if (admitted === undefined) throw new Error(`Interaction ${interactionId} accepted no message.`);
                    }
                    const deleted = await this.#db.client_interaction_delete.get<{ id: number }>({
                        interaction_id: interactionId,
                    });
                    if (deleted === undefined) {
                        throw new Error(`Pending client interaction ${interactionId} lost its durable row.`);
                    }
                } catch (cause) {
                    deferred.reject(cause);
                    return cause;
                }
                if (settlement.rejection !== undefined) deferred.reject(settlement.rejection);
                else if (settlement.resolution !== undefined) deferred.resolve(settlement.resolution);
                else deferred.reject(new Error(`Client interaction ${interactionId} settled without an outcome.`));
                return null;
            },
        };
        this.#pending.set(interactionId, waiter);
        signal?.addEventListener("abort", onAbort, { once: true });

        const event: ClientInteractionPendingEvent = {
            ...Validator.assertClientInteractionProjection({
                interactionId,
                workerId: ids.workerId,
                loopId: ids.loopId,
                turnId: ids.turnId,
                recipient,
                request: exact,
            }),
            workspaceId: ids.workspaceId,
        };
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch (cause) {
                console.error("client interaction pending observer failed:", cause);
            }
        }
        if (signal?.aborted) onAbort();
        return deferred.promise;
    }

    async resolve(interactionId: number, resolution: ClientInteractionResolution, respondent: ApplicationOwnerIdentity, message?: Settlement["message"]): Promise<void> {
        const waiter = this.#pending.get(interactionId);
        if (waiter === undefined) throw pendingFailure(interactionId);
        const pending = await this.#db.client_interaction_recipient.get<{ recipient: string; workspaceId: number }>({ interaction_id: interactionId });
        if (pending === undefined) throw pendingFailure(interactionId);
        if (pending.workspaceId !== respondent.workspaceId || pending.recipient !== respondent.address) {
            throw new OperationFailureError(Results.failure("interaction:resolution", "recipient-mismatch", 403,
                "Only the interaction's recipient may answer it.", {}, { interactionId }));
        }
        const exact = structuredClone(Validator.assertClientInteractionResolution(resolution));
        if (exact.status === "resolved") {
            const validation = Validator.validateJsonSchemaInstance(waiter.request.responseSchema, exact.payload);
            if (!validation.valid) {
                throw new OperationFailureError(Results.failure(
                    "interaction:resolution", "interaction-response-invalid", 400,
                    "Response does not satisfy the pending interaction's schema.", {},
                    { interactionId, issues: validation.errors, retryable: false },
                ));
            }
        }
        const failure = await waiter.settle({ resolution: exact, message });
        if (failure !== null) throw failure;
    }

    // {§client-interaction-list} — a durable row is resumable only while its operation still waits.
    async list(workspaceId: number): Promise<ClientInteractionProjection[]> {
        const rows = await this.#db.client_interaction_list.all<InteractionRow>({ workspace_id: workspaceId });
        return rows
            .filter((row) => this.#pending.has(row.interactionId))
            .map((row) => ClientInteractions.#project(row));
    }

    static #project(row: InteractionRow): ClientInteractionProjection {
        let request: unknown;
        try {
            request = JSON.parse(row.request);
        } catch (cause) {
            throw new Error(`Pending client interaction ${row.interactionId} has invalid request JSON.`, { cause });
        }
        return Validator.assertClientInteractionProjection({
            interactionId: row.interactionId,
            workerId: row.workerId,
            loopId: row.loopId,
            turnId: row.turnId,
            recipient: row.recipient,
            request: Validator.assertClientInteractionRequest(request as ClientInteractionRequest),
        });
    }
}
