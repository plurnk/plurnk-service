// {§agui-proposal-resolve} The in-process client-owned HITL core. Proposals
// and generic interactions share one render, reconnect, validation, and resume
// path; their stateful semantics remain with their respective core owners.

import type { Interrupt, ResumeEntry } from "@ag-ui/core";
import {
    Problems,
    Validator,
    type ApplicationPort,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import {
    interactionInterrupt,
    interactionResolutionFromResume,
    interactionToolCall,
    proposalInterrupt,
    proposalToolCall,
    resolutionFromResume,
} from "./AguiPlus.ts";
import type { AguiEvent, ProposalNotification } from "./types.ts";

type HitlSeam = Pick<
    ApplicationPort,
    | "subscribeToEvents"
    | "pendingProposals"
    | "resolveProposal"
    | "pendingClientInteractions"
    | "resolveClientInteraction"
>;

export interface HitlBatch {
    readonly events: AguiEvent[];
    readonly interrupts: Interrupt[];
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
    | {
        readonly kind: "proposal";
        readonly key: string;
        readonly id: number;
        readonly decision: "accept" | "reject" | "cancel";
        readonly body?: string;
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
        const problem = Problems.create("agui:interrupt", code, status, detail, {
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
        key: `prop:${projection.logEntryId}`,
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

const render = (item: PendingItem): HitlBatch => item.kind === "proposal"
    ? {
        events: proposalToolCall(item.projection),
        interrupts: [proposalInterrupt(item.id)],
    }
    : {
        events: interactionToolCall(item.projection),
        interrupts: [interactionInterrupt(item.projection)],
    };

const combine = (items: readonly PendingItem[]): HitlBatch => {
    const batches = items.map(render);
    return {
        events: batches.flatMap(({ events }) => events),
        interrupts: batches.flatMap(({ interrupts }) => interrupts),
    };
};

const parseResolution = (entry: ResumeEntry): ParsedResolution | null => {
    const proposal = resolutionFromResume(entry);
    if (proposal !== null) {
        return {
            kind: "proposal",
            key: entry.interruptId,
            id: proposal.logEntryId,
            decision: proposal.decision,
            ...(proposal.body !== undefined ? { body: proposal.body } : {}),
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
    readonly #seam: HitlSeam;
    readonly #emit: (workspaceId: number, workerId: number, loopId: number, batch: HitlBatch) => void;
    #off: (() => void) | null = null;

    constructor(
        seam: HitlSeam,
        emit: (workspaceId: number, workerId: number, loopId: number, batch: HitlBatch) => void,
    ) {
        this.#seam = seam;
        this.#emit = emit;
    }

    start(): void {
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return;
            if (method === "loop/proposal") {
                const item = proposalItem(params as ProposalNotification);
                if (item.kind !== "proposal" || item.projection.disposition.owner !== "client") return;
                this.#emit(workspaceId, item.workerId, item.loopId, render(item));
                return;
            }
            if (method === "loop/interaction") {
                const item = interactionItem(params as ClientInteractionProjection);
                this.#emit(workspaceId, item.workerId, item.loopId, render(item));
            }
        });
    }

    stop(): void {
        this.#off?.();
        this.#off = null;
    }

    async #pending(workspaceId: number, workerId?: number): Promise<PendingItem[]> {
        const [proposals, interactions] = await Promise.all([
            this.#seam.pendingProposals(workspaceId),
            this.#seam.pendingClientInteractions(workspaceId),
        ]);
        return [
            ...proposals
                .map(proposalItem)
                .filter((item) => item.kind === "proposal" && item.projection.disposition.owner === "client"),
            ...interactions.map(interactionItem),
        ]
            .filter((item) => workerId === undefined || item.workerId === workerId)
            .sort(comparePending);
    }

    async resurface(workspaceId: number, workerId?: number): Promise<HitlBatch> {
        return combine(await this.#pending(workspaceId, workerId));
    }

    async resolve(workspaceId: number, entries: ResumeEntry[]): Promise<{ loopId: number; workerId: number }> {
        const allPending = await this.#pending(workspaceId);
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
        if (resolutions.some((resolution) => resolution === null)) {
            throw new InterruptInputError(
                "interrupt-invalid",
                400,
                "The resume contains an invalid client interrupt.",
                { recovery: "Resume with the interrupt IDs and response shapes supplied by the pending tool calls." },
            );
        }
        const resolved = resolutions as ParsedResolution[];
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
        const pending = allPending.filter((item) => item.workerId === workerId);
        const expected = new Set(pending.map(({ key }) => key));
        if (expected.size !== received.size || [...expected].some((key) => !received.has(key))) {
            throw new InterruptInputError(
                "interrupt-set-incomplete",
                409,
                `The resume does not address every pending interrupt for worker ${workerId}.`,
                {
                    workerId,
                    receivedInterruptIds: [...received],
                    pendingInterruptIds: [...expected],
                    recovery: "Resolve every pending interrupt for this worker in one resume.",
                },
            );
        }
        const loopIds = new Set(pending.map(({ loopId }) => loopId));
        if (loopIds.size !== 1) {
            throw new Error(`worker ${workerId} has pending interrupts across multiple loops`);
        }

        await Promise.all(resolved.map(async (resolution) => {
            if (resolution.kind === "proposal") {
                this.#seam.resolveProposal(resolution.id, {
                    decision: resolution.decision,
                    ...(resolution.body !== undefined ? { body: resolution.body } : {}),
                });
                return;
            }
            await this.#seam.resolveClientInteraction(resolution.id, resolution.resolution);
        }));
        return { loopId: [...loopIds][0], workerId };
    }
}
