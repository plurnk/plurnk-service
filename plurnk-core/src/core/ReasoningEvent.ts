// {§notifications-reasoning-event} Transient readable-reasoning delivery to
// workspace-scoped presentation consumers. The provider response remains the
// durable authority; these events expose its live arrival without creating
// another stored representation.

export type ReasoningEventPayload = {
    workerId: number;
    loopId: number;
    turnId: number;
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
