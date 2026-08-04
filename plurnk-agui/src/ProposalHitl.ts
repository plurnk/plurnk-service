// The in-process HITL core (service#355 hooks B + C + A-resolve; plurnk-agui#2 WS-1).
// Subscribes to the daemon's event source, renders each stopped-world proposal as an
// AG-UI tool-call (via AguiPlus), re-surfaces a workspace's pending proposals on
// (re)connect, and maps standard resume entries back to resolveProposal. The
// engine's pause/gate/applyResolution stay core; this is the view + the round-trip.

import type { AguiEvent, ProposalNotification } from "./types.ts";
import type { DaemonSeam } from "./DaemonSeam.ts";
import { proposalToolCall, resolutionFromResume } from "./AguiPlus.ts";
import type { ResumeEntry } from "@ag-ui/core";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";

// The HITL core needs only the proposal slice of the seam — declare exactly that.
type HitlSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal">;

class ProposalInputError extends Error {
    readonly problem: ProblemDetails;

    constructor(code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>>) {
        const problem = Problems.create("agui:proposal", code, status, detail, {
            stage: "proposal-resolution",
            retryable: false,
            ...extensions,
        });
        super(problem.detail);
        this.name = "ProposalInputError";
        this.problem = problem;
    }
}

export default class ProposalHitl {
    #seam: HitlSeam;
    #emit: (workspaceId: number, workerId: number, events: AguiEvent[]) => void;
    #off: (() => void) | null = null;

    constructor(seam: HitlSeam, emit: (workspaceId: number, workerId: number, events: AguiEvent[]) => void) {
        this.#seam = seam;
        this.#emit = emit;
    }

    // Subscribe to the event source; project each live stopped-world as a tool-call.
    start(): void {
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (method !== "loop/proposal" || workspaceId === null) return;
            const proposal = params as ProposalNotification;
            // Core's one disposition drives both settlement and presentation.
            // A tool-call strictly means client-owned; loop-owned proposals
            // settle in-process and the same AG-UI Run continues.
            if (proposal.disposition.owner !== "client") return;
            this.#emit(workspaceId, proposal.workerId, proposalToolCall(proposal));
        });
    }

    stop(): void {
        this.#off?.();
        this.#off = null;
    }

    // Re-surface a workspace's pending stopped-worlds on (re)connect — a days-old
    // question is discoverable, not lost — each as a tool-call the frontend renders.
    async resurface(workspaceId: number, workerId?: number): Promise<AguiEvent[]> {
        const pending = (await this.#seam.pendingProposals(workspaceId))
            .filter((proposal) => proposal.disposition.owner === "client")
            .filter((proposal) => workerId === undefined || proposal.workerId === workerId);
        return pending.flatMap((proposal) => proposalToolCall(proposal));
    }

    // A standard AG-UI resume Run must address every pending interrupt for its
    // exact worker before any proposal is released.
    async resolve(workspaceId: number, entries: ResumeEntry[]): Promise<{ loopId: number; workerId: number }> {
        const allPending = (await this.#seam.pendingProposals(workspaceId))
            .filter((proposal) => proposal.disposition.owner === "client");
        const resolutions = entries.map(resolutionFromResume);
        if (resolutions.some((r) => r === null)) {
            throw new ProposalInputError(
                "interrupt-invalid",
                400,
                "The resume contains an invalid proposal interrupt.",
                { recovery: "Resume with the interrupt IDs and response shape supplied by the pending tool calls." },
            );
        }
        const resolved = resolutions as Array<NonNullable<(typeof resolutions)[number]>>;
        const received = new Set(resolved.map((r) => r.logEntryId));
        const addressed = allPending.filter((p) => received.has(p.logEntryId));
        if (addressed.length !== received.size) {
            throw new ProposalInputError(
                "proposal-not-pending",
                409,
                "The resume addresses a proposal that is not pending.",
                {
                    receivedProposalIds: [...received],
                    pendingProposalIds: allPending.map(({ logEntryId }) => logEntryId),
                    recovery: "Refresh pending proposals before resuming.",
                },
            );
        }
        const workerIds = new Set(addressed.map((p) => p.workerId));
        if (workerIds.size !== 1) {
            throw new ProposalInputError(
                "worker-scope-invalid",
                400,
                "One resume must address proposals for exactly one worker.",
                {
                    workerIds: [...workerIds],
                    recovery: "Resume each worker separately.",
                },
            );
        }
        const workerId = [...workerIds][0];
        const pending = allPending.filter((p) => p.workerId === workerId);
        const expected = new Set(pending.map((p) => p.logEntryId));
        if (expected.size !== received.size || [...expected].some((id) => !received.has(id))) {
            throw new ProposalInputError(
                "proposal-set-incomplete",
                409,
                `The resume does not address every pending proposal for worker ${workerId}.`,
                {
                    workerId,
                    receivedProposalIds: [...received],
                    pendingProposalIds: [...expected],
                    recovery: "Resolve every pending proposal for this worker in one resume.",
                },
            );
        }
        const loopIds = new Set(pending.map((p) => p.loopId));
        if (loopIds.size !== 1) throw new Error(`worker ${workerId} has pending interrupts across multiple loops`);
        for (const res of resolved) {
            this.#seam.resolveProposal(res.logEntryId, {
                decision: res.decision,
                ...(res.body !== undefined ? { body: res.body } : {}),
            });
        }
        return { loopId: [...loopIds][0], workerId };
    }

}
