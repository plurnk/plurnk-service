// The AG-UI event vocabulary this bridge emits — hand-defined from the protocol spec
// (https://docs.ag-ui.com), deliberately WITHOUT the @ag-ui/* SDK dependency: the shapes are
// plain JSON, the protocol is young, and a zero-dep daughter beats tracking SDK churn. When the
// official SDK stabilizes, adopting it is a types-only swap (§agui-zero-dep).
//
// Plurnk-specific richness the core vocabulary can't hold (fold state, coordinates, tags,
// proposals) rides CUSTOM events under the `plurnk.` namespace — generic frontends skip them,
// plurnk-aware frontends render them richly (§agui-custom-namespace).

export type AguiEvent =
    | { type: "RUN_STARTED"; threadId: string; runId: string }
    | { type: "RUN_FINISHED"; threadId: string; runId: string }
    | { type: "RUN_ERROR"; message: string; code?: string }
    | { type: "STEP_STARTED"; stepName: string }
    | { type: "STEP_FINISHED"; stepName: string }
    | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
    | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
    | { type: "TEXT_MESSAGE_END"; messageId: string }
    | { type: "THINKING_START"; title?: string }
    | { type: "THINKING_END" }
    | { type: "THINKING_TEXT_MESSAGE_START" }
    | { type: "THINKING_TEXT_MESSAGE_CONTENT"; delta: string }
    | { type: "THINKING_TEXT_MESSAGE_END" }
    | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; parentMessageId?: string }
    | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
    | { type: "TOOL_CALL_END"; toolCallId: string }
    | { type: "TOOL_CALL_RESULT"; toolCallId: string; messageId: string; content: string }
    | { type: "MESSAGES_SNAPSHOT"; messages: Array<{ id: string; role: string; content: string }> }
    | { type: "STATE_SNAPSHOT"; snapshot: unknown }
    | { type: "STATE_DELTA"; delta: Array<{ op: string; path: string; value?: unknown }> }
    | { type: "CUSTOM"; name: string; value: unknown };

// AG-UI's run input (the POST body). Only the fields this bridge consumes are typed;
// the rest pass through untouched (forwardedProps etc. are the frontend's business).
export interface RunAgentInput {
    threadId: string;
    runId: string;
    messages?: Array<{ role: string; content?: string }>;
    state?: unknown;
    forwardedProps?: unknown;
}

// The daemon wire — the slice of the plurnk JSON-RPC protocol this bridge consumes.
// The daemon owns these shapes; the module consumes them from the in-process seam.
export interface LogEntryNotification {
    entry: {
        id: number;
        coordinate?: string;
        op: string;
        origin: string;
        suffix?: string;
        signal?: unknown;
        scheme?: string | null;
        pathname?: string | null;
        // Parsed JSON on the real wire (the daemon ships objects); strings tolerated for robustness.
        tx?: unknown;
        rx?: unknown;
        status_rx?: number;
        turn_id?: number;
        expanded?: number;
        attrs?: string | null;
    };
}

export interface ProposalNotification {
    logEntryId: number;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: Record<string, unknown>;
    flags: Record<string, unknown>;
    staleClobberRisk?: boolean;
}

export interface TerminatedNotification {
    loopId: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds: number[];   // on the wire (Daemon.ts broadcast) — the turn count for a client's json record
    usage: {
        promptTokens: number;
        completionTokens: number;
        costPico: number;
        contextTokens: number;
        contextSize: number | null;
        meta: Record<string, unknown>;
    };
}
