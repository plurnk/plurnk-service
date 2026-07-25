// The in-process HITL core (service#355 hooks B + C + A-resolve; plurnk-agui#2 WS-1).
// Subscribes to the daemon's event source, renders each stopped-world proposal as an
// AG-UI tool-call (via AguiPlus), re-surfaces a workspace's pending proposals on
// (re)connect, and maps a resume worker's tool-result back to resolveProposal. The
// engine's pause/gate/applyResolution stay core; this is the view + the round-trip.

import type { AguiEvent, ProposalNotification } from "./types.ts";
import type { DaemonSeam, PendingProposal } from "./DaemonSeam.ts";
import { proposalToolCall, resolutionFromToolResult, type ToolResultMessage } from "./AguiPlus.ts";

// The HITL core needs only the proposal slice of the seam — declare exactly that.
type HitlSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal">;

export default class ProposalHitl {
    #seam: HitlSeam;
    #emit: (workspaceId: number, events: AguiEvent[]) => void; // fan-out to the workspace's client(s)
    #off: (() => void) | null = null;

    constructor(seam: HitlSeam, emit: (workspaceId: number, events: AguiEvent[]) => void) {
        this.#seam = seam;
        this.#emit = emit;
    }

    // Subscribe to the event source; project each live stopped-world as a tool-call.
    start(): void {
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (method !== "loop/proposal" || workspaceId === null) return;
            // Server-owned stopped-worlds (flags.auto / noProposals
            // auto-reject) settle in-process moments later — the loop continues on this
            // same run. Emitting a tool-call would TERMINATE the worker and orphan that
            // continuation, so a tool-call strictly means client-owned.
            const flags = (params as ProposalNotification).flags as Record<string, unknown> | undefined;
            if (flags?.auto === true || flags?.noProposals === true) return;
            this.#emit(workspaceId, proposalToolCall(params as ProposalNotification));
        });
    }

    stop(): void {
        this.#off?.();
        this.#off = null;
    }

    // Re-surface a workspace's pending stopped-worlds on (re)connect — a days-old
    // question is discoverable, not lost — each as a tool-call the frontend renders.
    async resurface(workspaceId: number): Promise<AguiEvent[]> {
        const pending = await this.#seam.pendingProposals(workspaceId);
        return pending.flatMap((p) => proposalToolCall(ProposalHitl.#normalize(p)));
    }

    // A resume worker's tool-result → resolveProposal. Resolve the persisted
    // proposal first so the caller can bind its response stream to the exact
    // continuation loop before resolution can emit a terminal event.
    async resolve(workspaceId: number, message: ToolResultMessage): Promise<{ resolved: false } | { resolved: true; loopId: number }> {
        const res = resolutionFromToolResult(message);
        if (res === null) return { resolved: false };
        const pending = await this.#seam.pendingProposals(workspaceId);
        const proposal = pending.find((item) => item.logEntryId === res.logEntryId);
        if (proposal === undefined) throw new Error(`proposal ${res.logEntryId} is not pending in workspace ${workspaceId}`);
        this.#seam.resolveProposal(res.logEntryId, { decision: res.decision, ...(res.body !== undefined ? { body: res.body } : {}) });
        return { resolved: true, loopId: proposal.loopId };
    }

    // The DB-shaped pending row → the ProposalNotification AguiPlus renders. attrs/tx
    // arrive as JSON strings; parse at the edge.
    static #normalize(p: PendingProposal): ProposalNotification {
        return {
            logEntryId: p.logEntryId, workspaceId: 0, workerId: p.workerId, loopId: p.loopId, turnId: p.turnId,
            op: p.op, target: { scheme: p.scheme, pathname: p.pathname },
            body: p.tx ?? "", attrs: ProposalHitl.#parseAttrs(p.attrs), flags: {}, staleClobberRisk: false,
        };
    }

    static #parseAttrs(a: string | null): Record<string, unknown> {
        if (a === null) return {};
        try {
            const v: unknown = JSON.parse(a);
            return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
        } catch {
            return {};
        }
    }
}
