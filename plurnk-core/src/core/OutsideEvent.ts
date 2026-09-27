// {§notifications-outside-event} One admitted emission's text outside every operation
// ({§outside-text}), delivered to workspace-scoped presentation consumers. The turn's
// `outside` source remains the durable authority; the event carries its exact text once.

export type OutsideEventPayload = {
    workerId: number;
    loopId: number;
    turnId: number;
    coordinate: string;
    text: string;
    tokens: number;
};

export type OutsideEventNotify = (
    workspaceId: number,
    event: OutsideEventPayload,
) => void;
