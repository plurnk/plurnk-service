// {§acp-daemon-client} {§acp-plurnk-metadata} {§acp-overview} Runtime-neutral client contracts for @plurnk/plurnk-acp/client.
import type {
    AcpDiscovery,
    ApplicationDaemonPolicy,
    ApplicationOverviewWorkspace,
    ApplicationServiceUpdateResult,
    ApplicationSessionKind,
    ApplicationSessionProjection,
    ApplicationSessionReply,
    ApplicationWorkspaceArchiving,
    ClientEnvelope,
    ClientInteractionProjection,
    ConfigListQuery,
    ConfigListResult,
    ConfigMutationResult,
    Effort,
    EntryReadResult,
    FunctionalityDiscoverQuery,
    FunctionalityDiscoverResult,
    FunctionalityListQuery,
    FunctionalityListResult,
    FunctionalityPreparationActivity,
    LogEntryWire,
    LoopLifecycle,
    McpOAuthBeginResult,
    McpOAuthCompletionResult,
    ModelCatalogPage,
    ModelCatalogQuery,
    ModelProvidersResult,
    ModelRoute,
    OperationResult,
    ProposalProjection,
    ProviderAccounting,
    RollbackReport,
} from "@plurnk/plurnk-contracts";

export interface AcpInitializeMetadata {
    readonly policy?: ApplicationDaemonPolicy;
}

export interface AcpThoughtMetadata {
    readonly sessionId: number;
    readonly sessionName: string;
    readonly loopId: number;
    readonly loopSeq: number;
    readonly turnId: number;
    readonly turnSeq: number;
    readonly coordinate: string;
    readonly body?: { readonly url: string; readonly mimeType: string };
}

export interface AcpOperationMetadata {
    readonly id: number;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly coordinate: string;
    readonly op: string | null;
    readonly origin: string;
    readonly status: number;
    readonly turnId: number;
    readonly turnSeq: number;
    readonly loopId: number;
    readonly loopSeq: number;
    readonly sequence: number;
    readonly scope: null;
    readonly state?: string;
    readonly source?: string;
    readonly signal?: number;
    readonly address?: string;
    readonly target?: string;
    readonly actor?: string;
    readonly actors?: readonly string[];
    readonly attrs?: Readonly<Record<string, unknown>>;
    readonly receipt?: Readonly<Record<string, unknown>>;
    readonly reasoning?: { readonly url: string; readonly mimeType: string };
    readonly body?: { readonly url: string; readonly mimeType?: string };
}

export interface AcpOverviewReply extends ApplicationSessionReply {
    readonly body: { readonly url: string; readonly mimeType: string };
}

export interface AcpOverviewSessionMetadata {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly id: number;
    readonly name: string;
    readonly parentSessionId: number | null;
    readonly kind: ApplicationSessionKind;
    readonly lifecycle: LoopLifecycle;
    readonly gates: number;
    readonly archived?: boolean;
    readonly title?: string | null;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly reply: AcpOverviewReply | null;
}

export interface AcpOverviewResponseMetadata {
    readonly scope: { readonly workspaceId: number } | null;
    readonly workspaces: readonly ApplicationOverviewWorkspace[];
    readonly omitted: number;
    readonly recent?: readonly unknown[];
    readonly recentOmitted?: number;
}

export interface AcpDescendantState {
    readonly id: number;
    readonly name: string;
    readonly parentSessionId: number | null;
    readonly kind: string;
    readonly lifecycle: string;
    readonly gates: ReadonlyArray<ProposalProjection | ClientInteractionProjection>;
}

export interface AcpStreamState {
    readonly entryId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly openedAt?: string;
    readonly op?: string;
    readonly aside?: string;
    readonly loopSeq?: number;
    readonly turnSeq?: number;
    readonly sequence?: number;
    readonly channels: ReadonlyArray<{
        readonly channel: string;
        readonly state: string;
        readonly mimetype: string;
    }>;
}

export interface AcpSpendState {
    readonly requests: number;
    readonly usage: ProviderAccounting["usage"];
    readonly knownUsage: ProviderAccounting["knownUsage"];
    readonly costUsd: string | null;
    readonly knownCostUsd: string | null;
}

export interface AcpInboxItem {
    readonly path: string;
    readonly id: string | null;
    readonly actor?: string;
    readonly loopId: number;
    readonly lifecycle: string;
    readonly body?: { readonly url: string; readonly mimeType: string };
}

export interface AcpWorkspaceState {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly preparation: readonly FunctionalityPreparationActivity[];
    readonly activity: {
        readonly phase: "preparing" | "indexing" | "complete" | "failed";
        readonly completed: number;
        readonly total: number;
        readonly percent: number;
        readonly message: string;
        readonly level: "info" | "warn" | "error";
    } | null;
}

export interface AcpProviderRoute {
    readonly alias: string;
    readonly provider: string;
    readonly model: string;
    readonly effort?: Effort | null;
    readonly effortSource?: "default" | "explicit";
    readonly active: boolean;
    readonly inputCapacity: number | null;
}

