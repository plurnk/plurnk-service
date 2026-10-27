import test, { describe } from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import Turn from "../../src/core/Turn.ts";
import LoopDriver from "../../src/core/LoopDriver.ts";
import SessionCap from "../../src/core/session-cap.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import WorkspaceGate from "../../src/core/WorkspaceGate.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import NoticeChannel from "../../src/core/NoticeChannel.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, holdChild, seedEntryWithChannel, insertTurn } from "./_db.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { Mock, type ChatMessage, type Provider, type ProviderResponse, type InputModality, chatMessageText, type ProviderSpec } from "@plurnk/plurnk-providers";
import { makeMockResponse, fixtureExecutors, answer, makeRawMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon, rpcCall, rpcProblem, subscribeNotifications, connect, waitFor, runLoopToTerminal } from "./_rpc.ts";
import { namedModelSession, admitTogether } from "./_sessions.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { routeForSpec } from "../../src/server/model-route.ts";
import { viableWindow, testProviderCapacity } from "./_provider.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { completeStmt, execStmt, dispositionStmt, sendStmt, killStmt, urlPath } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { testExecutors } from "./_execs.ts";
import { setTimeout as delay } from "node:timers/promises";
import { mountMemoryTracing } from "./_observe-memory.ts";
import { Module, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import { type FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { LOOP_TIMEOUT_REASON } from "../../src/core/TurnRunner.ts";
import { type Db } from "../../src/core/Db.ts";

describe("loop-lifecycle", () => {
test("{§session-loop-lifecycle} loop transitions are guarded and terminal state is immutable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        assert.equal(await lifecycle.wake(loopId), false, "an active loop cannot be woken");
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false, "a parked loop cannot be parked twice");
        assert.equal(await lifecycle.wake(loopId), true);
        const deliverable = { status: 200, content: "done", mimetype: "text/markdown" };
        assert.deepEqual(
            await lifecycle.finish(loopId, deliverable),
            deliverable,
        );
        assert.equal(
            await lifecycle.finish(
                loopId,
                Results.failure("lifecycle:cancel", "loop-cancelled", 499, "late cancel"),
                { terminatedBy: "cancel" },
            ),
            null,
            "a terminal winner cannot be rewritten",
        );
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false);
        assert.equal(await lifecycle.wake(loopId), false);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.deepEqual(await lifecycle.result(loopId), deliverable);
    } finally {
        await db.close();
    }
});

test("{§problems-functionality} structured cancellation atomically claims the unresolved descendant tree", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cancel-tree-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const rootLoop = await insertLoop(db, root, 1, "root");
        const child = await insertSession(db, workspaceId, root, "child");
        const childLoop = await insertLoop(db, child, 1, "child");
        const grandchild = await insertSession(db, workspaceId, child, "grandchild");
        const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
        const sibling = await insertSession(db, workspaceId, null, "sibling");
        const siblingLoop = await insertLoop(db, sibling, 1, "sibling");

        const cancelled = await new LoopLifecycle(db).cancelTree(root, "scope abandoned", false);

        assert.deepEqual(cancelled.sessionIds, [grandchild, child], "descendants are returned deepest-first for process-local reap");
        assert.deepEqual(new Set(cancelled.loops.map(({ loopId }) => loopId)), new Set([childLoop, grandchildLoop]));
        const status = async (loopId: number): Promise<number | undefined> =>
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(await status(rootLoop), 102, "includeRoot=false preserves the already-settling parent");
        assert.equal(await status(childLoop), 499);
        assert.equal(await status(grandchildLoop), 499);
        assert.equal(await status(siblingLoop), 102, "unowned siblings are untouched");
        for (const loop of cancelled.loops) {
            assert.equal(loop.result.status, 499);
            assert.equal(loop.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
            assert.equal(loop.result.problem?.instance, `ops://${loop.sessionId === child ? "child" : "grandchild"}/1`);
            assert.equal(loop.result.problem?.detail, "The session scope was cancelled: scope abandoned."); // {§problems-functionality}
            assert.equal(loop.result.problem?.reason, "scope abandoned");
            assert.equal(loop.result.problem?.stage, "loop");
            assert.equal(loop.result.problem?.retryable, false);
        }
        // {§session-causal-admission} — the session row carries the cancellation that retired its loops;
        // an untouched session carries none.
        const cancellation = async (id: number): Promise<unknown> =>
            JSON.parse((await db.test_get_session_cancellation.get<{ cancellation: string | null }>({ id }))?.cancellation ?? "null");
        assert.equal((await cancellation(child) as { problem: { reason: string } }).problem.reason, "scope abandoned");
        assert.equal((await cancellation(grandchild) as { status: number }).status, 499);
        assert.equal(await cancellation(sibling), null);
        assert.equal(await cancellation(root), null, "includeRoot=false leaves the root's cancellation unwritten");
    } finally {
        await db.close();
    }
});

test("{§session-loop-lifecycle} an uncommon terminal status remains exact in the result while the scheduler stores its terminal class", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-projection-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);
        const failure = Results.failure(
            "engine:provider",
            "provider-threw",
            502,
            "The provider returned an invalid response.",
        );

        const exact = await lifecycle.finish(loopId, failure);

        assert.equal(await lifecycle.status(loopId), 500, "the scheduler sees one terminal failure class");
        assert.equal(exact?.status, 502, "the product result retains the exact status");
        assert.equal(exact?.problem?.status, 502);
        const name = (await db.session_name_by_id.get<{ name: string }>({ session_id: sessionId }))!.name;
        assert.equal(exact?.problem?.instance, `ops://${name}/1`);
        assert.deepEqual(await lifecycle.result(loopId), exact);
    } finally {
        await db.close();
    }
});

test("{§session-loop-lifecycle} 202 remains a parked lifecycle state and cannot be stored as a terminal result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lifecycle-park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "work");
        const lifecycle = new LoopLifecycle(db);

        await assert.rejects(
            () => lifecycle.finish(loopId, { status: 202 }),
            /202 is the parked lifecycle state/,
        );
        assert.equal(await lifecycle.status(loopId), 102);
        assert.equal(await lifecycle.result(loopId), null);
    } finally {
        await db.close();
    }
});

test("{§session-wait-timing}: the wake time commits with the park and survives a new lifecycle owner", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "atomic-wait-deadline");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "inspect running work");
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "obligations", pollAt: 10_600 }), true);
        assert.deepEqual((await new LoopLifecycle(db).parked(sessionId))[0], {
            id: loopId, wait_revision: 1, wait_poll_at: 10_600,
        });
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_599 }), false);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_600 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_601 }), false);
        assert.equal(await lifecycle.status(loopId), 100, "expiry queues the same loop; it does not conclude it");
        assert.equal(await lifecycle.result(loopId), null);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: durable observation times cannot resume another wait generation", async (t) => {
    t.mock.method(Date, "now", () => 10_000);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "durable-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "original task");
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture", pollAt: 10_100 }), true);
        assert.deepEqual((await lifecycle.parked(sessionId))[0], { id: loopId, wait_revision: 1, wait_poll_at: 10_100 });
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_099 }), false);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_100 }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 10_300 }), false, "duplicate wake is inert");
        const claimed = await db.drain_claim_next_loop.get<{ id: number; prompt: string }>({ session_id: sessionId });
        assert.equal(claimed?.id, loopId);
        assert.equal(claimed?.prompt, "original task", "a wake is not another prompt or task");
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
        assert.equal(await lifecycle.wake(loopId, { revision: 1, dueAt: 99_999 }), false, "an old timer cannot wake a new wait");
        assert.equal((await lifecycle.parked(sessionId))[0]?.wait_poll_at, null, "a new wait starts without an observation time");
        await lifecycle.cancelTree(sessionId, "cancel waiting work", true);
        assert.equal(await lifecycle.wake(loopId, { revision: 2, dueAt: 99_999 }), false, "cancellation wins over every late timer");
        assert.equal(await lifecycle.status(loopId), 499);
    } finally { await db.close(); }
});

test("{§session-wait-timing}: multiple parked loops retain independent event observation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "independent-wakes");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const first = await insertLoop(db, parent, 1);
        const second = await insertLoop(db, parent, 2);
        const child = await insertSession(db, workspaceId, parent, "child");
        const childLoop = await insertLoop(db, child, 1);
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(first, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        await lifecycle.finish(childLoop, { status: 200, content: "child finished" });
        // Completion lands while second is active, before its parked transition.
        await lifecycle.park(second, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), true);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), true, "the first loop cannot consume the second's wake");
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false);
        assert.equal(await lifecycle.wake(second, { eventOnly: true }), false);
        await db.engine_reclaim_queued_loop.run({ loop_id: first });
        const next = await Turn.open(db, { loopId: first, producer: "model", kind: "inference" });
        await Turn.complete(db, next.id, 202);
        await lifecycle.park(first, { wakenBy: "test-fixture" });
        assert.equal(await lifecycle.wake(first, { eventOnly: true }), false,
            "a delayed duplicate completion cannot wake a later program that already observed it");
    } finally { await db.close(); }
});

for (const disposition of ["park", "finish", "cancel", "exception"] as const) {
    test(`{§session-wait-timing}: ${disposition} saves consumption and retires its timer`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
        let clock = 1000;
        t.mock.method(performance, "now", () => clock);
        const db = await openMigrated();
        const lifecycle = new LoopLifecycle(db);
        let loopId: number | undefined;
        try {
            const workspaceId = await insertWorkspace(db, `execution-${disposition}`);
            const sessionId = await insertSession(db, workspaceId);
            loopId = await insertLoop(db, sessionId, 1);
            let expired = false;
            assert.equal(await lifecycle.startExecution(loopId, 60000, () => { expired = true; }), true);
            clock += 40000;
            t.mock.timers.tick(40000);
            if (disposition === "park") await lifecycle.park(loopId, { wakenBy: "test-fixture" });
            else if (disposition === "finish") await lifecycle.finish(loopId, { status: 200 });
            else if (disposition === "cancel") await lifecycle.cancelTree(sessionId, "cancel task", true);
            else await lifecycle.endExecution(loopId);
            assert.deepEqual(await db.test_get_loop_execution.get({ id: loopId }), {
                execution_budget_ms: 60000, execution_elapsed_ms: 40000,
            }, "consumption is durable at the transition, not waiting for driver teardown");
            clock += 60000;
            t.mock.timers.tick(60000);
            assert.equal(expired, false, "the retired execution timer cannot fire into another lifecycle state");
        } finally {
            if (loopId !== undefined) await lifecycle.endExecution(loopId);
            await db.close();
        }
    });
}

test("{§session-wait-timing}: execution time is monotonic and invalid transitions cannot disable its timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    let clock = 1000;
    t.mock.method(performance, "now", () => clock);
    const db = await openMigrated();
    const lifecycle = new LoopLifecycle(db);
    let loopId: number | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "monotonic-execution");
        const sessionId = await insertSession(db, workspaceId);
        loopId = await insertLoop(db, sessionId, 1);
        const id = loopId;
        let expired = false;
        assert.equal(await lifecycle.startExecution(id, 60000, () => { expired = true; }), true);
        await assert.rejects(() => lifecycle.finish(id, { status: 202 }), /202 is the parked lifecycle state/);
        t.mock.timers.setTime(Date.now() - 86_400_000);
        clock += 40000;
        t.mock.timers.tick(40000);
        assert.equal(expired, false);
        await lifecycle.park(id, { wakenBy: "test-fixture" });
        assert.deepEqual(await db.test_get_loop_execution.get({ id }), {
            execution_budget_ms: 60000, execution_elapsed_ms: 40000,
        }, "a wall-clock correction cannot refund execution");
        await lifecycle.wake(id);
        await db.engine_reclaim_queued_loop.run({ loop_id: id });
        assert.equal(await lifecycle.startExecution(id, 120000, () => { expired = true; }), true);
        clock += 20000;
        t.mock.timers.tick(20000);
        assert.equal(expired, true, "the original allowance still expires after 60s of monotonic execution");
    } finally {
        if (loopId !== undefined) await lifecycle.endExecution(loopId);
        await db.close();
    }
});
});

describe("Daemon.causal-admission", () => {
for (const op of ["WORK", "FORK"]) {
    test(`{§session-causal-admission}: ${op} cannot admit a child after its source task is cancelled`, async (t) => {
    serverProposals(t, "accept");
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse(`\`\`\`\`${op} (session://late-child)
Do the delegated task.
\`\`\`\`
\`\`\`\`WAIT
Wait for the child.
\`\`\`\``),
            makeMockResponse("````WAIT\nChild task is still running.\n````"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-late-${op}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const deny = SessionCap.deny;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(SessionCap, "deny", async (...args: Parameters<typeof deny>) => {
                entered.resolve();
                await release.promise;
                return deny(...args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].sessionId === sessionId) finished.resolve(); }
            });
            try {
                const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Delegate this task." });
                await entered.promise;
                await daemon.cancelSession({ workspaceId, sessionId });
                assert.equal((await db.test_get_loop_status.get({ id: accepted.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                const sessions = await db.test_sessions_by_workspace.all<{ id: number }>({ workspace_id: workspaceId });
                const tasks = (await Promise.all(sessions.map(({ id }) =>
                    db.test_loop_queue_by_session.all<{ status: number }>({ session_id: id })))).flat();
                assert.equal(tasks.some(({ status }) => [100, 102, 202].includes(status)), false,
                    "no late runnable child escapes the cancelled parent task");
                assert.equal(provider.received.length, 1, "cancellation prevented child inference");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: accepted.loopId }))
                    .find((row) => row.op === op);
                assert.equal(receipt?.status_rx, 409, "the stopped delivery has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelSession({ workspaceId, sessionId });
            }
        });
    });
}

test("{§session-causal-admission}: cancellation wins over completion with an unread arrival and survives restart", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````SEND [200]\nFinished the original request.\n````"),
        makeMockResponse("````SEND [200]\nIndependent new request completed.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-prompt-promotion" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const concluding = Promise.withResolvers<void>();
        const conclude = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        const finish = LoopLifecycle.prototype.finish;
        const run = LoopDriver.prototype.runLoop;
        let taskLoopId: number | undefined;
        let firstConclusion = true;
        t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
            if (args[0] === taskLoopId && args[1].status === 200 && firstConclusion) {
                firstConclusion = false;
                concluding.resolve();
                await conclude.promise;
            }
            return finish.apply(this, args);
        });
        t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
            try { return await run.apply(this, args); }
            finally { if (args[0].sessionId === sessionId) finished.resolve(); }
        });
        try {
            const task = await daemon.runLoop({ workspaceId, sessionId, prompt: "Finish the original request." });
            taskLoopId = task.loopId;
            await concluding.promise;
            const arrival = await daemon.runLoop({ workspaceId, sessionId, prompt: "A now-cancelled follow-up request." });
            assert.equal(arrival.loopId, task.loopId);
            assert.equal(arrival.action, "injected_next_turn");
            await daemon.cancelSession({ workspaceId, sessionId });
            conclude.resolve();
            await finished.promise;
            assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 499,
                "the pending completion cannot overwrite cancellation");
            assert.equal((await db.test_loop_queue_by_session.all<{ status: number }>({ session_id: sessionId }))
                .some(({ status }) => [100, 102, 202].includes(status)), false, "cancelled unread work was not promoted");
            assert.deepEqual(await db.recovery_orphan_message_sources.all({}), [], "boot cannot resurrect the cancelled arrival");
            assert.equal((await db.test_messages_by_session.all({ session_id: sessionId })).length, 2,
                "both original messages remain available as evidence");
            await daemon.stop();
            const restarted = new Daemon({ db, provider });
            await restarted.start();
            try {
                const fresh = await restarted.runLoop({ workspaceId, sessionId, prompt: "This is an independent new request." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: fresh.loopId }))?.status, (status) => status === 200);
                assert.notEqual(fresh.loopId, task.loopId);
                assert.equal(provider.received.length, 2, "only the explicit new request ran after restart");
            } finally { await restarted.stop(); }
        } finally {
            conclude.resolve();
        }
    });
});

for (const recipientState of ["idle", "parked"]) {
    test(`{§session-causal-admission}: cancelled SEND cannot deliver to a ${recipientState} recipient`, async (t) => {
        const wait = makeMockResponse("````WAIT\nWaiting for a message.\n````");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(recipientState === "parked" ? [wait] : []),
            makeMockResponse("````SEND (session://recipient)\nThis message must not escape cancellation.\n````\n````SEND\nSent.\n````"),
            wait,
        ] });
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-send-${recipientState}` });
            const sourceSessionId = await namedModelSession(daemon, workspaceId, "main");
            const { sessionId } = await daemon.createSession({ workspaceId, name: "recipient" });
            await holdChild(db, workspaceId, sessionId);
            if (recipientState === "parked") {
                const task = await daemon.runLoop({ workspaceId, sessionId, prompt: "Await instructions." });
                await waitForDb(async () => (await db.test_get_loop_status.get({ id: task.loopId }))?.status, (status) => status === 202);
            }
            const promptsBefore = await db.test_messages_by_session.all({ session_id: sessionId });
            const loopsBefore = await db.test_loop_queue_by_session.all({ session_id: sessionId });
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const finished = Promise.withResolvers<void>();
            const inject = Daemon.prototype.inject;
            const run = LoopDriver.prototype.runLoop;
            t.mock.method(Daemon.prototype, "inject", async function (this: Daemon, args: Parameters<typeof inject>[0]) {
                if (args.sessionId === sessionId) {
                    entered.resolve();
                    await release.promise;
                }
                return inject.call(this, args);
            });
            t.mock.method(LoopDriver.prototype, "runLoop", async function (this: LoopDriver, ...args: Parameters<typeof run>) {
                try { return await run.apply(this, args); }
                finally { if (args[0].sessionId === sourceSessionId) finished.resolve(); }
            });
            try {
                const task = await daemon.runLoop({ workspaceId, sessionId: sourceSessionId, prompt: "Send instructions to recipient." });
                await entered.promise;
                await daemon.cancelSession({ workspaceId, sessionId: sourceSessionId });
                assert.equal((await db.test_get_loop_status.get({ id: task.loopId }))?.status, 499);
                release.resolve();
                await finished.promise;
                assert.deepEqual(await db.test_messages_by_session.all({ session_id: sessionId }), promptsBefore,
                    "the cancelled source did not append a prompt to the recipient");
                assert.deepEqual(await db.test_loop_queue_by_session.all({ session_id: sessionId }), loopsBefore,
                    "the cancelled source did not start or wake recipient work");
                const receipt = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: task.loopId }))
                    .find((row) => row.op === "SEND" && row.status_rx === 409);
                assert.ok(receipt, "the stopped message has an explicit refusal receipt");
                assert.equal(JSON.parse(receipt.rx).problem.type, "https://problems.plurnk.xyz/daemon/admission/source-not-running");
            } finally {
                release.resolve();
                await daemon.cancelSession({ workspaceId, sessionId: sourceSessionId });
                await daemon.cancelSession({ workspaceId, sessionId });
            }
        });
    });
}
});

describe("Daemon.exec-wake", () => {
// {§session-causal-admission}, {§notifications-stream-concluded}.
















// These fixtures exercise the lifecycle after a stream genuinely becomes
// monitored. Optimistic settlement has its own matrix; disable it here so the
// park/wake decision remains the controlled variable.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const execDsl = (command: string, disposition: "WAIT" | "NOTE" = "WAIT"): string =>
    `\`\`\`\`sh
${command}
\`\`\`\`

\`\`\`\`${disposition}
Observe the command.
\`\`\`\``;

