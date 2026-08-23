import type {
    ClientDisplayCapabilities,
    ClientInteractionProjection,
    ClientInteractionResolution,
    EntryReadResult,
    JsonSchema,
    LoopFlags,
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
        settings?: { readonly requestUserInput?: boolean },
    ): Promise<number>;
    runLoop(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly prompt: string;
        readonly source?: string;
        readonly maxTurns?: number;
        readonly flags?: Partial<LoopFlags>;
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
    dispatchClientAction(args: {
        readonly workspaceId: number;
        readonly workerId: number;
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
    constrain(
        workspaceId: number,
        effect: string,
        glob: string,
    ): Promise<{ readonly effect: string; readonly glob: string; readonly source: "explicit" }>;
    unconstrain(
        workspaceId: number,
        effect: string,
        glob: string,
    ): Promise<{ readonly effect: string; readonly glob: string }>;
    listConstraints(workspaceId: number): Promise<Array<{
        readonly effect: string;
        readonly glob: string;
        readonly source: "explicit" | "create";
    }>> | Array<{
        readonly effect: string;
        readonly glob: string;
        readonly source: "explicit" | "create";
    }>;
    workspaceDerivationStatus(workspaceId: number): {
        readonly phase: "preparing" | "indexing" | "complete" | "failed";
        readonly completed: number;
        readonly total: number;
        readonly percent: number;
        readonly message: string;
        readonly level: "info" | "error";
    } | null;
    listMembers(workspaceId: number): Promise<{
        readonly members: Array<{ readonly path: string; readonly effect: string }>;
        readonly hidden: string[];
    }>;
    look(args: {
        readonly workspaceId: number;
        readonly workerId: number;
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
        readonly settings?: { readonly requestUserInput?: boolean };
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
    readWorkerSettings(args: {
        readonly workspaceId: number;
        readonly workerId: number;
    }): Promise<{ readonly requestUserInput: boolean }>;
    setWorkerSettings(args: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly settings: { readonly requestUserInput?: boolean };
    }): Promise<{ readonly requestUserInput: boolean }>;
}