export interface AcpSessionStatus {
    readonly model: ModelRoute | null;
    readonly childModel?: ModelRoute | null;
    readonly loopId: number | null;
    readonly loopSeq: number | null;
    readonly packetCount: number;
    readonly lifecycle: string;
    readonly waitUntil: number | null;
    readonly claimedAt: number | null;
    readonly terminatedAt: number | null;
    readonly descendants: readonly AcpDescendantState[];
    readonly streams: readonly AcpStreamState[];
    readonly spend: AcpSpendState;
    readonly inbox: readonly AcpInboxItem[];
    readonly openMessages?: readonly AcpInboxItem[];
}

export interface AcpBudgetState {
    readonly curationWeight: number | null;
    readonly curationBudget: number | null;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
}

export interface AcpPlusState {
    readonly plurnk: {
        readonly workspace: AcpWorkspaceState;
        readonly providers: readonly AcpProviderRoute[];
        readonly status: AcpSessionStatus;
    };
    readonly budget: AcpBudgetState;
}

export type ActionOutcome<T = unknown> =
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly problem: Record<string, unknown> };

export interface AcpActionTargetParams {
    readonly workspace?: string;
    readonly workspaceId?: number;
    readonly session?: string;
    readonly sessionId?: string | number;
    readonly cwd?: string;
    readonly projectRoot?: string | null;
}

export interface AcpWorkspaceListEntry {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly createdAt: string;
    readonly archivedAt: string | null;
}

export interface AcpSessionLoopItem {
    readonly id: number;
    readonly sequence: number;
    readonly status: number;
    readonly lifecycle: LoopLifecycle;
    readonly source: string | null;
    readonly opening: string;
    readonly continued: boolean;
    readonly claimedAt: string | null;
    readonly terminatedAt: string | null;
}

/**
 * {§acp-daemon-client} {§acp-action-binding} Typed parameter and result map for built-in `_plurnk/action` verbs.
 */
