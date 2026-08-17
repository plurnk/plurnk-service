import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../core/Db.ts";
import type { WakeWorkerPayload } from "../core/ChannelWrite.ts";
import DrainSupervisor from "./DrainSupervisor.ts";

const payload: WakeWorkerPayload = {
    workspaceId: 1,
    workerId: 2,
    entryOwnerId: 2,
    entryId: 3,
    target: "sh:///1/1/1",
    subscriptionId: 4,
    result: { status: 200 },
    scheme: "sh",
    summary: "sh:///1/1/1 completed",
};

const supervisor = (
    readSystemPrompt: () => Promise<string>,
    emit: (workspaceId: number, method: string, params: unknown) => void = () => {},
): DrainSupervisor => new DrainSupervisor({
    db: {
        drain_find_slept_loop: { get: async () => undefined },
    } as unknown as Db,
    lifecycle: {} as never,
    injectPrompt: async () => null,
    assertInjectionCompatibility: async () => {},
    reconcilePrompts: async () => {},
    runLoop: async () => { throw new Error("unused runLoop"); },
    loopUsage: async () => ({} as never),
    loopAttributions: async () => [],
    takeParkDeadline: () => undefined,
    cancelSubscription: async () => false,
    hasActiveStreams: () => false,
    readSystemPrompt,
    emitLogEntry: async () => {},
    emit,
});

test("{§module-shutdown-order}: supervisor idle owns an accepted conclusion wake", async () => {
    const prompt = Promise.withResolvers<string>();
    const events: Array<{ method: string; params: unknown }> = [];
    const drains = supervisor(
        () => prompt.promise,
        (_workspaceId, method, params) => { events.push({ method, params }); },
    );
    drains.start();
    drains.notifyWakeWorker(payload);

    let settled = false;
    const idle = drains.idle().then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "idle cannot outrun an accepted wake task");

    prompt.resolve("system prompt");
    await idle;
    assert.deepEqual(events, [{
        method: "stream/concluded",
        params: {
            entryId: 3,
            target: "sh:///1/1/1",
            subscriptionId: 4,
            result: { status: 200 },
            scheme: "sh",
            summary: "sh:///1/1/1 completed",
            workerId: 2,
            workspaceId: 1,
            wakeAction: "no-loop",
        },
    }]);
});

test("{§module-shutdown-order}: supervisor idle preserves a wake failure", async (t) => {
    const cause = new Error("wake fixture failed");
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const drains = supervisor(async () => { throw cause; });
    drains.start();
    drains.notifyWakeWorker(payload);

    await assert.rejects(
        drains.idle(),
        (error: unknown) => error instanceof AggregateError
            && error.errors.length === 1
            && error.errors[0] === cause,
    );
    assert.equal(diagnostics.length, 1, "the runtime diagnostic remains visible");
    assert.match(String(diagnostics[0]?.[0]), /wake-on-completion/);
    await drains.idle();
});
