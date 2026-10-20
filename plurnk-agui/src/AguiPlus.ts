// {§agui-projection} The AG-UI+ projection is unit-tested independently of the
// in-process module. Pure functions:
// engine state → AG-UI events, and the inverse resume-mapping. No transport, no I/O
// — so it ports into the in-process module unchanged when the seam lands.
//
// §1 proposals → interrupts (terminate-resume HITL); §2 reads →
// shared STATE. This is the flagship choreography de-risked as logic before code.

import { EventType, type AguiEvent, type ProposalNotification } from "./types.ts";
import MessageAddress from "./MessageAddress.ts";
import type { JsonPatch, Interrupt, ResumeEntry } from "@ag-ui/core";
import { isRecord, lifecycleOfLoopStatus, type LoopLifecycle, type ProviderAccounting, type ApplicationLoopProjection, type ApplicationWorkerProjection, type ApplicationInboxMessage, type ApplicationProviderAlias, type ClientInteractionProjection, type ClientInteractionResolution, type FunctionalityPreparationActivity, type ModelRoute, type ProblemDetails, type ProposalResolution } from "@plurnk/plurnk-contracts";

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
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
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

// {§agui-plurnk-metadata} The interrupt carries Core's projection, the worker, loop and turn asking, as a proposal's does.
export const interactionInterrupt = (interaction: ClientInteractionProjection): Omit<Interrupt, "id"> => ({
    reason: "tool_call",
    toolCallId: interactionToolCallId(interaction.interactionId),
    message: interaction.request.message ?? "Provide the requested input.",
    responseSchema: interaction.request.responseSchema,
    metadata: { plurnk: { interaction } },
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
// {§agui-message-acceptance} — an accepted message the bound Worker has not yet observed: its immutable source address,
// the loop that holds it and, when a client on this thread sent it, that client's message id.
export interface AguiInboxEntry {
    readonly path: string;
    readonly id: string | null;
    readonly loopId: number;
    readonly lifecycle: LoopLifecycle;
}
export const inboxState = (messages: readonly ApplicationInboxMessage[], threadId: string): AguiInboxEntry[] =>
    messages.map(({ path, source, loopId, lifecycle }) => ({ path, id: MessageAddress.messageId(source, threadId), loopId, lifecycle }));

export interface AguiStatusState {
    readonly lifecycle: AguiLifecycle;
    readonly model: ModelRoute | null;
    readonly loopId: number | null;
    readonly packetCount: number;
    readonly waitUntil: number | null;
    // {§agui-status-descendants} — the bound Worker's tree beneath it, depth first.
    readonly descendants: ReadonlyArray<AguiDescendant>;
    // {§agui-status-spend} — what the bound Worker and its descendants have spent since it began.
    readonly spend: AguiSpendState;
    // {§agui-message-acceptance} — the accepted messages the bound Worker has not yet observed.
    readonly inbox: ReadonlyArray<AguiInboxEntry>;
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

// {§agui-status-descendants} One worker of the bound Worker's tree: who it is, beneath whom, its lifecycle, and the gates
// it waits on.
export interface AguiDescendant {
    readonly id: number;
    readonly name: string;
    readonly parentWorkerId: number;
    readonly kind: ApplicationWorkerProjection["kind"];
    readonly lifecycle: AguiLifecycle;
    readonly gates: number;
}

// {§agui-status-descendants} The bound Worker's whole tree beneath it, depth first and in creation order, each with the
// proposals and client interactions it waits on.
export const descendantsState = (
    workerId: number,
    workers: readonly ApplicationWorkerProjection[],
    gates: ReadonlyArray<{ readonly workerId: number }>,
): AguiDescendant[] => {
    const waiting = new Map<number, number>();
    for (const gate of gates) waiting.set(gate.workerId, (waiting.get(gate.workerId) ?? 0) + 1);
    const beneath = new Map<number, ApplicationWorkerProjection[]>();
    for (const worker of workers) {
        if (worker.parentWorkerId === null) continue;
        beneath.set(worker.parentWorkerId, [...beneath.get(worker.parentWorkerId) ?? [], worker]);
    }
    const tree: AguiDescendant[] = [];
    const visit = (parentWorkerId: number): void => {
        for (const { id, name, kind, lifecycle } of (beneath.get(parentWorkerId) ?? []).toSorted((a, b) => a.id - b.id)) {
            tree.push({ id, name, parentWorkerId, kind, lifecycle, gates: waiting.get(id) ?? 0 });
            visit(id);
        }
    };
    visit(workerId);
    return tree;
};

export const derivationActivity = (value: unknown): AguiDerivationActivity | null => {
    if (value === null) return null;
    if (!isRecord(value)) throw new TypeError("Invalid derivation activity.");
    const { phase, completed, total, percent, message } = value;
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
    descendants: readonly AguiDescendant[] = [],
    inbox: readonly AguiInboxEntry[] = [],
): AguiStatusState => ({
    // {§loop-lifecycle-vocabulary} — the one projection the worker directory shares.
    lifecycle: lifecycleOfLoopStatus(loop?.status ?? null),
    model,
    loopId: loop?.id ?? null,
    packetCount: loop?.packetCount ?? 0,
    waitUntil: loop?.status === 202 ? loop.waitUntil : null,
    ...loopTiming(loop),
    descendants,
    spend,
    inbox,
});
export interface AguiBudgetState {
    readonly curationWeight: number | null;
    readonly curationBudget: number | null;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
}

// {§agui-state-patches} The bound Worker's gauge: its status and the budget its latest concluded loop reported.
export interface AguiWorkerGauge {
    readonly status: AguiStatusState;
    readonly budget: AguiBudgetState;
}

// {§agui-workspace-state} The worker's gauge, `status` and `budget`, rides only a Run that binds a worker.
export const stateSnapshot = (s: Omit<AguiPlusState, "status">, gauge?: AguiWorkerGauge): AguiEvent => ({
    type: EventType.STATE_SNAPSHOT,
    snapshot: gauge === undefined ? { plurnk: s } : { plurnk: { ...s, status: gauge.status }, budget: gauge.budget },
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
    const plurnk = isRecord(forwardedProps) && isRecord(forwardedProps.plurnk) ? forwardedProps.plurnk : undefined;
    const action = plurnk?.action;
    if (!isRecord(action)) return null;
    const { kind } = action;
    if (typeof kind !== "string" || kind.length === 0) return null;
    const { kind: _kind, ...params } = action;
    return { kind, params };
};
export type ActionOutcome = { ok: true; result?: unknown } | { ok: false; problem: ProblemDetails };
// {§agui-plurnk-metadata} An action Run's result: the action's whole outcome, a failure included.
export const actionRunResult = (kind: string, outcome: ActionOutcome): Record<string, unknown> => ({ kind, ...outcome });
