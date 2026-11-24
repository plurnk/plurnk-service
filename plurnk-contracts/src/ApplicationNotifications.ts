import type {
    ApplicationLoopPacket,
    ApplicationSessionArchiving,
    ApplicationSessionDeletion,
    ApplicationSessionKind,
    ApplicationSessionOrigin,
    ApplicationSessionTitling,
    ApplicationWorkspaceArchiving,
    LogEntryWire,
    ProposalDecision,
} from "./Application.ts";
import { isRecord, isSafeInteger } from "./guards.ts";
import type { LoopLifecycle } from "./LoopLifecycle.ts";
import type {
    ClientEntryChannel,
    ClientInteractionProjection,
    FunctionalityPreparationActivity,
    JsonSchema,
    ModelRoute,
    Notice,
    OperationResult,
    ProposalProjection,
} from "./types.ts";
import type { DaemonNotificationEnvelope, ProviderAccounting } from "./types.generated.ts";

/**
 * {§application-session-observation} The closed alphabet of discrete daemon notification events
 * emitted across `ApplicationPort.subscribeToEvents` and `GET /notifications`.
 */
export const DAEMON_NOTIFICATION_EVENTS = Object.freeze([
    "workspace/created",
    "workspace/renamed",
    "workspace/archived",
    "functionality/changed",
    "session/created",
    "session/archived",
    "session/deleted",
    "session/titled",
    "session/policy",
    "loop/started",
    "loop/parked",
    "loop/proposal",
    "loop/interaction",
    "loop/gate-settled",
    "loop/terminated",
    "log/entry",
    "stream/concluded",
    "notice/event",
] as const);

export type DaemonNotificationEvent = (typeof DAEMON_NOTIFICATION_EVENTS)[number];

const DAEMON_NOTIFICATION_EVENT_SET: ReadonlySet<string> = new Set(DAEMON_NOTIFICATION_EVENTS);

export const isDaemonNotificationEvent = (value: unknown): value is DaemonNotificationEvent =>
    typeof value === "string" && DAEMON_NOTIFICATION_EVENT_SET.has(value);

/**
 * {§application-session-observation} In-process sub-turn streaming and telemetry callbacks
 * consumed by exterior protocol adapters (`plurnk-acp`, `plurnk-mcp`), never streamed on `GET /notifications`.
 */
export const APPLICATION_RUNTIME_STREAM_EVENTS = Object.freeze([
    "workspace/preparation",
    "loop/packet",
    "stream/event",
    "reasoning/event",
    "runtime/telemetry",
] as const);

export type ApplicationRuntimeStreamEvent = (typeof APPLICATION_RUNTIME_STREAM_EVENTS)[number];

const APPLICATION_RUNTIME_STREAM_EVENT_SET: ReadonlySet<string> = new Set(APPLICATION_RUNTIME_STREAM_EVENTS);

export const isApplicationRuntimeStreamEvent = (value: unknown): value is ApplicationRuntimeStreamEvent =>
    typeof value === "string" && APPLICATION_RUNTIME_STREAM_EVENT_SET.has(value);

/**
 * {§notifications} Classifies internal turn/lifecycle/derivation/progress telemetry notices that belong
 * on `ApplicationPort.subscribeToRuntimeStream` (`runtime/telemetry`) rather than public `notice/event`.
 */
export const isRuntimeTelemetryNotice = (notice: Notice): boolean => {
    if (
        notice.source === "engine:lifecycle" ||
        notice.source === "engine:derivation" ||
        notice.source === "engine:emission"
    ) {
        return true;
    }
    if (
        notice.source === "engine:turn" &&
        (notice.kind === "turn_queued" ||
            notice.kind === "turn_awaiting_model" ||
            notice.kind === "turn_generated" ||
            notice.kind === "results_pending")
    ) {
        return true;
    }
    if (notice.source.startsWith("exec:") && typeof (notice as Record<string, unknown>).percent === "number") {
        return true;
    }
    return typeof notice.message !== "string" || notice.message.trim().length === 0;
};

export interface WorkspaceCreatedNotification {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
}

export interface WorkspaceRenamedNotification {
    readonly id: number;
    readonly name: string;
}

export type WorkspaceArchivedNotification = ApplicationWorkspaceArchiving;

export interface WorkspacePreparationNotification {
    readonly workspaceId: number;
    readonly preparation: readonly FunctionalityPreparationActivity[];
}

