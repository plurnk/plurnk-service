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

// The grammar owns the protocol: the statement handed to dispatchAsClient IS
// @plurnk/plurnk-grammar's PlurnkStatement (parsed at the module's edge). Type-only
// import — erased at compile, so the published package stays zero-runtime-deps.
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
export type { PlurnkStatement };

// A journal entry as the daemon ships it (readLog / the log/entry event carry this).
export type LogEntryWire = Record<string, unknown>;

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
    // Loop-control — drive/steer a loop. Returns immediately; the outcome arrives on the
    // event source (loop/terminated). The provider + law-file prompt stay core.
    runLoop(args: { sessionId: number; runId: number; prompt: string; maxTurns?: number; flags?: { yolo?: boolean }; openPaths?: string[] }): Promise<{ action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }>;
    // Loop-control — cancel a run's active drain. Returns whether a drain was cancelled.
    cancelDrain(runId: number, reason?: string): boolean;
    // The op keystone — execute one parsed op as a client-origin turn; the emitted
    // log/entry arrives on the event source. Backs the whole op_* family; the module
    // parses with the grammar at its edge and hands over the statement.
    dispatchAsClient(args: { sessionId: number; runId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }>;
    // Journal read — the module's primary render input (ownership-verified per session).
    readLog(args: { sessionId: number; runId: number; loopId?: number; turnId?: number; sinceId?: number; limit?: number; loopSeq?: number; turnSeq?: number; sequence?: number }): Promise<LogEntryWire[]>;
    // Providers + effective prompt budget (contextSize) for the STATE gauge.
    listProviders(): { aliases: Array<{ alias: string; provider: string; model: string; active: boolean; contextSize: number | null }> };
    // Session lifecycle — establish the envelope a thread binds to. createSession
    // returns the full envelope INCLUDING modelRunId (no lazy inference — the WS
    // bridge's adopt-first-model-row dance is dead).
    createSession(args: { name?: string; projectRoot?: string | null; settings?: string; constraints?: Array<{ effect: string; glob: string }> }): Promise<ClientEnvelope>;
    attachSession(args: { sessionId: number; runId?: number; runName?: string }): Promise<ClientEnvelope>;
    listSessions(): Promise<Array<{ id: number; name: string }>>;
    listRuns(sessionId: number): Promise<Array<{ id: number; name: string }>>;
    // Session metadata + workspace membership (the verb surface).
    // Prior user prompts, newest-first — bare strings (the seam's shape; the wire's always was).
    listPrompts(sessionId: number, limit?: number): Promise<string[]>;
    renameSession(sessionId: number, name: string): Promise<{ id: number; name: string }>;
    constrain(sessionId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }>;
    unconstrain(sessionId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }>;
    listConstraints(sessionId: number): Promise<Array<{ effect: string; glob: string }>> | Array<{ effect: string; glob: string }>;
    // Entry shape/channel read + run branching.
    readEntry(args: { sessionId: number; target: string; channel?: string; offset?: number }): Promise<{ status: number; entry: unknown }>;
    forkRun(args: { sessionId: number; runId: number; name?: string }): Promise<{ runId: number; runName: string | null; parentRunId: number }>;
}

// The envelope a session-lifecycle call returns (core's shape, verbatim).
export interface ClientEnvelope {
    sessionId: number;
    sessionName: string;
    projectRoot: string | null;
    runId: number;
    runName: string;
    modelRunId: number | null;
    clientLoopId: number | null;
}
