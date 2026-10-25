// {§acp-client-types} Runtime-neutral client contracts for @plurnk/plurnk-acp/client.
import type {
    Effort,
    FunctionalityPreparationActivity,
    ModelRoute,
    ProposalProjection,
    ClientInteractionProjection,
    ProviderAccounting,
} from "@plurnk/plurnk-contracts";

export interface AcpDescendantState {
    readonly id: number;
    readonly name: string;
    readonly parentWorkerId: number | null;
    readonly kind: string;
    readonly lifecycle: string;
    readonly gates: ReadonlyArray<ProposalProjection | ClientInteractionProjection>;
}

export interface AcpStreamState {
    readonly entryId: number;
    readonly workerId: number;
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

export interface AcpWorkerStatus {
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
        readonly status: AcpWorkerStatus;
    };
    readonly budget: AcpBudgetState;
}

export type ActionOutcome<T = unknown> =
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly problem: Record<string, unknown> };
