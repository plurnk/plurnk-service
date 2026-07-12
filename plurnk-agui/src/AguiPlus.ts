// The AG-UI+ projection (single-interface rendering) — prototyped + unit-tested
// standalone ahead of the in-process module (plurnk-agui#2, WS-1). Pure functions:
// engine state → AG-UI events, and the inverse resume-mapping. No transport, no I/O
// — so it ports into the in-process module unchanged when the seam lands.
//
// §1 proposals/[300] questions → tool-calls (terminate-resume HITL); §2 reads →
// shared STATE. This is the flagship choreography de-risked as logic before code.

import type { AguiEvent, ProposalNotification } from "./types.ts";

// ── §1 — stop-the-world → tool-call ──────────────────────────────────
// toolCallId correlates the TERMINATING run's TOOL_CALL with the RESUME run's
// tool-result → the exact pending proposal. Encodes the logEntryId: `prop:<id>`.
export const proposalToolCallId = (logEntryId: number): string => `prop:${logEntryId}`;
export const logEntryIdFromToolCallId = (toolCallId: string): number | null => {
    const m = /^prop:(\d+)$/.exec(toolCallId);
    return m === null ? null : Number(m[1]);
};

// Tool-call NAME — AG-UI terminology all the way up to the seam (operator ruling,
// 2026-07-09): the client-facing name is AG-UI-conventional, NOT plurnk-namespaced.
// A side-effecting proposal is an approval request; a [300] question elicits input.
// The plurnk correlation rides the opaque toolCallId (`prop:<logEntryId>`), so the
// generic names carry no plurnk vocabulary upward.
export const proposalToolName = (op: string): string => (op === "SEND" ? "request_user_input" : "request_approval");

// The run's tail when it hits a pause: the tool-call, then the CALLER emits
// RUN_FINISHED to terminate. The loop stays paused in-engine — untouched.
export const proposalToolCall = (p: ProposalNotification): AguiEvent[] => {
    const toolCallId = proposalToolCallId(p.logEntryId);
    return [
        { type: "TOOL_CALL_START", toolCallId, toolCallName: proposalToolName(p.op) },
        { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ op: p.op, target: p.target, body: p.body, attrs: p.attrs, staleClobberRisk: p.staleClobberRisk ?? false }) },
        { type: "TOOL_CALL_END", toolCallId },
    ];
};

// The inverse — a resume run's tool-result → resolveProposal args, or null if the
// message isn't a plurnk proposal tool-result. `content` is the decision JSON
// ({decision, body?}); a bare "accept"/"reject"/"cancel" string is tolerated.
export interface ToolResultMessage { toolCallId?: string; content?: string; role?: string }
export interface Resolution { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string }
export const resolutionFromToolResult = (m: ToolResultMessage): Resolution | null => {
    if (typeof m.toolCallId !== "string") return null;
    const logEntryId = logEntryIdFromToolCallId(m.toolCallId);
    if (logEntryId === null) return null;
    let decision: string | undefined;
    let body: string | undefined;
    if (typeof m.content === "string" && m.content.length > 0) {
        try {
            const parsed = JSON.parse(m.content) as { decision?: string; body?: string };
            decision = parsed.decision;
            body = parsed.body;
        } catch {
            decision = m.content.trim(); // tolerate a bare decision string
        }
    }
    if (decision !== "accept" && decision !== "reject" && decision !== "cancel") return null;
    return { logEntryId, decision, ...(body !== undefined ? { body } : {}) };
};

// ── §2 — reads → shared STATE ────────────────────────────────────────
// The client OBSERVES this; no providers.list / session.list round-trips.
export interface AguiPlusState {
    providers?: Array<{ alias: string; model: string; active: boolean; contextSize: number | null }>;
    session?: { id: number; name: string; projectRoot?: string | null; budget?: number | null };
    sessions?: Array<{ id: number; name: string }>;
    constraints?: Array<{ effect: string; glob: string }>;
}
export const stateSnapshot = (s: AguiPlusState): AguiEvent => ({ type: "STATE_SNAPSHOT", snapshot: { plurnk: s } });
export const stateDelta = (patches: Array<{ op: string; path: string; value?: unknown }>): AguiEvent => ({ type: "STATE_DELTA", delta: patches });

// ── §3 — management actions: forwardedProps in, CUSTOM out ────────────
// Reads are STATE (§2); ACTIONS are verbs (rename, set-root, constrain, exec, fork,
// …), so they ride a run envelope. A family client requests one via
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
export type ActionOutcome = { ok: true; result?: unknown } | { ok: false; error: string };
export const actionResult = (kind: string, outcome: ActionOutcome): AguiEvent =>
    ({ type: "CUSTOM", name: "plurnk.action.result", value: { kind, ...outcome } });
