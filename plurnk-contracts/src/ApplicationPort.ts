import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoopLifecycle } from "./LoopLifecycle.ts";
import type { FunctionalityPreparationActivity, ProviderAccounting } from "./types.generated.ts";
import type { ApplicationMessage, MessageResource } from "./MessageResource.ts";
import type {
    CapabilityPolicy,
    CapabilityProjection,
    ClientDisplayCapabilities,
    ClientInteractionProjection,
    ClientInteractionResolution,
    EntryReadResult,
    JsonSchema,
    ModelCatalogPage,
    ModelCatalogQuery,
    ModelRoute,
    OperationResult,
    PlurnkStatement,
    ProposalProjection,
    Notice,
    Effort,
    WorkerOwner,
} from "./types.ts";

export type ProposalDecision = "accept" | "reject" | "cancel";

export interface ApplicationOwnerIdentity {
    readonly workspaceId: number;
    readonly address: string;
}

export interface ProposalResolution {
    readonly decision: ProposalDecision;
    readonly body?: string;
    readonly outcome?: string;
}

export type ApplicationActionContext =
    | { readonly scope: "worldless" }
    | { readonly scope: "workspace"; readonly workspaceId: number }
    | { readonly scope: "worker"; readonly workspaceId: number; readonly workerId: number };

export interface ApplicationActionDescriptor {
    readonly name: string;
    readonly scope: ApplicationActionContext["scope"];
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
}

// `workerId` is the client actor's worker: dispatched client actions live there
// ({§connection-lifecycle}, {§machine-processes}). The conversation worker is
// resolved separately by the client-interface module.
export interface ClientEnvelope {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly workerId: number;
    readonly workerName: string;
}

export type ApplicationWorkerOrigin = "model" | "client" | "_plurnk";

// {§application-worker-observation} — `kind` is how the worker was minted (a conversation, a FORK
// child with a forked log, a WORK child with a fresh log); `lifecycle` projects its representative loop
// through the shared {§loop-lifecycle-vocabulary}, so a directory row can carry the same glyph the
// bound worker's own status gauge shows. Neither is inferred by a client.
export type ApplicationWorkerKind = "conversation" | "fork" | "work";
export interface ApplicationWorkerProjection {
    readonly id: number;
    readonly name: string;
    readonly created_at: string;
    readonly origin: ApplicationWorkerOrigin;
    readonly owner: string;
    readonly parentWorkerId: number | null;
    readonly kind: ApplicationWorkerKind;
    readonly lifecycle: LoopLifecycle;
}

export interface ApplicationWorkerQuery {
    readonly origin?: ApplicationWorkerOrigin;
    /** Omitted means every lineage position; null means roots only. */
    readonly parentWorkerId?: number | null;
}

export type ApplicationWorkerIdentity =
    | { readonly id: number; readonly name?: never }
    | { readonly id?: never; readonly name: string };

export type ApplicationWorkerCreation = {
    readonly workspaceId: number;
    readonly name?: string;
} & (
    | { readonly parentWorkerId: number; readonly owner?: never }
    | { readonly parentWorkerId?: never; readonly owner?: string }
);

export interface ApplicationLoopProjection {
    readonly id: number;
    readonly workerId: number;
    readonly sequence: number;
    readonly status: number;
    readonly prompt: string;
    readonly promptSource: string | null;
    readonly terminatedAt: string | null;
    readonly terminalResult: OperationResult | null;
    /** Exact count of durable packet-bearing turns; retries and administrative turns do not contribute. */
    readonly packetCount: number;
    /** Durable observation deadline, Unix milliseconds; null outside bounded parks. */
    readonly waitUntil: number | null;
}

export interface ApplicationLoopPacket {
    readonly workerId: number;
    readonly loopId: number;
    readonly packetCount: number;
}