const mockResponse = (dsl: string) => {
    return {
        assistant: {
            content: dsl,
            reasoning: null,
            usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        },
        assistantRaw: null,
    };
};

test("{§session-causal-admission}: a person's operation can cancel a workspace stream and wake its initiating waiting session", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 65536, responses: [
        mockResponse("````sh\nsleep 30\n````\n````WAIT\nWait for the command's outcome.\n````"),
        mockResponse("````SEND [200]\nThe command was cancelled.\n````"),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        const entries = subscribeNotifications(ws, "log/entry");
        const terminated = subscribeNotifications(ws, "loop/terminated");
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-stream-not-session" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const lifecycle = new LoopLifecycle(db);
        try {
            await rpcCall(ws, 1, "workspace.attach", { workspaceId });
            const accepted = await daemon.runLoop({
                workspaceId, sessionId, prompt: "Observe a command's outcome.",
            });
            await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
            const subscriptions = await db.find_open_subscriptions_for_session.all<{ id: number }>({ session_id: sessionId });
            assert.equal(subscriptions.length, 1);
            const subscription = await db.test_get_subscription.get<{ entry_id: number }>({ id: subscriptions[0].id });
            const resource = await db.test_get_entry_by_id.get<{ pathname: string; scheme: string }>({ id: subscription!.entry_id });
            const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(`KILL (${resource!.scheme}://${resource!.pathname})`, null), { executors: fixtureExecutors(PlurnkParser.frame(`KILL (${resource!.scheme}://${resource!.pathname})`, null)) }).items[0];
            if (parsed?.kind !== "statement") throw new Error("Expected KILL");
            const [killed] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parsed.statement] });
            assert.equal(killed.status, 200, JSON.stringify(killed));
            await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 200);
            assert.equal(mock.received.length, 2, "a 499 stream result is a completion, not a cancelled session scope");
            // {§notifications-log-entry-notify} The loop's rows reach the log channel before its terminal is announced.
            await waitFor(() => terminated() as Array<{ loopId: number }>, (events) => events.some(({ loopId }) => loopId === accepted.loopId));
            const reads = (entries() as Array<{ entry: { loop_id: number; op: string; scheme: string; origin: string; status_rx: number } }>)
                .map(({ entry }) => entry)
                .filter((entry) => entry.loop_id === accepted.loopId && entry.op === "READ" && entry.scheme === "sh");
            assert.deepEqual(reads.map(({ origin, status_rx }) => ({ origin, status_rx })), [{ origin: "_plurnk", status_rx: 499 }],
                "the terminal stream READ reaches the live log channel once, before the loop concludes");
        } finally {
            ws.close();
            await daemon.cancelSession({ workspaceId, sessionId });
        }
    });
});

test("{§notifications-stream-concluded}: a pending completion wake is not reported as an executed resume", async (t) => {
    serverProposals(t, "accept");
    const parked = Promise.withResolvers<void>();
    const ensureDrain = DrainSupervisor.prototype.ensureDrain;
    t.mock.method(DrainSupervisor.prototype, "ensureDrain", async function (
        this: DrainSupervisor, ...args: Parameters<typeof ensureDrain>
    ) {
        const started = await ensureDrain.apply(this, args);
        void started?.drainPromise.then(() => parked.resolve(), parked.reject);
        return started;
    });
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const settle = DrainSupervisor.prototype.settleCompletionWake;
    t.mock.method(DrainSupervisor.prototype, "settleCompletionWake", async function (
        this: DrainSupervisor, ...args: Parameters<typeof settle>
    ) {
        await release.promise;
        try { await settle.apply(this, args); }
        finally { settled.resolve(); }
    });
    const provider = new Mock({ contextWindow: 65536, responses: [
        mockResponse("````sh\nsleep 30\n````\n````WAIT\nWait for the command.\n````"),
        mockResponse("````SEND [200]\nA cancelled task must not reach this turn.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        const conclusions = subscribeNotifications(ws, "stream/concluded");
        const { workspaceId } = await daemon.createWorkspace({ name: "pending-wake-publication" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const lifecycle = new LoopLifecycle(db);
        try {
            const attached = await rpcCall(ws, 1, "workspace.attach", { workspaceId });
            assert.equal((attached.result as { id: number }).id, workspaceId);
            const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Await the command." });
            await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
            // The database transition precedes drain teardown. Exercise a settled
            // park, not a completion racing the still-active drain.
            await parked.promise;
            const subscriptions = await db.find_open_subscriptions_for_session.all<{ id: number }>({ session_id: sessionId });
            assert.equal(subscriptions.length, 1);
            await daemon.engine.cancelSubscription(subscriptions[0].id);
            const events = await waitFor(() => conclusions() as Array<{ wakeAction: string }>, (values) => values.length > 0);
            assert.equal(events[0]?.wakeAction, "wake-pending", "stream completion is published before wake eligibility settles");
            assert.deepEqual(Object.keys(events[0]).toSorted(), ["entryId", "loop_seq", "result", "scheme", "sequence", "sessionId", "subscriptionId", "summary", "target", "turn_seq", "wakeAction", "workspaceId"], "the conclusion names its stream and coordinates, never a future recipient");
            assert.equal(await lifecycle.status(accepted.loopId), 202, "publication cannot claim execution while the task is parked");
            await daemon.cancelSession({ workspaceId, sessionId });
            release.resolve();
            await settled.promise;
            assert.equal(await lifecycle.status(accepted.loopId), 499, "cancellation won before settlement");
            assert.equal(provider.received.length, 1, "the pending event never resurrects cancelled work");
        } finally {
            await daemon.cancelSession({ workspaceId, sessionId });
            release.resolve();
            ws.close();
        }
    });
});

test("{§methods-loop-run-model}: an async wake resumes with the loop's durable provider", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const releaseDir = await mkdtemp(join(tmpdir(), "plurnk-wake-provider-"));
    const releasePath = join(releaseDir, "release");
    const boot = new Mock({
        contextWindow: 16384,
        responses: [mockResponse("````SEND [200]\nboot provider must never run this loop\n````")],
    });
    const selected = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl(`while [ ! -f '${releasePath}' ]; do sleep 0.05; done; echo selected`)),
            mockResponse("````SEND [200]\nresumed on selected provider\n````"),
        ],
    });
    const selectedSpec = { alias: "wakeb", provider: "openai", model: "wake-provider-b" } as const;
    const prior = process.env.PLURNK_MODEL_wakeb;
    process.env.PLURNK_MODEL_wakeb = "openai/wake-provider-b";
    ProviderInstantiate.registerInstance(selected, selectedSpec);

    try {
        await withDaemon(boot, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-provider-identity" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const started = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run on B, park, then resume on B",
                    selector: "wakeb",

                });
                const loopId = (started.result as { loopId: number }).loopId;

                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                    (status) => status === 202,
                );

                // A repeated client call naming a DIFFERENT provider must not mutate a
                // parked loop. Mid-loop hot-swap is not an implicit side effect of prompt
                // injection; the caller must conclude/cancel and open a new loop.
                const before = await db.test_sessions_with_model.all({});
                const conflict = await rpcCall(ws, 3, "loop.run", {
                    prompt: "silently change this parked loop to the boot model",
                    selector: "mocktest",

                });
                const problem = rpcProblem(conflict);
                assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/session-loop-active");
                assert.equal(problem.selectedAlias, "wakeb");
                assert.equal(problem.requestedAlias, "mocktest");
                assert.match(problem.recovery ?? "", /Conclude or cancel/);
                assert.deepEqual(await db.test_sessions_with_model.all({}), before, "a rejected prompt selector cannot rewrite session settings");

                await writeFile(releasePath, "");
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some((event) => event.loopId === loopId && event.result.status === 200),
                    { timeoutMs: 6000 },
                );
                assert.equal(selected.remaining, 0, "provider B generated both the initial and resumed turns");
                assert.equal(boot.remaining, 1, "boot-default provider A was never called");
            } finally { ws.close(); }
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_MODEL_wakeb;
        else process.env.PLURNK_MODEL_wakeb = prior;
        await rm(releaseDir, { recursive: true });
    }
});

test("{§methods-loop-run-model}: a selector-less continuation resumes the loop's durable provider, never the boot default", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const releaseDir = await mkdtemp(join(tmpdir(), "plurnk-wake-default-"));
    const releasePath = join(releaseDir, "release");
    const boot = new Mock({
        contextWindow: 16384,
        responses: [mockResponse("````SEND [200]\nboot provider must never run this loop\n````")],
    });
    const selected = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl(`while [ ! -f '${releasePath}' ]; do sleep 0.05; done; echo selected`)),
            mockResponse("````NOTE\nawaiting the exec before concluding\n````"),
            mockResponse("````SEND [200]\nresumed on selected provider\n````"),
        ],
    });
    const selectedSpec = { alias: "wakedefault", provider: "openai", model: "wake-provider-b" } as const;
    const prior = process.env.PLURNK_MODEL_wakedefault;
    process.env.PLURNK_MODEL_wakedefault = "openai/wake-provider-b";
    ProviderInstantiate.registerInstance(selected, selectedSpec);

    try {
        await withDaemon(boot, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-default-identity" });
                const started = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run on B, park, then resume on B without a selector",
                    selector: "wakedefault",

                });
                const loopId = (started.result as { loopId: number }).loopId;

                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                    (status) => status === 202,
                );

                // THE DEFECT: a selector-less continuation re-resolves to the boot default and
                // collides with the loop's durable provider (a false 409). It must resume on B.
                const resumed = await rpcCall(ws, 3, "loop.run", {
                    prompt: "resume the parked loop without naming a model",

                });
                const resumedResult = resumed.result as { problem?: { type?: string }; action?: string } | undefined;
                assert.equal(resumedResult?.problem, undefined, "selector-less continuation must not conflict");
                assert.equal(resumedResult?.action, "injected_next_turn", "the parked loop resumes in place");
            } finally { ws.close(); }
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_MODEL_wakedefault;
        else process.env.PLURNK_MODEL_wakedefault = prior;
        await rm(releaseDir, { recursive: true });
    }
});

test("{§methods-loop-run-model}: a parked loop retains its provider across daemon restart", async (t) => {
    serverProposals(t, "accept");
    const boot = new Mock({
        contextWindow: 16384,
        responses: [mockResponse("````SEND [200]\nboot provider must remain unused\n````")],
    });
    const selected = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("sleep 30")),
            mockResponse("````SEND [200]\nresumed after restart on selected provider\n````"),
        ],
    });
    const selectedSpec = { alias: "restartb", provider: "openai", model: "restart-provider-b" } as const;
    const prior = process.env.PLURNK_MODEL_restartb;
    process.env.PLURNK_MODEL_restartb = "openai/restart-provider-b";
    ProviderInstantiate.registerInstance(selected, selectedSpec);

    const db = await openMigrated();
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const schedule = DrainSupervisor.prototype.scheduleWakes;
    let stopping: Promise<void> | undefined;
    let held = false;
    t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (
        this: DrainSupervisor, ...args: Parameters<typeof schedule>
    ) {
        if (!held && (await new LoopLifecycle(db).parked(args[1])).length > 0) {
            held = true;
            parked.resolve();
            await release.promise;
        }
        return schedule.apply(this, args);
    });
    let first: Daemon | undefined;
    let second: Daemon | undefined;
    try {
        first = new Daemon({ db, provider: boot });
        await first.start();
        const envelope = await first.createWorkspace({ name: "exec-wake-provider-restart", projectRoot: null });
        const sessionId = await namedModelSession(first, envelope.workspaceId, "main");
        const started = await first.runLoop({
            workspaceId: envelope.workspaceId,
            sessionId,
            prompt: "park on B before restart",
            selector: "restartb",

        });
        await parked.promise;
        stopping = first.stop();
        await waitForDb(
            () => db.test_latest_subscription_for_session.get<{ close_status: number }>({ session_id: sessionId }),
            (subscription) => subscription?.close_status === 499,
        );
        release.resolve();
        await stopping;
        first = undefined;
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: started.loopId }))?.status,
            202,
            "graceful daemon shutdown preserves parked work for recovery instead of cancelling it",
        );

        second = new Daemon({ db, provider: boot });
        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        second.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        await second.start();
        await waitFor(
            () => terminated,
            (events) => events.some((event) => event.loopId === started.loopId && event.result.status === 200),
            { timeoutMs: 6000 },
        );
        const loops = await db.test_loop_queue_by_session.all<{ id: number; prompt: string }>({ session_id: sessionId });
        assert.deepEqual(
            loops.filter(({ prompt }) => prompt !== "").map(({ id }) => id),
            [started.loopId],
            "boot resumes the same durable loop without minting a prompt or loop",
        );
        assert.equal(selected.remaining, 0, "B generated before and after daemon restart");
        assert.equal(boot.remaining, 1, "restart never substituted boot-default A");
    } finally {
        release.resolve();
        await stopping;
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
        if (prior === undefined) delete process.env.PLURNK_MODEL_restartb;
        else process.env.PLURNK_MODEL_restartb = prior;
    }
});

test("{§session-wait-timing} wake-on-completion: a slept (202) loop resumes IN PLACE — no new loop, no summary-as-prompt", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // First loop: execution echo + WAIT — the loop SLEEPS while the
    // spawn runs on. When the spawn concludes (a stream-status transition to terminal,
    // {§actor-boundary}), the daemon AWAKENS that same loop in place —
    // never a fresh loop with a synthetic summary prompt. The resumed loop reads
    // the concluded stream's own state and finishes on its own.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("sleep 0.05; echo hi")),
            mockResponse("````SEND [200]\nsaw the wake\n````"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-dormant" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");

            // loop.run ACCEPTS and returns immediately (100 + loopId) — it never blocks on
            // the loop's lifecycle. A parked loop awaits an external event (here the spawn's
            // conclusion; in general a user reply), so loop.run cannot resolve on it without
            // deadlocking the very client that must send that event. Park, resume, and the
            // true terminal all arrive via events. {§session-causal-admission}.
            const firstSession = await rpcCall(ws, 2, "loop.run", { prompt: "kick off exec then park" });
            const parkedLoop = (firstSession.result as { loopId: number }).loopId;
            assert.equal((firstSession.result as { status: number }).status, 100, "loop.run returns immediately (100 accepted) — never a fake 200/202 standing in for the loop's real outcome");

            // echo hi is fast; the conclusion fires after the loop sleeps; the daemon
            // RESUMES the same loop; that resumed turn terminates it. Event-driven —
            // wait for the resume to land AND the loop to terminate. Hard-fails on a
            // timeout if the slept loop is ever stranded (the lost-loop hang), instead
            // of a fixed sleep that hides it under load.
            await waitFor(
                () => terminatedEvents() as Array<{ loopId: number; result: { status: number } }>,
                (ts) => {
                    const wake = (concludedEvents() as Array<{ scheme: string }>).find((c) => c.scheme === "sh");
                    return wake !== undefined && ts.some((t) => t.loopId === parkedLoop && t.result.status === 200);
                },
                { timeoutMs: 6000 },
            );

            const concluded = concludedEvents() as Array<{
                scheme: string; target: string; result: { status: number; problem?: { type: string } }; summary: string;
                wakeAction: string;
                loop_seq?: number; turn_seq?: number; sequence?: number;
            }>;
            assert.ok(concluded.length >= 1, `expected >=1 stream/concluded event, got ${concluded.length}`);
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.result.status, 200);
            assert.match(wake.target, /^sh:\/\/\//, "stream/concluded carries the canonical target URI");
            assert.match(wake.summary, /^sh:\/\/\/[a-f0-9]{8} completed \(exit 0\)/,
                "summary references the workspace-stable stream address");
            assert.equal(wake.wakeAction, "wake-pending", "the conclusion reports scheduling, not execution");
            assert.deepEqual(Object.keys(wake).toSorted(), ["entryId", "loop_seq", "result", "scheme", "sequence", "sessionId", "subscriptionId", "summary", "target", "turn_seq", "wakeAction", "workspaceId"]);

            assert.deepEqual([wake.loop_seq, wake.turn_seq, wake.sequence], [1, 2, 3],
                "stream/concluded carries causal coordinates independently of its output URI");

            // The loop's TRUE outcome arrives via loop/terminated — the resumed loop ends 200,
            // never through loop.session's (already-returned) result.
            const terminated = terminatedEvents() as Array<{ loopId: number; result: { status: number } }>;
            assert.ok(terminated.some((t) => t.loopId === parkedLoop && t.result.status === 200),
                "the resumed loop's 200 terminal arrives via events, not loop.session's return");
        } finally { ws.close(); }
    });
});

test("{§session-wait-timing} wake-on-completion preserves the durable loop's cumulative maxTurns ceiling", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("sleep 0.05; echo ceiling")),
            mockResponse("````SEND [200]\nmust not receive a second model turn\n````"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-max-turns" });
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");
            const accepted = await rpcCall(ws, 2, "loop.run", {
                prompt: "run once, park, and exhaust the durable loop ceiling",

                maxTurns: 1,
            });
            const loopId = (accepted.result as { loopId: number }).loopId;

            const seen = await waitFor(
                () => terminatedEvents() as Array<{
                    loopId: number; result: { status: number }; hitMaxTurns: boolean; turnIds: number[];
                }>,
                (events) => events.some((event) => event.loopId === loopId),
                { timeoutMs: 6000 },
            );
            const terminal = seen.find((event) => event.loopId === loopId);
            assert.equal(terminal?.result.status, 429);
            assert.equal(terminal?.hitMaxTurns, true);
            assert.equal(terminal?.turnIds.length, 2, "initialization and the pre-park model turn remain in the durable chronology");
            assert.equal(mock.remaining, 1, "resume terminates before asking the provider for a second turn");
        } finally {
            ws.close();
        }
    });
});

