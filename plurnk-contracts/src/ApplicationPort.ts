import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { FunctionalityPreparationActivity, ProviderAccounting, RollbackReport } from "./types.generated.ts";
import type { ApplicationInboxMessage, ApplicationMessage, MessageResource } from "./MessageResource.ts";
import type { ApplicationStream } from "./ApplicationStream.ts";
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
    SessionOwner,
} from "./types.ts";
import type {
    ApplicationOwnerIdentity,
    ProposalResolution,
    ApplicationActionContext,
    ApplicationActionDescriptor,
    ClientEnvelope,
    ApplicationSessionOverview,
    ApplicationSessionProjection,
    ApplicationSessionQuery,
    ApplicationSessionHiding,
    ApplicationWorkspaceHiding,
    ApplicationSessionIdentity,
    ApplicationSessionCreation,
    ApplicationLoopAdmission,
    ApplicationLoopProjection,
    ApplicationGauge,
    ApplicationProviderAlias,
    ApplicationServiceUpdateResult,
    LogEntryWire,
    ApplicationEventHandler,
    CredentialAuthority,
} from "./Application.ts";

/** {§http-host} One request on the daemon's listener, handed to the adapter that mounted its prefix. */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** {§http-host} One upgrade request on the daemon's listener, handed to the adapter that mounted its prefix. */
export type HttpUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;

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
    registerHttpUpgrade(prefix: string, handler: HttpUpgradeHandler): void;
    httpAddress(): { readonly host: string; readonly port: number };
}

