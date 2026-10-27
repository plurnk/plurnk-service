import StoredPacket from "../core/StoredPacket.ts";
// The root module exports the sync class, and the generated typings name every statement on it ({§db-durability}).
import { SqlRiteSync } from "@possumtech/sqlrite";
import type {
    DigestEvidence, EvidenceRows, ErrorEvidence, PacketEvidence, TurnRow,
    WorkspaceRow, SessionRow, LoopRow, TurnAttemptRow, InferenceCallRow, ModelCallRow,
    ProviderRequestRow, LogRow, EditRow, EmissionRow, ReasoningRow, LogCurationEffectRow,
    SessionRollupRow, OpMixRow, ExecutionEnvironmentRow, SearchStateRow, DerivationStateRow,
    DispositionCountRow, DispositionRow, StorageRow, StorageTableRow,
} from "@plurnk/plurnk-digest";
import PacketWire from "../core/packet-wire.ts";
import BudgetReadout from "../core/BudgetReadout.ts";
import FabricatedLog from "../core/FabricatedLog.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { contentWeight } from "../core/content-weight.ts";
import { renderTarget } from "../core/plurnk-uri.ts";
import { Validator, type ParsedPath } from "@plurnk/plurnk-contracts";
import { providerRequestFromStorageRow, type ProviderRequestStorageRow } from "../core/provider-accounting.ts";

const describeNonError = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

// The target a statement authored, when the stored text is a path the grammar names; a row whose stored target is not
// renders without its authored spelling.
const authoredPath = (text: string | null): ParsedPath | null => {
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    return Validator.validateParsedPath(value).valid ? Validator.assertParsedPath(value) : null;
};

// A settled request's ledger row names its outcome and cost kind; one that does not has no accounting to read.
const settledRow = (row: Omit<ProviderRequestRow, "accounting">): ProviderRequestStorageRow | null =>
    row.state === "settled" && row.outcome !== null && row.cost_kind !== null
        ? { ...row, outcome: row.outcome, cost_kind: row.cost_kind }
        : null;

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

    // The echoed emission headings in a program's text outside its operations ({§emission-admission}); a
    // heading quoted inside an operation body is the body's, not an echo.
    static #echoes(program: string | null): number {
        if (program === null || program.length === 0) return 0;
        return PlurnkParser.parse(program).items
            .reduce((sum, item) => item.kind === "text" ? sum + FabricatedLog.echoes(item.content) : sum, 0);
    }

    rows(): EvidenceRows {
        const db = this.#db;
        const decisions = new Map(
            db.digest_proposal_decisions.all<NonNullable<LogRow["proposalDecision"]> & { log_entry_id: number }>()
                .map(({ log_entry_id, ...decision }) => [log_entry_id, decision]),
        );
        const rows = {
            workspaces: db.digest_workspaces.all<WorkspaceRow & { project_root: string | null }>(),
            sessions: db.digest_sessions.all<SessionRow>(),
            loops: db.digest_loops.all<LoopRow>(),
            turns: db.digest_turns.all<Omit<TurnRow, "packetEchoes">>(),
            inferenceCalls: db.digest_inference_calls.all<InferenceCallRow>(),
            modelCalls: db.digest_model_calls.all<ModelCallRow>(),
            turnAttempts: db.digest_turn_attempts.all<TurnAttemptRow>(),
            providerRequests: db.digest_provider_requests.all<Omit<ProviderRequestRow, "accounting">>(),
            logEntries: db.digest_log_entries.all<Omit<LogRow, "target"> & { target_tx: string | null }>(),
            editRows: db.digest_edit_statements.all<EditRow>(),
            emissionRows: db.digest_emissions.all<EmissionRow>(),
            reasoningRows: db.digest_reasonings.all<ReasoningRow>(),
            curationEffects: db.digest_curation_effects.all<LogCurationEffectRow>(),
            sessionRollupRows: db.digest_session_rollups.all<SessionRollupRow>(),
            opMixRows: db.digest_session_op_mix.all<OpMixRow>(),
            environmentRows: db.digest_execution_environments.all<ExecutionEnvironmentRow>(),
            searchState: db.digest_channel_search_state.get<SearchStateRow>(),
            derivationState: db.digest_derivation_state.get<DerivationStateRow>(),
            dispositionCounts: db.digest_channel_disposition_counts.all<DispositionCountRow>(),
            dispositions: db.digest_channel_dispositions.all<DispositionRow>(),
            storage: db.digest_storage.get<StorageRow>(),
            storageTables: db.digest_storage_tables.all<StorageTableRow>(),
        };
        if (rows.storage === undefined) throw new Error("the database reported no storage facts");
        if (rows.searchState === undefined || rows.derivationState === undefined) throw new Error("search aggregate returned no row");
        const roots = new Map(rows.workspaces.map(({ id, project_root }) => [id, project_root]));
        const sessionRoots = new Map(rows.sessions.map(({ id, workspace_id }) => [id, roots.get(workspace_id) ?? null]));
        return {
            ...rows,
            storage: rows.storage, searchState: rows.searchState, derivationState: rows.derivationState,
            // {§emission-admission}: an echoed emission heading is counted where the model wrote it, in the text
            // outside its operations, whether that text became NOTEs beside them or the turn's outside source.
            turns: rows.turns.map((turn) => ({ ...turn, packetEchoes: EvidenceReader.#echoes(turn.program) + FabricatedLog.echoes(turn.outside ?? "") })),
            logEntries: rows.logEntries.map(({ target_tx, ...row }) => ({
                ...row, target: renderTarget(row, sessionRoots.get(row.session_id) ?? null, authoredPath(target_tx)),
                ...(decisions.has(row.id) ? { proposalDecision: decisions.get(row.id) } : {}),
            })),
            providerRequests: rows.providerRequests.map((row) => {
                const settled = settledRow(row);
                return { ...row, accounting: settled === null ? null : providerRequestFromStorageRow(settled) };
            }),
        };
    }

    packet(turn: TurnRow): PacketEvidence {
        if (this.#lastPacket?.turnId === turn.id) return this.#lastPacket.evidence;
        this.#lastPacket = undefined;
        let evidence: PacketEvidence = { packet: null, packetFailure: null };
        if (turn.has_packet === 1) {
            const row = this.#db.digest_turn_packet.get<{ packet: string; packet_bag: string }>({ turn_id: turn.id });
            if (row === undefined) throw new Error(`turn ${turn.id} packet disappeared`);
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
                        // {§digest-navigation}: retention can leave a bag without its input sections.
                        // PacketWire's empty-request defaults are not historical evidence.
                        messages: () => packet.sections.length === 0 ? [] : PacketWire.packetToWireMessages(packet),
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
        return this.#db.digest_model_response.get<{ response: string }>({ model_call_id: modelCallId })?.response ?? null;
    }

    request(requestId: number): string | null {
        const row = this.#db.digest_provider_request_evidence.get<{ evidence?: string | null }>({ request_id: requestId });
        if (row === undefined) throw new Error(`provider request ${requestId} disappeared`);
        return row.evidence ?? null;
    }

    reasoning(turn: TurnRow): string | null {
        if (turn.has_reasoning === 0) return null;
        const row = this.#db.digest_turn_reasoning.get<{ content: string }>({ turn_id: turn.id });
        if (row === undefined) throw new Error(`turn ${turn.id} reasoning source disappeared`);
        return row.content;
    }
}
