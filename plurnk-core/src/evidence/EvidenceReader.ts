import SqlRiteSync from "@possumtech/sqlrite/sync";
import StoredPacket from "../core/StoredPacket.ts";
import type { SqlRiteSyncPreparedStatements as SyncPrep } from "@possumtech/sqlrite";
import type {
    DigestEvidence, EvidenceRows, ErrorEvidence, PacketEvidence, TurnRow,
    WorkspaceRow, WorkerRow, LoopRow, TurnAttemptRow, InferenceCallRow, ModelCallRow,
    ProviderRequestRow, LogRow, EditRow, EmissionRow, ReasoningRow, LogCurationEffectRow,
    WorkerRollupRow, OpMixRow, ExecutionEnvironmentRow, SearchStateRow, DerivationStateRow,
    DispositionCountRow, DispositionRow, StorageRow, StorageTableRow,
} from "@plurnk/plurnk-digest";
import PacketWire from "../core/packet-wire.ts";
import BudgetReadout from "../core/BudgetReadout.ts";
import LegacyPacketEnvelope from "./LegacyPacketEnvelope.ts";
import FabricatedLog from "../core/FabricatedLog.ts";
import { contentWeight } from "../core/content-weight.ts";
import { renderTarget } from "../core/plurnk-uri.ts";
import { providerRequestFromStorageRow, type ProviderRequestStorageRow } from "../core/provider-accounting.ts";

const describeNonError = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

const errorEvidence = (value: unknown, seen = new Set<unknown>()): ErrorEvidence => {
    if (seen.has(value)) return { name: "Error", message: "Circular error cause" };
    if (typeof value === "object" && value !== null) seen.add(value);
    if (!(value instanceof Error)) return { name: "NonError", message: describeNonError(value) };
    return {
        name: value.name, message: value.message,
        ...(value.cause === undefined ? {} : { cause: errorEvidence(value.cause, seen) }),
    };
};

// {§digest-forensic-fidelity}: heavy evidence is read on demand, never multiplied by graph size.
export default class EvidenceReader implements DigestEvidence {
    readonly #db: SqlRiteSync;
    #lastPacket: { turnId: number; evidence: PacketEvidence } | undefined;

