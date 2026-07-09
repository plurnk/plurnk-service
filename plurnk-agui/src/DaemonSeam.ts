// My coupling to the daemon's in-process client-interface seam (service#355). The
// module depends on THIS interface — the committed, tested contract — never the
// Daemon class's guts. It grows as the service lands hooks (loop-control,
// session/envelope, reads, fork, execs/auth, the boot plug-point); today it carries
// what's published: the event source (B) and proposal read + resolve (C + A-resolve).

export type ProposalDecision = "accept" | "reject" | "cancel";

export interface ProposalResolution {
    decision: ProposalDecision;
    body?: string;    // reviewer-edited content, INPUT to applyResolution
    outcome?: string; // operational reason (rejected, timeout, policy_veto, …)
}

// The DB-shaped pending row (Daemon.pendingProposals). attrs/tx arrive as JSON
// strings; the module parses at its edge.
export interface PendingProposal {
    logEntryId: number;
    runId: number;
    loopId: number;
    turnId: number;
    op: string;
    suffix: string;
    scheme: string | null;
    pathname: string | null;
    tx: string | null;
    attrs: string | null;
}

export interface DaemonSeam {
    // Hook B — the in-process event source. `handler` receives every session-scoped
    // engine event as (sessionId, method, params); sessionId is null for a global
    // event (session/created). Returns an unsubscribe. Core emits; the module fans out.
    subscribeToEvents(handler: (sessionId: number | null, method: string, params: unknown) => void): () => void;
    // Hook C — a session's stopped-world proposals, for re-surfacing on (re)connect.
    pendingProposals(sessionId: number): Promise<PendingProposal[]>;
    // Hook A-resolve — feed the human's decision. The gate/validation/applyResolution
    // stay core; this is only the resolve. Throws for an unknown/already-resolved id.
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void;
}
