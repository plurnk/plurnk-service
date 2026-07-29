// My coupling to the daemon's in-process client-interface seam (service#355). The
// module depends on THIS interface — the committed, tested contract — never the
// Daemon class's guts. It grows as the service lands hooks (loop-control,
// workspace/envelope, reads, fork, execs/auth, the boot plug-point); today it carries
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
    workerId: number;
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
import type { OperationResult } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
export type { PlurnkStatement };

// A journal entry as the daemon ships it (readLog / the log/entry event carry this).
export type LogEntryWire = Record<string, unknown>;

export interface DaemonSeam {
    // Hook B — the in-process event source. `handler` receives every workspace-scoped
    // engine event as (workspaceId, method, params); workspaceId is null for a global
    // event (workspace/created). Returns an unsubscribe. Core emits; the module fans out.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
    // Hook C — a workspace's stopped-world proposals, for re-surfacing on (re)connect.
    pendingProposals(workspaceId: number): Promise<PendingProposal[]>;
    // Hook A-resolve — feed the human's decision. The gate/validation/applyResolution
    // stay core; this is only the resolve. Throws for an unknown/already-resolved id.
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void;
    // Run-split (service SPEC, machine-processes): loops live in the workspace's MODEL run, never the
    // client worker (connection scratch). Resolve it here — created on first use.
    ensureModelWorker(workspaceId: number): Promise<number>;
    // Loop-control — drive/steer a loop on the MODEL run (runLoop refuses a client-origin
    // run loudly). Returns immediately; the outcome arrives on the event source.
    runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: { auto?: boolean }; openPaths?: string[]; alias?: string; model?: string }): Promise<OperationResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }>;
    // Loop-control — cancel a worker's active drain. Returns whether a drain was cancelled.
    cancelDrain(workerId: number, reason?: string): boolean;
    // One client action journals all of its parsed statements in one internal segment.
    // The segment is evidence for the action and may remain open across an AG-UI
    // interrupt/resume while a proposed statement awaits resolution.
    dispatchClientAction(args: { workspaceId: number; workerId: number; statements: PlurnkStatement[] }): Promise<OperationResult[]>;
    // Journal read — the module's primary render input (ownership-verified per workspace).
    readLog(args: { workspaceId: number; workerId: number; loopId?: number; turnId?: number; sinceId?: number; limit?: number; loopSeq?: number; turnSeq?: number; sequence?: number }): Promise<LogEntryWire[]>;
    // Providers + effective prompt budget (promptBudget) for the STATE gauge.
    listProviders(): { aliases: Array<{ alias: string; provider: string; model: string; active: boolean; promptBudget: number | null }> };
    // Workspace lifecycle — establish the envelope a thread binds to. createWorkspace
    // returns the full envelope INCLUDING modelWorkerId (no lazy inference — the WS
    // bridge's adopt-first-model-row dance is dead).
    createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object; constraints?: Array<{ effect: string; glob: string }> }): Promise<ClientEnvelope>;
    attachWorkspace(args: { workspaceId: number; workerId?: number; workerName?: string }): Promise<ClientEnvelope>;
    listWorkspaces(): Promise<Array<{ id: number; name: string }>>;
    listWorkers(workspaceId: number): Promise<Array<{ id: number; name: string }>>;
    // Workspace metadata + workspace membership (the verb surface).
    // Prior user prompts, newest-first — bare strings (the seam's shape; the wire's always was).
    listPrompts(workspaceId: number, limit?: number): Promise<string[]>;
    renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }>;
    constrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }>;
    unconstrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }>;
    listConstraints(workspaceId: number): Promise<Array<{ effect: string; glob: string }>> | Array<{ effect: string; glob: string }>;
    workspaceDerivationStatus(workspaceId: number): {
        phase: "preparing" | "indexing" | "complete" | "failed";
        completed: number; total: number; percent: number; message: string; level: "info" | "error";
    } | null;
    // Workspace membership (gutter signs / the /members verb).
    listMembers(workspaceId: number): Promise<{ members: Array<{ path: string; effect: string }>; hidden: string[] }>;
    // The pure READ-projection query (svc#358): parse at the module's edge, rewrite
    // LOOK→READ, hand the statement; resolves run-relative on the client loop,
    // returns content, mints NO log row. Engine.look throws on a non-READ statement.
    look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }>;
    // Entry shape/channel read + run branching.
    readEntry(args: { workspaceId: number; target: string; channel?: string; offset?: number }): Promise<OperationResult & { entry: unknown }>;
    forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }>;
    // The third door (svc#366): a named, empty-log, model-origin ROOT run — a fresh
    // conversation over the same world. ensureModelWorker = the stable default,
    // forkWorker = branch with history, createConversationWorker = fresh thread.
    createConversationWorker(args: { workspaceId: number; name?: string }): Promise<{ workerId: number; workerName: string }>;
}

// The envelope a workspace-lifecycle call returns (core's shape, verbatim).
export interface ClientEnvelope {
    workspaceId: number;
    workspaceName: string;
    projectRoot: string | null;
    workerId: number;
    workerName: string;
    modelWorkerId: number | null;
    clientLoopId: number | null;
}