export interface FunctionalityChangedNotification {
    readonly workspaceId: number;
    readonly sessionId: number | null;
    readonly family: string;
}

export interface SessionCreatedNotification {
    readonly id: number;
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    readonly projectLabel: string | null;
    readonly name: string;
    readonly parentSessionId: number | null;
    readonly origin: ApplicationSessionOrigin;
    readonly kind: ApplicationSessionKind;
    readonly lifecycle: LoopLifecycle;
    readonly persona?: string | null;
}

export type SessionArchivedNotification = ApplicationSessionArchiving;

export type SessionDeletedNotification = ApplicationSessionDeletion;

export type SessionTitledNotification = ApplicationSessionTitling;

export interface SessionPolicyNotification {
    readonly sessionId: number;
    readonly model: ModelRoute | null;
    readonly childModel: ModelRoute | null;
    readonly persona?: string | null;
}

export type LoopPacketNotification = ApplicationLoopPacket;

// {§methods-invocation} The row exactly as core sends it.
export interface LogEntryNotification {
    readonly entry: LogEntryWire;
}

export interface LoopStartedNotification {
    readonly sessionId: number;
    readonly loopId: number;
    readonly loopSeq: number;
}

export interface LoopParkedNotification {
    readonly sessionId: number;
    readonly loopId: number;
    readonly loopSeq: number;
    readonly status: 202;
}

export type ProposalNotification = ProposalProjection;

export type LoopInteractionNotification = ClientInteractionProjection;

export type LoopGateSettledNotification =
    | {
          readonly kind: "proposal";
          readonly sessionId: number;
          readonly loopId: number;
          readonly logEntryId: number;
          readonly decision: ProposalDecision;
          readonly outcome: string;
      }
    | {
          readonly kind: "interaction";
          readonly sessionId: number;
          readonly loopId: number;
          readonly interactionId: number;
          readonly action: "accept" | "decline" | "cancel";
      };

export interface StreamEventNotification {
    readonly entryId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly channel: string;
    readonly state: ClientEntryChannel["state"];
    readonly contentLength: number;
    readonly loopSeq?: number;
    readonly turnSeq?: number;
    readonly sequence?: number;
    readonly mimetype?: string;
}

export interface StreamConcludedNotification {
    readonly sessionId: number;
    readonly entryId: number;
    readonly target: string;
    readonly subscriptionId: number;
    readonly result: OperationResult;
    readonly scheme: string;
    readonly summary: string;
    readonly wakeAction: string;
    readonly loopSeq?: number;
    readonly turnSeq?: number;
    readonly sequence?: number;
}

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

