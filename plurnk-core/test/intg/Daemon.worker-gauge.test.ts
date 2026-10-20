// {§methods-worker-gauge} — a Worker's gauge is what `loop/terminated.usage` reported for its latest concluded work loop:
// nothing before its first conclusion, each conclusion's own after it, unchanged while a later loop's call is under way,
// a cancelled loop's as its terminal reported it, absent capacity evidence absent; another workspace's Worker is refused.
import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationWorkerGauge } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import type Daemon from "../../src/server/Daemon.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

// The four gauge facts of each loop/terminated, by loop, and a wait for one loop's.
const terminals = (daemon: Daemon) => {
    const reported = new Map<number, ApplicationWorkerGauge>();
    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
        if (method !== "loop/terminated") return;
        const { loopId, usage: { curationWeight, curationBudget, contextTokens, contextCapacity } } = params as {
            loopId: number; usage: ApplicationWorkerGauge;
        };
        reported.set(loopId, { curationWeight, curationBudget, contextTokens, contextCapacity });
    });
    const terminal = (loopId: number) => waitForDb(async () => reported.get(loopId), (value) => value !== undefined);
    return { terminal, off };
};

test("{§methods-worker-gauge}: the gauge the Worker's latest conclusion reported, and none before its first", async (t) => {
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"),
        makeMockResponse("````SEND [200]\nThe second answer.\n````"),
        makeMockResponse("````SEND [200]\nThe third answer.\n````"),
    ] });
    // The second loop's call is held while the gauge is read, then cancelled.
    const generate = provider.generate.bind(provider);
    let holdNext = false;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (holdNext) {
            holdNext = false;
            held.resolve();
            await release.promise;
        }
        return generate(...args);
    });
    t.after(() => release.resolve());
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "worker-gauge" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const { terminal, off } = terminals(daemon);
        try {
            const gauge = () => daemon.workerGauge({ workspaceId, workerId });
            assert.deepEqual(await gauge(), { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null },
                "a Worker that has not concluded a loop reports no gauge");

            const { loopId: first } = await daemon.runLoop({ workspaceId, workerId, prompt: "Answer once." });
            const firstReported = await terminal(first);
            assert.deepEqual(await gauge(), firstReported, "the gauge the first conclusion reported");

            holdNext = true;
            const { loopId: second } = await daemon.runLoop({ workspaceId, workerId, prompt: "Answer again." });
            await held.promise;
            assert.deepEqual(await gauge(), firstReported, "a later loop's call under way leaves the latest conclusion's gauge");
            await daemon.cancelWorker({ workspaceId, workerId, reason: "user_escape" });
            release.resolve();
            const cancelled = await terminal(second);
            assert.deepEqual(await gauge(), cancelled, "a cancelled loop's gauge as its terminal reported it");

            const { loopId: third } = await daemon.runLoop({ workspaceId, workerId, prompt: "Answer a third time." });
            const latest = await terminal(third);
            assert.notDeepEqual(latest, firstReported, "each conclusion reports a gauge of its own");
            assert.deepEqual(await gauge(), latest, "the gauge follows the conclusion that came last");

            const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "worker-gauge-elsewhere" });
            await assert.rejects(daemon.workerGauge({ workspaceId: elsewhere, workerId }), (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/worker/workspace-mismatch");
        } finally {
            off();
        }
    });
});

test("{§methods-worker-gauge}: absent capacity evidence stays absent, as the terminal reported it", async () => {
    const provider = new Mock({ contextWindow: null, responses: [makeMockResponse("````SEND [200]\nThe answer.\n````")] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "worker-gauge-uncalibrated" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const { terminal, off } = terminals(daemon);
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Answer once." });
            const reported = await terminal(loopId);
            const gauge = await daemon.workerGauge({ workspaceId, workerId });
            assert.deepEqual(gauge, reported, "the gauge the conclusion reported");
            assert.equal(gauge.contextCapacity, null, "no capacity evidence, no capacity");
            assert.equal(gauge.curationBudget, null, "no capacity, no curation budget");
            assert.notEqual(gauge.curationWeight, null, "the packet's own weight is still known");
        } finally {
            off();
        }
    });
});