/** {§application-session-observation} The transport-neutral application contract consumed by exterior adapters. */
export interface ApplicationPort extends HttpHost {
    readonly credentials: CredentialAuthority;
    registerSessionOwner(workspaceId: number, owner: SessionOwner): Promise<void>;
    claimSessionOwner(args: { readonly workspaceId: number; readonly sessionId: number; readonly owner: string }): Promise<SessionOwner>;
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
    readMessages(args: { readonly workspaceId: number; readonly sessionId: number; readonly loopId?: number }): Promise<ApplicationMessage[]>;
    /** {§methods} The accepted messages the session has not yet observed at a turn boundary, in acceptance order, each with the lifecycle of the loop holding it. */
    readInbox(args: { readonly workspaceId: number; readonly sessionId: number }): Promise<ApplicationInboxMessage[]>;
    /** {§methods} The streams the session holds open, in opening order, each with its channels' states. */
    readStreams(args: { readonly workspaceId: number; readonly sessionId: number }): Promise<ApplicationStream[]>;
    /** {§methods} A client message's address is its idempotency key: `new` when nothing is accepted there,
     *  `accepted` when the same body is; another body under an accepted address is refused, 422 `message-address-reused`. */
    messageAdmission(args: { readonly workspaceId: number; readonly address: string; readonly body: string }): Promise<"new" | "accepted">;
    ensureRuntimeSession(workspaceId: number): Promise<number>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
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
    cancelDrain(sessionId: number, reason?: string): boolean;
    cancelSession(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly reason?: string;
    }): Promise<void>;
    // {§connection-lifecycle} — a person's client operation: one loop in the workspace's runtime session,
    // attributed to `actor`, its `log:///` addresses read in `contextSessionId`'s log
    // ({§connection-lifecycle}); `onLoop` hears that loop before any statement runs.
    dispatchClientAction(args: {
        readonly workspaceId: number;
        readonly actor: string;
        readonly contextSessionId?: number;
        readonly statements: PlurnkStatement[];
        readonly onLoop?: (loop: { readonly sessionId: number; readonly loopId: number }) => void;
    }): Promise<OperationResult[]>;
    // {§connection-lifecycle} — cancel exactly one client operation: its dispatch while it runs and every execution its
    // rows started that still runs; false when nothing of it was running.
    cancelLoop(args: { readonly workspaceId: number; readonly loopId: number; readonly reason?: string }): Promise<boolean>;
    // {§fence-pairing} — the workspace's available names also permit slotless invocation.
    executorTags(workspaceId: number): readonly string[];
    readLog(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly loopId?: number;
        readonly turnId?: number;
        readonly sinceId?: number;
        readonly beforeId?: number;
        readonly limit?: number;
        readonly loopSeq?: number;
        readonly turnSeq?: number;
        readonly sequence?: number;
    }): Promise<LogEntryWire[]>;
    /** {§acp-status-descendants} Each alias is the route a session seeded from it gets, its configured effort included. */
    listProviders(): { readonly aliases: Array<ApplicationProviderAlias> };
    listModels(query: ModelCatalogQuery): ModelCatalogPage;
    /** {§startup-admission} Explicitly refresh the Models.dev catalog cache and installed npm package when `PLURNK_SERVICE_UPDATEABLE=1`. */
    updateService?(): Promise<ApplicationServiceUpdateResult>;
    createWorkspace(args: {
        readonly name?: string;
        readonly projectRoot?: string | null;
        readonly settings?: string | object;
    }): Promise<ClientEnvelope>;
    /** {§methods-workspace-create} Read-only selection; folder defaults are derived by the daemon. */
    attachWorkspace(args:
        | { readonly workspaceId: number; readonly name?: never; readonly projectRoot?: never }
        | { readonly name: string; readonly workspaceId?: never; readonly projectRoot?: never }
        | { readonly projectRoot: string; readonly workspaceId?: never; readonly name?: never }
    ): Promise<ClientEnvelope>;
    /** {§session-external-reference} Opaque, adapter-namespaced identity; reading never allocates. */
    readSessionReference(args: { readonly namespace: string; readonly reference: string }): Promise<{ readonly workspaceId: number; readonly sessionId: number } | null>;
    /** {§session-external-reference} Atomically allocate a folderless workspace and model session when absent. */
    ensureSessionReference(args: { readonly namespace: string; readonly reference: string }): Promise<{ readonly workspaceId: number; readonly sessionId: number }>;
    /** {§session-external-reference} Inspect the adapter's retained references to this session. */
    listSessionReferences(args: { readonly workspaceId: number; readonly sessionId: number; readonly namespace: string }): Promise<string[]>;
    /** {§machine-processes} Omitted `hidden` lists every workspace; true only hidden ones, false only shown ones. */
    listWorkspaces(query?: { readonly hidden?: boolean }): Promise<Array<{
        readonly id: number;
        readonly name: string;
        readonly project_root: string | null;
        /** {§execution-output-identity} */
        readonly project_label: string | null;
        readonly created_at: string;
        /** {§machine-processes} When the workspace was hidden, or null while it is shown. */
        readonly hidden_at: string | null;
    }>>;
    listSessions(
        workspaceId: number,
        query?: ApplicationSessionQuery,
    ): Promise<ApplicationSessionProjection[]>;
    readSession(args: {
        readonly workspaceId: number;
        readonly identity: ApplicationSessionIdentity;
    }): Promise<ApplicationSessionProjection | null>;
    listSessionLoops(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<ApplicationLoopProjection[]>;
    // {§methods-workspace-create} — the places of the daemon, or of one workspace, with what waits there.
    readSessionOverview(args: {
        readonly workspaceId?: number;
        readonly limit: number;
        readonly excerptChars: number;
    }): Promise<ApplicationSessionOverview>;
    // {§methods-workspace-create} — the spend of the session and its descendants since it began.
    sessionAccounting(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<ProviderAccounting>;
    // {§methods-workspace-create} — the client gauge the session's latest packet reported.
    sessionGauge(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<ApplicationGauge>;
    // {§methods-workspace-create} — an omitted sessionId lists every model session's client-addressed seeds.
    listPrompts(workspaceId: number, limit?: number, sessionId?: number): Promise<string[]>;
    // {§share} — the workspace's share, from a consistent copy of the daemon's database, into an absolute folder.
    shareWorkspace(args: { readonly workspaceId: number; readonly folder: string }): Promise<{ readonly folder: string }>;
    renameWorkspace(workspaceId: number, name: string): Promise<{ readonly id: number; readonly name: string }>;
    /** {§methods-workspace-create} Hide or show a workspace; a hide is refused while it holds live work. */
    setWorkspaceHidden(args: { readonly workspaceId: number; readonly hidden: boolean }): Promise<ApplicationWorkspaceHiding>;
    /** {§methods-workspace-create} Hide or show a session with every session beneath it; a hide is refused while they hold live work. */
    setSessionHidden(args: { readonly workspaceId: number; readonly sessionId: number; readonly hidden: boolean }): Promise<ApplicationSessionHiding>;
    // {§log-wire-format} — reverse `sessionId`'s settled file mutations after its log coordinate `to`, latest
    // first, as one client operation of `actor` ({§connection-lifecycle}); stops at the first file that no
    // longer holds what its mutation wrote.
    rollback(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly actor: string;
        readonly to: string;
    }): Promise<RollbackReport>;
    /** {§methods-workspace-create} Activate a cold workspace's Functionality without a turn; resolves when it is active. */
    activateWorkspace(args: { readonly workspaceId: number }): Promise<void>;
    workspacePreparationStatus(workspaceId: number): readonly FunctionalityPreparationActivity[];
    workspaceDerivationStatus(workspaceId: number): {
        readonly phase: "preparing" | "indexing" | "complete" | "failed";
        readonly completed: number;
        readonly total: number;
        readonly percent: number;
        readonly message: string;
        // {§operation-results}: the producer's level rides unchanged — `warn` when a completed pass carries failed members.
        readonly level: "info" | "warn" | "error";
    } | null;
    readEntry(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly target: string;
        readonly channel?: string;
        readonly offset?: number;
    }): Promise<EntryReadResult>;
    // {§methods} — the channel `target` selects, its fragment's or else its scheme's default, complete.
    readEntryChannel(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly target: string;
    }): Promise<EntryReadResult>;
    forkSession(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly name?: string;
    }): Promise<{
        readonly sessionId: number;
        readonly sessionName: string | null;
        readonly parentSessionId: number;
    }>;
    createSession(args: ApplicationSessionCreation): Promise<{ readonly sessionId: number; readonly sessionName: string }>;
    readSessionModel(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<{ readonly model: ModelRoute | null; readonly spawnModel: ModelRoute | null }>;
    setSessionModel(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly selector: string;
        /** An effort chosen with the model; the daemon validates and persists the pair as one. */
        readonly effort?: unknown;
    }): Promise<ModelRoute>;
    setSessionSpawnModel(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly selector: string | null;
    }): Promise<ModelRoute | null>;
    readSessionEffort(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
    }): Promise<{
        readonly effort: Effort | null;
        // {§session-model-selection} — `explicit` only after setSessionEffort.
        readonly source: "default" | "explicit";
        readonly supportedEfforts: readonly Effort[];
    }>;
    setSessionEffort(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
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
