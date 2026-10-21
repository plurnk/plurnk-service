// Standard wire shapes come from the protocol package. PLURNK-specific richness
// rides CUSTOM events under the `plurnk.` namespace.
//
// Plurnk-specific richness the core vocabulary can't hold (curation metadata, coordinates, tags,
// proposals) rides CUSTOM events under the `plurnk.` namespace — generic frontends skip them,
// plurnk-aware frontends render them richly ({§agui-custom-namespace}).

export { EventType } from "@ag-ui/core";
export type {
    AGUIEvent as AguiEvent,
    AssistantMessage,
    ReasoningMessage,
    RunAgentInput,
    ToolMessage,
    UserMessage,
} from "@ag-ui/core";
import { isRecord, type LogEntryWire, type OperationResult, type ProposalProjection, type ProviderAccounting } from "@plurnk/plurnk-contracts";

// The daemon event shapes this module consumes from the typed in-process seam.
// Core owns the shapes; this module owns their external AG-UI projection.
// {§methods-log-entry-wire} The row exactly as core sends it.
export interface LogEntryNotification {
    entry: LogEntryWire;
}
// What the Portal proves before it hands the row to a translator: a record carrying a row record. The row's own
// fields are the wire's ({§methods-log-entry-wire}), read as the translator reads them.
export const isLogEntryNotification = (value: unknown): value is LogEntryNotification => isRecord(value) && isRecord(value.entry);

export type ProposalNotification = ProposalProjection;

export type ReasoningEventNotification = {
    workerId: number;
    loopId: number;
    turnId: number;
    loopSeq: number;
    turnSeq: number;
    modelCallId: number;
    requestSequence: number;
} & (
    | { phase: "start" | "end" }
    | { phase: "content"; delta: string }
);

// {§agui-outside-text}: one admitted emission's text outside every operation, with the exact
// weight the model was told and the `<worker>-<loop>-<turn>` coordinate its evidence is filed under.
export interface OutsideEventNotification {
    workerId: number;
    loopId: number;
    turnId: number;
    coordinate: string;
    text: string;
    tokens: number;
}

export interface TerminatedNotification {
    workerId: number;
    loopId: number;
    result: OperationResult;
    hitMaxTurns: boolean;
    turnIds: number[];   // on the wire (Daemon.ts broadcast) — the turn count for a client's json record
    attributions: string[];
    // {§notifications-loop-terminated} — when the loop concluded, Unix milliseconds.
    terminatedAt: number;
    usage: {
        accounting: ProviderAccounting;
        curationWeight: number | null;
        curationBudget: number | null;
        contextTokens: number | null;
        contextCapacity: number | null;
        meta: Record<string, unknown>;
    };
}