test("{§session-causal-admission} wake-on-completion: active loop → daemon does NOT open a new loop (no-op-active-loop)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Loop emits exec + an NOTE per turn — the loop
    // stays active across multiple turns. The exec finishes mid-loop;
    // wake should see active loop and skip.
    const continueResponse = mockResponse("````NOTE\nthinking\n````");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse(execDsl("echo soon", "NOTE")),
            continueResponse,
            continueResponse,
            continueResponse,
            mockResponse("````SEND [200]\ndone\n````"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-active" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            await runLoopToTerminal(ws, 2, { prompt: "stay active during exec" });
            // Event-driven: wait for the exec to conclude (it finishes while the loop is
            // still emitting in-progress inventories), not a fixed sleep racing the spawn.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 5000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.wakeAction, "no-op-active-loop",
                "wake declined to open a new loop because the original was still active");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission} wake-on-completion: streaming spawn outlives loop — wake summary reports the FULL final byte count, not what was buffered at loop-end", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // A countdown emits 5 lines over ~2.5s. The model waits — the loop SLEEPS
    // while the countdown runs on. When the countdown concludes, the loop RESUMES in
    // place, and the conclusion's summary reflects the COMPLETE stdout (10 bytes for
    // "5\n4\n3\n2\n1\n") — proving the streaming continued past the sleep and the
    // conclusion is the final state, not a partial snapshot buffered at sleep-time.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse("````sh\nfor i in 5 4 3 2 1; do echo $i; sleep 0.4; done\n````\n\n````WAIT\nfire and forget\n````"),
            // Wake-opened loop just terminates so the test completes:
            mockResponse("````SEND [200]\nsaw the wake\n````"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-streaming" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");

            const startedAt = Date.now();
            const firstResp = await rpcCall(ws, 2, "loop.run", { prompt: "stream while I leave" });
            const firstResult = firstResp.result as { loopId: number; status: number };
            const parkedLoop = firstResult.loopId;
            const firstElapsed = Date.now() - startedAt;
            assert.equal(firstResult.status, 100, "loop.run returns immediately (100 accepted); the spawn's late conclusion resumes the loop");
            // loop.run accepts immediately — it returns well before the spawn's ~2.5s.
            // The resume path handles the spawn's late conclusion, not a blocking loop.run.
            assert.ok(firstElapsed < 1500,
                `loop.run returns before the spawn finishes (~2.5s); got ${firstElapsed}ms`);

            // Event-driven: wait for the ~2.5s countdown spawn to conclude (200) and its
            // wake to fire, not a fixed sleep that races a slower spawn under load.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string; result: { status: number } }>,
                (cs) => cs.some((c) => c.scheme === "sh" && c.result.status === 200),
                { timeoutMs: 8000 },
            );

            const concluded = concludedEvents() as Array<{
                scheme: string; result: { status: number }; summary: string; wakeAction: string;
            }>;
            const wake = concluded.find((c) => c.scheme === "sh" && c.result.status === 200);
            assert.ok(wake, "exec stream concluded");
            // The KEY assertion: summary has the FULL byte count, not
            // whatever happened to be in the channel when loop ended.
            assert.match(wake.summary, /stdout=10 bytes/,
                `summary should report the full final stdout=10 bytes ("5\\n4\\n3\\n2\\n1\\n"); got ${wake.summary}`);
            assert.equal(wake.wakeAction, "wake-pending");
            const terminated = await waitFor(
                () => terminatedEvents() as Array<{ loopId: number; result: { status: number } }>,
                (events) => events.some(({ loopId }) => loopId === parkedLoop),
            );
            assert.equal(terminated.find(({ loopId }) => loopId === parkedLoop)?.result.status, 200,
                "the original task's terminal event, not the stream's prediction, proves same-loop resumption");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} wake-on-completion: loop.cancel mid-spawn → daemon skips wake (skipped-aborted)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Slow exec; loop.cancel RPC fires the drain controller; spawn aborts
    // with result.status=499; daemon's handler skips opening a wake loop.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse("````sh\nsleep 30\n````\n\n````NOTE\nrunning\n````"),
            mockResponse("````SEND [200]\nnever\n````"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "exec-wake-cancelled" });
            const workspaceId = (created.result as { id: number }).id;
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "cancel mid-stream" });
            // Cancel must land on a LIVE exec (sleep 30 mid-run) — wait for its subscription
            // to open, not a fixed sleep racing the spawn.
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            // Event-driven: wait for the exec's 499 conclusion to broadcast.
            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 5000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; result: { status: number; problem?: { type: string } }; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.result.status, 499);
            assert.equal(wake.result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/cancelled");
            assert.equal(wake.wakeAction, "skipped-aborted",
                "deliberate cancellations don't resurrect into a wake loop");
        } finally { ws.close(); }
    });
});

test("{§executor-cancellation} loop.cancel preserves partial stdout on the 499 conclusion (chunk-capture)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // printf lands "a\nb\n" (4 bytes) immediately, then `sleep 30` runs; at
    // cancel time those bytes are already in the channel. Under
    // {§executor-cancellation}, loop.cancel process-group-kills the job; the 499
    // conclusion must STILL report those 4 bytes — partial output captured
    // + retained through an abort, not discarded.
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            mockResponse("````sh\nprintf 'a\\nb\\n'; sleep 30\n````\n\n````NOTE\nrunning\n````"),
            mockResponse("````SEND [200]\nnever\n````"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-cancel-partial" });
            const streamEvents = subscribeNotifications(ws, "stream/event");
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "cancel after partial output" });

            // Deterministic: cancel only AFTER the 4 bytes have actually
            // landed in the stdout channel — no fixed sleep racing printf.
            await waitFor(
                () => streamEvents() as Array<{ channel: string; contentLength: number }>,
                (evs) => evs.some((e) => e.channel === "stdout" && e.contentLength >= 4),
                { timeoutMs: 4000 },
            );

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }

            await waitFor(
                () => concludedEvents() as Array<{ scheme: string }>,
                (cs) => cs.some((c) => c.scheme === "sh"),
                { timeoutMs: 4000 },
            );

            const concluded = concludedEvents() as Array<{ scheme: string; result: { status: number; problem?: { type: string } }; summary: string }>;
            const wake = concluded.find((c) => c.scheme === "sh");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.result.status, 499, "deliberate cancel concludes at 499");
            assert.equal(wake.result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/cancelled");
            assert.match(wake.summary, /stdout=4 bytes/,
                `partial stdout ("a\\nb\\n" = 4 bytes) survives the abort; got ${wake.summary}`);
        } finally { ws.close(); }
    });
});
});

describe("Daemon.execution-budget", () => {
for (const wake of ["message", "same-drain", "restart"] as const) {
    test(`{§session-wait-timing}: ${wake} wake retains the task's remaining execution allowance`, async (t) => {
        // The wait parks on live work the fixture holds; a restart wakes it through recovery.
        const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
            else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        });
        const provider = new Mock({ contextWindow: 65536, responses: [
            makeMockResponse("````WAIT\nResume the same task later.\n````"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            let activeDaemon = daemon;
            const { workspaceId } = await daemon.createWorkspace({ name: `execution-${wake}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            await holdChild(db, workspaceId, sessionId);
            const parked = Promise.withResolvers<void>();
            const resumed = Promise.withResolvers<AbortSignal>();
            const completed = Promise.withResolvers<number>();
            const schedule = DrainSupervisor.prototype.scheduleWakes;
            const park = LoopLifecycle.prototype.park;
            const finish = LoopLifecycle.prototype.finish;
            let loopId: number | undefined;
            t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                await schedule.apply(this, args);
                if (args[1] === sessionId) parked.resolve();
            });
            if (wake === "same-drain") {
                t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
                    const result = await park.apply(this, args);
                    if (result && args[0] === loopId) {
                        assert.equal(await this.wake(args[0]), true, "the wake crosses the current driver's park boundary");
                    }
                    return result;
                });
            }
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                const result = await finish.apply(this, args);
                if (args[0] === loopId && result !== null) completed.resolve(result.status);
                return result;
            });
            const generate = provider.generate.bind(provider);
            let calls = 0;
            t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
                if (calls++ === 0) {
                    t.mock.timers.tick(40_000);
                    return generate(args);
                }
                const signal = args.signal;
                assert.ok(signal !== undefined, "the provider receives the execution cancellation scope");
                signal.throwIfAborted();
                resumed.resolve(signal);
                return await new Promise<never>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
            t.mock.method(performance, "now", () => Date.now());
            try {
                loopId = (await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait and finish this assignment." })).loopId;
                if (wake !== "same-drain") {
                    await parked.promise;
                    if (wake === "restart") {
                        await daemon.stop();
                        activeDaemon = new Daemon({ db, provider });
                        await activeDaemon.start();
                    } else {
                        t.mock.timers.tick(30_000);
                        const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "Continue now." });
                        assert.equal(delivered.loopId, loopId);
                    }
                }
                const signal = await resumed.promise;
                t.mock.timers.tick(19_999);
                assert.equal(signal.aborted, false);
                t.mock.timers.tick(1);
                assert.equal(signal.aborted, true, "one shared lifecycle owner retained the execution time before waiting");
                assert.equal(await completed.promise, 504);
                assert.equal((await new LoopLifecycle(db).result(loopId))?.problem?.type,
                    "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } finally {
                await activeDaemon.cancelSession({ workspaceId, sessionId });
                t.mock.timers.reset();
                if (activeDaemon !== daemon) await activeDaemon.stop();
            }
        });
    });
}
});

describe("Daemon.lifecycle-recovery", () => {
const providerSpec = {
    alias: "recovery",
    provider: "openai",
    model: "lifecycle-recovery",
} as const;

const enqueueLoop = async (
    db: Parameters<typeof insertSession>[0],
    sessionId: number,
    prompt: string,
): Promise<number> => {
    const row = await db.drain_enqueue_loop.get<{ id: number }>({
        session_id: sessionId,
        prompt,
        prompt_source: null,
        model_route_id: await routeForSpec(db, providerSpec),
        spawn_model_route_id: null,
        effort: "adaptive",
        max_turns: 50,
    });
    if (row === undefined) throw new Error("recovery fixture failed to enqueue loop");
    // {§message-arrival} — as the daemon's enqueue does: the assignment is ordinal 1 of the inbox.
    const seeded = await db.drain_enqueue_message.get<{ id: number }>({ loop_id: row.id, source: null, body: prompt, open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
    if (seeded === undefined) throw new Error("recovery fixture failed to seed the loop's message");
    return row.id;
};

test("{§message-arrival} boot restores a drain for accepted queued work", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nrecovered queued work\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const activations: number[] = [];
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("recovery activation fixture", {
                activate: async ({ workspaceId }) => {
                    activations.push(workspaceId);
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId,
                        namespaceOwner: "recovery activation fixture",
                        state: null,
                        runtimes: [],
                    });
                },
                deactivate: async () => undefined,
            });
        },
    }, "test-module");
    try {
        const workspaceId = await insertWorkspace(db, `recovery-queue-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "accepted before restart");

        await daemon.start();

        const status = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(status, 200);
        assert.equal(mock.remaining, 0, "the recovered queue was executed, not merely relabelled");
        assert.deepEqual(
            activations,
            [workspaceId],
            "durable queued work activates workspace Functionality without a client attachment",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-wait-timing}: restart settles an interrupted child and wakes the parent parked on it", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 65536, responses: [makeMockResponse("````SEND [200]\nThe child was interrupted.\n````")] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "recovery-completion-before-clock");
        const sessionId = await insertSession(db, workspaceId, null, "parent", "model");
        const loopId = await enqueueLoop(db, sessionId, "Observe the child's outcome.");
        const child = await insertSession(db, workspaceId, sessionId, "child", "model");
        const childLoop = await enqueueLoop(db, child, "Interrupted work.");
        for (const id of [loopId, childLoop]) await db.engine_reclaim_queued_loop.run({ loop_id: id });
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(loopId, { wakenBy: "test-fixture" });
        await daemon.start();
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200);
        assert.equal((await lifecycle.result(childLoop))?.status, 500);
        assert.equal(mock.received.length, 1, "parent observes the durable completion at boot");
        assert.equal((await lifecycle.parked(sessionId)).length, 0);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§machine-processes}: boot rejects queued provider work owned by a non-model actor", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nmust remain unused\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-runtime-queue-${crypto.randomUUID()}`);
        const runtimeSessionId = await RuntimeSession.ensure(db, workspaceId);
        await enqueueLoop(db, runtimeSessionId, "illegal queued inference");

        await assert.rejects(
            () => daemon.start(),
            /Queued provider work belongs to _plurnk session .* only model sessions may enter inference/,
        );
        assert.equal(mock.remaining, 1, "recovery fails before acquiring a provider for an invalid actor");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§message-arrival} boot settles a crash-open physical request as unknown and closes its emission attempt", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-unscoped-accounting-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "interrupted unscoped provider call");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const turnId = turn.id;
        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            kind: "emission",
            attributions: "[]",
            model: mock.model,
        });
        assert.ok(modelCall !== undefined);
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            model_call_id: modelCall.id,
        });
        assert.ok(attempt !== undefined);
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            inference_call_id: modelCall.id,
            sequence: 1,
            provider: "provider:mock",
            model: mock.model,
        });
        assert.ok(request !== undefined);

        await daemon.start();

        const requests = await db.test_provider_requests.all<{
            state: string;
            outcome: string;
            cost_kind: string;
            cost_reason: string;
        }>({ turn_id: turnId });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.state, "settled");
        assert.equal(requests[0]?.outcome, "error");
        assert.equal(requests[0]?.cost_kind, "unknown");
        assert.match(requests[0]?.cost_reason ?? "", /restarted before provider request evidence/);
        const calls = await db.test_model_calls.all<{ state: string; failure: string | null }>({ turn_id: turnId });
        assert.equal(calls[0]?.state, "error");
        assert.match(calls[0]?.failure ?? "", /owner-vanished/);
        const recoveredTurn = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turnId });
        assert.equal(recoveredTurn?.status, 500);
        assert.ok(recoveredTurn?.completed_at !== null, "the vanished producer's turn is completed");
        const usage = await daemon.engine.loopUsage(loopId);
        assert.equal(usage.accounting.costUsd, null);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-causal-admission}: failed database settlement rolls back before any work resumes", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "recovery-atomic-settlement");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await enqueueLoop(db, sessionId, "Interrupted work.");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.test_refuse_recovery_turn_settlement({});

        await assert.rejects(() => daemon.start(), /recovery settlement fixture/);

        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102,
            "a later settlement failure rolls back the loop's earlier owner-loss transition");
        assert.equal((await db.test_get_turn.get<{ completed_at: string | null }>({ id: turn.id }))?.completed_at, null);
        assert.equal(mock.received.length, 0, "failed settlement starts no inference");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const pending of [false, true]) {
    test(`{§session-causal-admission} {§loop-completion}: database recovery respects pending messages (${pending})`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `recovery-message-${pending}`);
            const sender = await insertSession(db, workspaceId, null, "sender");
            const receiver = await insertSession(db, workspaceId, null, "receiver");
            const senderLoop = await enqueueLoop(db, sender, "Wait for a reply.");
            const receiverLoop = await enqueueLoop(db, receiver, "Other work.");
            await db.engine_reclaim_queued_loop.run({ loop_id: senderLoop });
            const turn = await Turn.open(db, { loopId: senderLoop, producer: "model", kind: "inference" });
            if (pending) {
                await db.drain_enqueue_message.get({
                    loop_id: receiverLoop, source: "session://sender", body: "A question.",
                    open_paths: "[]", evidence: "{}", address: null,
                    opened_turn_id: turn.id, opened_sequence: 1,
                });
            }
            assert.equal(await new LoopLifecycle(db).park(senderLoop, { wakenBy: "test-fixture" }), true);
            for (let attempt = 0; attempt < 2; attempt++) {
                await db.recovery_settle_process_owners({});
                assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: senderLoop }))?.status,
                    pending ? 202 : 100, "only an empty obligation set requeues without a completion");
            }
        } finally { await db.close(); }
    });
}

