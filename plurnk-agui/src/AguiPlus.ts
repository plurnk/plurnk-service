// {§agui-projection} The AG-UI+ projection is unit-tested independently of the
// in-process module. Pure functions:
// engine state → AG-UI events, and the inverse resume-mapping. No transport, no I/O
// — so it ports into the in-process module unchanged when the seam lands.
//
// §1 proposals → interrupts (terminate-resume HITL); §2 reads →
// shared STATE. This is the flagship choreography de-risked as logic before code.

import { EventType, type AguiEvent, type ProposalNotification } from "./types.ts";
import type { JsonPatch, Interrupt, ResumeEntry } from "@ag-ui/core";
import { lifecycleOfLoopStatus, type LoopLifecycle, type ProviderAccounting, type ApplicationLoopProjection, type ApplicationProviderAlias, type ClientInteractionProjection, type ClientInteractionResolution, type FunctionalityPreparationActivity, type ModelRoute, type ProblemDetails, type ProposalResolution } from "@plurnk/plurnk-contracts";

// ── §1 — stop-the-world → interrupt ──────────────────────────────────
// {§agui-proposal-resolve} A gate is the operation awaiting its decision: the Portal presents its call, per Run, and the
// interrupt names it there. The interrupt carries Core's projection, what the reviewer reviews; the resume names the
// proposal by this key, which no client sees.
export const proposalKey = (logEntryId: number): string => `proposal:${logEntryId}`;
const logEntryIdFromKey = (key: string): number | null => {
    const m = /^proposal:(\d+)$/.exec(key);
    return m === null ? null : Number(m[1]);
};

export const proposalInterrupt = (proposal: ProposalNotification): Omit<Interrupt, "id"> => ({
    reason: "tool_call",
    message: "Review the requested action.",
    responseSchema: {
        type: "object",
        properties: {
            decision: { type: "string", enum: ["accept", "reject", "cancel"] },
            body: { type: "string" },
            outcome: { type: "string" },
        },
        required: ["decision"],
    },
    ...(proposal.expiresAt === undefined ? {} : { expiresAt: proposal.expiresAt }),
    metadata: { plurnk: { proposal } },
});

