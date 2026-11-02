// {§acp-daemon-client} {§acp-plurnk-metadata} {§acp-overview} Runtime-neutral client contracts for @plurnk/plurnk-acp/client.
import type {
    ApplicationOverviewWorkspace,
    ApplicationSessionKind,
    ApplicationSessionReply,
    ClientInteractionProjection,
    Effort,
    FunctionalityPreparationActivity,
    LoopLifecycle,
    ModelRoute,
    ProposalProjection,
    ProviderAccounting,
} from "@plurnk/plurnk-contracts";

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
    readonly sessionId: number;
    readonly name: string;
    readonly sessionName: string;
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
    readonly lifetime: string;
    readonly loop_seq?: number;
    readonly turn_seq?: number;
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
    readonly spawnModel?: ModelRoute | null;
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
