// The in-process HITL core (service#355 hooks B + C + A-resolve; plurnk-agui#2 WS-1).
// Subscribes to the daemon's event source, renders each stopped-world proposal as an
// AG-UI tool-call (via AguiPlus), re-surfaces a session's pending proposals on
// (re)connect, and maps a resume run's tool-result back to resolveProposal. The
// engine's pause/gate/applyResolution stay core; this is the view + the round-trip.

import type { AguiEvent, ProposalNotification } from "./types.ts";
import type { DaemonSeam, PendingProposal } from "./DaemonSeam.ts";
import { proposalToolCall, resolutionFromToolResult, type ToolResultMessage } from "./AguiPlus.ts";

// The HITL core needs only the proposal slice of the seam — declare exactly that.
type HitlSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal">;

export default class ProposalHitl {
    #seam: HitlSeam;
    #emit: (sessionId: number, events: AguiEvent[]) => void; // fan-out to the session's client(s)
    #off: (() => void) | null = null;

    constructor(seam: HitlSeam, emit: (sessionId: number, events: AguiEvent[]) => void) {
        this.#seam = seam;
        this.#emit = emit;
    }

    // Subscribe to the event source; project each live stopped-world as a tool-call.
    start(): void {
        this.#off = this.#seam.subscribeToEvents((sessionId, method, params) => {
            if (method !== "loop/proposal" || sessionId === null) return;
            // Server-owned stopped-worlds (flags.yolo auto-accept / noProposals
            // auto-reject) settle in-process moments later — the loop continues on this
            // same run. Emitting a tool-call would TERMINATE the run and orphan that
            // continuation, so a tool-call strictly means client-owned.
            const flags = (params as ProposalNotification).flags as Record<string, unknown> | undefined;
            if (flags?.yolo === true || flags?.noProposals === true) return;
            this.#emit(sessionId, proposalToolCall(params as ProposalNotification));
        });
    }

    stop(): void {
        this.#off?.();
        this.#off = null;
    }

    // Re-surface a session's pending stopped-worlds on (re)connect — a days-old
    // question is discoverable, not lost — each as a tool-call the frontend renders.
    async resurface(sessionId: number): Promise<AguiEvent[]> {
        const pending = await this.#seam.pendingProposals(sessionId);
        return pending.flatMap((p) => proposalToolCall(ProposalHitl.#normalize(p)));
    }

    // A resume run's tool-result → resolveProposal. Returns true if it resolved a
    // proposal (false = not a plurnk proposal tool-result; the caller handles it as
    // an ordinary message).
    resolve(message: ToolResultMessage): boolean {
        const res = resolutionFromToolResult(message);
        if (res === null) return false;
        this.#seam.resolveProposal(res.logEntryId, { decision: res.decision, ...(res.body !== undefined ? { body: res.body } : {}) });
        return true;
    }

    // The DB-shaped pending row → the ProposalNotification AguiPlus renders. attrs/tx
    // arrive as JSON strings; parse at the edge.
    static #normalize(p: PendingProposal): ProposalNotification {
        return {
            logEntryId: p.logEntryId, sessionId: 0, runId: p.runId, loopId: p.loopId, turnId: p.turnId,
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
