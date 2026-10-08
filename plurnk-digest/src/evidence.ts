import type { ChatMessage } from "@plurnk/plurnk-providers";
import type {
    DerivationStateRow, DispositionCountRow, DispositionRow, EditRow, EmissionRow,
    ExecutionEnvironmentRow, InferenceCallRow, LogCurationEffectRow, LogRow, LoopRow,
    ModelCallRow, OpMixRow, PacketEvidence, ProviderRequestRow, ReasoningRow,
    SearchStateRow, StorageRow, StorageTableRow, TurnAttemptRow, TurnRow, WorkerRollupRow,
    WorkerRow, WorkspaceRow,
} from "./digest-rows.ts";

// {§digest-evidence-reader}: a validated read projection, not a second persisted packet format.
export interface EvidencePacket {
    readonly assistant: { readonly content: string; readonly reasoning: string | null } | null;
    readonly assistantRaw: unknown;
    readonly attributions: readonly string[];
    readonly attachments: readonly unknown[];
    // {§digest-room-line}: the request's measured weight, and the budget its gauge showed (null without one).
    readonly weight: number;
    readonly budget: number | null;
    slot(name: "system" | "user"): string;
    messages(): Array<ChatMessage & { content: string }>;
}

export interface EvidenceRows {
    workspaces: WorkspaceRow[];
    workers: WorkerRow[];
    loops: LoopRow[];
    turns: TurnRow[];
    inferenceCalls: InferenceCallRow[];
    modelCalls: ModelCallRow[];
    turnAttempts: TurnAttemptRow[];
    providerRequests: ProviderRequestRow[];
    logEntries: LogRow[];
    editRows: EditRow[];
    emissionRows: EmissionRow[];
    reasoningRows: ReasoningRow[];
    curationEffects: LogCurationEffectRow[];
    workerRollupRows: WorkerRollupRow[];
    opMixRows: OpMixRow[];
    environmentRows: ExecutionEnvironmentRow[];
    searchState: SearchStateRow;
    derivationState: DerivationStateRow;
    dispositionCounts: DispositionCountRow[];
    dispositions: DispositionRow[];
    storage: StorageRow;
    storageTables: StorageTableRow[];
}

export interface DigestEvidence extends Disposable {
    rows(): EvidenceRows;
    packet(turn: TurnRow): PacketEvidence;
    response(modelCallId: number): string | null;
    request(requestId: number): string | null;
    reasoning(turn: TurnRow): string | null;
    textWeight(text: string): number;
}

export type OpenEvidence = (dbPath: string) => DigestEvidence;
