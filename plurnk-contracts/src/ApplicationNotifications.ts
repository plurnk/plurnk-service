import type { LogEntryWire } from "./Application.ts";
import type { JsonSchema, OperationResult, ProposalProjection } from "./types.ts";
import type { ProviderAccounting } from "./types.generated.ts";

// {§methods-invocation} The row exactly as core sends it.
export interface LogEntryNotification {
    readonly entry: LogEntryWire;
}

export type ProposalNotification = ProposalProjection;

export type ReasoningEventNotification = {
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly loopSeq: number;
    readonly turnSeq: number;
    readonly modelCallId: number;
    readonly requestSequence: number;
} & (
    | { readonly phase: "start" | "end" }
    | { readonly phase: "content"; readonly delta: string }
);

// {§acp-plurnk-metadata}: one admitted emission's text outside every operation, with the exact
// weight the model was told and the `<session>-<loop>-<turn>` coordinate its evidence is filed under.
export interface OutsideEventNotification {
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly coordinate: string;
    readonly text: string;
    readonly tokens: number;
}

export interface TerminatedNotification {
    readonly sessionId: number;
    readonly loopId: number;
    // {§notifications} — the loop's number among its session's loops.
    readonly loopSeq: number;
    readonly result: OperationResult;
    readonly hitMaxTurns: boolean;
    readonly turnIds: number[];
    readonly attributions: string[];
    // {§notifications} — when the loop concluded, Unix milliseconds.
    readonly terminatedAt: number;
    readonly usage: {
        readonly accounting: ProviderAccounting;
        readonly curationWeight: number | null;
        readonly curationBudget: number | null;
        readonly contextTokens: number | null;
        readonly contextCapacity: number | null;
        readonly meta: Record<string, unknown>;
    };
}

export interface ApplicationNotificationContract<T = unknown> {
    readonly payloadSchema: JsonSchema;
    // The payload the schema generates: the type the table declares beside the schema, never a value the contract carries.
    readonly payload?: T;
}