test("{§message-loop-containment} boot closes an open operation turn even when its loop already parked", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-parked-turn-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "parked after its operation committed");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        assert.equal(await new LoopLifecycle(db).park(loopId, { wakenBy: "test-fixture" }), true);

        await daemon.start();

        const recovered = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
        assert.equal(recovered?.status, 500);
        assert.ok(recovered?.completed_at !== null, "boot leaves no open producer corpse");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const staged of ["loop", "messages"] as const) {
    test(`{§message-loop-containment}: boot completes recovery with ${staged} staged without replay`, async () => {
        const db = await openMigrated();
        const firstProvider = new Mock({
            contextWindow: 16384,
            responses: [makeMockResponse("````SEND [200]\nFirst orphan recovered.\n````\n\n````SEND [200]\nSecond orphan recovered.\n````")],
        });
        ProviderInstantiate.registerInstance(firstProvider, providerSpec);
        const firstDaemon = new Daemon({ db, provider: firstProvider });
        let secondDaemon: Daemon | undefined;
        try {
            const workspaceId = await insertWorkspace(db, `recovery-orphans-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
            const sourceLoopId = await enqueueLoop(db, sessionId, "concluded source");
            for (const [index, content] of ["first orphan", "second orphan"].entries()) {
                const message = await db.drain_enqueue_message.get({ loop_id: sourceLoopId, source: `session://sender-${index + 1}`, body: content, open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
                assert.ok(message !== undefined, "the unfinished source admitted the message before forced termination");
            }
            await db.test_set_loop_status.run({
                id: sourceLoopId,
                status: 200,
                terminal_result: JSON.stringify({ status: 200 }),
            });

            const recovery = await db.drain_enqueue_orphan_recovery_loop.get<{
                id: number; sequence: number; message_count: number;
            }>({
                session_id: sessionId,
                orphan_source_loop_id: sourceLoopId,
            });
            assert.ok(recovery !== undefined);
            assert.equal(recovery.sequence, 2);
            if (staged === "messages") {
                const moved = await db.drain_rehome_orphaned_messages.run({
                    source_loop_id: sourceLoopId,
                    target_loop_id: recovery.id,
                });
                assert.equal(moved.changes, 2, "the prior process moved both messages before disappearing");
            }

            await firstDaemon.start();
            assert.equal(await waitForDb(
                async () => (await db.test_get_loop_status.get<{ status: number }>({ id: recovery.id }))?.status,
                (status) => status === 200,
            ), 200);
            const frames = (await db.test_log_entries_by_loop.all<{
                op: string; origin: string; tx: string; source: string | null;
            }>({ loop_id: recovery.id })).filter((row) => row.op === "SEND" && row.origin === "_plurnk");
            assert.deepEqual(
                frames.map((row) => ({
                    content: (JSON.parse(row.tx) as { body: { raw: string } }).body.raw,
                    source: row.source,
                })),
                [
                    { content: "first orphan", source: "session://sender-1" },
                    { content: "second orphan", source: "session://sender-2" },
                ],
                "boot completed the existing queued recovery before its drain claimed it",
            );
            const inbox = (await db.test_messages_by_loop.all({ loop_id: recovery.id })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
            assert.deepEqual(inbox.map(({ ordinal, body }) => ({ ordinal, body })), [{ ordinal: 1, body: "first orphan" }, { ordinal: 2, body: "second orphan" }], "the orphans moved into the recovery loop's inbox, renumbered");
            assert.ok(inbox.every(({ log_entry_id }) => log_entry_id !== null), "the recovery loop published them once");
            await firstDaemon.stop();

            const secondProvider = new Mock({
                contextWindow: 16384,
                responses: [makeMockResponse("````SEND [200]\nmust remain unused\n````")],
            });
            ProviderInstantiate.registerInstance(secondProvider, providerSpec);
            secondDaemon = new Daemon({ db, provider: secondProvider });
            await secondDaemon.start();
            const modelLoops = (await db.application_list_session_loops.all<{ prompt: string }>({
                session_id: sessionId,
            })).filter(({ prompt }) => prompt.length > 0);
            assert.equal(modelLoops.length, 2, "a later boot neither remints nor replays the completed recovery");
            assert.equal(secondProvider.remaining, 1, "no provider call was replayed");
        } finally {
            await secondDaemon?.stop();
            await firstDaemon.stop();
            await db.close();
        }
    });
}

test("{§session-causal-admission}: cancelled undelivered messages stay cancelled across restart", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 65536, responses: [makeMockResponse("````SEND [200]\nMust not execute.\n````")] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "cancelled-prompt-recovery");
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "Original task.");
        await db.drain_enqueue_message.get({ loop_id: loopId, source: null, body: "A follow-up admitted before cancellation.", open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.cancelTree(sessionId, "Cancel the whole assignment.", true);
        await daemon.start();
        assert.equal(await lifecycle.status(loopId), 499);
        assert.equal((await db.test_loop_queue_by_session.all({ session_id: sessionId })).length, 1,
            "boot must not promote a cancelled prompt into fresh work");
        assert.equal(mock.received.length, 0);
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
        assert.deepEqual(inbox.filter(({ ordinal }) => ordinal > 1).map(({ body }) => body), ["A follow-up admitted before cancellation."],
            "cancellation preserves the message as evidence without executing it");
        assert.ok(inbox.every(({ log_entry_id }) => log_entry_id === null), "nothing was published");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const accepted of [false, true]) test(`{§proposal}: boot terminalizes interrupted ${accepted ? "accepted" : "undecided"} proposals without replay`, async () => {
    const db = await openMigrated();
    const first = new Daemon({ db, provider: null });
    const second = new Daemon({ db, provider: null });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-proposal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "interrupted proposal");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 1,
            origin: "model",
            source: null,
            model_call_id: null,
            op: "EDIT",
            scheme: "workspace",
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: "/interrupted",
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ op: "EDIT" }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 202, body: "review material" }),
            mimetype_rx: "application/json",
            status_rx: 202,
            weight: 0,
            state: "proposed",
            outcome: null,
            attrs: "{}",
        });
        assert.ok(inserted !== undefined);
        if (accepted) await db.proposal_record_decision.run({
            log_entry_id: inserted.id, decision: "accept", resolver: "_plurnk", body: "approved replacement", outcome: null,
        });

        await first.start();

        const recovered = await db.test_get_log_entry_by_id.get<{
            state: string;
            status_rx: number;
            outcome: string | null;
            rx: string;
        }>({ id: inserted.id });
        assert.equal(recovered?.state, "failed");
        assert.equal(recovered?.status_rx, 500);
        assert.equal(recovered?.outcome, "owner_vanished");
        const result = JSON.parse(recovered?.rx ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string; instance?: string };
        } | null;
        assert.equal(result?.status, 500);
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished");
        assert.equal(result?.problem?.status, 500);
        assert.match(result?.problem?.detail ?? "", accepted
            ? /after approval.*whether the effect completed is unknown.*not replayed/
            : /proposal.*process-local owner no longer exists/);
        const decision = await db.test_proposal_decision.get({ id: inserted.id });
        if (accepted) {
            assert.equal(decision?.decision, "accept");
            assert.equal(decision?.body, "approved replacement");
        } else assert.equal(decision, undefined, "restart never invents an approval decision");
        assert.equal(result?.problem?.instance, "log:///1/1/1/EDIT");
        const loop = await db.lifecycle_loop_status.get<{
            status: number;
            terminal_result: string | null;
        }>({ loop_id: loopId });
        assert.equal(loop?.status, 500);
        const loopResult = JSON.parse(loop?.terminal_result ?? "null") as {
            status?: number;
            problem?: { type?: string };
        } | null;
        assert.equal(loopResult?.status, 500);
        assert.equal(loopResult?.problem?.type, result?.problem?.type, "the loop and its interrupted operation share one owner-loss disposition");
        assert.deepEqual(await first.pendingProposals(workspaceId), []);
        const rendered = await db.engine_render_log.all<{ sequence: number; op: string; state: string; status_rx: number }>({ session_id: sessionId });
        assert.ok(
            rendered.some((row) => row.sequence === 1 && row.op === "EDIT" && row.state === "failed" && row.status_rx === 500),
            "the reconciled operation is visible as a truthful failed occurrence",
        );

        await first.stop();
        await second.start();
        const recoveredAgain = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null; rx: string }>({ id: inserted.id });
        assert.deepEqual(recoveredAgain, recovered, "a later boot leaves the terminal occurrence unchanged");
        assert.deepEqual(await db.test_proposal_decision.get({ id: inserted.id }), decision);
    } finally {
        await Promise.allSettled([first.stop(), second.stop()]);
        await db.close();
    }
});

test("{§message-arrival} boot settles vanished owners and resumes the now-unblocked parent topology", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nparent observed the interrupted child\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-topology-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "parent", "model");
        const childId = await insertSession(db, workspaceId, parentId, "child", "model");
        const parentLoopId = await enqueueLoop(db, parentId, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, { wakenBy: "test-fixture" }), true);
        const childLoopId = await enqueueLoop(db, childId, "interrupted child");
        await db.engine_reclaim_queued_loop.run({ loop_id: childLoopId });

        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "sh",
            pathname: "/interrupted",
            channel: "stdout",
            state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId: childId,
            entryId,
            scheme: "sh",
            handle: "lost process",
        });

        await daemon.start();

        const child = await waitForDb(
            () => db.test_list_loops_all.all<{
                id: number;
                status: number;
                terminal_result: string | null;
            }>({}).then((rows) => rows.find((row) => row.id === childLoopId)),
            (row) => row?.status === 500,
        );
        const childResult = JSON.parse(child?.terminal_result ?? "null") as {
            problem?: { detail?: string };
        } | null;
        assert.match(childResult?.problem?.detail ?? "", /daemon restarted/);

        const subscription = await db.test_get_subscription.get<{
            close_status: number | null;
            close_result: string | null;
        }>({ id: subscriptionId });
        assert.equal(subscription?.close_status, 500);
        const result = JSON.parse(subscription?.close_result ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string };
        } | null;
        assert.equal(result?.status, 500);
        assert.equal(result?.problem?.status, 500);
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished");
        assert.match(result?.problem?.detail ?? "", /process-local owner no longer exists/);
        const channel = await db.test_get_channel.get<{ state: string }>({
            entry_id: entryId,
            name: "stdout",
        });
        assert.equal(channel?.state, "errored");

        const parentStatus = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(parentStatus, 200, "the settled child propagated a wake through the parent edge");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§message-arrival} a child drain exception still propagates the parent wake edge", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nparent handled child failure\n````")],
    });
    const generate = mock.generate.bind(mock);
    let calls = 0;
    let childProviderIdentity = "";
    mock.generate = async (request) => {
        calls += 1;
        if (request.sessionId === childProviderIdentity) throw new Error("child provider failed");
        return generate(request);
    };
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const realError = console.error;
    console.error = () => {};
    try {
        const workspaceId = await insertWorkspace(db, `recovery-child-error-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "parent", "model");
        const childId = await insertSession(db, workspaceId, parentId, "child", "model");
        childProviderIdentity = (await db.test_sessions_get_provider_identity.get<{
            provider_identity: string;
        }>({ id: childId }))?.provider_identity ?? "";
        assert.notEqual(childProviderIdentity, "", "the fixture addresses the failed child by its provider identity");
        const parentLoopId = await enqueueLoop(db, parentId, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, { wakenBy: "test-fixture" }), true);
        const childLoopId = await enqueueLoop(db, childId, "fail while running");

        await daemon.start();

        const parentStatus = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(parentStatus, 200);
        const childStatus = await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId });
        assert.equal(childStatus?.status, 500);
        assert.equal(calls, 2, "the failed child terminal woke exactly one parent continuation");
    } finally {
        console.error = realError;
        await daemon.stop();
        await db.close();
    }
});
});

describe("Daemon.loop-address", () => {
test("{§session-wait-timing}: explicit delivery wakes its addressed parked Loop, not the oldest", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: Array.from({ length: 3 }, () => makeMockResponse("````WAIT\n````")) });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        const common = { workspaceId, sessionId, providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            effort: "adaptive" as const, systemPrompt: "test system" };
        const [first, second] = await admitTogether(t, sessionId, [
            () => daemon.inject({ ...common, prompt: "first" }), () => daemon.inject({ ...common, prompt: "second" }),
        ]);
        try {
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202));
            const accepted = await daemon.runLoop({ workspaceId, sessionId, loopId: second.loopId, prompt: "addressed arrival" });
            assert.equal(accepted.loopId, second.loopId);
            assert.equal(accepted.action, "injected_next_turn");
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (loops) => provider.received.length === 3 && loops.every(({ status }) => status === 202));
            assert.equal((await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === first.loopId)?.status, 202);
            const messages = await daemon.readMessages({ workspaceId, sessionId, loopId: second.loopId });
            assert.ok(messages.some(({ body }) => body === "addressed arrival"));
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});

test("{§session-wait-timing}: terminal, foreign and missing recipients create no replacement work", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("finished"), makeMockResponse("````WAIT\n````")] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "loop-address-refusal" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const other = await daemon.createSession({ workspaceId });
        const terminal = await daemon.runLoop({ workspaceId, sessionId, prompt: "finish" });
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }), (loops) => loops[0]?.status === 200);
        await holdChild(db, workspaceId, other.sessionId);
        const foreign = await daemon.runLoop({ workspaceId, sessionId: other.sessionId, prompt: "wait" });
        await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId: other.sessionId }), (loops) => loops[0]?.status === 202);
        const before = await daemon.listSessionLoops({ workspaceId, sessionId });
        for (const loopId of [terminal.loopId, foreign.loopId, 999_999]) {
            await assert.rejects(daemon.runLoop({ workspaceId, sessionId, loopId, prompt: "must not be admitted" }),
                (error: unknown) => error instanceof OperationFailureError && error.result.status === 409
                    && error.result.problem.type === "https://problems.plurnk.xyz/daemon/admission/loop-not-open");
        }
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId }), before);
        assert.equal(provider.received.length, 2);
        assert.equal((await daemon.readMessages({ workspaceId, sessionId })).some(({ body }) => body === "must not be admitted"), false);
    });
});
});

describe("Daemon.stop-pending-proposal", () => {
// {§session-causal-admission}: shutdown cancels a pending stopped-world proposal
// before awaiting its drain.





test("{§session-causal-admission}: Daemon.stop terminates with a pending proposal", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // A non-auto host execution proposes (202) and stops the world; nobody ever resolves it.
        makeMockResponse("\n````sh\necho pending\n````\n\n````NOTE\nproposed\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stop-pending" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            // Leave the proposal UNRESOLVED — withDaemon's finally now runs daemon.stop against a
            // stopped world. The assertion IS this test completing: a deadlocked stop times out.
        } finally { ws.close(); }
    });
    assert.ok(true, "stop returned with a pending proposal outstanding");
});
});

describe("Daemon.wait-obligations", () => {
// {§session-wait-timing} — parked loops of one session keep their identity under arrivals and
// cancellation; the waits park on live work the fixture holds.









test("{§session-wait-timing}: a message's reported and actual receiving loop agree with several parked loops", async (t) => {
    // The waits park on live work the fixture holds; the message is what wakes one of them.
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("````WAIT\nFirst task waits.\n````"),
            makeMockResponse("````WAIT\nSecond task waits.\n````"),
            makeMockResponse("````NOTE\nThe new message reached the receiving task.\n````\n````WAIT\n````"),
        ],
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "two-parked-recipients" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        try {
            const common = {
                workspaceId, sessionId,
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                effort: "adaptive" as const, systemPrompt: "test system",
            };
            const accepted = await admitTogether(t, sessionId, [
                () => daemon.inject({ ...common, prompt: "First task." }),
                () => daemon.inject({ ...common, prompt: "Second task." }),
            ]);
            const ids = new Set(accepted.map(({ loopId }) => loopId));
            await waitForDb(
                async () => (await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: sessionId }))
                    .filter(({ id }) => ids.has(id)),
                (loops) => loops.length === 2 && loops.every(({ status }) => status === 202),
            );
            const delivered = await daemon.runLoop({ workspaceId, sessionId, prompt: "A new message." });
            assert.equal(delivered.loopId, accepted[0]?.loopId, "return and wake the same oldest unfinished loop that owns the message");
            await waitForDb(() => db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: delivered.loopId }),
                (rows) => rows.some(({ op, tx }) => op === "NOTE" && tx.includes("new message reached")));
            assert.equal(provider.received.length, 3);
            assert.ok(JSON.stringify(provider.received[2]).includes("A new message."));
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: accepted[1].loopId }))?.status, 202,
                "a message does not resume an unrelated wait");
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});

test("{§session-causal-admission}: a concurrent cancellation leaves no runnable orphan message", async (t) => {
    const provider = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse("````WAIT\nWait.\n````"),
        makeMockResponse("````SEND [200]\nMust not execute the cancelled follow-up.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-admission-race" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await holdChild(db, workspaceId, sessionId);
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Original task." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const inject = Engine.prototype.injectIntoLoop;
        t.mock.method(Engine.prototype, "injectIntoLoop", async function (this: Engine, ...args: Parameters<typeof inject>) {
            entered.resolve();
            await release.promise;
            return inject.apply(this, args);
        });
        const injection = daemon.runLoop({ workspaceId, sessionId, prompt: "Follow-up before cancellation." });
        await entered.promise;
        const cancellation = daemon.cancelSession({ workspaceId, sessionId });
        try {
            await lifecycle.status(accepted.loopId);
            release.resolve();
            await Promise.all([injection, cancellation]);
            assert.equal(await lifecycle.status(accepted.loopId), 499);
            const loops = await db.test_loop_queue_by_session.all<{ prompt: string; status: number }>({ session_id: sessionId });
            assert.equal(loops.some(({ prompt, status }) => prompt === "Follow-up before cancellation." && status < 200), false,
                "a concurrent cancel cannot strand a fresh follow-up outside its scope");
            assert.equal(provider.received.length, 1, "the cancelled message was not dispatched");
        } finally {
            release.resolve();
            await daemon.cancelSession({ workspaceId, sessionId });
        }
    });
});
});

describe("cancel-provenance", () => {
// {§loop-completion}, {§methods-loop-cancel}: external cancellation is durable and explicit.









type LoopRow = { id: number; status: number; terminal_result: string | null; terminated_by: string | null };

const terminalResult = (row: LoopRow): {
    status: number;
    problem?: { detail?: string; reason?: string };
} => {
    assert.notEqual(row.terminal_result, null, "a terminal loop carries its exact result");
    return JSON.parse(row.terminal_result!) as {
        status: number;
        problem?: { detail?: string; reason?: string };
    };
};

test("{§turn-record}: cancellation during packet preparation completes the turn without inventing a provider failure", async (t) => {
    serverProposals(t, "accept");
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const build = PacketBuilder.prototype.buildRequestPacket;
    t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, ...args: Parameters<typeof build>) {
        // The initialization turn builds packets too ({§context-fit}); the witness holds the inference turn's.
        if (args[0].currentTurnSeq > 1) {
            preparing.resolve();
            await release.promise;
        }
        return build.apply(this, args);
    });
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````")] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cancel-preparation" });
            const running = rpcCall(ws, 2, "loop.run", { prompt: "prepare a packet" });
            await preparing.promise;
            const cancelled = rpcCall(ws, 3, "loop.cancel", { reason: "cancel during preparation" });
            const loop = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find(({ status }) => status === 499),
                (row) => row !== undefined,
            );
            release.resolve();
            await cancelled;
            await running;
            const turns = await waitForDb(
                () => db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: loop!.id }),
                (rows) => rows.every(({ completed_at }) => completed_at !== null),
            );
            assert.equal(turns.find(({ kind }) => kind === "inference")?.status, 499);
            assert.equal(mock.received.length, 0, "cancelled preparation makes no provider request");
            assert.equal(terminalResult(loop!).problem?.reason, "cancel during preparation");
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loop!.id });
            assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: session!.session_id }), [], "cancellation does not publish a provider failure");
        } finally { release.resolve(); ws.close(); }
    });
});

test("{§loop-completion}: cancelling a live loop records who and why", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 30\n````\n\n````NOTE\nrunning\n````"),
        makeMockResponse("````SEND [200]\ndone\n````"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-live" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job" });
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "operator redirected the task" });
            // The ROW is the record: 499, provenanced, carrying the client's reason.
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 499),
                (l) => l !== undefined,
            );
            assert.equal(row!.terminated_by, "cancel", "the external act is named on the terminal record");
            assert.equal(terminalResult(row!).problem?.reason, "operator redirected the task", "the client's reason remains in the exact cancellation Problem");
            // The broadcast carries the same why.
            const notes = await waitFor(
                () => terminated() as Array<{ result: { status: number; problem?: {
                    type?: string;
                    detail?: string;
                    reason?: string;
                    stage?: string;
                    retryable?: boolean;
                } } }>,
                (ns) => ns.some((n) => n.result.status === 499),
            );
            const cancelled = notes.find((n) => n.result.status === 499);
            assert.equal(cancelled?.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
            assert.equal(cancelled?.result.problem?.detail, "The session scope was cancelled: operator redirected the task."); // {§problems-functionality}
            assert.equal(cancelled?.result.problem?.reason, "operator redirected the task");
            assert.equal(cancelled?.result.problem?.stage, "loop");
            assert.equal(cancelled?.result.problem?.retryable, false);
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: row!.id });
            assert.deepEqual(
                await db.test_error_rows_for_session.all({ session_id: session!.session_id }),
                [],
                "lifecycle cancellation never fabricates a provider failure",
            );
        } finally { ws.close(); }
    });
});

test("{§methods-loop-cancel}: cancelling a parked loop terminalizes it", async (t) => {
    serverProposals(t, "accept");
    // A session parked on a live obligation has no active drain, so cancellation
    // terminalizes the durable 202 row directly.
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 30\n````\n\n````WAIT\nawaiting the slow job\n````"),
        makeMockResponse("````SEND [200]\ndone\n````"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-parked" });
            const workspaceId = (created.result as { id: number }).id;
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job" });
            // Parked: the loop row reaches 202 (the drain has exited by then).
            const parked = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 202),
                (l) => l !== undefined,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "shutting down the request" });
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.id === parked!.id),
                (l) => l !== undefined && l.status !== 202,
            );
            assert.equal(row!.status, 499, "the parked loop went terminal — never a zombie 202");
            assert.equal(row!.terminated_by, "cancel");
            assert.equal(terminalResult(row!).problem?.reason, "shutting down the request");
            const sh = await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" });
            assert.ok(sh !== undefined, "workspace still readable"); // the reap itself is pinned elsewhere ({§notifications-stream-concluded})
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: external cancellation terminalizes the durable subtree and emits each loop's turns", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-tree" });
            const workspaceId = (created.result as { id: number }).id;
            const root = await insertSession(db, workspaceId, null, "root");
            const rootLoop = await insertLoop(db, root, 1, "root");
            const rootTurn = await insertTurn(db, rootLoop, 1, 102);
            const child = await insertSession(db, workspaceId, root, "child");
            const childLoop = await insertLoop(db, child, 1, "child");
            const childTurn = await insertTurn(db, childLoop, 1, 102);
            const grandchild = await insertSession(db, workspaceId, child, "grandchild");
            const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
            const grandchildTurn = await insertTurn(db, grandchildLoop, 1, 102);
            const terminated = subscribeNotifications(ws, "loop/terminated");

            assert.equal(daemon.cancelDrain(root, "operator cancelled the scope"), false,
                "no process-local drain was active; durable cancellation still proceeds");

            const rows = await waitForDb(
                () => db.test_list_loops_all.all<LoopRow>({}),
                (loops) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    loops.some((loop) => loop.id === id && loop.status === 499)),
            );
            for (const loopId of [rootLoop, childLoop, grandchildLoop]) {
                const row = rows.find(({ id }) => id === loopId);
                assert.ok(row);
                assert.equal(row?.terminated_by, "cancel");
                assert.equal(terminalResult(row).problem?.reason, "operator cancelled the scope");
            }

            const notes = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number }; turnIds: number[] }>,
                (events) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    events.some((event) => event.loopId === id && event.result.status === 499)),
            );
            assert.deepEqual(
                new Map(notes.map(({ loopId, turnIds }) => [loopId, turnIds])),
                new Map([
                    [rootLoop, [rootTurn]],
                    [childLoop, [childTurn]],
                    [grandchildLoop, [grandchildTurn]],
                ]),
                "each terminal event carries the turns belonging to that loop",
            );
        } finally { ws.close(); }
    });
});

for (const mode of ["immediate", "awaited"] as const) {
    test(`{§module-shutdown-order}: stop joins ${mode} cancellation before its final database read`, async (t) => {
        const collecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const mock = new Mock({ contextWindow: 16384, responses: [] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-stop-${mode}` });
            const sessionId = await insertSession(db, workspaceId, null, "cancelled");
            const loopId = await insertLoop(db, sessionId, 1, "cancel this task");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const events: Array<{ loopId: number; result: { status: number }; turnIds: number[] }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") {
                    events.push(params as typeof events[number]);
                    order.push("terminal event");
                }
            });
            const loopUsage = Engine.prototype.loopUsage;
            t.mock.method(Engine.prototype, "loopUsage", async function (this: Engine, id: number) {
                if (id === loopId) {
                    collecting.resolve();
                    await release.promise;
                    order.push("final database read");
                }
                return loopUsage.call(this, id);
            });
            const cancelSessionTree = DrainSupervisor.prototype.cancelSessionTree;
            let settlement: Promise<void> | undefined;
            t.mock.method(DrainSupervisor.prototype, "cancelSessionTree", function (this: DrainSupervisor, id: number, reason: string) {
                const result = cancelSessionTree.call(this, id, reason);
                if (id === sessionId) settlement = result;
                return result;
            });
            const cancellation = mode === "awaited"
                ? daemon.cancelSession({ workspaceId, sessionId, reason: "operator cancelled" })
                : daemon.cancelDrain(sessionId, "operator cancelled");
            if (mode === "immediate") assert.equal(cancellation, false, "no active drain does not mean no cancellation work");
            await collecting.promise;
            let stopped = false;
            const stopping = daemon.stop().then(() => { stopped = true; order.push("stopped"); });
            try {
                // A negative window: room for a stop that did not join the cancellation to finish. It can pass falsely on
                // a slow host, never fail falsely.
                await new Promise((resolve) => setTimeout(resolve, 50));
                assert.equal(stopped, false, "stop cannot authorize database closure while cancellation still uses it");
            } finally {
                release.resolve();
                await cancellation;
                await settlement;
                await stopping;
            }
            assert.deepEqual(order, ["final database read", "terminal event", "stopped"]);
            assert.deepEqual(events.map(({ loopId: id, result, turnIds }) => ({ loopId: id, status: result.status, turnIds })), [
                { loopId, status: 499, turnIds: [turnId] },
            ], "the durable cancellation is published once before shutdown completes");
        });
    });
}
});

