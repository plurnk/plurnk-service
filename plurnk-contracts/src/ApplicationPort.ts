import type {
    CapabilityPolicy,
    CapabilityProjection,
    ClientDisplayCapabilities,
    ClientInteractionProjection,
    ClientInteractionResolution,
    EntryReadResult,
    JsonSchema,
    LoopPolicy,
    ModelCatalogPage,
    ModelCatalogQuery,
    ModelRoute,
    OperationResult,
    PlurnkStatement,
    ProposalProjection,
    ReasoningPolicy,
} from "./types.ts";

export type ProposalDecision = "accept" | "reject" | "cancel";

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

export interface ClientEnvelope {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly workerId: number;
    readonly workerName: string;
}

export type ApplicationWorkerOrigin = "model" | "client" | "_plurnk";

export interface ApplicationWorkerProjection {
    readonly id: number;
    readonly name: string;
    readonly created_at: string;
    readonly origin: ApplicationWorkerOrigin;
    readonly parentWorkerId: number | null;
}

export interface ApplicationWorkerQuery {
    readonly origin?: ApplicationWorkerOrigin;
    /** Omitted means every lineage position; null means roots only. */
    readonly parentWorkerId?: number | null;
}

export type ApplicationWorkerIdentity =
    | { readonly id: number; readonly name?: never }
    | { readonly id?: never; readonly name: string };

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
}

export interface ApplicationLoopPacket {
    readonly workerId: number;
    readonly loopId: number;
    readonly packetCount: number;
}

export type LogEntryWire = Readonly<Record<string, unknown>>;
export type ApplicationEventHandler = (
    workspaceId: number | null,
    method: string,
    params: unknown,
) => void;

/** The transport-neutral application contract consumed by exterior adapters. */
export interface ApplicationPort {
    listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities>;
    listModuleActions(): ApplicationActionDescriptor[];
    invokeModuleAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ApplicationActionContext,
    ): Promise<unknown>;
    subscribeToEvents(handler: ApplicationEventHandler): () => void;
    pendingProposals(workspaceId: number): Promise<ProposalProjection[]>;
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void;
    pendingClientInteractions(workspaceId: number): Promise<ClientInteractionProjection[]>;
    resolveClientInteraction(
        interactionId: number,
        resolution: ClientInteractionResolution,
    ): Promise<void>;
    ensureModelWorker(
        workspaceId: number,
        settings?: { readonly capabilities?: CapabilityPolicy },
    ): Promise<number>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly prompt: string;
        readonly source?: string;
        readonly maxTurns?: number;
        readonly policy?: Partial<LoopPolicy>;
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
        readonly functionalityWorkerId: number;
        readonly statements: PlurnkStatement[];
    }): Promise<OperationResult[]>;
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
    listPrompts(workspaceId: number, limit?: number): Promise<string[]>;
    renameWorkspace(workspaceId: number, name: string): Promise<{ readonly id: number; readonly name: string }>;
    workspaceDerivationStatus(workspaceId: number): {
        readonly phase: "preparing" | "indexing" | "complete" | "failed";
        readonly completed: number;
        readonly total: number;
        readonly percent: number;
        readonly message: string;
        readonly level: "info" | "error";
    } | null;
    look(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly functionalityWorkerId: number;
        readonly statement: PlurnkStatement;
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
    createConversationWorker(args: {
        readonly workspaceId: number;
        readonly name?: string;
        readonly settings?: { readonly capabilities?: CapabilityPolicy };
    }): Promise<{ readonly workerId: number; readonly workerName: string }>;
    readWorkerModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<{ readonly model: ModelRoute | null; readonly spawnModel: ModelRoute | null }>;
    setWorkerModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly selector: string;
    }): Promise<ModelRoute>;
    setWorkerSpawnModel(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly selector: string | null;
    }): Promise<ModelRoute | null>;
    readWorkerReasoning(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<{
        readonly policy: ReasoningPolicy | null;
        readonly supportedPolicies: readonly ReasoningPolicy[];
    }>;
    setWorkerReasoning(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly policy: unknown;
    }): Promise<{
        readonly policy: ReasoningPolicy;
        readonly supportedPolicies: readonly ReasoningPolicy[];
    }>;
    readWorkerCapabilities(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<CapabilityProjection>;
    setWorkerCapabilities(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly policy: CapabilityPolicy;
    }): Promise<CapabilityProjection>;
}