// Every log entry carries its logical coordinate — loop_seq/turn_seq/sequence — so the
// client renders ordering without re-deriving it from DB keys. {§methods-log-coordinate}
// A type alias, not an interface: a serialized wire bag must satisfy index-signature
// consumers (Record<string, unknown>), which TypeScript grants aliases but not interfaces.
export type LogEntryWire = {
    id: number;
    worker_id: number;
    loop_id: number;
    loop_seq: number;
    turn_id: number;
    turn_seq: number;
    sequence: number;
    at: string;
    origin: string;
    source: string | null;
    op: string | null;
    signal: unknown;
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    query: string | null;
    fragment: string | null;
    lineMarker: unknown;
    tx: unknown;
    mimetype_tx: string;
    rx: unknown;
    mimetype_rx: string;
    status_rx: number;
    weight: number;
    attrs: unknown;
    reasoning?: string;
};
export type ApplicationEventHandler = (
    workspaceId: number | null,
    method: string,
    params: unknown,
) => void;

/** {§http-host} One request on the daemon's listener, handed to the adapter that mounted its prefix. */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * {§http-host} The daemon's one HTTP listener, offered to exterior adapters. A daemon is one trust
 * domain on one address: core binds `PLURNK_HOST:PLURNK_PORT` before it admits durable state,
 * answers 503 until admission, then routes to the longest mounted prefix or answers 404.
 * Adapters mount at `start()`; none opens a socket of its own. This is the one place the
 * application port names a transport, by ruling (#641): the standards address by URL, never by
 * port, so every exterior interface shares the address.
 */
export interface HttpHost {
    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void;
    httpAddress(): { readonly host: string; readonly port: number };
}

/** {§application-port} The transport-neutral application contract consumed by exterior adapters. */
export interface ApplicationPort extends HttpHost {
    registerWorkerOwner(workspaceId: number, owner: WorkerOwner): Promise<void>;
    claimWorkerOwner(args: { readonly workspaceId: number; readonly workerId: number; readonly owner: string }): Promise<WorkerOwner>;
    configurationNotices(): readonly Notice[];
    listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities>;
    listModuleActions(): ApplicationActionDescriptor[];
    invokeModuleAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ApplicationActionContext,
    ): Promise<unknown>;
    subscribeToEvents(handler: ApplicationEventHandler): () => void;
    pendingProposals(workspaceId: number): Promise<ProposalProjection[]>;
    resolveProposal(logEntryId: number, resolution: ProposalResolution, owner: ApplicationOwnerIdentity): Promise<void>;
    pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]>;
    resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
        respondent: ApplicationOwnerIdentity,
        message?: { readonly body: string; readonly source: string; readonly envelope: Readonly<Record<string, unknown>> },
    ): Promise<void>;
    readMessages(args: { readonly workspaceId: number; readonly workerId: number; readonly loopId?: number }): Promise<ApplicationMessage[]>;
    ensureModelWorker(
        workspaceId: number,
    ): Promise<number>;
    ensureRuntimeWorker(workspaceId: number): Promise<number>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly prompt: string;
        readonly source?: string;
        readonly messageAddress?: string;
        readonly attachments?: readonly MessageResource[];
        readonly envelope?: Readonly<Record<string, unknown>>;
        readonly maxTurns?: number;
        readonly openPaths?: string[];
        readonly selector?: string;
        readonly childSelector?: string | null;
    }): Promise<OperationResult & {
        readonly action: "injected_next_turn" | "enqueued_new_loop";
        readonly loopId: number;
        readonly turnSeq?: number;
    }>;
    cancelDrain(workerId: number, reason?: string): boolean;
    cancelWorker(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly reason?: string;
    }): Promise<void>;
    // {§actor-boundary-attached-functionality} — a client operation journals in
    // its own worker and executes in the attached Worker's environment.
    dispatchClientAction(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly statements: PlurnkStatement[];
    }): Promise<OperationResult[]>;
    // {§fence-heading-in-body} — the executor tags this workspace can run: what a client-tier
    // parse must know for those tags to open blocks ({§interstitial-fence}).
    executorTags(workspaceId: number): readonly string[];
    // {§bare-option-object} — the executors whose declared body is JSON; a client-tier parse reads their bare
    // heading object as that body instead of the option array.
    executorJsonBodyTags(workspaceId: number): readonly string[];
    readLog(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly loopId?: number;
        readonly turnId?: number;
        readonly sinceId?: number;
        readonly limit?: number;
        readonly loopSeq?: number;
        readonly turnSeq?: number;
        readonly sequence?: number;
    }): Promise<LogEntryWire[]>;
    listProviders(): {
        readonly aliases: Array<{
            readonly alias: string;
            readonly provider: string;
            readonly model: string;
            readonly active: boolean;
            readonly inputCapacity: number | null;
        }>;
    };
    listModels(query: ModelCatalogQuery): ModelCatalogPage;
    createWorkspace(args: {
        readonly name?: string;
        readonly projectRoot?: string | null;
        readonly settings?: string | object;
        readonly constraints?: Array<{ readonly effect: string; readonly glob: string }>;
    }): Promise<ClientEnvelope>;
    attachWorkspace(args: {
        readonly workspaceId: number;
        readonly workerId?: number;
        readonly workerName?: string;
    }): Promise<ClientEnvelope>;
    listWorkspaces(): Promise<Array<{
        readonly id: number;
        readonly name: string;
        readonly project_root: string | null;
        readonly created_at: string;
    }>>;
    listWorkers(
        workspaceId: number,
        query?: ApplicationWorkerQuery,
    ): Promise<ApplicationWorkerProjection[]>;
    readWorker(args: {
        readonly workspaceId: number;
        readonly identity: ApplicationWorkerIdentity;
    }): Promise<ApplicationWorkerProjection | null>;
    listWorkerLoops(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<ApplicationLoopProjection[]>;
    // {§methods-worker-descendants} — the spend of the worker's descendants on loops begun
    // after `loopId`; `null` (no loop) is the empty projection.
    descendantAccounting(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly loopId: number | null;
    }): Promise<ProviderAccounting>;
    // {§methods-workspace-prompts} — an omitted workerId lists every model worker's client-addressed seeds.
    listPrompts(workspaceId: number, limit?: number, workerId?: number): Promise<string[]>;
    // {§share} — the workspace's share, from a consistent copy of the daemon's database, into an absolute folder.
    shareWorkspace(args: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }>;
    renameWorkspace(workspaceId: number, name: string): Promise<{ readonly id: number; readonly name: string }>;
    workspacePreparationStatus(workspaceId: number): readonly FunctionalityPreparationActivity[];
    workspaceDerivationStatus(workspaceId: number): {
        readonly phase: "preparing" | "indexing" | "complete" | "failed";
        readonly completed: number;
        readonly total: number;
        readonly percent: number;
        readonly message: string;
        // {§notice-level}: the producer's level rides unchanged — `warn` when a completed pass carries failed members.
        readonly level: "info" | "warn" | "error";
    } | null;
    // {§op-look} — `workerId` owns the closed observation segment; `perspectiveWorkerId`, when
    // given, is the worker whose local `log:///` the READ resolves against, so a human's look
    // sees the conversation as the model does without touching the conversation's loops.
    look(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly statement: PlurnkStatement;
        readonly perspectiveWorkerId?: number;
    }): Promise<OperationResult>;
    readEntry(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly target: string;
        readonly channel?: string;
        readonly offset?: number;
    }): Promise<EntryReadResult>;
    forkWorker(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly name?: string;
    }): Promise<{
        readonly workerId: number;
        readonly workerName: string | null;
        readonly parentWorkerId: number;
    }>;
    createConversationWorker(args: ApplicationWorkerCreation): Promise<{ readonly workerId: number; readonly workerName: string }>;
    readWorkerModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<{ readonly model: ModelRoute | null; readonly spawnModel: ModelRoute | null }>;
    setWorkerModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly selector: string;
        /** An effort chosen with the model; the daemon validates and persists the pair as one. */
        readonly effort?: unknown;
    }): Promise<ModelRoute>;
    setWorkerSpawnModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly selector: string | null;
    }): Promise<ModelRoute | null>;
    readWorkerEffort(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<{
        readonly effort: Effort | null;
        // {§worker-effort-source} — `explicit` only after worker.effort.set.
        readonly source: "default" | "explicit";
        readonly supportedEfforts: readonly Effort[];
    }>;
    setWorkerEffort(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly effort: unknown;
    }): Promise<{
        readonly effort: Effort;
        readonly source: "explicit";
        readonly supportedEfforts: readonly Effort[];
    }>;
    readWorkspaceCapabilities(args: {
        readonly workspaceId: number;
    }): Promise<CapabilityProjection>;
    setWorkspaceCapabilities(args: {
        readonly workspaceId: number;
        readonly policy: CapabilityPolicy;
    }): Promise<CapabilityProjection>;
}