// The inverse — a standard resume entry resolves the durable PLURNK proposal.
export interface Resolution extends ProposalResolution { logEntryId: number }
export const resolutionFromResume = (entry: ResumeEntry): Resolution | null => {
    const logEntryId = logEntryIdFromKey(entry.interruptId);
    if (logEntryId === null) return null;
    const payload = entry.payload as { decision?: unknown; body?: unknown; outcome?: unknown } | undefined;
    if (payload?.outcome !== undefined && typeof payload.outcome !== "string") return null;
    const outcome = payload?.outcome === undefined ? {} : { outcome: payload.outcome };
    if (entry.status === "cancelled") return { logEntryId, decision: "cancel", ...outcome };
    const decision = payload?.decision;
    const body = typeof payload?.body === "string" ? payload.body : undefined;
    if (decision !== "accept" && decision !== "reject" && decision !== "cancel") return null;
    return { logEntryId, decision, ...(body !== undefined ? { body } : {}), ...outcome };
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

export const interactionInterrupt = (interaction: ClientInteractionProjection): Omit<Interrupt, "id"> => ({
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
    providers?: ApplicationProviderAlias[];
    workspace?: AguiWorkspaceState;
    workspaces?: Array<{ id: number; name: string }>;
    constraints?: Array<{ effect: string; glob: string; source: "explicit" | "create" }>;
    status?: AguiStatusState;
}
// {§agui-workspace-state} — the bound workspace, its folder, and the activity that belongs to it rather
// than to any worker: capability preparation and derivation.
export interface AguiWorkspaceState {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly preparation: readonly FunctionalityPreparationActivity[];
    readonly activity: AguiDerivationActivity | null;
}
export type AguiLifecycle = LoopLifecycle;
export interface AguiDerivationActivity {
    readonly kind: "derivation";
    readonly phase: "preparing" | "indexing" | "failed";
    readonly completed: number;
    readonly total: number;
    readonly percent: number;
    readonly message: string;
}
export interface AguiStatusState {
    readonly lifecycle: AguiLifecycle;
    readonly model: ModelRoute | null;
    readonly loopId: number | null;
    readonly packetCount: number;
    readonly waitUntil: number | null;
    // {§agui-status-children} — the bound Worker's alive direct children (queued, running, parked).
    readonly children: number;
    // {§agui-status-spend} — what the bound Worker and its descendants have spent since it began.
    readonly spend: AguiSpendState;
    // {§agui-status-timing} — when the latest Loop first ran and when it concluded, Unix milliseconds.
    readonly claimedAt: number | null;
    readonly terminatedAt: number | null;
}

// {§agui-status-timing} — the Loop's durable stamps as the gauge carries them.
export const loopTiming = (loop: ApplicationLoopProjection | null): Pick<AguiStatusState, "claimedAt" | "terminatedAt"> => ({
    claimedAt: loop?.claimedAt == null ? null : Date.parse(loop.claimedAt),
    terminatedAt: loop?.terminatedAt == null ? null : Date.parse(loop.terminatedAt),
});

// {§agui-status-spend} — the daemon's {§provider-accounting} projection over the Worker and its
// descendants, without its request list: how many settled requests, their usage, their cost. Numbers
// verbatim ({§agui-numbers-passthrough}); zero requests is "nothing spent", not "unknown".
export interface AguiSpendState extends Omit<ProviderAccounting, "requests"> {
    readonly requests: number;
}
export const spendState = ({ requests, ...projection }: ProviderAccounting): AguiSpendState => ({
    ...projection,
    requests: requests.length,
});

// {§agui-status-children} — a child that still owes a result is alive; one that concluded is not.
export const ALIVE_LIFECYCLES: ReadonlySet<LoopLifecycle> = new Set<LoopLifecycle>(["queued", "running", "parked"]);
export const aliveChildren = (rows: readonly { readonly lifecycle: LoopLifecycle }[]): number =>
    rows.filter(({ lifecycle }) => ALIVE_LIFECYCLES.has(lifecycle)).length;

export const derivationActivity = (value: unknown): AguiDerivationActivity | null => {
    if (value === null) return null;
    if (typeof value !== "object") throw new TypeError("Invalid derivation activity.");
    const { phase, completed, total, percent, message } = value as Record<string, unknown>;
    if (phase !== "preparing" && phase !== "indexing" && phase !== "complete" && phase !== "failed"
        || typeof completed !== "number" || !Number.isSafeInteger(completed) || completed < 0
        || typeof total !== "number" || !Number.isSafeInteger(total) || total < completed
        || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100
        || typeof message !== "string") {
        throw new TypeError("Invalid derivation activity.");
    }
    return phase === "complete" ? null : { kind: "derivation", phase, completed, total, percent, message };
};

export const statusState = (
    model: ModelRoute | null,
    loop: ApplicationLoopProjection | null,
    spend: AguiSpendState,
    children = 0,
): AguiStatusState => ({
    // {§loop-lifecycle-vocabulary} — the one projection the worker directory shares.
    lifecycle: lifecycleOfLoopStatus(loop?.status ?? null),
    model,
    loopId: loop?.id ?? null,
    packetCount: loop?.packetCount ?? 0,
    waitUntil: loop?.status === 202 ? loop.waitUntil : null,
    ...loopTiming(loop),
    children,
    spend,
});
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

// {§agui-workspace-state} The worker's gauge, `status` and `budget`, rides only a Run that binds a worker.
export const stateSnapshot = (s: AguiPlusState): AguiEvent => ({
    type: EventType.STATE_SNAPSHOT,
    snapshot: s.status === undefined ? { plurnk: s } : { plurnk: s, budget: EMPTY_BUDGET },
});
// {§agui-daemon-client} — AG-UI 1.0 types STATE_DELTA as a real RFC 6902 patch, so the
// operation union is the parameter type rather than a loose object shape.
export const stateDelta = (patches: JsonPatch): AguiEvent => ({ type: EventType.STATE_DELTA, delta: patches });

// ── §3 — management actions: forwardedProps in, the Run's result out ────────────
// Reads are STATE (§2); ACTIONS are verbs (rename, set-root, constrain, exec, fork,
// …), so they ride a worker envelope. A family client requests one via
// forwardedProps.plurnk.action; the module executes it through the seam and finishes
// the Run with the outcome as its result.
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
// {§agui-plurnk-metadata} An action Run's result: the action's whole outcome, a failure included.
export const actionRunResult = (kind: string, outcome: ActionOutcome): Record<string, unknown> => ({ kind, ...outcome });
