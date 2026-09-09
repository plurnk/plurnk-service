import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../core/Db.ts";
import type { WakeWorkerPayload } from "../core/ChannelWrite.ts";
import { OperationFailureError } from "../core/results.ts";
import DrainSupervisor from "./DrainSupervisor.ts";

const payload: WakeWorkerPayload = {
    workspaceId: 1,
    workerId: 2,
    entryOwnerId: 2,
    entryId: 3,
    target: "sh:///1/1/1/EXEC",
    subscriptionId: 4,
    result: { status: 200 },
    scheme: "sh",
    summary: "sh:///1/1/1/EXEC completed",
};

const supervisor = (
    readSystemPrompt: () => Promise<string>,
    emit: (workspaceId: number, method: string, params: unknown) => void = () => {},
    overrides: Partial<ConstructorParameters<typeof DrainSupervisor>[0]> = {},
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
    cancelSubscription: async () => false,
    hasActiveStreams: () => false,
    isDetachedSubscription: () => false,
    readSystemPrompt,
    emitLogEntry: async () => {},
    emit,
    ...overrides,
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
            target: "sh:///1/1/1/EXEC",
            subscriptionId: 4,
            result: { status: 200 },
            scheme: "sh",
            summary: "sh:///1/1/1/EXEC completed",
            workerId: 2,
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

const cancellationCases = [
    { name: "immediate", includeRoot: true, cancel: (drains: DrainSupervisor) => drains.cancel(2, "operator cancelled") },
    { name: "awaited", includeRoot: true, cancel: (drains: DrainSupervisor) => drains.cancelWorkerTree(2, "operator cancelled") },
    { name: "descendant", includeRoot: false, cancel: (drains: DrainSupervisor) => drains.cancelDescendants(2, "operator cancelled") },
] as const;

for (const { name, includeRoot, cancel } of cancellationCases) {
    test(`{§module-shutdown-order}: supervisor idle joins ${name} cancellation`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const calls: unknown[][] = [];
        const drains = supervisor(async () => "system", undefined, {
            db: { drain_get_worker_workspace: { get: async () => ({ workspace_id: 1 }) } } as unknown as Db,
            lifecycle: {
                cancelTree: async (...args: unknown[]) => {
                    calls.push(args);
                    entered.resolve();
                    await release.promise;
                    return { workerIds: [], loops: [] };
                },
            } as never,
        });
        drains.start();
        const cancellation = cancel(drains);
        await entered.promise;
        drains.beginStop("daemon_stopping");
        let settled = false;
        const idle = drains.idle().then(() => { settled = true; });
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(settled, false, "accepted cancellation belongs to the shutdown barrier");
        } finally {
            release.resolve();
            await cancellation;
            await idle;
        }
        assert.deepEqual(calls, [[2, "operator cancelled", includeRoot]]);
    });

    test(`{§module-shutdown-order}: supervisor preserves ${name} cancellation failure`, async (t) => {
        const cause = new Error("cancellation fixture failed");
        const diagnostics: unknown[][] = [];
        t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
        const drains = supervisor(async () => "system", undefined, {
            db: { drain_get_worker_workspace: { get: async () => ({ workspace_id: 1 }) } } as unknown as Db,
            lifecycle: { cancelTree: async () => { throw cause; } } as never,
        });
        drains.start();
        const cancellation = cancel(drains);
        const caller = typeof cancellation === "boolean"
            ? Promise.resolve(assert.equal(cancellation, false))
            : assert.rejects(cancellation, (error: unknown) => error === cause);
        await caller;
        await assert.rejects(drains.idle(), (error: unknown) => error instanceof AggregateError
            && error.errors.length === 1
            && error.errors[0] === cause);
        assert.equal(diagnostics.length, 1, "each failure is reported once, including immediate acknowledgement");
        assert.equal(diagnostics[0]?.[1], cause, "the original failure remains inspectable");
        await drains.idle();
    });
}