describe("exec-kill-reap", () => {
// The teardown-reap half of the KILL wire onto @plurnk/plurnk-execs ({§session-causal-admission}).
// A background exec that IGNORES the polite signals (HUP/TERM) is endable ONLY by the bounded
// housekeeping SIGKILL — so this is the positive proof that the service hands the executor
// `{ housekeeping, graceMs }` on teardown, not a bare abort the executor can't escalate past SIGHUP.






// The reap fixture requires an already-monitored stream; settlement behavior
// is covered independently.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A host exec that arms itself against the polite signals, then sleeps. Only the housekeeping
// SIGKILL (delivered to the whole process group) can end it — a bare HUP/TERM is trapped away.
const stubbornSpawn = "````sh\ntrap '' HUP TERM; sleep 30\n````\n\n````WAIT\nparked with a stubborn spawn\n````";

test("{§session-causal-admission} teardown hard-kills a SIGHUP/SIGTERM-ignoring background spawn — the bounded housekeeping reap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const prior = process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
    process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "50";  // a fast SIGKILL grace — deterministic, far under the waitFor budget
    try {
        const mock = new Mock({ contextWindow: viableWindow(), responses: [mockTurn(stubbornSpawn)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-stubborn-reap" });
                const concluded = subscribeNotifications(ws, "stream/concluded");
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a stubborn exec then park" });
                const loopId = (run.result as { loopId: number }).loopId;

                // The loop parks (202) only AFTER its execution has spawned, so a 202 status is the
                // deterministic "the stubborn spawn is live" gate — never a fixed-sleep race.
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 202,
                    { timeoutMs: 5000 },
                );

                // Cancel fires the session-level total reap. The spawn traps HUP+TERM, so the polite
                // signal can't end it; only the housekeeping SIGKILL (after the 50ms grace) does.
                // Its 499 conclusion is the positive proof the service sent { housekeeping, graceMs }.
                const cancel = await rpcCall(ws, 3, "loop.cancel", {});
                assert.equal((cancel.result as { cancelled: boolean }).cancelled, true, "cancel saw the live spawn as work");

                await waitFor(
                    () => concluded() as Array<{ scheme: string; result: { status: number } }>,
                    (cs) => cs.some((c) => c.scheme === "sh" && c.result.status === 499),
                    { timeoutMs: 5000 },
                );
            } finally { ws.close(); }
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        else process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = prior;
    }
});
});

describe("exec-wait", () => {
// {§session-causal-admission} — an execution receives one turn-scoped opportunity
// to settle before the terminal SEND judges whether the stream needs monitoring.















let runtimeSequence = 0;

const response = (tag: string, disposition: "WAIT" | "SEND") => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [execStmt(tag, "go"), disposition === "WAIT" ? dispositionStmt("WAIT") : sendStmt(null, "The execution failed.")],
    },
});

const wire = async (run: Executor["run"]) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const executors = await testExecutors();
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    const tag = `settle${++runtimeSequence}`;
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag,
            glyph: "~",
            get manifest() {
                return {
                    name: tag,
                    channels: { results: "text/stream" },
                    defaultChannel: "results",
                    category: "data",
                    writableBy: [],
                    volatile: true,
                    modelVisible: true,
                } as never;
            },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/stream", defaultState: "active" as const } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run,
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "~",
        summary: "Settlement fixture.",
        invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
        details: "",
        available: true,
        detail: undefined,
    } as never);
    const workspaceId = await insertWorkspace(db, `settlement-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "settle the stream");
    return { db, engine, schemes, tag, workspaceId, sessionId, loopId };
};

const idle = async (schemes: SchemeRegistry): Promise<void> => {
    await (schemes.get("exec") as Exec).idle();
};

test("{§subscriptions} a failed executor close retains a callable owner for its durable obligation", { timeout: 10000 }, async (t) => {
    const completion = Promise.withResolvers<{ status: number }>();
    const fixture = await wire(() => completion.promise);
    const failure = new Error("fixture durable closure failure");
    const close = t.mock.method(ChannelWrite, "closeSubscription", async () => { throw failure; }, { times: 1 });
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId, sessionId: fixture.sessionId, loopId: fixture.loopId, messages: [],
        });
        assert.equal(result.status, 202);
        const settling = idle(fixture.schemes);
        completion.resolve({ status: 200 });
        await settling;
        assert.equal(close.mock.callCount(), 1);
        const open = await fixture.db.find_open_subscriptions_for_session.all<{ id: number }>({ session_id: fixture.sessionId });
        assert.equal(open.length, 1, "failed persistence cannot pretend the obligation has settled");
        const subscription = await fixture.db.test_get_subscription.get<{ entry_id: number }>({ id: open[0].id });
        const entry = await fixture.db.test_get_entry_by_id.get<{ pathname: string }>({ id: subscription!.entry_id });
        const logs = await fixture.db.test_log_entries_by_turn.all<{ sequence: number }>({ turn_id: result.turnId });
        const killed = await fixture.engine.dispatch({
            statement: killStmt(urlPath(fixture.tag, entry!.pathname)),
            workspaceId: fixture.workspaceId, sessionId: fixture.sessionId, loopId: fixture.loopId,
            turnId: result.turnId, sequence: Math.max(...logs.map(({ sequence }) => sequence)) + 1, origin: "model",
        });
        assert.equal(killed.status, 200, "KILL can settle the durable obligation through its retained owner");
        assert.equal((await fixture.db.find_open_subscriptions_for_session.all({ session_id: fixture.sessionId })).length, 0);
        const closed = await fixture.db.test_get_subscription.get<{ close_status: number }>({ id: open[0].id });
        assert.equal(closed?.close_status, 200, "settlement retains the producer's actual result, not a fabricated cancellation");
    } finally {
        completion.resolve({ status: 200 });
        await idle(fixture.schemes);
        await fixture.db.close();
    }
});

test("{§send-wait-scope} a decorated WAIT parks on its actual live stream; the decoration is a label, never a join", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "1";
    const completion = Promise.withResolvers<{ status: number }>();
    const fixture = await wire(() => completion.promise);
    try {
        const content = [
            PlurnkParser.frame(fixture.tag, "go"),
            PlurnkParser.frame("WAIT (session://absent) <0,0> [{\"timeout\":0}]", "Await results."),
        ].join("\n\n");
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId: fixture.workspaceId, sessionId: fixture.sessionId, loopId: fixture.loopId, messages: [],
        });
        assert.equal(result.status, 202);
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 202, problemType: null },
        ]);
        const attempts = await fixture.db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
    } finally {
        completion.resolve({ status: 200 });
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-loop-lifecycle} fast current-turn streams settle before waiting and do not become monitored work", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    // The cap is a minute, past the runner's bound, so the elapsed bound below separates "ended when the stream
    // settled" from "waited for the cap" by far more than any loaded host's turn costs.
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "60000";
    let startedAt = 0;
    const fixture = await wire(async () => {
        startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 200 };
    });
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 102, "a concluded-but-unobserved stream continues to its observation turn");
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 102, problemType: null },
        ]);
        assert.ok(Date.now() - startedAt < 20_000, "settlement ends when the stream settles, not at the full minute cap");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-loop-lifecycle} a current-turn stream still active at the settlement cap follows the ordinary monitored path", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "40";
    let release!: () => void;
    let startedAt = 0;
    const fixture = await wire(() => new Promise((resolve) => {
        startedAt = Date.now();
        release = () => resolve({ status: 200 });
    }));
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 202, "the still-live stream remains a genuine monitored obligation");
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 202, problemType: null },
        ]);
        assert.ok(Date.now() - startedAt >= 30, "SEND adjudication follows the configured settlement opportunity");
        release();
    } finally {
        release?.();
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

// {§loop-completion}: a fast failure must settle before strike exhaustion reaps work.
test("{§session-causal-admission} a fast failed stream settles naturally and its observed failure does not itself strike out the loop", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "1000";
    const fixture = await wire(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return Results.failure("executor:settle", "spawn-failed", 500, "The fast stream failed.");
    });
    try {
        const result = await fixture.engine.runLoop({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "SEND"), {
                assistant: { content: "", reasoning: null, ops: [completeStmt("")] },
            }] }),
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            loopId: fixture.loopId,
            maxStrikes: 1,
            messages: [],
        });
        assert.equal(result.result.status, 200, "a handled executor failure does not manufacture a loop failure");
        assert.equal(result.turnIds.length, 3, "initialization, execution, and observation");
        await idle(fixture.schemes);
        const subscription = await fixture.db.test_latest_subscription_for_session.get<{ close_status: number | null }>({
            session_id: fixture.sessionId,
        });
        assert.equal(subscription?.close_status, 500, "the stream retains its own failure, never a cancellation");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});
});

describe("loop-claim-latency", () => {
// {§session-wait-timing} — a loop's first claim is a durable fact, so wake-to-first-turn latency is measurable (#703).



test("{§session-wait-timing}: a queued loop is stamped when first claimed; a running insert at insertion; later claims never move it", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, await insertWorkspace(db, `claim-${crypto.randomUUID()}`));
        const claimed = async (id: number) => (await db.test_get_loop_claimed_at.get<{ claimed_at: string | null }>({ id }))?.claimed_at ?? null;

        const queued = (await db.test_insert_queued_loop.get<{ id: number }>({ session_id: sessionId, sequence: 1, prompt: "later" }))!.id;
        assert.equal(await claimed(queued), null, "a queued loop has not been claimed");
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        const first = await claimed(queued);
        assert.match(String(first), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/u);
        await db.test_set_loop_status.run({ id: queued, status: 100, terminal_result: null });
        await db.test_set_loop_status.run({ id: queued, status: 102, terminal_result: null });
        assert.equal(await claimed(queued), first, "a re-claim keeps the first claim");

        const running = await insertLoop(db, sessionId, 2, "now");
        assert.notEqual(await claimed(running), null, "a loop inserted running is claimed at insertion");
    } finally { await db.close(); }
});
});

describe("operator-timeouts", () => {
// {§operator-config-loop-timeout}












class AbortBlockingMock extends Mock {
    readonly entered = Promise.withResolvers<void>();
    signal: AbortSignal | undefined;

    override async generate(args: Parameters<Mock["generate"]>[0]): Promise<never> {
        args.signal?.throwIfAborted();
        if (args.signal === undefined) throw new Error("AbortBlockingMock requires the engine's loop signal");
        this.signal = args.signal;
        this.entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
            args.signal?.addEventListener("abort", () => reject(args.signal?.reason), { once: true });
        });
    }
}

test("{§operator-config-loop-timeout} execution exhaustion rules a legible 504 loop_timeout terminal", async (t) => {
    const loopTimeoutMs = 60_000;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    // Restored, never deleted: the panel's value is what every later test in this file runs under,
    // and no code-side default papers over a knob this test removed.
    const panelTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = String(loopTimeoutMs);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "walled");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 50 });
        await provider.entered.promise;
        t.mock.timers.tick(loopTimeoutMs);
        const result = await running;
        assert.equal(result.result.status, 504, "the wall's terminal is 504, never an outside kill");
        assert.equal(result.reason, "loop_timeout");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 504, "the loop row carries the wall terminal");
        const turns = await db.test_list_turns_in_loop.all<{ status: number; packet: string }>({ loop_id: loopId });
        const attempted = turns.at(-1);
        assert.equal(attempted?.status, 504, "an interrupted provider attempt closes with the wall's exact status");
        const packet = JSON.parse(attempted?.packet ?? "{}") as { sections?: unknown; assistant?: unknown };
        assert.ok(Array.isArray(packet.sections), "the interrupted attempt retains its exact request packet");
        assert.equal(packet.assistant, undefined, "the timeout never fabricates an assistant response");
        assert.deepEqual(
            await db.test_error_rows_for_session.all({ session_id: sessionId }),
            [],
            "the lifecycle timeout never fabricates a provider failure",
        );
    } finally {
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = panelTimeout;
        await db.close();
    }
});

test("{§operator-config-loop-timeout}: waiting preserves one execution allowance across engine reconstruction", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const originalTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
    const db = await openMigrated();
    let resumed: ReturnType<Engine["runLoop"]> | undefined;
    try {
        const workspaceId = await insertWorkspace(db, "cumulative-execution");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Wait, then finish the same assignment.");
        const childId = await insertSession(db, workspaceId, sessionId, "child");
        await insertLoop(db, childId, 1, "Live child work the wait joins.");
        const first = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeMockResponse("````WAIT\nWait before continuing.\n````"),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
            t.mock.timers.tick(40_000);
            return generate(...args);
        });
        const parked = await first.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(parked.result.status, 202);
        t.mock.timers.tick(86_400_000);
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.status(loopId), 202, "deliberate waiting cannot spend execution time or time out the task");
        assert.equal(await lifecycle.wake(loopId), true);
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        // A later process/configuration cannot renew an already-started task's allowance.
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "120000";
        const second = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const blocked = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        resumed = second.runLoop({ provider: blocked, workspaceId, sessionId, loopId, messages: [] });
        await blocked.entered.promise;
        t.mock.timers.tick(19_999);
        assert.equal(blocked.signal?.aborted, false, "the remaining allowance is available to useful work");
        t.mock.timers.tick(1);
        assert.equal(blocked.signal?.aborted, true, "40s before waiting plus 20s after resumption exhaust the original 60s allowance");
        const result = await resumed;
        assert.equal(result.reason, "loop_timeout");
        assert.equal(result.result.status, 504);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/loop-timeout");
        assert.equal(await lifecycle.status(loopId), 504);
        assert.equal(await lifecycle.wake(loopId), false, "a deadline never makes a finished task runnable");
    } finally {
        t.mock.timers.tick(120_000);
        await resumed;
        if (originalTimeout === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = originalTimeout;
        await db.close();
    }
});

test("{§operator-config-loop-timeout} the panel's wall never intrudes — a short loop concludes 200 untouched", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-wall-off-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "quick");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } }] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.result.status, 200, "the panel's execution allowance is invisible to a normal loop");
    } finally { await db.close(); }
});

test("{§session-wait-timing}: exhaustion while acquiring the workspace settles without inference or a leaked gate", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "execution-lock-timeout");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Wait for the workspace.");
        const gate = new WorkspaceGate(async () => false);
        const exclusive = gate.requestExclusive(workspaceId);
        await exclusive.acquired;
        const waiting = Promise.withResolvers<void>();
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            withWorkspaceTurn: (workspace, session, run, signal) => {
                const request = gate.withTurn(workspace, session, run, signal);
                waiting.resolve();
                return request;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        try {
            await waiting.promise;
            t.mock.timers.tick(1000);
            const result = await running;
            assert.equal(result.result.status, 504, "the timeout settles while another owner still holds the workspace");
            assert.equal(result.reason, "loop_timeout");
            assert.equal(provider.received.length, 0, "the cancelled admission never reaches the provider");
        } finally { exclusive.release(); }
        (await gate.acquireTurn(workspaceId, sessionId))();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        await db.close();
    }
});

test("{§session-wait-timing}: an exceptional exit saves consumption and releases the execution scope", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "exceptional-execution");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const failure = new Error("workspace admission failed");
        let executionSignal: AbortSignal | undefined;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            withWorkspaceTurn: async (_workspace, _session, _run, signal) => {
                executionSignal = signal;
                t.mock.timers.tick(40000);
                throw failure;
            },
        });
        const provider = new Mock({ contextWindow: 100000, responses: [] });
        await assert.rejects(engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] }),
            (error: unknown) => error === failure);
        assert.equal(executionSignal?.aborted, true, "failed execution cannot leave its effect scope alive");
        assert.equal((await db.test_get_loop_execution.get({ id: loopId }))?.execution_elapsed_ms, 40000);
        t.mock.timers.tick(86_400_000);
        assert.equal(executionSignal?.reason, "loop_execution_failed", "no retained timeout overwrites the original failure");
    } finally { await db.close(); }
});

test("{§session-loop-lifecycle}: a cancellation committed before timeout settlement keeps its exact result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    t.mock.method(performance, "now", () => Date.now());
    const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "1000";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "cancel-timeout-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const lifecycle = new LoopLifecycle(db);
        const finish = lifecycle.finish.bind(lifecycle);
        t.mock.method(lifecycle, "finish", async (...args: Parameters<typeof finish>) => {
            if (args[1].status === 504) await lifecycle.cancelTree(sessionId, "cancel won", true);
            return finish(...args);
        });
        const engine = new Engine({ db, lifecycle, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new AbortBlockingMock({ contextWindow: 100000, responses: [] });
        const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        await provider.entered.promise;
        t.mock.timers.tick(1000);
        const result = await running;
        assert.equal(result.reason, "external");
        assert.equal(result.result.status, 499);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
        assert.deepEqual(await lifecycle.result(loopId), result.result);
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        await db.close();
    }
});
});

describe("optimistic-settlement", () => {
// {§session-causal-admission} — terminal stream and child arrivals remain
// independent durable wake edges while one bounded session-local opportunity
// coalesces provider dispatch over sibling obligations.











const requestAccounting = {
    provider: "provider:controlled-settlement",
    model: "controlled-settlement",
    outcome: "response",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "controlled fixture" },
} as const;

const response = (
    content: string,
    capacity: ProviderResponse["capacity"],
    grammar?: string,
): ProviderResponse => {
    return {
        assistant: {
            content,
            reasoning: null,
            finishReason: "stop",
            model: "controlled-settlement",
        },
        assistantRaw: null,
        accounting: [requestAccounting],
        capacity,
        ...(grammar === undefined
            ? {}
            : { grammarEvidence: { input: content, contentStart: 0, transported: true } }),
    };
};

class ControlledSessionProvider implements Provider {
    readonly contextWindow = 100_000;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly outputFloor = null;
    readonly inputWall = null;
    readonly model = "controlled-settlement";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly childrenStarted = Promise.withResolvers<void>();
    readonly #parentTurns: readonly string[];
    readonly #parentStarts: Array<PromiseWithResolvers<void>>;
    readonly #childReleases: Array<PromiseWithResolvers<void>>;
    readonly #parentMessages: ChatMessage[][] = [];
    readonly #parentStartedAt: number[] = [];
    #parentCalls = 0;
    #childCalls = 0;

    constructor({ parentTurns, childCount }: { parentTurns: readonly string[]; childCount: number }) {
        this.#parentTurns = parentTurns;
        this.#parentStarts = parentTurns.map(() => Promise.withResolvers<void>());
        this.#childReleases = Array.from({ length: childCount }, () => Promise.withResolvers<void>());
        if (childCount === 0) this.childrenStarted.resolve();
    }

    get parentCalls(): number { return this.#parentCalls; }
    get childCalls(): number { return this.#childCalls; }
    parentMessages(call: number): readonly ChatMessage[] { return this.#parentMessages[call - 1] ?? []; }
    parentStartedAt(call: number): number | undefined { return this.#parentStartedAt[call - 1]; }
    waitForParentCall(call: number): Promise<void> {
        const started = this.#parentStarts[call - 1];
        if (started === undefined) throw new RangeError(`No parent turn ${call} is configured.`);
        return started.promise;
    }

    countPromptTokens(messages: readonly ChatMessage[]) {
        return Promise.resolve({
            kind: "exact" as const,
            tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
            source: "controlled-settlement:chars2",
        });
    }

    async assessRequestCapacity(messages: readonly ChatMessage[]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    #parentIdentity: string | undefined;

    async generate({
        messages,
        sessionId,
        signal,
        grammar,
        observeRequest,
    }: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> {
        signal?.throwIfAborted();
        const capacity = await this.assessRequestCapacity(messages);
        const settle = await observeRequest?.({
            provider: requestAccounting.provider,
            model: requestAccounting.model,
        });
        // The parent session is whoever calls first; children spawn from its turn.
        this.#parentIdentity ??= sessionId;
        if (sessionId === this.#parentIdentity) {
            const index = this.#parentCalls++;
            const content = this.#parentTurns[index];
            if (content === undefined) throw new Error(`Unexpected parent provider call ${index + 1}.`);
            this.#parentMessages[index] = messages;
            this.#parentStartedAt[index] = performance.now();
            this.#parentStarts[index]?.resolve();
            await settle?.(requestAccounting);
            return response(content, capacity, grammar);
        }

        const index = this.#childCalls++;
        if (index >= this.#childReleases.length) throw new Error(`Unexpected child provider call ${index + 1}.`);
        if (this.#childCalls === this.#childReleases.length) this.childrenStarted.resolve();
        await this.#childReleases[index].promise;
        signal?.throwIfAborted();
        await settle?.(requestAccounting);
        return response(`\`\`\`\`SEND [200]
child ${index + 1} done
\`\`\`\``, capacity, grammar);
    }

    releaseChild(index: number): void {
        this.#childReleases[index]?.resolve();
    }

    releaseAll(): void {
        for (const release of this.#childReleases) release.resolve();
    }
}

