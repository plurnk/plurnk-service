import type { IncomingMessage, ServerResponse } from "node:http";
import type { FunctionalityPreparationActivity, ProviderAccounting, RollbackReport } from "./types.generated.ts";
import type { ApplicationMessage, MessageResource } from "./MessageResource.ts";
import type {
    CapabilityPolicy,
    CapabilityProjection,
    ClientDisplayCapabilities,
    ClientInteractionProjection,
    ClientInteractionResolution,
    EntryReadResult,
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
import type {
    ApplicationOwnerIdentity,
    ProposalResolution,
    ApplicationActionContext,
    ApplicationActionDescriptor,
    ClientEnvelope,
    ApplicationWorkerProjection,
    ApplicationWorkerQuery,
    ApplicationWorkerIdentity,
    ApplicationWorkerCreation,
    ApplicationLoopAdmission,
    ApplicationLoopProjection,
    ApplicationProviderAlias,
    LogEntryWire,
    ApplicationEventHandler,
    CredentialAuthority,
} from "./Application.ts";

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
    readonly credentials: CredentialAuthority;
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
    /** {§message-idempotency} A client message's address is its idempotency key: `new` when nothing is accepted there,
     *  `accepted` when the same body is; another body under an accepted address is refused, 422 `message-address-reused`. */
    messageAdmission(args: { readonly workspaceId: number; readonly address: string; readonly body: string }): Promise<"new" | "accepted">;
    ensureRuntimeWorker(workspaceId: number): Promise<number>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly loopId?: number;
        readonly prompt: string;
        readonly source?: string;
        readonly messageAddress?: string;
        readonly attachments?: readonly MessageResource[];
        readonly envelope?: Readonly<Record<string, unknown>>;
        readonly maxTurns?: number;
        readonly openPaths?: string[];
        readonly selector?: string;
        readonly childSelector?: string | null;
    }): Promise<ApplicationLoopAdmission>;
    cancelDrain(workerId: number, reason?: string): boolean;
    cancelWorker(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly reason?: string;
    }): Promise<void>;
    // {§connection-lifecycle} — a person's client operation: one loop in the workspace's runtime worker,
    // attributed to `actor`, its `log:///` addresses read in `contextWorkerId`'s log
    // ({§actor-boundary-client-operations}); `onLoop` hears that loop before any statement runs.
    dispatchClientAction(args: {
        readonly workspaceId: number;
        readonly actor: string;
        readonly contextWorkerId?: number;
        readonly statements: PlurnkStatement[];
        readonly onLoop?: (loop: { readonly workerId: number; readonly loopId: number }) => void;
    }): Promise<OperationResult[]>;
    // {§connection-lifecycle} — cancel exactly one client operation: its dispatch while it runs and every execution its
    // rows started that still runs; false when nothing of it was running.
    cancelLoop(args: { readonly workspaceId: number; readonly loopId: number; readonly reason?: string }): Promise<boolean>;
    // {§fence-heading-in-body} — the executor tags this workspace can run: what a parse of
    // client-authored text must know for those tags to open blocks ({§interstitial-fence}).
    executorTags(workspaceId: number): readonly string[];
    // {§bare-option-object} — the executors whose declared body is JSON; a parse of client-authored text reads
    // their bare heading object as that body instead of the option array.
    executorJsonBodyTags(workspaceId: number): readonly string[];
    readLog(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly loopId?: number;
        readonly turnId?: number;
        readonly sinceId?: number;
        readonly beforeId?: number;
        readonly limit?: number;
        readonly loopSeq?: number;
        readonly turnSeq?: number;
        readonly sequence?: number;
    }): Promise<LogEntryWire[]>;
    /** {§agui-provider-routes} Each alias is the route a worker seeded from it gets, its configured effort included. */
    listProviders(): { readonly aliases: Array<ApplicationProviderAlias> };
    listModels(query: ModelCatalogQuery): ModelCatalogPage;
    createWorkspace(args: {
        readonly name?: string;
        readonly projectRoot?: string | null;
        readonly settings?: string | object;
        readonly constraints?: Array<{ readonly effect: string; readonly glob: string }>;
    }): Promise<ClientEnvelope>;
    /** {§methods-workspace-attach} Read-only selection; folder defaults are derived by the daemon. */
    attachWorkspace(args:
        | { readonly workspaceId: number; readonly name?: never; readonly projectRoot?: never }
        | { readonly name: string; readonly workspaceId?: never; readonly projectRoot?: never }
        | { readonly projectRoot: string; readonly workspaceId?: never; readonly name?: never }
    ): Promise<ClientEnvelope>;
    /** {§worker-external-reference} Opaque, adapter-namespaced identity; reading never allocates. */
    readWorkerReference(args: { readonly namespace: string; readonly reference: string }): Promise<{ readonly workspaceId: number; readonly workerId: number } | null>;
    /** {§worker-external-reference} Atomically allocate a folderless workspace and model worker when absent. */
    ensureWorkerReference(args: { readonly namespace: string; readonly reference: string }): Promise<{ readonly workspaceId: number; readonly workerId: number }>;
    /** {§worker-external-reference} Inspect the adapter's retained references to this worker. */
    listWorkerReferences(args: { readonly workspaceId: number; readonly workerId: number; readonly namespace: string }): Promise<string[]>;
    listWorkspaces(): Promise<Array<{
        readonly id: number;
        readonly name: string;
        readonly project_root: string | null;
        /** {§workspace-label} */
        readonly project_label: string | null;
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
    // {§methods-worker-accounting} — the spend of the worker and its descendants since it began.
    workerAccounting(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<ProviderAccounting>;
    // {§methods-workspace-prompts} — an omitted workerId lists every model worker's client-addressed seeds.
    listPrompts(workspaceId: number, limit?: number, workerId?: number): Promise<string[]>;
    // {§share} — the workspace's share, from a consistent copy of the daemon's database, into an absolute folder.
    shareWorkspace(args: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }>;
    renameWorkspace(workspaceId: number, name: string): Promise<{ readonly id: number; readonly name: string }>;
    // {§rollback} — reverse `workerId`'s settled file mutations after its log coordinate `to`, latest
    // first, as one client operation of `actor` ({§connection-lifecycle}); stops at the first file that no
    // longer holds what its mutation wrote.
    rollback(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly actor: string;
        readonly to: string;
    }): Promise<RollbackReport>;
    /** {§methods-workspace-activate} Activate a cold workspace's Functionality without a turn; resolves when it is active. */
    activateWorkspace(args: { readonly workspaceId: number }): Promise<void>;
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
    createWorker(args: ApplicationWorkerCreation): Promise<{ readonly workerId: number; readonly workerName: string }>;
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
