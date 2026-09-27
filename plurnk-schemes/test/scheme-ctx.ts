// One contract-shaped SchemeCtx for scheme fixtures: identity at its defaults and every
// capability refusing until the fixture overrides it.
import type { SchemeCtx } from "../src/ctx.ts";

const outside = (surface: string) => async (): Promise<never> => {
    throw new Error(`${surface} is outside this fixture.`);
};

export const schemeCtx = (overrides: Partial<SchemeCtx> = {}): SchemeCtx => ({
    workspaceId: 1,
    workerId: 1,
    loopId: 1,
    turnId: 1,
    writer: "model",
    signal: undefined,
    entries: {
        operations: {
            editBatch: outside("entries.operations.editBatch"),
            find: outside("entries.operations.find"),
            send: outside("entries.operations.send"),
        },
        address: outside("entries.address"),
        read: outside("entries.read"),
        write: outside("entries.write"),
        delete: outside("entries.delete"),
    },
    channels: {
        append: outside("channels.append"),
        replace: outside("channels.replace"),
        setState: outside("channels.setState"),
    },
    notify: {
        streamEvent: () => { throw new Error("notify.streamEvent is outside this fixture."); },
    },
    projection: {
        readable: outside("projection.readable"),
        binary: outside("projection.binary"),
        identity: outside("projection.identity"),
        isBinary: outside("projection.isBinary"),
        parseIssues: outside("projection.parseIssues"),
    },
    interactions: { request: outside("interactions.request") },
    subscriptions: {
        open: outside("subscriptions.open"),
        notifyChunk: outside("subscriptions.notifyChunk"),
        close: outside("subscriptions.close"),
    },
    resources: { capture: outside("resources.capture") },
    messages: {
        prepare: outside("messages.prepare"),
        reply: outside("messages.reply"),
    },
    ...overrides,
});