test("{§session-causal-admission} near-simultaneous child conclusions share one parent provider turn", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 2,
        parentTurns: [
            "````WORK (session://first)\nfinish first\n\n````\n"
            + "````WORK (session://second)\nfinish second\n\n````\n"
            + "````WAIT\nwaiting for both\n````",
            "````SEND [200]\nboth children landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate two independent jobs and await both",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;

                provider.releaseChild(0);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId }) => loopId !== parentLoopId),
                );
                const resumedBeforeSibling = await Promise.race([
                    provider.waitForParentCall(2).then(() => true),
                    delay(200, false),
                ]);
                assert.equal(
                    resumedBeforeSibling,
                    false,
                    "the first child conclusion holds provider dispatch while its sibling remains in flight",
                );

                provider.releaseChild(1);
                const events = await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (items) => items.some(({ loopId }) => loopId === parentLoopId),
                    { timeoutMs: 5_000 },
                );
                const parent = events.find(({ loopId }) => loopId === parentLoopId);
                assert.equal(parent?.result.status, 200);
                assert.equal(provider.childCalls, 2);
                assert.equal(provider.parentCalls, 2, "both child returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} a lone child conclusion resumes immediately without paying the settlement cap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (session://only)\nfinish the only job\n````\n\n````WAIT\nwaiting\n````",
            "````SEND [200]\nonly child landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-single" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate one job and await it",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                const releasedAt = performance.now();
                provider.releaseChild(0);
                await provider.waitForParentCall(2);
                assert.ok(
                    performance.now() - releasedAt < 350,
                    "without a sibling obligation, the completion wake bypasses the 500ms hold",
                );
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                );
                assert.equal(provider.parentCalls, 2);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} stream conclusions coalesce across the same session-local settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "200";
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse(
                "````sh\nsleep 0.25; echo first-stream\n\n````\n"
                + "````sh\nsleep 0.40; echo second-stream\n\n````\n"
                + "````WAIT\nwaiting for both streams\n````",
            ),
            makeMockResponse("````SEND [200]\nboth streams landed\n````"),
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-stream-fanout" });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "run two independent streams and await both",

                });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "two stream conclusions cost one resumed provider turn");
            } finally {
                ws.close();
            }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} a child and stream conclusion share the same settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "300";
    const provider = new ControlledSessionProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (session://child)\nfinish independently\n\n````\n"
            + "````sh\nsleep 0.50; echo stream-done\n\n````\n"
            + "````WAIT\nwaiting for child and stream\n````",
            "````SEND [200]\nchild and stream landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-mixed-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run one child and one stream and await both",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );
                provider.releaseChild(0);

                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 2, "mixed asynchronous returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /stream-done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} the settlement deadline is bounded and does not slide on later conclusions", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 3,
        parentTurns: [
            "````WORK (session://first)\nfinish first\n\n````\n"
            + "````WORK (session://second)\nfinish second\n\n````\n"
            + "````WORK (session://third)\nfinish third\n\n````\n"
            + "````WAIT\nwaiting for all three\n````",
            "````WAIT\ntwo landed; still waiting\n````",
            "````SEND [200]\nall three landed\n````",
        ],
    });
    const windowOpened = Promise.withResolvers<void>();
    const secondArrival = Promise.withResolvers<void>();
    const settle = DrainSupervisor.prototype.settleCompletionWake;
    let arrivals = 0;
    approvalContext.mock.method(DrainSupervisor.prototype, "settleCompletionWake", function (
        this: DrainSupervisor, ...args: Parameters<typeof settle>
    ) {
        const pending = settle.apply(this, args);
        if (++arrivals === 2) secondArrival.resolve();
        return pending;
    });
    const tracing = await mountMemoryTracing((span) => {
        if (span.name !== "session.wake.settlement") return;
        approvalContext.mock.timers.enable({ apis: ["setTimeout"] });
        windowOpened.resolve();
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-non-sliding" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate three jobs and await all three",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(0);
                await windowOpened.promise;
                approvalContext.mock.timers.tick(350);
                provider.releaseChild(1);
                await secondArrival.promise;
                approvalContext.mock.timers.tick(149);
                assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status, 202,
                    "the parent remains parked before the original deadline while one child is still live");
                assert.equal(provider.parentCalls, 1);
                assert.equal(tracing.spans().some(({ name }) => name === "session.wake.settlement"), false,
                    "the opportunity has not expired at 499ms");
                approvalContext.mock.timers.tick(1);
                approvalContext.mock.timers.reset();
                await provider.waitForParentCall(2);
                const window = tracing.spans().find(({ name }) => name === "session.wake.settlement");
                assert.equal(window?.attributes.release, "deadline");
                assert.equal(window?.attributes.conclusions, 2,
                    "the second arrival shares the first deadline, rather than starting a new opportunity");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
                assert.doesNotMatch(resumedPacket, /child 3 done/);
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(2);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 3, "deadline wake plus final lone-child wake are the only resumptions");
            } finally {
                approvalContext.mock.timers.reset();
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        approvalContext.mock.timers.reset();
        provider.releaseAll();
        await tracing.shutdown();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});
});

describe("scheduled-occurrence", () => {
const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);

test("{§functionality-state} schedule startup rejects malformed persisted enabledness before arming", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "invalid-schedule-state");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: "@plurnk/plurnk-schedule",
        state: JSON.stringify({ version: 1, definitions: { beat: {
            origin: "workspace", enabled: "false",
            definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://recipient", prompt: "Must not fire." },
        } } }),
    });
    const timers: SchedulerTimers = { set: () => assert.fail("malformed state must not arm a timer"), clear: () => {} };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => INITIAL, timers });
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await assert.rejects(daemon.start(), {
        name: "Error", message: "Functionality state for schedule alias 'beat' is malformed.",
    });
});

test("{§schedule-residency} restart arms the coordinator's complete definitions and per-workspace enabledness", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const baseline = {
        rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY",
        target: "session://recipient", prompt: "Baseline.",
    };
    const replacement = { rule: `${baseline.rule};COUNT=2`, target: "session://alternate", prompt: "Workspace override." };
    const instances: Daemon[] = [];
    const start = async () => {
        const module = Module.init({
            env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1", PLURNK_SCHEDULE_beat: JSON.stringify(baseline) },
            clock: () => INITIAL, timers: { set: () => Symbol("occurrence"), clear: () => {} },
        });
        const daemon = new Daemon({ db, provider: null });
        instances.push(daemon);
        daemon.registerModule(module, "@plurnk/plurnk-schedule");
        await daemon.start();
        return { daemon, module };
    };
    t.after(async () => { for (const daemon of instances) await daemon.stop(); await db.close(); });
    const first = await start();
    const alice = await insertWorkspace(db, "schedule-alice");
    const bob = await insertWorkspace(db, "schedule-bob");
    const charlie = await insertWorkspace(db, "schedule-charlie");
    const invoke = (workspaceId: number, verb: string, params = {}) => first.daemon.invokeModuleAction(
        `workspace.schedule.${verb}`, params, { scope: "workspace", workspaceId },
    );
    await invoke(alice, "add", { alias: "beat", definition: replacement });
    await invoke(alice, "add", { alias: "muted", definition: replacement });
    await invoke(alice, "disable", { alias: "muted" });
    await invoke(bob, "disable", { alias: "beat" });
    await invoke(bob, "add", { alias: "private", definition: replacement });
    await first.daemon.stop();

    const restored = await start();
    for (const [workspaceId, aliases] of [[alice, ["beat"]], [bob, ["private"]], [charlie, ["beat"]]] as const) {
        const listing = await restored.daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        assert.deepEqual(listing.definitions.filter(({ state }) => state !== "disabled").map(({ alias }) => alias), aliases);
        assert.deepEqual(restored.module.functionality.scheduler.armed(workspaceId), aliases,
            "restart and passive inspection must agree without demanding workspace residency");
        assert.ok(listing.definitions.every(({ state }) => state === "disabled" || state === "dormant"),
            "arming a durable obligation does not prepare the workspace's capabilities");
        assert.deepEqual(listing.definitions.find(({ alias }) => alias === "beat")?.definition,
            workspaceId === alice ? replacement : baseline, "the local rule does not inherit baseline policy or message fields");
    }
});

// {§schedule-delivery} — a composed daemon with one hourly rule targeting the recipient session; the
// scheduler's timers are the test's, so an occurrence fires when the test says so.
test("{§schedule-delivery}: an occurrence after conclusion starts a successor loop", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        "````SEND [200]\nDone for now; the reminder will start its own loop.\n````",
        "````SEND [200]\nReceived scheduled-proof.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const timerApi: SchedulerTimers = {
        set: (callback, delayMs) => { const id = ++serial; timers.set(id, { callback, due: now + delayMs }); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers: timerApi });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-occurrence", projectRoot: null });
        const { sessionId, sessionName } = await daemon.createSession({ workspaceId, name: "recipient" });
        const added = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "reminder", definition: { rule: "FREQ=HOURLY;COUNT=2", target: `session://${sessionName}`, prompt: "scheduled-proof" },
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(added.status, 201);

        const lifecycle = new LoopLifecycle(db);
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "Reply now; the reminder is scheduled." });
        await waitForDb(() => lifecycle.status(first.loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(first.loopId), 200, "a loop with nothing live concludes; the schedule holds nothing");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the rule stays armed on its own");

        const next = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(next, "the scheduler has an armed occurrence");
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();

        await waitForDb(async () => provider.received.length, (calls) => calls >= 2);
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the occurrence arrives as a message and runs a loop");
        const loops = await daemon.listSessionLoops({ workspaceId, sessionId });
        await waitForDb(async () => (await daemon.listSessionLoops({ workspaceId, sessionId })).filter(({ status }) => status === 200).length, (done) => done === 2);
        assert.equal(loops.length, 2, "the occurrence started a second loop on the same session");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the next recurrence armed from the delivery");
    } finally { await daemon.stop(); await db.close(); }
});

test("{§schedule-delivery} {§session-wait-timing}: an occurrence wakes a genuinely parked loop and arrives there exactly once", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        { assistant: { content: "```WAIT [600]\nWaiting for the child.\n```", reasoning: null } },
        { assistant: { content: "```NOTE\nReceived the scheduled message.\n```\n\n```WAIT [600]\nThe child is still running.\n```", reasoning: null } },
    ] });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const module = Module.init({
        env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now,
        timers: {
            set: (callback, delayMs) => { const id = ++serial; timers.set(id, { callback, due: now + delayMs }); return id; },
            clear: (id) => { timers.delete(id as number); },
        },
    });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-parked-arrival", projectRoot: null });
        const { sessionId, sessionName } = await daemon.createSession({ workspaceId, name: "recipient" });
        await holdChild(db, workspaceId, sessionId);
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait for the child." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        assert.equal(provider.received.length, 1, "a real parked loop, not a WAIT receipt that merely says continue");

        // The parking turn still holds the workspace gate for a moment after the loop's status row
        // says 202. A capability change in that window is answered `workspace-busy`, 409 and
        // retryable, and this witness retries it as a client would (#1117).
        const added = await waitForDb(async (): Promise<{ status: number } | null> => {
            try {
                return await daemon.invokeModuleAction("workspace.schedule.add", {
                    alias: "reminder", definition: { rule: "FREQ=HOURLY;COUNT=1", target: `session://${sessionName}`, prompt: "scheduled-proof" },
                }, { scope: "workspace", workspaceId }) as { status: number };
            } catch (cause) {
                const problem = cause instanceof OperationFailureError ? cause.result.problem : undefined;
                if (problem?.type?.endsWith("/workspace-busy") === true && problem.retryable === true) return null;
                throw cause;
            }
        }, (result) => result !== null);
        assert.equal(added?.status, 201);
        const occurrence = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(occurrence, "one occurrence is armed");
        now = occurrence[1].due;
        timers.delete(occurrence[0]);
        occurrence[1].callback();

        await waitForDb(() => db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: accepted.loopId }),
            (rows) => rows.some(({ op, tx }) => op === "NOTE" && tx.includes("Received the scheduled message.")));
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        await waitForDb(async () => module.functionality.scheduler.armed(workspaceId), (aliases) => aliases.length === 0);
        assert.equal(provider.received.length, 2, "the occurrence wakes the loop without waiting for its ten-minute deadline");
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the resumed model sees the message");
        assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId })).map(({ id }) => id), [accepted.loopId],
            "the scheduler joins the existing loop rather than starting a successor");
        const arrivals = (await db.test_messages_by_loop.all<{ source: string; body: string; log_entry_id: number | null }>({ loop_id: accepted.loopId }))
            .filter(({ source }) => source === "schedule://reminder");
        assert.deepEqual(arrivals.map(({ body }) => body), ["scheduled-proof"]);
        assert.ok(arrivals[0].log_entry_id !== null, "the arrival has a published ordinary log receipt");
        const listing = await daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        const reminder = listing.definitions.find(({ alias }) => alias === "reminder");
        assert.ok(reminder !== undefined && reminder.state !== "unavailable", "exhaustion follows a successful delivery");
        await daemon.cancelSession({ workspaceId, sessionId });
    } finally { await daemon.stop(); await db.close(); }
});
});

