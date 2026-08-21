// {§agui-daemon-client} The daemon's in-process client-interface seam. The
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

// Core's contracts-owned pending-proposal projection. Persistence never crosses
// this seam; live delivery and reconnect expose the same domain shape.
export type { ProposalProjection as PendingProposal } from "@plurnk/plurnk-contracts";
export type { ClientInteractionProjection as PendingClientInteraction } from "@plurnk/plurnk-contracts";
import type {
    ClientDisplayCapabilities,
    ClientInteractionProjection,
    ClientInteractionResolution,
    EntryReadResult,
    ModelCatalogPage,
    ModelCatalogQuery,
    ModelRoute,
    ProposalProjection,
} from "@plurnk/plurnk-contracts";

// The grammar owns the protocol: the statement handed to dispatchAsClient IS
// @plurnk/plurnk-contracts's PlurnkStatement (parsed at the module's edge). Type-only
// import — erased at compile, so the published package stays zero-runtime-deps.
import type { OperationResult } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ReasoningPolicy } from "@plurnk/plurnk-contracts";
export type { PlurnkStatement };

export type ModuleActionContext =
    | { readonly scope: "worldless" }
    | { readonly scope: "workspace"; readonly workspaceId: number };

export interface ModuleActionDescriptor {
    readonly name: string;
    readonly scope: ModuleActionContext["scope"];
}

// A journal entry as the daemon ships it (readLog / the log/entry event carry this).
export type LogEntryWire = Record<string, unknown>;

export interface DaemonSeam {
    listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities>;
    listModuleActions(): ModuleActionDescriptor[];
    invokeModuleAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ModuleActionContext,
    ): Promise<unknown>;
    // Hook B — the in-process event source. `handler` receives every workspace-scoped
    // engine event as (workspaceId, method, params); workspaceId is null for a global
    // event (workspace/created). Returns an unsubscribe. Core emits; the module fans out.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
    // Hook C — a workspace's stopped-world proposals, for re-surfacing on (re)connect.
    pendingProposals(workspaceId: number): Promise<ProposalProjection[]>;
    // Hook A-resolve — feed the human's decision. The gate/validation/applyResolution
    // stay core; this is only the resolve. Throws for an unknown/already-resolved id.
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void;
    // Generic operation-owned client input shares AG-UI's interrupt/resume path
    // without exposing the operation owner's private continuation state.
    pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]>;
    resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
    ): Promise<void>;
    // Worker split ({§machine-processes}): model loops live in the workspace's model worker, never the
    // client worker (connection scratch). Resolve it here — created on first use.
    ensureModelWorker(workspaceId: number, settings?: { requestUserInput?: boolean }): Promise<number>;
    // Loop control — drive/steer a loop on the model worker (runLoop refuses a client-origin
    // worker loudly). Returns immediately; the outcome arrives on the event source.
    runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: { auto?: boolean }; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<OperationResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }>;
    // Loop-control — cancel a worker's active drain. Returns whether a drain was cancelled.
    cancelDrain(workerId: number, reason?: string): boolean;
    // One client action journals all of its parsed statements in one internal segment.
    // The segment is evidence for the action and may remain open across an AG-UI
    // interrupt/resume while a proposed statement awaits resolution.
    dispatchClientAction(args: { workspaceId: number; workerId: number; statements: PlurnkStatement[] }): Promise<OperationResult[]>;
    // Journal read — the module's primary render input (ownership-verified per workspace).
    readLog(args: { workspaceId: number; workerId: number; loopId?: number; turnId?: number; sinceId?: number; limit?: number; loopSeq?: number; turnSeq?: number; sequence?: number }): Promise<LogEntryWire[]>;
    // Providers + their resolved physical input capacity for the STATE gauge.
    listProviders(): { aliases: Array<{ alias: string; provider: string; model: string; active: boolean; inputCapacity: number | null }> };
    // Bounded release-pinned catalog discovery is worldless and side-effect free.
    listModels(query: ModelCatalogQuery): ModelCatalogPage;
    // Workspace lifecycle — establish the world/client-worker value a thread binds to.
    // Conversation-worker selection remains a separate module-owned step.
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
    // The pure READ projection after AG-UI has admitted and rewritten one LOOK. {§agui-op-look} {§op-look}
    look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }>;
    // Contracts {§entry-read-result}: the thread worker supplies the reader perspective.
    readEntry(args: { workspaceId: number; workerId: number; target: string; channel?: string; offset?: number }): Promise<EntryReadResult>;
    forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }>;
    // {§agui-thread-binding} A named, empty-log, model-origin root worker — a fresh
    // conversation over the same world. ensureModelWorker = the stable default,
    // forkWorker = branch with history, createConversationWorker = fresh thread.
    createConversationWorker(args: { workspaceId: number; name?: string; settings?: { requestUserInput?: boolean } }): Promise<{ workerId: number; workerName: string }>;
    // {§agui-worker-model-actions} — the worker's durable model and spawn override,
    // resolved specs or null (unset / inherit).
    readWorkerModel(args: { workspaceId: number; workerId: number }): Promise<{ model: ModelRoute | null; spawnModel: ModelRoute | null }>;
    setWorkerModel(args: { workspaceId: number; workerId: number; selector: string }): Promise<ModelRoute>;
    setWorkerSpawnModel(args: { workspaceId: number; workerId: number; selector: string | null }): Promise<ModelRoute | null>;
    // {§agui-worker-reasoning-actions} — reasoning is a durable worker policy,
    // independent of model selection and immutable during a loop.
    readWorkerReasoning(args: { workspaceId: number; workerId: number }): Promise<{ policy: ReasoningPolicy | null; supportedPolicies: readonly ReasoningPolicy[] }>;
    setWorkerReasoning(args: { workspaceId: number; workerId: number; policy: unknown }): Promise<{ policy: ReasoningPolicy; supportedPolicies: readonly ReasoningPolicy[] }>;
    // {§worker-settings} — the worker's own behavioral rules (closed known-key
    // bag), mutable between loops.
    readWorkerSettings(args: { workspaceId: number; workerId: number }): Promise<{ requestUserInput: boolean }>;
    setWorkerSettings(args: { workspaceId: number; workerId: number; settings: { requestUserInput?: boolean } }): Promise<{ requestUserInput: boolean }>;
}

// The envelope a workspace-lifecycle call returns (core's shape, verbatim).
export interface ClientEnvelope {
    workspaceId: number;
    workspaceName: string;
    projectRoot: string | null;
    workerId: number;
    workerName: string;
}
