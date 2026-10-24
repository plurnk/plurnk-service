// {§acp-proposal-resolve} The in-process client-owned HITL core. Proposals
// and generic interactions share one render, reconnect, validation, and resume
// path; their stateful semantics remain with their respective core owners.

import {
    Problems,
    Validator,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type LogEntryWire,
    type ProblemDetails,
    type ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import {
    interactionInterrupt,
    interactionResolutionFromResume,
    interactionToolCall,
    proposalInterrupt,
    proposalKey,
    resolutionFromResume,
} from "./AcpPlus.ts";
import type { AcpEvent, Interrupt, ProposalNotification, ResumeEntry } from "./types.ts";

type HitlPort = Pick<
    ApplicationPort,
    | "subscribeToEvents"
    | "pendingProposals"
    | "resolveProposal"
    | "pendingClientInteractions"
    | "resolveClientInteraction"
    | "readLog"
>;

// {§acp-proposal-resolve} The operation a gate awaits a decision on: its worker, loop and coordinate, and its row, whose
// call the gate presents on a Run that holds that worker's conversation.
export interface GatedCall {
    readonly workerId: number;
    readonly loopId: number;
    readonly coordinate: string;
    readonly entry: LogEntryWire;
}

// One gate: the key its resume entry resolves, its interrupt before the Portal identifies it per Run, and, for a
// proposal, the call it concerns. A client interaction is its own call.
export interface HitlGate {
    readonly key: string;
    readonly kind: "proposal" | "interaction";
    readonly interrupt: Omit<Interrupt, "id">;
    readonly call?: GatedCall;
}

export interface HitlBatch {
    readonly events: AcpEvent[];
    readonly gates: HitlGate[];
}

export interface HitlDelivery {
    readonly recipient: string;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly batch: HitlBatch;
}

type PendingItem =
    | {
        readonly kind: "proposal";
        readonly id: number;
        readonly key: string;
        readonly workerId: number;
        readonly loopId: number;
        readonly turnId: number;
        readonly projection: ProposalNotification;
    }
    | {
        readonly kind: "interaction";
        readonly id: number;
        readonly key: string;
        readonly workerId: number;
        readonly loopId: number;
        readonly turnId: number;
        readonly projection: ClientInteractionProjection;
    };

type ParsedResolution =
    | ProposalResolution & {
        readonly kind: "proposal";
        readonly key: string;
        readonly id: number;
    }
    | {
        readonly kind: "interaction";
        readonly key: string;
        readonly id: number;
        readonly resolution: ClientInteractionResolution;
    };

class InterruptInputError extends Error {
    readonly problem: ProblemDetails;

    constructor(code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>>) {
        const problem = Problems.create("acp:interrupt", code, status, detail, {
            stage: "interrupt-resolution",
            retryable: false,
            ...extensions,
        });
        super(problem.detail);
        this.name = "InterruptInputError";
        this.problem = problem;
    }
}

const proposalItem = (value: ProposalNotification): PendingItem => {
    const projection = Validator.assertProposalProjection(value);
    return {
        kind: "proposal",
        id: projection.logEntryId,
        key: proposalKey(projection.logEntryId),
        workerId: projection.workerId,
        loopId: projection.loopId,
        turnId: projection.turnId,
        projection,
    };
};

const interactionItem = (value: ClientInteractionProjection): PendingItem => {
    const projection = Validator.assertClientInteractionProjection(value);
    return {
        kind: "interaction",
        id: projection.interactionId,
        key: `int:${projection.interactionId}`,
        workerId: projection.workerId,
        loopId: projection.loopId,
        turnId: projection.turnId,
        projection,
    };
};

const comparePending = (left: PendingItem, right: PendingItem): number =>
    left.workerId - right.workerId
    || left.loopId - right.loopId
    || left.turnId - right.turnId
    || left.kind.localeCompare(right.kind)
    || left.id - right.id;

const recipient = (item: PendingItem): string => item.kind === "proposal" ? item.projection.owner : item.projection.recipient;

const parseResolution = (entry: ResumeEntry): ParsedResolution | null => {
    const proposal = resolutionFromResume(entry);
    if (proposal !== null) {
        return {
            kind: "proposal",
            key: entry.interruptId,
            id: proposal.logEntryId,
            decision: proposal.decision,
            ...(proposal.body !== undefined ? { body: proposal.body } : {}),
            ...(proposal.outcome !== undefined ? { outcome: proposal.outcome } : {}),
        };
    }
    const interaction = interactionResolutionFromResume(entry);
    if (interaction === null) return null;
    return {
        kind: "interaction",
        key: entry.interruptId,
        id: interaction.interactionId,
        resolution: interaction.resolution,
    };
};

export default class ProposalHitl {
    readonly #seam: HitlPort;
    // {§acp-proposal-resolve} A gate is handed over the moment its event arrives, while its row is still being read, so
    // whatever the workspace publishes after it waits behind its presentation.
    readonly #emit: (workspaceId: number, delivery: Promise<HitlDelivery>) => void;
    #off: (() => void) | null = null;

    constructor(
        seam: HitlPort,
        emit: (workspaceId: number, delivery: Promise<HitlDelivery>) => void,
    ) {
        this.#seam = seam;
        this.#emit = emit;
    }

    start(): void {
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return;
            const item = method === "loop/proposal" ? proposalItem(Validator.assertProposalProjection(params))
                : method === "loop/interaction" ? interactionItem(Validator.assertClientInteractionProjection(params))
                : null;
            if (item === null || (item.kind === "proposal" && item.projection.disposition.decision !== "review")) return;
            this.#emit(workspaceId, this.#render(workspaceId, item).then((batch) => (
                { recipient: recipient(item), workerId: item.workerId, loopId: item.loopId, turnId: item.turnId, batch })));
        });
    }

    // {§acp-proposal-resolve} A proposal's gate is the operation's own call and an interrupt naming it: the gate carries
    // the operation's row, read by its coordinate, and the Portal presents its call on each Run.
    async #render(workspaceId: number, item: PendingItem): Promise<HitlBatch> {
        if (item.kind === "interaction") {
            return { events: interactionToolCall(item.projection), gates: [{ key: item.key, kind: "interaction", interrupt: interactionInterrupt(item.projection) }] };
        }
        const { workerId, loopId, coordinate } = item.projection;
        const [loopSeq, turnSeq, sequence] = coordinate.split("/").map(Number);
        const [row] = await this.#seam.readLog({ workspaceId, workerId, loopSeq, turnSeq, sequence });
        if (row === undefined) throw new Error(`Pending proposal ${item.id} has no row at ${coordinate}.`);
        return { events: [], gates: [{ key: item.key, kind: "proposal", interrupt: proposalInterrupt(item.projection),
            call: { workerId, loopId, coordinate, entry: row } }] };
    }

    async #combine(workspaceId: number, items: readonly PendingItem[]): Promise<HitlBatch> {
        const batches = await Promise.all(items.map((item) => this.#render(workspaceId, item)));
        return { events: batches.flatMap(({ events }) => events), gates: batches.flatMap(({ gates }) => gates) };
    }

    stop(): void {
        this.#off?.();
        this.#off = null;
    }

    async #pending(workspaceId: number): Promise<PendingItem[]> {
        const [proposals, interactions] = await Promise.all([
            this.#seam.pendingProposals(workspaceId),
            this.#seam.pendingClientInteractions(workspaceId),
        ]);
        return [
            ...proposals
                .map(proposalItem)
                .filter((item) => item.kind === "proposal" && item.projection.disposition.decision === "review"),
            ...interactions.map(interactionItem),
        ]
            .toSorted(comparePending);
    }

    // {§acp-held-interrupts} The keys of the gates pending for an owner.
    async pendingKeys(workspaceId: number, address: string): Promise<ReadonlySet<string>> {
        return new Set((await this.#pending(workspaceId)).filter((item) => recipient(item) === address).map(({ key }) => key));
    }

    async resurface(workspaceId: number, address: string): Promise<HitlDelivery[]> {
        const pending = (await this.#pending(workspaceId)).filter((item) => recipient(item) === address);
        const workerIds = [...new Set(pending.map(({ workerId }) => workerId))];
        return await Promise.all(workerIds.map(async (workerId) => {
            const workerPending = pending.filter((item) => item.workerId === workerId);
            const first = workerPending[0];
            const loopIds = new Set(workerPending.map(({ loopId }) => loopId));
            if (loopIds.size !== 1 || first === undefined) {
                throw new Error(`worker ${workerId} has pending interrupts across multiple loops`);
            }
            return {
                recipient: address,
                workerId,
                loopId: first.loopId,
                turnId: first.turnId,
                batch: await this.#combine(workspaceId, workerPending),
            };
        }));
    }

    async resolve(
        workspaceId: number,
        address: string,
        entries: ResumeEntry[],
        beforeRelease: (
            binding: { loopId: number; workerId: number },
        ) => void | Promise<void> = () => {},
    ): Promise<{ loopId: number; workerId: number }> {
        const allPending = (await this.#pending(workspaceId)).filter((item) => recipient(item) === address);
        const entryKeys = entries.map(({ interruptId }) => interruptId);
        if (new Set(entryKeys).size !== entryKeys.length) {
            throw new InterruptInputError(
                "interrupt-duplicate",
                400,
                "The resume contains the same interrupt more than once.",
                {
                    receivedInterruptIds: entryKeys,
                    recovery: "Include each pending interrupt exactly once.",
                },
            );
        }
        const resolutions = entries.map(parseResolution);
        if (!resolutions.every((resolution): resolution is ParsedResolution => resolution !== null)) {
            throw new InterruptInputError(
                "interrupt-invalid",
                400,
                "The resume contains an invalid client interrupt.",
                { recovery: "Resume with the interrupt IDs and response shapes supplied by the pending tool calls." },
            );
        }
        const resolved = resolutions;
        const received = new Set(resolved.map(({ key }) => key));
        const addressed = allPending.filter(({ key }) => received.has(key));
        if (addressed.length !== received.size) {
            throw new InterruptInputError(
                "interrupt-not-pending",
                409,
                "The resume addresses an interrupt that is not pending.",
                {
                    receivedInterruptIds: [...received],
                    pendingInterruptIds: allPending.map(({ key }) => key),
                    recovery: "Refresh pending interrupts before resuming.",
                },
            );
        }
        const workerIds = new Set(addressed.map(({ workerId }) => workerId));
        if (workerIds.size !== 1) {
            throw new InterruptInputError(
                "worker-scope-invalid",
                400,
                "One resume must address interrupts for exactly one worker.",
                {
                    workerIds: [...workerIds],
                    recovery: "Resume each worker separately.",
                },
            );
        }
        const workerId = [...workerIds][0];
        // {§acp-proposal-resolve} The presentation is the unit a resume answers, and the Portal holds it: a gate of this
        // worker the resume does not name stays pending and is presented next.
        const loopIds = new Set(addressed.map(({ loopId }) => loopId));
        if (loopIds.size !== 1) {
            throw new Error(`worker ${workerId} has pending interrupts across multiple loops`);
        }

        const binding = { loopId: [...loopIds][0], workerId };
        await beforeRelease(binding);
        await Promise.all(resolved.map(async (resolution) => {
            if (resolution.kind === "proposal") {
                await this.#seam.resolveProposal(resolution.id, {
                    decision: resolution.decision,
                    ...(resolution.body !== undefined ? { body: resolution.body } : {}),
                    ...(resolution.outcome !== undefined ? { outcome: resolution.outcome } : {}),
                }, { workspaceId, address });
                return;
            }
            await this.#seam.resolveClientInteraction(resolution.id, resolution.resolution, { workspaceId, address });
        }));
        return binding;
    }
}