export interface PlurnkActionMap {
    readonly ping: {
        readonly params: Readonly<Record<string, never>>;
        readonly result: Readonly<Record<string, never>>;
    };
    readonly discover: {
        readonly params: Readonly<Record<string, never>>;
        readonly result: AcpDiscovery;
    };
    readonly "models.list": {
        readonly params: ModelCatalogQuery & { readonly all?: boolean };
        readonly result: ModelCatalogPage;
    };
    readonly "models.providers": {
        readonly params: Record<string, never>;
        readonly result: ModelProvidersResult;
    };
    readonly "service.update": {
        readonly params: Readonly<Record<string, never>>;
        readonly result: ApplicationServiceUpdateResult;
    };
    readonly "workspace.create": {
        readonly params: {
            readonly name?: string;
            readonly projectRoot?: string | null;
            readonly config?: Readonly<Record<string, string>>;
            readonly client?: string;
        };
        readonly result: ClientEnvelope;
    };
    readonly "workspace.attach": {
        readonly params: {
            readonly id?: number;
            readonly workspaceId?: number;
            readonly name?: string;
            readonly projectRoot?: string;
        };
        readonly result: ClientEnvelope;
    };
    readonly "workspace.list": {
        readonly params: {
            readonly archived?: boolean;
            readonly includeArchived?: boolean;
        };
        readonly result: { readonly workspaces: readonly AcpWorkspaceListEntry[] };
    };
    readonly "workspace.sessions": {
        readonly params: AcpActionTargetParams & {
            readonly archived?: boolean;
            readonly includeArchived?: boolean;
        };
        readonly result: { readonly sessions: readonly ApplicationSessionProjection[] };
    };
    readonly "workspace.rename": {
        readonly params: AcpActionTargetParams & {
            readonly from?: string;
            readonly name?: string;
            readonly to?: string;
        };
        readonly result: { readonly id: number; readonly name: string };
    };
    readonly "workspace.archive": {
        readonly params: AcpActionTargetParams & {
            readonly archived?: boolean;
        };
        readonly result: ApplicationWorkspaceArchiving;
    };
    readonly "workspace.share": {
        readonly params: AcpActionTargetParams & {
            readonly folder: string;
        };
        readonly result: { readonly folder: string };
    };
    readonly "workspace.prompts": {
        readonly params: AcpActionTargetParams & {
            readonly limit?: number;
        };
        readonly result: { readonly prompts: readonly string[] };
    };
    readonly "session.rollback": {
        readonly params: AcpActionTargetParams & {
            readonly to: string;
        };
        readonly result: RollbackReport;
    };
    readonly "session.loops": {
        readonly params: AcpActionTargetParams & {
            readonly loopSeq?: number;
        };
        readonly result: {
            readonly items: readonly AcpSessionLoopItem[];
            readonly updates?: readonly unknown[];
        };
    };
    readonly "log.read": {
        readonly params: AcpActionTargetParams & {
            readonly loopId?: number;
            readonly turnId?: number;
            readonly sinceId?: number;
            readonly beforeId?: number;
            readonly limit?: number;
            readonly loopSeq?: number;
            readonly beforeLoopSeq?: number;
            readonly afterLoopSeq?: number;
            readonly lastLoops?: number;
            readonly turnSeq?: number;
            readonly sequence?: number;
        };
        readonly result: { readonly entries: readonly LogEntryWire[] };
    };
    readonly "entry.read": {
        readonly params: AcpActionTargetParams & {
            readonly target: string;
            readonly channel?: string;
            readonly offset?: number;
        };
        readonly result: EntryReadResult;
    };
    readonly "op.exec": {
        readonly params: AcpActionTargetParams & {
            readonly text: string;
        };
        readonly result: { readonly results: readonly OperationResult[] };
    };
    readonly "service.config.list": { readonly params: ConfigListQuery; readonly result: ConfigListResult };
    readonly "service.config.set": { readonly params: { readonly key: string; readonly value: string }; readonly result: ConfigMutationResult };
    readonly "service.config.unset": { readonly params: { readonly key: string }; readonly result: ConfigMutationResult };
    readonly "workspace.config.list": { readonly params: AcpActionTargetParams & ConfigListQuery; readonly result: ConfigListResult };
    readonly "workspace.config.set": { readonly params: AcpActionTargetParams & { readonly key: string; readonly value: string }; readonly result: ConfigMutationResult };
    readonly "workspace.config.unset": { readonly params: AcpActionTargetParams & { readonly key: string }; readonly result: ConfigMutationResult };
    readonly "service.mcp.list": { readonly params: FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "service.mcp.discover": { readonly params: FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "service.mcp.oauth.begin": { readonly params: { readonly alias: string; readonly redirectUrl: string }; readonly result: McpOAuthBeginResult };
    readonly "service.mcp.oauth.complete": { readonly params: { readonly alias: string; readonly callbackUrl: string }; readonly result: McpOAuthCompletionResult };
    readonly "service.mcp.secrets.list": {
        readonly params: { readonly alias?: string };
        readonly result: { readonly alias?: string; readonly keys?: readonly string[]; readonly byServer: Readonly<Record<string, readonly string[]>> };
    };
    readonly "service.mcp.secrets.set": {
        readonly params: { readonly alias: string; readonly secrets: Readonly<Record<string, string>> };
        readonly result: { readonly alias: string; readonly keys: readonly string[] };
    };
    readonly "service.mcp.secrets.unset": {
        readonly params: { readonly alias: string; readonly keys?: readonly string[] };
        readonly result: { readonly alias: string; readonly keys: readonly string[] };
    };
    readonly "service.skills.list": { readonly params: FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "service.skills.discover": { readonly params: FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "service.personas.list": { readonly params: FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "service.personas.discover": { readonly params: FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "service.env.list": { readonly params: FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "service.env.discover": { readonly params: FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.mcp.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.mcp.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.mcp.oauth.begin": { readonly params: AcpActionTargetParams & { readonly alias: string; readonly redirectUrl: string }; readonly result: McpOAuthBeginResult };
    readonly "workspace.mcp.oauth.complete": { readonly params: AcpActionTargetParams & { readonly alias: string; readonly callbackUrl: string }; readonly result: McpOAuthCompletionResult };
    readonly "workspace.mcp.secrets.list": {
        readonly params: AcpActionTargetParams & { readonly alias?: string };
        readonly result: {
            readonly alias?: string;
            readonly keys?: readonly string[];
            readonly inheritedKeys?: readonly string[];
            readonly byServer: Readonly<Record<string, { readonly keys: readonly string[]; readonly inheritedKeys: readonly string[] }>>;
        };
    };
    readonly "workspace.mcp.secrets.set": {
        readonly params: AcpActionTargetParams & { readonly alias: string; readonly secrets: Readonly<Record<string, string>> };
        readonly result: { readonly alias: string; readonly keys: readonly string[] };
    };
    readonly "workspace.mcp.secrets.unset": {
        readonly params: AcpActionTargetParams & { readonly alias: string; readonly keys?: readonly string[] };
        readonly result: { readonly alias: string; readonly keys: readonly string[] };
    };
    readonly "workspace.skills.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.skills.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.personas.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.personas.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.members.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.members.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.schedule.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.schedule.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "workspace.env.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "workspace.env.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
    readonly "session.env.list": { readonly params: AcpActionTargetParams & FunctionalityListQuery; readonly result: FunctionalityListResult };
    readonly "session.env.discover": { readonly params: AcpActionTargetParams & FunctionalityDiscoverQuery; readonly result: FunctionalityDiscoverResult };
}

export type PlurnkActionName = keyof PlurnkActionMap;
export type PlurnkActionParams<K extends PlurnkActionName> = PlurnkActionMap[K]["params"];
export type PlurnkActionResult<K extends PlurnkActionName> = PlurnkActionMap[K]["result"];