describe("session-topology", () => {
// {§session-loop-lifecycle} topology join — a child session finishing is a WAKE EDGE for a parent that parked
// awaiting it. Without it, a parent that spawns work and hibernates would dead-park.
// The proof: the parent concludes at all — a non-woken 202 would hang (runLoopToTerminal times out).

















test("{§session-loop-lifecycle} a child session concluding wakes a parent parked at 202", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Response order is forced by causality: the parent can't resume until the child concludes,
    // and the child can't run until the parent spawns it — so the Mock queue is deterministic.
    // 16384: the parent's final resume carries the whole child subtree; that accumulation crests at the 8192 edge
    // and grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake topology, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a child session, then hibernate awaiting it.
        makeMockResponse("````WORK (session://session)\ncompute the thing and finish\n````\n\n````WAIT\nspawned session; waiting on it\n````", 10),
        // Child turn 1: do its part and conclude → this is the wake edge for the parent.
        makeMockResponse("````SEND [200]\nsession done\n````", 10),
        // Parent turn 2 (only reached if the child's conclusion woke it): conclude.
        makeMockResponse("````SEND [200]\nsession finished; all done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "session-topology" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // runLoopToTerminal awaits the PARENT's loop/terminated. If the child-wake doesn't fire,
            // the parent stays parked at 202 forever and this times out — so reaching 200 IS the proof.
            const { finalStatus, turnIds, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "spawn a session and wait for it" });
            assert.equal(finalStatus, 200, "the parent resumed from 202 (woken by the child) and concluded");
            assert.equal(turnIds?.length, 3, "the terminal event includes initialization and both model turns across park/resume");
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 200, "the child concluded 200");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a child cancelling itself (499) also wakes the parent — any conclusion is a wake edge", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The parent observes cancellation as well as successful completion.
    // 16384: the parent's woken turn carries the whole child history + collect delta, cresting at the
    // 8192 edge; execs-common 0.2.21's second sh teaching line consumed the last margin (the same
    // budget-edge class as the grammar 0.76.4 bumps above). Headroom for the wake, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://doomed)\ntry the risky thing\n````\n\n````WAIT\nwaiting on doomed\n````", 10),
        makeMockResponse("````SEND\ndoomed gave up\n````\n````KILL (session://doomed)\n````", 10),
        makeMockResponse("````SEND [200]\ndoomed is done (failed); concluding\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-fail" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn doomed, wait" });
            assert.equal(finalStatus, 200, "the parent woke on the child's 499 and concluded — a failed child is still a wake edge");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: one completed child task wakes its parent while another task stays parked", async (t) => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nFirst task waits.\n````"),
        makeMockResponse("````WAIT\nSecond task waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits results.\n````"),
        makeMockResponse("````SEND [200]\nFirst task result: 42.\n````\n\n````SEND [200]\nFirst task result: 42.\n````"),
        makeMockResponse("````WAIT\nFirst result observed; second task remains.\n````"),
    ] });
    try {
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "partial-child-result" });
            const parentId = await namedModelSession(daemon, workspaceId, "main");
            const parentSession = await daemon.readSession({ workspaceId, identity: { id: parentId } });
            assert.ok(parentSession);
            const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
            const held = await holdChild(db, workspaceId, childId);
            try {
                const common = {
                    workspaceId, sessionId: childId,
                    source: `session://${parentSession.name}`,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive" as const, systemPrompt: "test system",
                };
                const childTasks = await admitTogether(t, childId, [
                    () => daemon.inject({ ...common, prompt: "First child task." }),
                    () => daemon.inject({ ...common, prompt: "Second child task." }),
                ]);
                const ids = new Set(childTasks.map(({ loopId }) => loopId));
                await waitForDb(
                    async () => (await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId }))
                        .filter(({ id }) => ids.has(id)),
                    (tasks) => tasks.length === 2 && tasks.every(({ status }) => status === 202),
                );
                const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe each child result." });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
                await new LoopLifecycle(db).finish(held, { status: 200, content: "The held work finished." });
                const delivery = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Complete the first task.", source: `session://${parentSession.name}` });
                assert.equal(delivery.loopId, childTasks[0]?.loopId);
                await waitForDb(async () => provider.received.length, (count) => count === 5);
                const latest = provider.received.at(-1)!;
                assert.match(JSON.stringify(latest), /First task result: 42/, "the resumed parent sees the completed task's deliverable");
                const tasks = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId });
                assert.deepEqual(tasks.filter(({ id }) => ids.has(id)).map(({ status }) => status), [200, 202],
                    "observing one completion neither finishes nor wakes the other child task");
                const parentTasks = await db.test_loop_queue_by_session.all<{ id: number; prompt: string }>({ session_id: parentId });
                assert.deepEqual(parentTasks.filter(({ prompt }) => prompt === "Observe each child result.").map(({ id }) => id), [parent.loopId],
                    "the parent resumes its original task without a synthetic message");
            } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission}: cancelling a parked child notifies its waiting parent without a live child drain", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nChild waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits child.\n````"),
        makeMockResponse("````SEND [200]\nChild cancellation observed.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-parked-child" });
        const parentId = await namedModelSession(daemon, workspaceId, "main");
        const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
        await holdChild(db, workspaceId, childId);
        try {
            const child = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Wait for instructions." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }), (row) => row?.status === 202);
            const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe the child outcome." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
            await daemon.cancelSession({ workspaceId, sessionId: childId });
            const completed = await waitForDb(
                () => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }),
                (row) => row?.status === 200,
            );
            assert.equal(completed?.status, 200);
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }))?.status, 499);
            assert.equal(provider.received.length, 3, "only the live parent resumes on cancellation evidence");
        } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
    });
});

test("{§session-loop-lifecycle} an empty failed child stream is observed by the child before its terminal result reaches the parent", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://stream-child)\nrun the empty failing stream and report its outcome\n````\n\n````WAIT\nwaiting on stream-child\n````", 10),
        makeMockResponse("````sh (emptyfail)\ngo\n````\n\n````WAIT\nwaiting for emptyfail\n````", 10),
        makeMockResponse("````SEND\nemptyfail failed with no output\n````\n````KILL (session://stream-child)\n````", 10),
        makeMockResponse("````SEND [200]\nthe child reported the empty stream failure\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        await daemon.registerRuntime({
            namespaceOwner: "session topology test module",
            decl: { name: "emptyfail", glyph: "×", summary: "Empty failure fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } } },
            executor: {
                runtime: "emptyfail", glyph: "×",
                get manifest() { return { name: "emptyfail", channels: { results: "text/plain" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
                get defaultChannel() { return "results"; },
                get channels() { return { results: { mimetype: "text/plain" } }; },
                effect: () => "pure",
                probe: async () => ({ available: true, detail: "fixture" }),
                run: async () => Results.failure(
                    "executor:emptyfail",
                    "fixture-failed",
                    500,
                    "The empty failing stream fixture failed.",
                    { exitCode: 1 },
                    { stage: "execute", retryable: false },
                ),
            } as unknown as Executor,
            availability: { available: true, detail: "fixture" },
        });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-empty-failed-stream" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus, modelSessionId } = await runLoopToTerminal(ws, 2, {
                prompt: "delegate a failing stream and wait for its result",

            });
            assert.equal(finalStatus, 200);
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 499, "the child concluded with its observed stream failure");
            assert.equal(mock.remaining, 0, "all four causal turns ran: parent park, child exec, child terminal, parent terminal");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: abandonment survives child activation finishing after cancellation", async (t) => {
    serverProposals(t, "accept");
    const activationStarted = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    const childSettled = Promise.withResolvers<void>();
    let childId: number | undefined;
    const cancelSessionTree = DrainSupervisor.prototype.cancelSessionTree;
    t.mock.method(DrainSupervisor.prototype, "cancelSessionTree", async function (
        this: DrainSupervisor,
        ...args: Parameters<typeof cancelSessionTree>
    ) {
        await activationStarted.promise;
        return cancelSessionTree.apply(this, args);
    });
    const materialize = LoopDocs.materialize;
    t.mock.method(LoopDocs, "materialize", async (...args: Parameters<typeof materialize>) => {
        const [, db, workspaceId] = args;
        const child = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
        if (child !== undefined) {
            childId = child.id;
            activationStarted.resolve();
            await releaseActivation.promise;
        }
        return materialize(...args);
    });
    const runLoop = LoopDriver.prototype.runLoop;
    t.mock.method(LoopDriver.prototype, "runLoop", async function (
        this: LoopDriver,
        args: Parameters<typeof runLoop>[0],
    ) {
        try { return await runLoop.call(this, args); }
        finally { if (args.sessionId === childId) childSettled.resolve(); }
    });
    // Cancellation reaps the subtree even before the child's activation finishes.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\nkeep working until cancelled\n````\n\n````SEND\nabandon this scope\n````\n````KILL (session://root)\n````", 10),
        makeMockResponse("````NOTE\nstill working\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "abandon-tree" });
            const { sessionId } = await daemon.createSession({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
            const parent = runLoopToTerminal(ws, 2, { prompt: "spawn then abandon", sessionId });
            await activationStarted.promise;
            const { finalStatus } = await parent;
            assert.equal(finalStatus, 499);
            const cancelled = await db.test_list_loops_all.all<{ session_id: number; status: number }>({});
            assert.deepEqual(cancelled.filter(({ session_id }) => session_id === childId).map(({ status }) => status), [499],
                "the child is durably cancelled before its delayed activation completes");
            releaseActivation.resolve();
            await childSettled.promise;
            const loops = await db.test_list_loops_all.all<{ id: number; session_id: number; status: number }>({});
            assert.ok(loops.every(({ status }) => ![100, 102, 202].includes(status)), `no unresolved descendant survives abandonment: ${JSON.stringify(loops)}`);
            const childLoops = loops.filter(({ session_id }) => session_id === childId);
            assert.deepEqual(childLoops.map(({ status }) => status), [499], "workspace document maintenance does not create child loops");
            assert.equal(mock.remaining, 1, "the cancelled child never calls the model");
        } finally { releaseActivation.resolve(); ws.close(); }
    });
});

test("{§session-loop-lifecycle} wake propagates UP a grandchild chain (parent→child→grandchild)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Each level parks until the one below concludes — so the order is forced and the recursion shows:
    // grandchild concludes → wakes child → child concludes → wakes parent → parent concludes.
    // 16384: a 2-deep chain piles grandchild→child→parent results into the parent's final resume, cresting at the
    // 8192 edge; grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake recursion, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\ndo subwork\n````\n\n````WAIT\nawaiting child\n````", 10),       // parent t1
        makeMockResponse("````WORK (session://grandchild)\ndo leaf work\n````\n\n````WAIT\nawaiting grandchild\n````", 10), // child t1
        makeMockResponse("````SEND [200]\nleaf done\n````", 10),                                                   // grandchild
        makeMockResponse("````SEND [200]\nchild done\n````", 10),                                                  // child t2 (woken)
        makeMockResponse("````SEND [200]\nall done\n````", 10),                                                    // parent t2 (woken)
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "grandchild" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn a 2-deep chain and wait" });
            assert.equal(finalStatus, 200, "the wake propagated up two levels — the parent concluded only after the whole subtree did");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a parent wakes across SEQUENTIAL children (multiple wakes)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // 16384: the parent's woken turn carries the whole child history; generous headroom over the
    // static packet so the wake budget edge is the subtree, not the tool teaching.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://w1)\nfirst job\n````\n\n````WAIT\nawaiting w1\n````", 10), // parent t1
        makeMockResponse("````SEND [200]\nw1 done\n````", 10),                                       // w1
        makeMockResponse("````WORK (session://w2)\nsecond job\n````\n\n````WAIT\nawaiting w2\n````", 10),// parent t2 (woken by w1)
        makeMockResponse("````SEND [200]\nw2 done\n````", 10),                                       // w2
        makeMockResponse("````SEND [200]\nboth done\n````", 10),                                     // parent t3 (woken by w2)
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "sequential" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "two jobs in sequence" });
            assert.equal(finalStatus, 200, "the parent parked, woke on w1, spawned+parked again, woke on w2, then concluded");
            const sessions = await db.test_sessions_with_parent.all<{ id: number; name: string; parent_session_id: number | null; origin: string }>({});
            const modelSessions = sessions.filter(({ origin }) => origin === "model");
            const parent = modelSessions.find(({ parent_session_id: parentId }) => parentId === null);
            assert.ok(parent, `the topology has a root model session; got ${JSON.stringify(modelSessions)}`);
            assert.deepEqual(
                modelSessions.filter(({ parent_session_id: parentId }) => parentId === parent.id).map(({ name }) => name),
                ["w1", "w2"],
                "the sequential path created both named child sessions under the same parent — terminal output alone is not proof",
            );
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission} an irc (SEND session://name) wakes a CONCLUDED sibling on that session's durable model", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Under {§session-causal-admission}, an actor with nothing to wait on CONCLUDES — it does not
    // park awaiting voice. So the voice door (a sibling's irc) reawakens it as a NEW loop carrying the
    // message as its prompt (the same wake `loop.inject` proves for the operator voice), never a
    // resume-in-place of a slept loop — there is no slept loop to resume.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nstanding by for the entry code\n````", 10), // loop 1 — idle actor concludes
    ] });
    const directRoute: ProviderSpec = { provider: "mocktest", model: `irc-${crypto.randomUUID()}` };
    const selected = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nreceived the entry code and confirmed\n````", 10),
    ] });
    ProviderInstantiate.registerInstance(selected, directRoute);
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "irc-wake" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "be a butler; await the entry code" });
            const modelSessionId = (response.result as { modelSessionId: number }).modelSessionId;
            const loopId = (response.result as { loopId: number }).loopId;
            // The actor concludes its first (idle) loop — nothing to wait on.
            await waitFor(() => terminated() as Array<{ loopId: number }>, (ts) => ts.some((t) => t.loopId === loopId), { timeoutMs: 8000 });
            const before = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;
            await daemon.setSessionModel({
                workspaceId,
                sessionId: modelSessionId,
                selector: `${directRoute.provider}/${directRoute.model}`,
            });
            // Address the concluded actor by name, then irc it — the voice door.
            const sessions = ((await rpcCall(ws, 4, "workspace.sessions", {})).result as { sessions: Array<{ name: string; origin: string }> }).sessions;
            const actor = sessions.find((r) => r.origin === "model")!;
            await rpcCall(ws, 5, "op.send", { recipient: `session://${actor.name}`, body: "the entry code is 4815" });
            // A FRESH loop is minted (there was no slept loop to resume).
            const after = await waitForDb(() => db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }), (r) => (r?.n ?? 0) > before, { timeoutMs: 8000 });
            assert.ok((after?.n ?? 0) > before, "the irc reawakened the concluded actor as a FRESH loop — the voice door mints a new loop, never resumes a park");
            const secondLoop = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (items) => items.some(({ loopId: candidate }) => candidate !== loopId),
                { timeoutMs: 8000 },
            );
            assert.equal(secondLoop.find(({ loopId: candidate }) => candidate !== loopId)?.result.status, 200);
            assert.equal(selected.remaining, 0, "the voice door retained the receiving session's explicitly selected model");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} an empty wait continues through the real loop until the assignment is answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````WAIT\nnothing running; done for now\n````", 10),
        makeMockResponse("````SEND [200]\nNo work remains.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "idle-concludes" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 2, "loop.run", { prompt: "nothing to do" });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number }; loopId?: number }>, (items) => items.length > 0, { timeoutMs: 8000 });
            assert.equal(t.length, 1, "the loop concluded — one loop/terminated, no held-open 202");
            assert.equal(t[0].result.status, 200, "the answered assignment concludes the loop");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: t[0].loopId! });
            assert.deepEqual(rows.filter(({ op, origin }) => origin === "model" && (op === "WAIT" || op === "SEND")).map(({ status_rx }) => status_rx), [102, 200]);
            assert.equal(mock.remaining, 0);
        } finally { ws.close(); }
    });
});

test("{§session-ownership} server auto-approval settles both WORK and FORK child edits", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a session AND fork self, then park awaiting them.
        makeMockResponse("````WORK (session://session)\nedit something and finish\n````\n\n````FORK (session://mirror)\nedit something and finish\n````\n\n````WAIT\ndelegated; waiting\n````", 10),
        // Session turn 1: a SIDE-EFFECTING op (proposes unless auto), then conclude.
        makeMockResponse("````EDIT (workspace:///from-session)\npayload\n````\n\n````SEND\nsession done\n````", 10),
        // Fork turn 1: same shape.
        makeMockResponse("````EDIT (workspace:///from-fork)\npayload\n````\n\n````SEND\nfork done\n````", 10),
        // {§loop-completion}: the children observe their EDIT receipts
        // before completing. A parent claim remains gated on its child results.
        ...Array.from({ length: 4 }, () => makeMockResponse("````SEND [200]\nDelegated edits observed.\n````", 10)),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "delegation-policy" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "delegate everything" });
            assert.equal(finalStatus, 200, "the whole topology concluded — no child stalled in a proposal void");
            const edits = await db.test_edit_states.all<{ pathname: string; state: string }>({});
            const childEdits = edits.filter((x) => /from-(session|fork)/.test(x.pathname));
            assert.equal(childEdits.length, 2, "both delegated children performed their EDIT");
            for (const e of childEdits) {
                assert.equal(e.state, "resolved", `child EDIT ${e.pathname} accepted by server policy`);
            }
        } finally { ws.close(); }
    });
});

test("{§loop-completion} a wake re-queue (100) mid-drain is re-claimed and continued — never returned as a terminal", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The delegation-policy race: a conclusion-wake re-queues a parent's loop (202→100) between its
    // turn-end and its drain's next status check; pre-fix, runLoop read the queued 100 as an external
    // terminal and broadcast a QUEUED loop as loop/terminated{100}.
    // Under {§loop-completion} a loop blocks at 202 only on a live obligation, so the wake is a
    // REAL child-wake: the parent blocks on a spawned child, the child's conclusion re-queues the parent
    // (202→100) and the drain re-claims it (100→102). Exactly one terminal must fire for the parent, 200.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WORK (session://helper)\ndo a quick thing\n````\n\n````WAIT\nawaiting helper\n````", 10), // parent — blocks on its child
        makeMockResponse("````SEND [200]\nhelper done\n````", 10),                    // helper — concludes, waking the parent
        makeMockResponse("````SEND [200]\nhelper delivered; concluding\n````", 10),   // parent — re-queued by the wake, concludes
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "wake-requeue" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a helper and await it" });
            const loopId = (accept.result as { loopId: number }).loopId;
            // The parent's loop is re-queued in place by the child-wake, then continues to its own terminal.
            const seen = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (ts) => ts.some((t) => t.loopId === loopId),
                { timeoutMs: 8000 },
            );
            const finals = seen.filter((t) => t.loopId === loopId).map((t) => t.result.status);
            assert.deepEqual(finals, [200], `exactly one terminal broadcast for the parent, 200 — never a queued 100; got ${JSON.stringify(finals)}`);
        } finally { ws.close(); }
    });
});

test("{§log-history-projection} log-targeted KILL is recorded in the DB, and a failed one persists", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Successful meta-operations are forensic but render-free; failures remain
    // visible error signals. {§log-history-projection}
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````EDIT (workspace:///note)\nsome content worth folding\n````\n\n````NOTE\nwrote\n````", 10),
        // The phantom KILL fails (404); the next turn observes the failure.
        makeMockResponse("````KILL (log:///1/2/1) <1,-1>````\n````KILL (log:///9/9/9) <1,-1>````\n````NOTE\ncurated\n````", 10),
        makeMockResponse("````SEND [200]\nthe phantom KILL failed; curation done\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "meta-ops" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(finalStatus, 200, "a curation turn is work, never idleness — the loop concluded");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
            const kills = rows.filter((r) => r.origin === "model" && r.op === "KILL" && JSON.parse(r.tx).target !== null);
            assert.equal(kills.length, 2, `both KILLs recorded in the DB; got ${JSON.stringify(kills)}`);
            assert.deepEqual(kills.map(({ status_rx }) => status_rx), [200, 404], "one success + one failure recorded");
        } finally { ws.close(); }
    });
});
});

