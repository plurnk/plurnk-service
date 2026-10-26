// {§notifications-reasoning-event} Transient readable-reasoning delivery to
// workspace-scoped presentation consumers. The provider response remains the
// durable authority; these events expose its live arrival without creating
// another stored representation.

export type ReasoningEventPayload = {
    sessionId: number;
    loopId: number;
    turnId: number;
    // The turn's ordinals in its session's log, its `L/T` ({§turn-source-resources}).
    loopSeq: number;
    turnSeq: number;
    modelCallId: number;
    requestSequence: number;
} & (
    | { phase: "start" | "end" }
    | { phase: "content"; delta: string }
);

export type ReasoningEventNotify = (
    workspaceId: number,
    event: ReasoningEventPayload,
) => void;