test("{§worker-lifecycle-durable-disposition}: stopping during wait selection preserves the parked loop", async (t) => {
    const selecting = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<Array<{ id: number; wait_revision: number }>>();
    let wakes = 0;
    let starts = 0;
    const drains = supervisor(async () => "system", undefined, {
        lifecycle: {
            parked: async () => { selecting.resolve(); return selected.promise; },
            wake: async () => { wakes++; return true; },
        } as never,
    });
    t.mock.method(drains, "ensureDrain", async () => { starts++; return null; });
    drains.start();
    const settlement = drains.settleCompletionWake(1, 2, "system");
    await selecting.promise;
    drains.beginStop("daemon_stopping");
    selected.resolve([{ id: 7, wait_revision: 1 }]);
    await settlement;
    assert.equal(wakes, 0, "a pre-stop selection must not enqueue parked work after stopping");
    assert.equal(starts, 0, "no provider drain can start from the stale selection");
});

const delivery = {
    workspaceId: 1, workerId: 2, sourceLoopId: 10, prompt: "message",
    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
    reasoningPolicy: "adaptive", systemPrompt: "system",
} as const;

test("{§worker-causal-admission}: cancellation follows accepted delivery without blocking another workspace", async (t) => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const drains = supervisor(async () => "system", undefined, {
        db: {
            drain_message_source: { get: async ({ loop_id }: { loop_id: number }) => ({ workspace_id: loop_id === 10 ? 1 : 2, status: 102 }) },
            drain_current_loop_for_worker: { get: async ({ worker_id }: { worker_id: number }) => ({ id: worker_id }) },
            drain_get_worker_workspace: { get: async () => ({ workspace_id: 1 }) },
        } as unknown as Db,
        lifecycle: {
            wake: async () => false,
            cancelTree: async () => { order.push("cancel"); return { workerIds: [], loops: [] }; },
        } as never,
        injectPrompt: async (loopId) => {
            if (loopId === 2) { writing.resolve(); await release.promise; }
            order.push(`deliver:${loopId}`);
            return { loopId, turnSeq: 2 };
        },
    });
    t.mock.method(drains, "ensureDrain", async () => null);
    drains.start();
    const admitted = drains.inject(delivery);
    await writing.promise;
    const cancelled = drains.cancelWorkerTree(1, "cancel source");
    try {
        const independent = await drains.inject({ ...delivery, workspaceId: 2, workerId: 3, sourceLoopId: 11 });
        assert.equal(independent.action, "injected_next_turn");
        assert.deepEqual(order, ["deliver:3"], "cancellation cannot cross an unfinished admission; another workspace can proceed");
    } finally { release.resolve(); }
    await Promise.all([admitted, cancelled]);
    assert.deepEqual(order, ["deliver:3", "deliver:2", "cancel"]);
});

test("{§worker-causal-admission}: cancellation wins before a queued causal delivery; independent arrivals remain legal", async (t) => {
    const cancelling = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sourceStatus = 102;
    const messages: string[] = [];
    const drains = supervisor(async () => "system", undefined, {
        db: {
            drain_message_source: { get: async () => ({ workspace_id: 1, status: sourceStatus }) },
            drain_current_loop_for_worker: { get: async () => ({ id: 20 }) },
            drain_get_worker_workspace: { get: async () => ({ workspace_id: 1 }) },
        } as unknown as Db,
        lifecycle: {
            wake: async () => false,
            cancelTree: async () => {
                cancelling.resolve();
                await release.promise;
                sourceStatus = 499;
                return { workerIds: [], loops: [] };
            },
        } as never,
        injectPrompt: async (loopId, prompt) => { messages.push(prompt); return { loopId, turnSeq: 2 }; },
    });
    t.mock.method(drains, "ensureDrain", async () => null);
    drains.start();
    const cancelled = drains.cancelWorkerTree(1, "cancel source");
    await cancelling.promise;
    const rejected = assert.rejects(drains.inject(delivery), (error: unknown) => error instanceof OperationFailureError
        && error.result.status === 409
        && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/admission/source-not-running"
        && error.result.problem?.sourceStatus === 499);
    // All fake boundary calls resolve in-process; one event-loop turn drains their microtasks.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    await Promise.all([cancelled, rejected]);
    assert.deepEqual(messages, []);
    const { sourceLoopId: _source, ...independent } = delivery;
    const accepted = await drains.inject({ ...independent, prompt: "new independent message" });
    assert.equal(accepted.action, "injected_next_turn");
    assert.deepEqual(messages, ["new independent message"]);
});