describe("turn-preparation", () => {
for (const mode of ["cancel", "cancel-wrapped", "cancel-context", "deadline", "deadline-wrapped", "internal", "internal-after-cancel", "foreign-abort-after-cancel", "aggregate-after-cancel"] as const) {
    test(`{§turn-record}: ${mode} during preparation retains its cause and performs no inference`, async (t) => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `preparation-${mode}`);
            const sessionId = await insertSession(db, workspaceId, null, "subject");
            const loopId = await insertLoop(db, sessionId, 1, "prepare");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const controller = new AbortController();
            const deadline = mode.startsWith("deadline");
            const cancelled = deadline || mode.startsWith("cancel");
            const reason = deadline ? LOOP_TIMEOUT_REASON : new Error("owner cancelled preparation");
            let thrown: unknown;
            // {§context-fit} — initialization measures its own rows through the same builder; the failure under
            // test belongs to the inference turn's preparation, after initialization completed.
            const build = PacketBuilder.prototype.buildRequestPacket;
            t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, args: Parameters<PacketBuilder["buildRequestPacket"]>[0]) {
                if (args.currentTurnSeq === 1) return build.call(this, args);
                if (mode !== "internal") controller.abort(reason);
                if (mode.endsWith("wrapped") || mode === "cancel-context") {
                    try {
                        await delay(1, undefined, { signal: controller.signal });
                    } catch (cause) {
                        thrown = mode === "cancel-context" ? new Error("preparation dependency failed", { cause }) : cause;
                        throw thrown;
                    }
                }
                thrown = cancelled ? reason : new Error("packet construction failed");
                if (mode === "foreign-abort-after-cancel") thrown = new DOMException("unrelated abort", "AbortError");
                if (mode === "aggregate-after-cancel") thrown = new AggregateError([reason, thrown], "preparation and cleanup failed", { cause: reason });
                throw thrown;
            });
            const provider = new Mock({ contextWindow: 100_000, responses: [] });
            const running = engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], signal: controller.signal });
            if (deadline) {
                const result = await running;
                assert.equal(result.result.status, 504);
                assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } else {
                await assert.rejects(running, (cause) => cause === thrown, "the original preparation cause remains intact");
            }
            const turns = await db.test_list_turns_in_loop.all<{
                status: number; completed_at: string | null; packet: string | null;
            }>({ loop_id: loopId });
            assert.deepEqual(turns.map(({ status }) => status), [200, deadline ? 504 : cancelled ? 499 : 500], "completed initialization is unchanged; only the open inference turn is settled");
            assert.ok(turns.every(({ completed_at }) => completed_at !== null));
            assert.equal(turns.at(-1)?.packet, null, "failed preparation does not fabricate a request packet");
            assert.equal(provider.received.length, 0);
            assert.deepEqual(await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }), [], "preparation failure is not a provider call");
            assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: sessionId }), [], "no provider problem is fabricated");
        } finally { await db.close(); }
    });
}
});

describe("turns", () => {
// {§packet-items} — the stored bag carries no sections; they are rows.
const MIN_PACKET = JSON.stringify({
    weight: 0,
    attributions: [],
    assistant: { content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

const seedLoop = async (db: Db): Promise<number> => {
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return insertLoop(db, sessionId, 1);
};

const setup = async () => {
    const db = await openMigrated();
    const loopId = await seedLoop(db);
    return { db, loopId };
};

test("{§packet-items} turns: table is STRICT", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("{§packet-items} turns: insert with required fields — defaults populate", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        const row = await db.test_turns_get_full.get<{
            id: number; version: number; loop_id: number; sequence: number; timestamp: string;
            producer: string; kind: string; status: number; completed_at: string | null;
            usage_curation_budget: number | null; packet: string;
        }>({ loop_id: loopId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.sequence, 1);
        assert.equal(row?.producer, "model");
        assert.equal(row?.kind, "inference");
        assert.match(row?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.match(row?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.status, 200);
        assert.equal(row?.usage_curation_budget, null);
        // {§packet-items} — read back through turn_packets, the bag carries its (empty) sections.
        assert.deepEqual(JSON.parse(row?.packet ?? "null"), { ...JSON.parse(MIN_PACKET), sections: [] });
    } finally { await db.close(); }
});

test("{§packet-items} turns: status range CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [seq, status] of [[1, 100], [2, 200], [3, 499], [4, 599]] as const) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: seq, status, packet: MIN_PACKET });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: 99, status: bad, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet-items} turns: sequence < 1 rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const bad of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: bad, status: 200, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet-items} turns: (loop_id, sequence) UNIQUE", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: sequence resets per loop", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-crossloop");
        const sessionId = await insertSession(db, workspaceId);
        const loopA = await insertLoop(db, sessionId, 1);
        const loopB = await insertLoop(db, sessionId, 2);
        await db.test_turns_insert.run({ loop_id: loopA, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopB, sequence: 1, status: 200, packet: MIN_PACKET });
        const count = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("{§packet-items} turns: loop_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_loop_id.run({ sequence: 1, status: 200, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.loop_id/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: status NOT NULL", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_status.run({ loop_id: loopId, sequence: 1, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.status/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: NULL packet means no model request was assembled", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert_missing_packet.run({ loop_id: loopId, sequence: 1, status: 200 });
        const row = await db.test_turns_get_full.get<{ packet: string | null }>({ loop_id: loopId });
        assert.equal(row?.packet, null);
    } finally { await db.close(); }
});

test("{§packet-items} turns: packet CHECK enforces the request/admitted-response root algebra", async () => {
    const { db, loopId } = await setup();
    try {
        const invalid = [
            "{}",
            "[]",
            "null",
            JSON.stringify({ tokens: 0 }),
            JSON.stringify({ tokens: 0, sections: [], assistant: { content: "", ops: [], reasoning: null } }),
            JSON.stringify({ tokens: 0, sections: [], assistantRaw: null }),
            // {§packet-items} — sections never ride in the bag
            JSON.stringify({ weight: 0, sections: [], attributions: [] }),
        ];
        for (const [index, packet] of invalid.entries()) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet }),
                /CHECK constraint failed/,
                `invalid packet ${packet}`,
            );
        }
    } finally { await db.close(); }
});

test("{§packet-items} Turn: every non-model producer uses the same operation-turn lifecycle", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [index, producer] of (["client", "_plurnk"] as const).entries()) {
            const turn = await Turn.open(db, { loopId, producer, kind: "operation" });
            const open = await db.test_get_turn.get<{
                producer: string; kind: string; status: number; completed_at: string | null; packet: string | null;
            }>({ id: turn.id });
            assert.deepEqual(open, {
                id: turn.id,
                loop_id: loopId,
                sequence: index + 1,
                producer,
                kind: "operation",
                status: 102,
                completed_at: null,
                finish_reason: null,
                model: null,
                packet: null,
            });
            await Turn.complete(db, turn.id, 204);
            const completed = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
            assert.equal(completed?.status, 204);
            assert.match(completed?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
    } finally { await db.close(); }
});

test("{§packet-items} turns: producer and kind are required and reject incoherent identities", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_producer.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.producer/,
        );
        await assert.rejects(
            () => db.test_turns_insert_missing_kind.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.kind/,
        );
        for (const [sequence, producer, kind, packet] of [
            [1, "nobody", "operation", null],
            [2, "client", "mystery", null],
            [3, "client", "inference", MIN_PACKET],
            [4, "model", "operation", null],
            [5, "client", "initialization", null],
            [6, "client", "operation", MIN_PACKET],
        ] as const) {
            await assert.rejects(
                () => db.test_turns_insert_identity.run({
                    loop_id: loopId, sequence, producer, kind, status: 200, packet,
                }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§packet-items} Turn: producer is immutable and model calls require inference", async () => {
    const { db, loopId } = await setup();
    try {
        const operation = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        await assert.rejects(
            () => db.engine_open_model_call.get({
                turn_id: operation.id,
                kind: "emission",
                attributions: "[]",
                model: "mock/model",
            }),
            /inference call requires a valid owning workspace and causal context/,
        );
        await assert.rejects(
            () => db.test_turns_update_identity.run({
                id: operation.id,
                producer: "_plurnk",
                kind: "operation",
            }),
            /turn producer and kind are immutable/,
        );
        await assert.rejects(
            () => Turn.recordInference(db, operation.id, {
                packet: MIN_PACKET,
                sections: "[]",
                usageCurationBudget: null,
                finishReason: null,
                model: "mock/model",
                meta: "{}",
            }),
            /not an open model inference turn/,
        );

        const inference = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await assert.rejects(
            () => db.test_turns_update_identity.run({ id: inference.id, producer: "_plurnk", kind: "operation" }),
            /turn producer and kind are immutable/,
        );
    } finally { await db.close(); }
});

test("{§turn-record} inference history prevents changing the turn producer", async () => {
    const { db, loopId } = await setup();
    try {
        const emitted = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.engine_open_model_call.get({ turn_id: emitted.id, kind: "emission", attributions: "[]", model: "mock/model" });
        await assert.rejects(() => db.test_turns_update_identity.run({ id: emitted.id, producer: "_plurnk", kind: "operation" }), /turn producer and kind are immutable/, "a model emission is history; the producer cannot change beneath it");
    } finally { await db.close(); }
});

test("{§packet-items} turns: malformed JSON in packet rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: "{not json" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: loop_id FK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: 99999, sequence: 1, status: 200, packet: MIN_PACKET }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: ON DELETE CASCADE via loop", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        await db.test_turns_loops_delete.run({ id: loopId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§packet-items} turns: CASCADE chain workspace→sessions→loops→turns", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-fullchain");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§packet-items} turns: curation budget is a positive optional gauge denominator", async () => {
    const { db, loopId } = await setup();
    try {
        for (const curationBudget of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert_with_curation_budget.run({
                    loop_id: loopId,
                    sequence: 1,
                    status: 200,
                    packet: MIN_PACKET,
                    curation_budget: curationBudget,
                }),
                /CHECK constraint failed/,
            );
        }
        await db.test_turns_insert_with_curation_budget.run({
            loop_id: loopId,
            sequence: 1,
            status: 200,
            packet: MIN_PACKET,
            curation_budget: 200_000,
        });
        const row = await db.test_turns_get_curation_budget.get<{
            usage_curation_budget: number;
        }>({ loop_id: loopId });
        assert.equal(row?.usage_curation_budget, 200_000);
    } finally { await db.close(); }
});

test("{§packet-items} turns: negative version rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_with_version.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET, version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§packet-items} turns: unique index turns_loop_id_sequence exists", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_index_meta.get<{ name: string; sql: string }>({ name: "turns_loop_id_sequence" });
        assert.equal(row?.name, "turns_loop_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("{§packet-items} turns: id auto-assigns on insert", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        const rows = await db.test_turns_list_ids.all<{ id: number }>({ loop_id: loopId });
        assert.equal(rows[1].id, rows[0].id + 1);
    } finally { await db.close(); }
});
});

describe("undelivered-child-term", () => {
// {§loop-completion}: sessions concluding DURING the parent's generation are no
// longer live, but their ambient event is newer than the parent's observation cursor and queued
// for the next packet. Both dispositions must preserve that completed-but-unobserved result.











async function raceScenario(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `race-${crypto.randomUUID()}`);
    const parent = await insertSession(db, workspaceId);
    const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "```NOTE\nCollect the child result.\n```", reasoning: null } }] }),
        workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
    });
    const { id: parentTurn } = await Turn.open(db, { loopId: parentLoop, producer: "model", kind: "inference" });
    // A child spawned by the parent concludes after the parent's turn opened.
    const child = await insertSession(db, workspaceId, parent, "session-x");
    const childLoop = await insertLoop(db, child, 1, "fetch the value");
    await insertTurn(db, childLoop, 1, 102);
    await new LoopLifecycle(db).finish(childLoop, {
        status: 200,
        content: "the value is 42",
        mimetype: "text/markdown",
    });
    return { workspaceId, parent, parentLoop, parentTurn, engine };
}

test("{§session-loop-lifecycle} waiting on a just-concluded child continues until the result is delivered", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: dispositionStmt("WAIT", "Waiting for session-x."), workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait is NOT on nothing — the child's deliverable is on the doorstep; continue");
        const loop = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.notEqual(loop?.status, 200, "the loop did not conclude over the undelivered result");
    } finally { await db.close(); }
});

// A branch batch that fails git-preflight finishes the child's loop before the child ever had a
// turn. Its termination still announces to the parent, which never waits on a child that cannot
// report (#385).
test("{§loop-completion} a child refused before its first turn still announces its death to the parent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ghost-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 102);
        const child = await insertSession(db, workspaceId, parent, "session-ghost");
        const childLoop = await insertLoop(db, child, 1, "implement");
        await new LoopLifecycle(db).finish(childLoop, Results.failure(
            "lifecycle:branch",
            "branch-checkout-dirty",
            409,
            "The project repository has staged, unstaged, or nonignored untracked changes.",
            {},
            { stage: "git-preflight", retryable: false },
        ));
        const pending = await db.engine_session_has_undelivered_child_term.get<{ pending: number }>({ session_id: parent });
        assert.ok(pending !== undefined, "the refused spawn is an undelivered child termination");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.dispatch({ statement: dispositionStmt("WAIT", "Waiting for session-ghost."), workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait continues so the failure lands in the next packet instead of parking on a ghost");
    } finally { await db.close(); }
});

test("{§loop-completion} a delivered answer cannot complete before the just-concluded child is observed", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.executeAdmittedTurn({ statements: [completeStmt("done")], source: null, emission: null, workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, fromSequence: 1, origin: "model" });
        assert.equal(r.status, 102, "concluding over an undelivered session result is deferred, never refused");
        assert.deepEqual(r.outcomes, [{ op: "SEND", status: 200, problemType: null }]);
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "", reasoning: null } }] });
        const observed = await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages: [] });
        assert.equal(observed.status, 200);
        assert.match(JSON.stringify(provider.received[0]), /the value is 42/);
    } finally { await db.close(); }
});
});

describe("wait-duration", () => {
// {§session-wait-timing} Real subprocesses exercise wait expiry independently of their lifetime.







// Observation begins only after optimistic settlement declines to keep waiting.
// This suite isolates the parked observation itself.
const disableOptimisticWait = (t: test.TestContext) => {
    const prev = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prev;
    });
};

test("{§notice-drain-on-read} cancelling a parked loop releases its undelivered feedback", async (t) => {
    disableOptimisticWait(t);
    serverProposals(t, "accept");
    const pushed = t.mock.method(NoticeChannel.prototype, "push");
    const deleted = t.mock.method(NoticeChannel.prototype, "delete");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse("````sh\nsleep 30\n````\n\n````WAIT 15\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cancel-wait-feedback" });
            const notices = subscribeNotifications(ws, "notice/event");
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            const { loopId } = response.result as { loopId: number };
            await waitFor(() => notices() as Array<{ loopId: number; notice: { kind: string; status?: number } }>,
                (items) => items.some((item) => item.loopId === loopId && item.notice.kind === "loop_status" && item.notice.status === 202));
            const warning = pushed.mock.calls.find(({ arguments: args }) => args[2] === loopId && args[3].kind === "parse_advisory");
            assert.ok(warning, "the real parser generated feedback for the parked loop");
            const channel = warning.this as NoticeChannel;
            assert.equal(deleted.mock.calls.some((call) => call.this === channel && call.arguments[0] === loopId), false,
                "parking is not terminal cleanup");
            await rpcCall(ws, 3, "loop.cancel", {});
            await waitFor(() => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (items) => items.some((item) => item.loopId === loopId && item.result.status === 499));
            assert.deepEqual(channel.drain(loopId), [], "cancellation releases feedback without another model call");
            assert.equal(mock.received.length, 1);
        } finally { ws.close(); }
    });
});

for (const header of ["WAIT", "WAIT [0]"]) {
    test(`{§session-loop-lifecycle} ${header} resumes a loop without closing its open stream`, async (t) => {
        disableOptimisticWait(t);
    serverProposals(t, "accept");
        const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
        process.env.PLURNK_SERVICE_WAIT_SEC = "1";
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse(`\`\`\`\`sh [{"lifetime": "30m"}]\nsleep 30\n\`\`\`\`\n\n\`\`\`\`${header}\nawait the result\n\`\`\`\``, 10),
            makeMockResponse("````SEND\nobserved the still-open stream\n````\n````KILL (session://root)\n````", 10),
        ] });
        try {
            await withDaemon(mock, async (db, daemon, addr) => {
                const ws = await connect(addr);
                const notices = subscribeNotifications(ws, "notice/event");
                try {
                    const workspace = await rpcCall(ws, 1, "workspace.create", { name: "wait-duration" });
                    const { sessionId } = await daemon.createSession({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                    const generate = mock.generate.bind(mock);
                    let observedLiveStream = false;
                    t.mock.method(mock, "generate", async (args: Parameters<typeof mock.generate>[0]) => {
                        if (mock.received.length === 1) {
                            assert.equal((await db.session_live_obligations.get({ session_id: sessionId }))?.streams, 1,
                                "continuation preserves the still-running subprocess");
                            const loops = await daemon.listSessionLoops({ workspaceId: (workspace.result as { id: number }).id, sessionId });
                            assert.equal(loops.at(-1)?.waitUntil, null, "the resumed application projection clears the deadline");
                            observedLiveStream = true;
                        }
                        return generate(args);
                    });
                    const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", sessionId });
                    assert.equal(finalStatus, 499);
                    assert.equal(mock.remaining, 0);
                    assert.equal(observedLiveStream, true, "the wait expired before the 30-second stream concluded");
                    const parks = (notices() as Array<{ notice: { kind: string; status?: number } }>)
                        .filter(({ notice }) => notice.kind === "loop_status" && notice.status === 202);
                    assert.equal(parks.length, header === "WAIT" ? 1 : 0, "zero bypasses parking rather than creating an immediate timer");
                } finally { ws.close(); }
            });
        } finally {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
            else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
        }
    });
}

test("{§session-loop-lifecycle} closure wakes the parked loop exactly once before its wait expires", async (approvalContext) => {
    disableOptimisticWait(approvalContext);
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
    // The duration is far longer than the spawn: the only wake that can arrive is closure.
    process.env.PLURNK_SERVICE_WAIT_SEC = "600";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 3; echo closed\n````\n\n````WAIT\nwaiting for closure\n````", 10),
        makeMockResponse("````SEND [200]\nobserved terminal closure\n````", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "wait-closure" });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3, "initialization plus two model turns; no pre-closure wake consumed the terminal response");
                assert.equal(mock.remaining, 0, "closure produced the only continuation");
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
    }
});
});
