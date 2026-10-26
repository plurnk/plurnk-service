// {§methods-session-gauge} {§notifications-loop-packet} — a Session's gauge is what its latest packet reported: nothing
// before its first, each model turn's own after it, so it moves while a loop works; a loop's last packet and its terminal
// report the same gauge; absent capacity evidence stays absent; another workspace's Session is refused.
import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationGauge } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { OperationFailureError } from "../../src/core/results.ts";
import type Daemon from "../../src/server/Daemon.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";

const NONE: ApplicationGauge = { curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null };

// Each packet's gauge in arrival order, and each terminal's, by loop.
const observe = (daemon: Daemon) => {
    const packets: Array<{ loopId: number; gauge: ApplicationGauge }> = [];
    const terminals = new Map<number, ApplicationGauge>();
    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
        if (method === "loop/packet") packets.push(params as { loopId: number; gauge: ApplicationGauge });
        if (method !== "loop/terminated") return;
        const { loopId, usage: { curationWeight, curationBudget, contextTokens, contextCapacity } } = params as {
            loopId: number; usage: ApplicationGauge;
        };
        terminals.set(loopId, { curationWeight, curationBudget, contextTokens, contextCapacity });
    });
    const terminal = (loopId: number) => waitForDb(async () => terminals.get(loopId), (value) => value !== undefined);
    const latest = (): ApplicationGauge => packets.at(-1)?.gauge ?? NONE;
    const lastOf = (loopId: number): ApplicationGauge | undefined => packets.findLast((packet) => packet.loopId === loopId)?.gauge;
    return { packets, terminal, latest, lastOf, off };
};

test("{§methods-session-gauge}: the gauge the Session's latest packet reported, moving with each model turn", async (t) => {
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"),
        makeMockResponse("````NOTE\nWorking on the second.\n````"),
        makeMockResponse("````SEND [200]\nThe second answer.\n````"),
        makeMockResponse("````SEND [200]\nThe third answer.\n````"),
    ] });
    // The second loop's second call is held while the gauge is read, then cancelled.
    const generate = provider.generate.bind(provider);
    let calls = 0;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (++calls === 3) {
            held.resolve();
            await release.promise;
        }
        return generate(...args);
    });
    t.after(() => release.resolve());
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { packets, terminal, latest, lastOf, off } = observe(daemon);
        try {
            const gauge = () => daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(await gauge(), NONE, "a Session without a packet reports no gauge");

            const { loopId: first } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            const concluded = await terminal(first);
            assert.deepEqual(lastOf(first), concluded, "a loop's last packet and its terminal report one gauge");
            assert.deepEqual(await gauge(), latest(), "the gauge the latest packet reported");

            const { loopId: second } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer again." });
            await held.promise;
            const working = lastOf(second);
            assert.ok(working !== undefined, "the working loop's first turn reported its gauge before the loop ends");
            assert.notDeepEqual(working, concluded, "that turn's gauge is its own");
            assert.deepEqual(await gauge(), working, "the gauge moves with the working loop's turn");
            await daemon.cancelSession({ workspaceId, sessionId, reason: "user_escape" });
            release.resolve();
            await terminal(second);
            assert.deepEqual(await gauge(), latest(), "a cancelled loop leaves the gauge its latest packet reported");

            const { loopId: third } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer a third time." });
            const ended = await terminal(third);
            assert.deepEqual(lastOf(third), ended, "each loop's last packet and terminal agree");
            assert.deepEqual(await gauge(), latest(), "the gauge follows the packet that came last");
            assert.ok(packets.length >= 4, "every model turn reported a packet");

            const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "session-gauge-elsewhere" });
            await assert.rejects(daemon.sessionGauge({ workspaceId: elsewhere, sessionId }), (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
        } finally {
            off();
        }
    });
});

test("{§methods-session-gauge}: absent capacity evidence stays absent, as the packet reported it", async () => {
    const provider = new Mock({ contextWindow: null, responses: [makeMockResponse("````SEND [200]\nThe answer.\n````")] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "session-gauge-uncalibrated" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { terminal, latest, off } = observe(daemon);
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Answer once." });
            await terminal(loopId);
            const gauge = await daemon.sessionGauge({ workspaceId, sessionId });
            assert.deepEqual(gauge, latest(), "the gauge the packet reported");
            assert.equal(gauge.contextCapacity, null, "no capacity evidence, no capacity");
            assert.equal(gauge.curationBudget, null, "no capacity, no curation budget");
            assert.notEqual(gauge.curationWeight, null, "the packet's own weight is still known");
        } finally {
            off();
        }
    });
});