    private constructor(db: SqlRiteSync) { this.#db = db; }

    static open(path: string): EvidenceReader {
        return new EvidenceReader(new SqlRiteSync({ path, dir: [import.meta.dirname] }));
    }

    [Symbol.dispose](): void {
        this.#lastPacket = undefined;
        this.#db.close();
    }

    textWeight(text: string): number { return contentWeight(text); }

    rows(): EvidenceRows {
        const db = this.#db;
        const rows = {
            workspaces: (db.digest_workspaces as SyncPrep<WorkspaceRow>).all(),
            workers: (db.digest_workers as SyncPrep<WorkerRow>).all(),
            loops: (db.digest_loops as SyncPrep<LoopRow>).all(),
            turns: (db.digest_turns as SyncPrep<Omit<TurnRow, "packetEchoes">>).all(),
            inferenceCalls: (db.digest_inference_calls as SyncPrep<InferenceCallRow>).all(),
            modelCalls: (db.digest_model_calls as SyncPrep<ModelCallRow>).all(),
            turnAttempts: (db.digest_turn_attempts as SyncPrep<TurnAttemptRow>).all(),
            providerRequests: (db.digest_provider_requests as SyncPrep<Omit<ProviderRequestRow, "accounting">>).all(),
            logEntries: (db.digest_log_entries as SyncPrep<Omit<LogRow, "target">>).all(),
            editRows: (db.digest_edit_statements as SyncPrep<EditRow>).all(),
            emissionRows: (db.digest_emissions as SyncPrep<EmissionRow>).all(),
            reasoningRows: (db.digest_reasonings as SyncPrep<ReasoningRow>).all(),
            curationEffects: (db.digest_curation_effects as SyncPrep<LogCurationEffectRow>).all(),
            workerRollupRows: (db.digest_worker_rollups as SyncPrep<WorkerRollupRow>).all(),
            opMixRows: (db.digest_worker_op_mix as SyncPrep<OpMixRow>).all(),
            environmentRows: (db.digest_execution_environments as SyncPrep<ExecutionEnvironmentRow>).all(),
            searchState: (db.digest_channel_search_state as SyncPrep<SearchStateRow>).get(),
            derivationState: (db.digest_derivation_state as SyncPrep<DerivationStateRow>).get(),
            dispositionCounts: (db.digest_channel_disposition_counts as SyncPrep<DispositionCountRow>).all(),
            dispositions: (db.digest_channel_dispositions as SyncPrep<DispositionRow>).all(),
            storage: (db.digest_storage as SyncPrep<StorageRow>).get(),
            storageTables: (db.digest_storage_tables as SyncPrep<StorageTableRow>).all(),
        };
        if (rows.storage === undefined) throw new Error("digest: the database reported no storage facts");
        if (rows.searchState === undefined || rows.derivationState === undefined) throw new Error("digest: search aggregate returned no row");
        return {
            ...rows,
            storage: rows.storage, searchState: rows.searchState, derivationState: rows.derivationState,
            turns: rows.turns.map((turn) => ({ ...turn, packetEchoes: FabricatedLog.echoes(turn.outside ?? "") })),
            logEntries: rows.logEntries.map((row) => ({ ...row, target: renderTarget(row) })),
            providerRequests: rows.providerRequests.map((row) => ({
                ...row,
                accounting: row.state === "settled" ? providerRequestFromStorageRow(row as ProviderRequestStorageRow) : null,
            })),
        };
    }

    packet(turn: TurnRow): PacketEvidence {
        if (this.#lastPacket?.turnId === turn.id) return this.#lastPacket.evidence;
        this.#lastPacket = undefined;
        let evidence: PacketEvidence = { packet: null, packetFailure: null };
        if (turn.has_packet === 1) {
            const row = (this.#db.digest_turn_packet as SyncPrep<{ packet: string; packet_bag: string }>).get({ turn_id: turn.id });
            if (row === undefined) throw new Error(`digest: turn ${turn.id} packet disappeared`);
            try {
                const packet = StoredPacket.parse(row.packet, `digest turn ${turn.id}`);
                evidence = {
                    packet: packet === null ? null : {
                        assistant: StoredPacket.isAdmitted(packet)
                            ? { content: packet.assistant.content, reasoning: packet.assistant.reasoning }
                            : null,
                        assistantRaw: StoredPacket.isAdmitted(packet) ? packet.assistantRaw : null,
                        attributions: packet.attributions,
                        attachments: packet.attachments ?? [],
                        weight: packet.weight,
                        budget: BudgetReadout.budgetOf(PacketWire.sectionContent(packet, "budget")),
                        slot: (name) => PacketWire.renderSlot(packet.sections, name),
                        messages: (emissions) => packet.sections.some(({ name }) => name === "previous-emission")
                            ? PacketWire.packetToWireMessages(packet)
                            : LegacyPacketEnvelope.packetToWireMessages(packet, emissions),
                    },
                    packetFailure: null,
                };
            } catch (cause) {
                evidence = { packet: null, packetFailure: { raw: row.packet_bag, error: errorEvidence(cause) } };
            }
        }
        this.#lastPacket = { turnId: turn.id, evidence };
        return evidence;
    }

    response(modelCallId: number): string | null {
        return (this.#db.digest_model_response as SyncPrep<{ response: string }>).get({ model_call_id: modelCallId })?.response ?? null;
    }

    request(requestId: number): string | null {
        const row = (this.#db.digest_provider_request_evidence as SyncPrep<{ evidence?: string | null }>).get({ request_id: requestId });
        if (row === undefined) throw new Error(`digest: provider request ${requestId} disappeared`);
        return row.evidence ?? null;
    }

    reasoning(turn: TurnRow): string | null {
        if (turn.has_reasoning === 0) return null;
        const row = (this.#db.digest_turn_reasoning as SyncPrep<{ content: string }>).get({ turn_id: turn.id });
        if (row === undefined) throw new Error(`digest: turn ${turn.id} reasoning source disappeared`);
        return row.content;
    }
}