export interface NoticeEventNotification {
    readonly sessionId: number | null;
    readonly loopId: number;
    readonly notice: Notice;
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

export interface NotificationsResyncPayload {
    readonly reason: "restarted" | "evicted" | "malformed";
    readonly epoch: string;
    readonly latestId: number;
}

export type NotificationReplayResult =
    | {
          readonly status: "ok";
          readonly epoch: string;
          readonly events: readonly DaemonNotification[];
      }
    | {
          readonly status: "resync";
          readonly resync: NotificationsResyncPayload;
      };

export interface DaemonNotificationPayloadMap {
    readonly "workspace/created": WorkspaceCreatedNotification;
    readonly "workspace/renamed": WorkspaceRenamedNotification;
    readonly "workspace/archived": WorkspaceArchivedNotification;
    readonly "functionality/changed": FunctionalityChangedNotification;
    readonly "session/created": SessionCreatedNotification;
    readonly "session/archived": SessionArchivedNotification;
    readonly "session/deleted": SessionDeletedNotification;
    readonly "session/titled": SessionTitledNotification;
    readonly "session/policy": SessionPolicyNotification;
    readonly "loop/started": LoopStartedNotification;
    readonly "loop/parked": LoopParkedNotification;
    readonly "loop/proposal": ProposalNotification;
    readonly "loop/interaction": LoopInteractionNotification;
    readonly "loop/gate-settled": LoopGateSettledNotification;
    readonly "loop/terminated": TerminatedNotification;
    readonly "log/entry": LogEntryNotification;
    readonly "stream/concluded": StreamConcludedNotification;
    readonly "notice/event": NoticeEventNotification;
}

export interface ApplicationRuntimeStreamPayloadMap {
    readonly "workspace/preparation": WorkspacePreparationNotification;
    readonly "loop/packet": LoopPacketNotification;
    readonly "stream/event": StreamEventNotification;
    readonly "reasoning/event": ReasoningEventNotification;
    readonly "runtime/telemetry": NoticeEventNotification;
}

export type ApplicationRuntimeStreamHandler = <
    E extends ApplicationRuntimeStreamEvent = ApplicationRuntimeStreamEvent,
>(
    workspaceId: number,
    method: E,
    params: ApplicationRuntimeStreamPayloadMap[E],
) => void;

export type DaemonNotification<E extends DaemonNotificationEvent = DaemonNotificationEvent> = {
    [K in E]: {
        readonly id: number;
        readonly event: K;
        readonly timestamp: number;
        readonly workspaceId: number | null;
        readonly sessionId: number | null;
        readonly data: DaemonNotificationPayloadMap[K];
    };
}[E];

// Compile-time witness that generated DaemonNotificationEnvelope covers and conforms to DaemonNotification.
type _AssertEnvelopeAssignable =
    DaemonNotificationEnvelope extends DaemonNotification
        ? [DaemonNotificationEvent] extends [DaemonNotificationEnvelope["event"]]
            ? true
            : never
        : never;
const _envelopeWitness: _AssertEnvelopeAssignable = true;
void _envelopeWitness;

export interface NotificationFilter {
    readonly events?: readonly DaemonNotificationEvent[];
    readonly workspaceId?: number;
    readonly sessionId?: number;
}

const extractSessionId = (event: DaemonNotificationEvent, data: unknown): number | null => {
    if (!isRecord(data)) return null;
    if (isSafeInteger(data.sessionId)) return data.sessionId;
    if (
        (event === "session/created" ||
            event === "session/archived" ||
            event === "session/deleted" ||
            event === "session/titled") &&
        isSafeInteger(data.id)
    ) {
        return data.id;
    }
    if (event === "log/entry" && isRecord(data.entry) && isSafeInteger(data.entry.sessionId)) {
        return data.entry.sessionId;
    }
    return null;
};

const extractWorkspaceId = (
    workspaceId: number | null,
    event: DaemonNotificationEvent,
    data: unknown,
): number | null => {
    if (workspaceId !== null) return workspaceId;
    if (event === "workspace/created" && isRecord(data) && isSafeInteger(data.id)) {
        return data.id;
    }
    return null;
};

/**
 * {§application-session-observation} Wraps a raw event emission in the canonical `DaemonNotification`
 * envelope shared by `ApplicationPort.subscribeToEvents` and `GET /notifications`.
 */
export const toDaemonNotification = <E extends DaemonNotificationEvent>(
    id: number,
    workspaceId: number | null,
    event: E,
    data: DaemonNotificationPayloadMap[E],
    timestamp: number = Date.now(),
): DaemonNotification => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- discriminated envelope constructed for event E
    return {
        id,
        event,
        timestamp,
        workspaceId: extractWorkspaceId(workspaceId, event, data),
        sessionId: extractSessionId(event, data),
        data,
    } as DaemonNotification;
};

/**
 * {§application-session-observation} Evaluates whether a `DaemonNotification` matches a
 * `NotificationFilter` (event set, workspace scope, and session scope including subtree archive/delete).
 */
export const matchesNotificationFilter = (
    notification: DaemonNotification,
    filter?: NotificationFilter,
): boolean => {
    if (filter === undefined) return true;
    if (filter.events !== undefined && !filter.events.includes(notification.event)) {
        return false;
    }
    if (filter.workspaceId !== undefined && notification.workspaceId !== filter.workspaceId) {
        return false;
    }
    if (filter.sessionId !== undefined) {
        if (notification.sessionId === filter.sessionId) return true;
        if (
            (notification.event === "session/archived" || notification.event === "session/deleted") &&
            isRecord(notification.data) &&
            Array.isArray(notification.data.sessionIds) &&
            notification.data.sessionIds.includes(filter.sessionId)
        ) {
            return true;
        }
        return false;
    }
    return true;
};

export interface ApplicationNotificationContract<T = unknown> {
    readonly payloadSchema: JsonSchema;
    // The payload the schema generates: the type the table declares beside the schema, never a value the contract carries.
    readonly payload?: T;
}
