// Row and model shapes the digest reads from the DB ({§digest-programmatic-surface}); shared by
// Digest (the reader), DigestRender, and DigestRequiem.
import type { SqlRiteSyncPreparedStatements } from "@possumtech/sqlrite";
import type { ChatMessage, ProviderAccounting, ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { DurablePacket } from "../core/StoredPacket.ts";

// sqlrite types dynamic PREP accessors as `any` ([method: string]); bind each
// block accessor to its shipped generic statement shape at the use site.
export type SyncPrep<T> = SqlRiteSyncPreparedStatements<T>;

export interface WorkspaceRow { id: number; name: string }
export interface WorkerRow { id: number; workspace_id: number; name: string; provider_identity: string }
export interface LoopRow {
    id: number;
    worker_id: number;
    sequence: number;
    status: number;
    prompt: string;
    policy: string;
    terminated_by: string | null;
    terminal_result: string | null;
}
export interface ErrorEvidence {
    name: string;
    message: string;
    cause?: ErrorEvidence;
}
export interface PacketFailure {
    raw: string;
    error: ErrorEvidence;
}
export interface TurnRow {
    id: number; loop_id: number; sequence: number;
    producer: "model" | "client" | "_plurnk" | "plugin";
    kind: "inference" | "initialization" | "overflow" | "operation";
    status: number; completed_at: string | null; packet: DurablePacket | null;
    packetFailure: PacketFailure | null;
    finish_reason: string | null; model: string | null;
    meta: string | null;  // {§meta-passthrough}, {§rail-truth-engine-verdict}
}
export type StoredTurnRow = Omit<TurnRow, "packet" | "packetFailure"> & { packet: string | null };
export interface TurnAttemptRow {
    id: number; model_call_id: number; turn_id: number; sequence: number; kind: "emission";
    state: "pending" | "response" | "error"; accepted: number | null;
    response: string | null; failure: string | null; parse_errors: string; attributions: string;
    finish_reason: string | null; model: string; timestamp: string; completed_at: string | null;
    request_model: string; response_model: string | null;
}
export interface InferenceCallRow {
    id: number;
    workspace_id: number;
    turn_id: number | null;
    sequence: number;
    kind: "emission" | "bare" | "embedding_query" | "embedding_documents";
    state: "pending" | "response" | "error";
    attributions: string;
    request_model: string;
    timestamp: string;
    completed_at: string | null;
}
export interface ModelCallRow {
    id: number;
    workspace_id: number;
    turn_id: number;
    sequence: number;
    kind: "emission" | "bare";
    state: "pending" | "response" | "error";
    response: string | null;
    failure: string | null;
    capacity: string | null;
    attributions: string;
    finish_reason: string | null;
    model: string;
    request_model: string;
    response_model: string | null;
    timestamp: string;
    completed_at: string | null;
    turn_attempt_id: number | null;
    accepted: number | null;
    parse_errors: string | null;
    log_entry_id: number | null;
}
export interface EmbeddingCallRow {
    id: number;
    workspace_id: number;
    turn_id: number | null;
    sequence: number;
    kind: "embedding_query" | "embedding_documents";
    state: "pending" | "response" | "error";
    model: string;
    input_count: number | null;
    output_count: number | null;
    metadata: string | null;
    failure: string | null;
    timestamp: string;
    completed_at: string | null;
}
export interface ProviderRequestRow {
    id: number;
    inference_call_id: number;
    turn_attempt_id: number | null;
    kind: InferenceCallRow["kind"];
    turn_id: number | null;
    loop_id: number | null;
    worker_id: number | null;
    workspace_id: number;
    sequence: number;
    provider: string;
    model: string;
    state: "pending" | "settled";
    outcome: "response" | "error" | null;
    status: number | null;
    usage_input: number | null;
    usage_output: number | null;
    usage_total: number | null;
    usage_input_no_cache: number | null;
    usage_input_cache_read: number | null;
    usage_input_cache_write: number | null;
    usage_output_text: number | null;
    usage_output_reasoning: number | null;
    cost_kind: "charged" | "estimated" | "unknown" | null;
    cost_amount: string | null;
    cost_currency: string | null;
    cost_usd_equivalent: string | null;
    cost_source: string | null;
    cost_reason: string | null;
    started_at: string;
    completed_at: string | null;
}
export interface LogRow {
    id: number; worker_id: number; loop_id: number; turn_id: number; sequence: number;
    origin: string; source: string | null; model_call_id: number | null; attrs: string;
    op: string | null; scheme: string | null; hostname: string | null; port: number | null;
    pathname: string | null; query: string | null; fragment: string | null;
    rx: string | null; mimetype_rx: string; status_rx: number; state: string; outcome: string | null;
    initial_folded: string; projection_active: 0 | 1; projection_folded: string; tags: string;
}
export interface LogCurationEffectRow {
    operation_log_entry_id: number;
    target_log_entry_id: number;
    active_before: 0 | 1;
    active_after: 0 | 1;
    folded_before: string;
    folded_after: string;
    tags_added: string;
    tags_removed: string;
}
export interface WorkerRollupRow {
    worker_id: number; loops: number; turns: number;
    last_status: number | null;
}
export interface OpMixRow { worker_id: number; op: string; n: number }
export interface SemanticStateRow {
    channel_entries: number;
    derivation_complete: number;
    unfinished: number;
}
export interface DispositionCountRow { disposition: string; n: number }
export interface DispositionRow {
    scheme: string;
    authority: string;
    pathname: string;
    channel: string;
    disposition: string;
    reason: string | null;
}
export interface DerivationStateRow {
    complete: number;
    building: number;
}
export interface EmbeddingStateRow {
    chunks: number;
    models: number;
}

// Loaded snapshot + derived index maps, threaded through the renderers so the
// data flow is explicit (no hidden module-level state).
export interface DigestModel {
    dbPath: string;
    digestDir: string;
    workspaces: WorkspaceRow[];
    workers: WorkerRow[];
    loops: LoopRow[];
    turns: TurnRow[];
    inferenceCalls: InferenceCallRow[];
    modelCalls: ModelCallRow[];
    embeddingCalls: EmbeddingCallRow[];
    turnAttempts: TurnAttemptRow[];
    providerRequests: ProviderRequestRow[];
    logEntries: LogRow[];
    curationEffects: LogCurationEffectRow[];
    workersByWorkspace: Map<number, WorkerRow[]>;
    loopsByWorker: Map<number, LoopRow[]>;
    turnsByLoop: Map<number, TurnRow[]>;
    attemptsByTurn: Map<number, TurnAttemptRow[]>;
    requestsByInferenceCall: Map<number, ProviderRequestRow[]>;
    requestsByAttempt: Map<number, ProviderRequestRow[]>;
    requestsByTurn: Map<number, ProviderRequestRow[]>;
    requestsByLoop: Map<number, ProviderRequestRow[]>;
    requestsByWorker: Map<number, ProviderRequestRow[]>;
    requestsByWorkspace: Map<number, ProviderRequestRow[]>;
    logEntriesByTurn: Map<number, LogRow[]>;
    loopsById: Map<number, LoopRow>;
    workersById: Map<number, WorkerRow>;
    workerRollups: Map<number, WorkerRollupRow>;
    opMixByWorker: Map<number, OpMixRow[]>;
    embeddings: {
        channel_entries: number;
        derivation_complete: number;
        vector_complete: number;
        lexical: number;
        excluded: number;
        nonsemantic: number;
        failed: number;
        dispositions: Array<{
            scheme: string;
            authority: string;
            pathname: string;
            channel: string;
            disposition: string;
            reason: string | null;
        }>;
        unfinished: number;
        derivation_artifacts_complete: number;
        derivation_artifacts_building: number;
        chunk_rows: number;
        models: number;
        token_derivations: number;
    };
}

// Programmatic entry options ({§digest-programmatic-surface}).
// dbPath is required; digestDir defaults to the bin's test/digest; an optional
// workerId/workspaceId narrows the digest to one scope instead of the whole DB.
export interface DigestOptions {
    dbPath: string;
    digestDir?: string;
    workerId?: number;
    workspaceId?: number;
}

export type RequiemCallRecord = {
    openedAt: string;
    completedAt: string | null;
    state: "open" | "response" | "error";
    requests: Array<{
        provider: string;
        model: string;
        openedAt: string;
        completedAt: string | null;
        state: "open" | "settled";
        accounting: ProviderRequestAccounting | null;
    }>;
    failure: unknown;
};

export type RequiemWorkerReport = {
    workerId: number;
    workerName: string;
    messages: ChatMessage[];
    responses: unknown[];
    calls: RequiemCallRecord[];
    accounting: ProviderAccounting;
    testimony: string | null;
};

