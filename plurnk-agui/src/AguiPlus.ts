// {§agui-projection} The AG-UI+ projection is unit-tested independently of the
// in-process module. Pure functions:
// engine state → AG-UI events, and the inverse resume-mapping. No transport, no I/O
// — so it ports into the in-process module unchanged when the seam lands.
//
// §1 proposals → tool-calls (terminate-resume HITL); §2 reads →
// shared STATE. This is the flagship choreography de-risked as logic before code.

import { EventType, type AguiEvent, type ProposalNotification } from "./types.ts";
import type { Interrupt, ResumeEntry } from "@ag-ui/core";
import type {
    ClientInteractionProjection,
    ClientInteractionResolution,
    ProblemDetails,
} from "@plurnk/plurnk-contracts";

// ── §1 — stop-the-world → tool-call ──────────────────────────────────
// toolCallId correlates the terminating AG-UI Run's TOOL_CALL and interrupt with the next
// AG-UI Run's ResumeEntry → the exact pending proposal. Encodes the logEntryId: `prop:<id>`.
export const proposalToolCallId = (logEntryId: number): string => `prop:${logEntryId}`;
export const logEntryIdFromToolCallId = (toolCallId: string): number | null => {
    const m = /^prop:(\d+)$/.exec(toolCallId);
    return m === null ? null : Number(m[1]);
};

// Tool-call NAME — AG-UI terminology all the way up to the seam: the client-facing
// name is AG-UI-conventional, not plurnk-namespaced.
// A side-effecting proposal is an approval request. The plurnk correlation rides
// the opaque toolCallId (`prop:<logEntryId>`), so the generic name carries no
// plurnk vocabulary upward.
export const proposalToolName = (_op: string): string => "request_approval";

// The worker's tail when it hits a pause: the tool-call, then the CALLER emits
// RUN_FINISHED to terminate. The loop stays paused in-engine — untouched.
export const proposalToolCall = (p: ProposalNotification): AguiEvent[] => {
    const toolCallId = proposalToolCallId(p.logEntryId);
    return [
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: proposalToolName(p.op) },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify({ op: p.op, target: p.target, body: p.body, attrs: p.attrs, flags: p.flags }) },
        { type: EventType.TOOL_CALL_END, toolCallId },
    ];
};

export const proposalInterrupt = (logEntryId: number): Interrupt => ({
    id: proposalToolCallId(logEntryId),
    reason: "tool_call",
    toolCallId: proposalToolCallId(logEntryId),
    message: "Review the requested action.",
    responseSchema: {
        type: "object",
        properties: {
            decision: { type: "string", enum: ["accept", "reject", "cancel"] },
            body: { type: "string" },
        },
        required: ["decision"],
    },
});

// The inverse — a standard resume entry resolves the durable PLURNK proposal.
export interface Resolution { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string }
export const resolutionFromResume = (entry: ResumeEntry): Resolution | null => {
    const logEntryId = logEntryIdFromToolCallId(entry.interruptId);
    if (logEntryId === null) return null;
    if (entry.status === "cancelled") return { logEntryId, decision: "cancel" };
    const payload = entry.payload as { decision?: unknown; body?: unknown } | undefined;
    const decision = payload?.decision;
    const body = typeof payload?.body === "string" ? payload.body : undefined;
    if (decision !== "accept" && decision !== "reject" && decision !== "cancel") return null;
    return { logEntryId, decision, ...(body !== undefined ? { body } : {}) };
};

export const interactionToolCallId = (interactionId: number): string => `int:${interactionId}`;
export const interactionIdFromToolCallId = (toolCallId: string): number | null => {
    const match = /^int:(\d+)$/.exec(toolCallId);
    return match === null ? null : Number(match[1]);
};

export const interactionToolCall = (interaction: ClientInteractionProjection): AguiEvent[] => {
    const toolCallId = interactionToolCallId(interaction.interactionId);
    return [
        {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: interaction.request.toolName,
        },
        {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: JSON.stringify(interaction.request.arguments),
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
    ];
};

export const interactionInterrupt = (interaction: ClientInteractionProjection): Interrupt => ({
    id: interactionToolCallId(interaction.interactionId),
    reason: "tool_call",
    toolCallId: interactionToolCallId(interaction.interactionId),
    message: interaction.request.message ?? "Provide the requested input.",
    responseSchema: interaction.request.responseSchema,
});

export interface InteractionResolution {
    interactionId: number;
    resolution: ClientInteractionResolution;
}

export const interactionResolutionFromResume = (entry: ResumeEntry): InteractionResolution | null => {
    const interactionId = interactionIdFromToolCallId(entry.interruptId);
    if (interactionId === null) return null;
    if (entry.status === "cancelled") {
        return { interactionId, resolution: { status: "cancelled" } };
    }
    return {
        interactionId,
        resolution: {
            status: "resolved",
            ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
        },
    };
};

// ── §2 — reads → shared STATE ────────────────────────────────────────
// The client OBSERVES this; no providers.list / workspace.list round-trips.
export interface AguiPlusState {
    providers?: Array<{ alias: string; model: string; active: boolean; inputCapacity: number | null }>;
    workspace?: { id: number; name: string; projectRoot?: string | null; budget?: number | null };
    workspaces?: Array<{ id: number; name: string }>;
    constraints?: Array<{ effect: string; glob: string; source: "explicit" | "create" }>;
}
export interface AguiBudgetState {
    readonly curationWeight: number | null;
    readonly curationBudget: number | null;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
}

const EMPTY_BUDGET: AguiBudgetState = Object.freeze({
    curationWeight: null,
    curationBudget: null,
    contextTokens: null,
    contextCapacity: null,
});

export const stateSnapshot = (s: AguiPlusState): AguiEvent => ({
    type: EventType.STATE_SNAPSHOT,
    snapshot: { plurnk: s, budget: EMPTY_BUDGET },
});
export const stateDelta = (patches: Array<{ op: string; path: string; value?: unknown }>): AguiEvent => ({ type: EventType.STATE_DELTA, delta: patches });

// ── §3 — management actions: forwardedProps in, CUSTOM out ────────────
// Reads are STATE (§2); ACTIONS are verbs (rename, set-root, constrain, exec, fork,
// …), so they ride a worker envelope. A family client requests one via
// forwardedProps.plurnk.action; the module executes it through the seam and returns
// the outcome as a CUSTOM event. AG-UI has no vocabulary for plurnk workspace ops,
// so this is a legitimate Tier-2 metadata extension (the standard's own
// forwardedProps channel in, a plurnk.* custom out).
export interface ActionRequest { kind: string; params: Record<string, unknown> }
export const parseAction = (forwardedProps: unknown): ActionRequest | null => {
    const action = (forwardedProps as { plurnk?: { action?: unknown } } | undefined)?.plurnk?.action;
    if (action === null || typeof action !== "object") return null;
    const kind = (action as { kind?: unknown }).kind;
    if (typeof kind !== "string" || kind.length === 0) return null;
    const { kind: _kind, ...params } = action as Record<string, unknown>;
    return { kind, params };
};
export type ActionOutcome = { ok: true; result?: unknown } | { ok: false; problem: ProblemDetails };
export const actionResult = (kind: string, outcome: ActionOutcome): AguiEvent =>
    ({ type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind, ...outcome } });
