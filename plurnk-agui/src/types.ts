// Standard wire shapes come from the protocol package. PLURNK-specific richness
// rides CUSTOM events under the `plurnk.` namespace.
//
// Plurnk-specific richness the core vocabulary can't hold (fold state, coordinates, tags,
// proposals) rides CUSTOM events under the `plurnk.` namespace — generic frontends skip them,
// plurnk-aware frontends render them richly ({§agui-custom-namespace}).

export { EventType } from "@ag-ui/core";
export type {
    AGUIEvent as AguiEvent,
    ActivityMessage,
    AssistantMessage,
    ReasoningMessage,
    RunAgentInput,
} from "@ag-ui/core";
import type { OperationResult, ProposalProjection, ProviderAccounting } from "@plurnk/plurnk-contracts";

// The daemon event shapes this module consumes from the typed in-process seam.
// Core owns the shapes; this module owns their external AG-UI projection.
export interface LogEntryNotification {
    entry: {
        id: number;
        worker_id: number;
        loop_id: number;
        coordinate?: string;
        op: string | null;
        origin: string;
        delimiter?: string;
        signal?: unknown;
        scheme?: string | null;
        pathname?: string | null;
        // Parsed JSON on the real wire (the daemon ships objects); strings tolerated for robustness.
        tx?: unknown;
        rx?: unknown;
        status_rx?: number;
        turn_id?: number;
        expanded?: number;
        attrs?: unknown;
        tags?: string[];
        reasoning?: string;
    };
}

export type ProposalNotification = ProposalProjection;

export type ReasoningEventNotification = {
    workerId: number;
    loopId: number;
    turnId: number;
    modelCallId: number;
} & (
    | { phase: "start" | "end" }
    | { phase: "content"; delta: string }
);

export interface TerminatedNotification {
    workerId: number;
    loopId: number;
    result: OperationResult;
    hitMaxTurns: boolean;
    turnIds: number[];   // on the wire (Daemon.ts broadcast) — the turn count for a client's json record
    attributions: string[];
    usage: {
        accounting: ProviderAccounting;
        curationWeight: number | null;
        curationBudget: number | null;
        contextTokens: number | null;
        contextCapacity: number | null;
        meta: Record<string, unknown>;
    };
}
