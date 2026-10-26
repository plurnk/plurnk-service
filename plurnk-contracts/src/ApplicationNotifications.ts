import { isRecord } from "./guards.ts";
import type { ApplicationLoopPacket, LogEntryWire } from "./Application.ts";
import type { ClientInteractionProjection, JsonSchema, OperationResult, ProposalProjection } from "./types.ts";
import type { ProviderAccounting } from "./types.generated.ts";

// {§methods-log-entry-wire} The row exactly as core sends it.
export interface LogEntryNotification {
    readonly entry: LogEntryWire;
}

export const isLogEntryNotification = (value: unknown): value is LogEntryNotification =>
    isRecord(value) && isRecord(value.entry);

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

// {§acp-outside-text}: one admitted emission's text outside every operation, with the exact
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
    // {§notifications-loop-terminated} — the loop's number among its session's loops.
    readonly loopSeq: number;
    readonly result: OperationResult;
    readonly hitMaxTurns: boolean;
    readonly turnIds: number[];
    readonly attributions: string[];
    // {§notifications-loop-terminated} — when the loop concluded, Unix milliseconds.
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

const id = (name: string): string => `https://schemas.plurnk.xyz/v0/${name}.json`;
const ref = (name: string): JsonSchema => ({ $ref: id(name) });
const string = (options: Readonly<Record<string, unknown>> = {}): JsonSchema => ({ type: "string", ...options });
const integer = (minimum: number = 0): JsonSchema => ({
    type: "integer",
    minimum,
    maximum: Number.MAX_SAFE_INTEGER,
});
const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [schema, { type: "null" }] });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const object = (
    properties: Readonly<Record<string, JsonSchema>> = {},
    required: readonly string[] = [],
    additionalProperties: boolean = false,
): JsonSchema => ({
    type: "object",
    ...(required.length === 0 ? {} : { required }),
    additionalProperties,
    properties,
});

const NONEMPTY = string({ minLength: 1 });
const POSITIVE = integer(1);
const NONNEGATIVE = integer(0);
const OPERATION_RESULT = ref("OperationResult");
const PROVIDER_ACCOUNTING = { $ref: "https://schemas.plurnk.xyz/ProviderAccounting.json" };

const notification = <T = unknown>(payloadSchema: JsonSchema): ApplicationNotificationContract<T> =>
    Object.freeze({ payloadSchema });

const streamCoordinate = {
    loop_seq: NONNEGATIVE,
    turn_seq: NONNEGATIVE,
    sequence: NONNEGATIVE,
};
const streamBase = {
    entryId: POSITIVE,
    sessionId: POSITIVE,
    target: NONEMPTY,
    scheme: NONEMPTY,
    channel: NONEMPTY,
    state: { enum: ["static", "active", "closed", "errored"] },
    contentLength: NONNEGATIVE,
    mimetype: NONEMPTY,
    ...streamCoordinate,
};
const reasoningIdentity = {
    sessionId: POSITIVE,
    loopId: POSITIVE,
    turnId: POSITIVE,
    loopSeq: POSITIVE,
    turnSeq: POSITIVE,
    modelCallId: POSITIVE,
    requestSequence: POSITIVE,
};

export const APPLICATION_NOTIFICATIONS = Object.freeze({
    "workspace/preparation": notification<{ preparation: unknown }>(object({
        workspaceId: POSITIVE,
        preparation: array(ref("FunctionalityPreparationActivity")),
    }, ["workspaceId", "preparation"])),
    "log/entry": notification<LogEntryNotification>(object({
        entry: object({
            id: POSITIVE,
            session_id: POSITIVE,
            loop_id: POSITIVE,
            op: nullable(string()),
            origin: NONEMPTY,
        }, ["id", "session_id", "loop_id", "op", "origin"], true),
    }, ["entry"])),
    "loop/terminated": notification<TerminatedNotification>(object({
        sessionId: POSITIVE,
        loopId: POSITIVE,
        loopSeq: POSITIVE,
        result: OPERATION_RESULT,
        hitMaxTurns: { type: "boolean" },
        turnIds: array(POSITIVE),
        attributions: array(NONEMPTY),
        usage: object({
            accounting: PROVIDER_ACCOUNTING,
            curationWeight: nullable(NONNEGATIVE),
            curationBudget: nullable(NONNEGATIVE),
            contextTokens: nullable(NONNEGATIVE),
            contextCapacity: nullable(POSITIVE),
            meta: { type: "object", additionalProperties: true },
        }, ["accounting", "curationWeight", "curationBudget", "contextTokens", "contextCapacity", "meta"]),
        // {§notifications-loop-terminated} — Unix milliseconds, the loop's own stamp.
        terminatedAt: POSITIVE,
    }, ["sessionId", "loopId", "loopSeq", "result", "hitMaxTurns", "turnIds", "attributions", "usage", "terminatedAt"])),
    "loop/packet": notification<ApplicationLoopPacket>(object({
        sessionId: POSITIVE,
        loopId: POSITIVE,
        loopSeq: POSITIVE,
        packetCount: POSITIVE,
        gauge: object({
            curationWeight: nullable(NONNEGATIVE),
            curationBudget: nullable(NONNEGATIVE),
            contextTokens: nullable(NONNEGATIVE),
            contextCapacity: nullable(POSITIVE),
        }, ["curationWeight", "curationBudget", "contextTokens", "contextCapacity"]),
    }, ["sessionId", "loopId", "loopSeq", "packetCount", "gauge"])),
    "loop/proposal": notification<ProposalProjection>(ref("ProposalProjection")),
    "loop/interaction": notification<ClientInteractionProjection>(ref("ClientInteractionProjection")),
    "notice/event": notification<{ notice?: unknown; loopId?: unknown }>(object({
        sessionId: nullable(POSITIVE),
        loopId: NONNEGATIVE,
        notice: ref("Notice"),
    }, ["sessionId", "loopId", "notice"])),
    "reasoning/event": notification<ReasoningEventNotification>({
        oneOf: [
            object({
                ...reasoningIdentity,
                phase: { enum: ["start", "end"] },
            }, ["sessionId", "loopId", "turnId", "loopSeq", "turnSeq", "modelCallId", "requestSequence", "phase"]),
            object({
                ...reasoningIdentity,
                phase: { enum: ["content"] },
                delta: NONEMPTY,
            }, ["sessionId", "loopId", "turnId", "loopSeq", "turnSeq", "modelCallId", "requestSequence", "phase", "delta"]),
        ],
    }),
    "outside/event": notification<OutsideEventNotification>(object({
        sessionId: POSITIVE,
        loopId: POSITIVE,
        turnId: POSITIVE,
        coordinate: NONEMPTY,
        text: NONEMPTY,
        tokens: POSITIVE,
    }, ["sessionId", "loopId", "turnId", "coordinate", "text", "tokens"])),
    "stream/event": notification(object(streamBase, ["entryId", "sessionId", "target", "channel", "state", "contentLength"])),
    "stream/concluded": notification(object({
        entryId: POSITIVE,
        sessionId: POSITIVE,
        target: NONEMPTY,
        subscriptionId: POSITIVE,
        result: OPERATION_RESULT,
        scheme: NONEMPTY,
        summary: string(),
        wakeAction: { enum: ["skipped-aborted", "skipped-cancelled", "wake-pending", "no-op-active-loop", "no-loop"] },
        ...streamCoordinate,
    }, ["entryId", "sessionId", "target", "subscriptionId", "result", "scheme", "summary", "wakeAction"])),
} satisfies Readonly<Record<string, ApplicationNotificationContract>>);
