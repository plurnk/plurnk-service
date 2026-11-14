import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { WakeSessionPayload } from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import Results, { type SchemeResult } from "../core/results.ts";
import DrainSupervisor, { type DrainEngine } from "./DrainSupervisor.ts";

const PROVIDER_SPEC = { alias: "mocktest", provider: "openai", model: "mocktest" } as const;

interface InMemoryHarness {
    readonly drains: DrainSupervisor;
    readonly events: Array<{ workspaceId: number; method: string; params: unknown }>;
    readonly loops: Map<number, {
        id: number;
        sessionId: number;
        workspaceId: number;
        sequence: number;
        prompt: string;
        max_turns: number;
        status: number;
        wait_revision: number;
        wait_poll_at: number | null;
        terminated_by: string | null;
        terminal_result: SchemeResult | null;
        unpublishedMessages: number;
        eventReady: boolean;
    }>;
    readonly sessions: Map<number, { workspaceId: number; parentSessionId: number | null; children: number[] }>;
    readonly openSubscriptions: Map<number, Set<number>>;
    readonly liveObligations: Map<number, { streams: 0 | 1; sessions: 0 | 1 }>;
    ensureSession(sessionId: number, workspaceId?: number, parentSessionId?: number | null): void;
    enqueueLoop(sessionId: number, prompt: string, workspaceId?: number): number;
}

const createHarness = (opts: {
    runLoop: ConstructorParameters<typeof DrainSupervisor>[0]["runLoop"];
    engine?: Partial<DrainEngine>;
    hasActiveStreams?: (sessionId: number) => boolean;
}): InMemoryHarness => {
    let nextLoopId = 1;
    let nextMessageId = 1;
    const events: Array<{ workspaceId: number; method: string; params: unknown }> = [];
    const loops: InMemoryHarness["loops"] = new Map();
    const sessions: InMemoryHarness["sessions"] = new Map();
    const openSubscriptions: InMemoryHarness["openSubscriptions"] = new Map();
    const liveObligations: InMemoryHarness["liveObligations"] = new Map();

    const ensureSession = (sessionId: number, workspaceId = 1, parentSessionId: number | null = null): void => {
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, { workspaceId, parentSessionId, children: [] });
            if (parentSessionId !== null) {
                ensureSession(parentSessionId, workspaceId, null);
                sessions.get(parentSessionId)!.children.push(sessionId);
            }
        }
    };

    const collectSubtree = (rootId: number, includeRoot: boolean): number[] => {
        const result: number[] = [];
        const visit = (id: number, isRoot: boolean): void => {
            if (!isRoot || includeRoot) result.push(id);
            for (const child of sessions.get(id)?.children ?? []) visit(child, false);
        };
        visit(rootId, true);
        return result;
    };

    const enqueueLoop = (sessionId: number, prompt: string, workspaceId = 1): number => {
        ensureSession(sessionId, workspaceId);
        const sessionLoops = [...loops.values()].filter((l) => l.sessionId === sessionId);
        const id = nextLoopId++;
        loops.set(id, {
            id,
            sessionId,
            workspaceId: sessions.get(sessionId)!.workspaceId,
            sequence: sessionLoops.length + 1,
            prompt,
            max_turns: 8,
            status: 100,
            wait_revision: 0,
            wait_poll_at: null,
            terminated_by: null,
            terminal_result: null,
            unpublishedMessages: 0,
            eventReady: false,
        });
        return id;
    };

    const db = {
        message_source_by_address: { get: async () => undefined },
        drain_message_source: {
            get: async ({ loop_id }: { loop_id: number }) => {
                const row = loops.get(loop_id);
                return row === undefined ? undefined : { workspace_id: row.workspaceId, status: row.status };
            },
        },
        drain_message_recipient: {
            get: async ({ session_id, loop_id }: { session_id: number; loop_id: number | null }) => {
                if (loop_id !== null) {
                    const row = loops.get(loop_id);
                    return row !== undefined && row.sessionId === session_id && [100, 102, 202].includes(row.status)
                        ? { id: row.id }
                        : undefined;
                }
                const running = [...loops.values()].find((l) => l.sessionId === session_id && l.status === 102);
                if (running !== undefined) return { id: running.id };
                const parked = [...loops.values()]
                    .filter((l) => l.sessionId === session_id && l.status === 202)
                    .toSorted((a, b) => a.sequence - b.sequence)[0];
                return parked === undefined ? undefined : { id: parked.id };
            },
        },
        drain_get_loop_max_turns: {
            get: async ({ loop_id }: { loop_id: number }) => {
                const row = loops.get(loop_id);
                return row === undefined ? undefined : { max_turns: row.max_turns };
            },
        },
        model_route_lookup: { get: async () => ({ id: 1 }) },
        model_route_create: { get: async () => ({ id: 1 }) },
        drain_enqueue_loop: {
            get: async ({ session_id, prompt, max_turns }: { session_id: number; prompt: string; max_turns: number }) => {
                const id = enqueueLoop(session_id, prompt);
                loops.get(id)!.max_turns = max_turns;
                return { id };
            },
        },
        drain_enqueue_message: {
            get: async () => ({ id: nextMessageId++, ordinal: 1 }),
        },
        drain_ready_loop: {
            get: async ({ session_id }: { session_id: number }) => {
                const ready = [...loops.values()]
                    .filter((l) => l.sessionId === session_id && l.status === 100)
                    .toSorted((a, b) => a.sequence - b.sequence)[0];
                return ready === undefined ? undefined : { id: ready.id };
            },
        },
        drain_claim_next_loop: {
            get: async ({ session_id }: { session_id: number }) => {
                const ready = [...loops.values()]
                    .filter((l) => l.sessionId === session_id && l.status === 100)
                    .toSorted((a, b) => a.sequence - b.sequence)[0];
                if (ready === undefined) return undefined;
                ready.status = 102;
                ready.wait_poll_at = null;
                return { id: ready.id, sequence: ready.sequence, prompt: ready.prompt, max_turns: ready.max_turns };
            },
        },
        drain_unpublished_messages_for_loop: {
            get: async ({ loop_id }: { loop_id: number }) => {
                const row = loops.get(loop_id);
                return row !== undefined && row.unpublishedMessages > 0 ? { id: 1 } : undefined;
            },
        },
        drain_find_slept_loop: {
            get: async ({ session_id }: { session_id: number }) => {
                const slept = [...loops.values()].find((l) => l.sessionId === session_id && l.status === 202);
                return slept === undefined ? undefined : { id: slept.id };
            },
        },
        drain_get_session_workspace: {
            get: async ({ session_id }: { session_id: number }) => {
                const session = sessions.get(session_id);
                return session === undefined ? undefined : { workspace_id: session.workspaceId };
            },
        },
        find_open_subscriptions_for_session: {
            all: async ({ session_id }: { session_id: number }) =>
                [...(openSubscriptions.get(session_id) ?? [])].map((id) => ({ id })),
        },
        session_live_obligations: {
            get: async ({ session_id }: { session_id: number }) =>
                liveObligations.get(session_id) ?? { streams: 0, sessions: 0 },
        },
        session_parent_id: {
            get: async ({ session_id }: { session_id: number }) => ({
                parent_session_id: sessions.get(session_id)?.parentSessionId ?? null,
            }),
        },
        loop_termination_wake_recipients: { all: async () => [] },
        message_reply_recipients: { all: async () => [] },
    } as unknown as Db;

    const lifecycle = {
        parked: async (sessionId: number) =>
            [...loops.values()]
                .filter((l) => l.sessionId === sessionId && l.status === 202)
                .map((l) => ({ id: l.id, wait_revision: l.wait_revision, wait_poll_at: l.wait_poll_at })),
        wake: async (
            loopId: number,
            condition: { revision?: number; dueAt?: number; eventOnly?: boolean } = {},
        ) => {
            const row = loops.get(loopId);
            if (row === undefined || row.status !== 202) return false;
            if (condition.revision !== undefined && row.wait_revision !== condition.revision) return false;
            if (condition.dueAt !== undefined && (row.wait_poll_at === null || row.wait_poll_at > condition.dueAt)) {
                return false;
            }
            if (condition.eventOnly === true && !row.eventReady) return false;
            row.status = 100;
            row.wait_poll_at = null;
            row.unpublishedMessages = 0;
            row.eventReady = false;
            return true;
        },
        finish: async (loopId: number, result: SchemeResult, finishOpts?: { terminatedBy?: string }) => {
            const row = loops.get(loopId);
            if (row === undefined || ![100, 102, 202].includes(row.status)) return null;
            row.status = result.status;
            row.terminal_result = result;
            row.terminated_by = finishOpts?.terminatedBy ?? "engine";
            return result;
        },
        cancelled: async (loopId: number) => loops.get(loopId)?.terminated_by === "cancel",
        result: async (loopId: number) => loops.get(loopId)?.terminal_result ?? null,
        turnIds: async () => [1],
        observation: async (loopId: number) => {
            const row = loops.get(loopId);
            const terminal = row !== undefined && ![100, 102, 202].includes(row.status);
            return {
                loopSeq: row?.sequence ?? 1,
                claimedAt: 1_000,
                terminatedAt: terminal ? 2_000 : null,
                packetCount: 1,
            };
        },
        cancelTree: async (rootSessionId: number, reason: string, includeRoot: boolean) => {
            const targetSessions = collectSubtree(rootSessionId, includeRoot);
            const cancelledLoops: Array<{ loopId: number; sessionId: number; result: SchemeResult }> = [];
            for (const targetSessionId of targetSessions) {
                for (const row of loops.values()) {
                    if (row.sessionId !== targetSessionId || ![100, 102, 202].includes(row.status)) continue;
                    const cancelledResult = Results.failure(
                        "lifecycle:cancel",
                        "scope-cancelled",
                        499,
                        `Cancelled: ${reason}`,
                    );
                    row.status = 499;
                    row.terminated_by = "cancel";
                    row.terminal_result = cancelledResult;
                    row.wait_poll_at = null;
                    cancelledLoops.push({ loopId: row.id, sessionId: targetSessionId, result: cancelledResult });
                }
            }
            return { sessionIds: targetSessions, loops: cancelledLoops };
        },
    };

    const engine: DrainEngine = {
        injectIntoLoop: async (loopId) => {
            const row = loops.get(loopId);
            if (row === undefined || ![100, 102, 202].includes(row.status)) return null;
            if (row.status === 102) row.unpublishedMessages++;
            return { loopId, messageId: nextMessageId++, turnSeq: 2 };
        },
        loopUsage: async () => ({} as never),
        loopAttributions: async () => [],
        discardLoopNotices: () => {},
        cancelSubscription: async () => true,
        subscriptionConcluded: async () => {},
        reapLoopStreams: async () => [],
        ...opts.engine,
    };

    const drains = new DrainSupervisor({
        db,
        engine,
        lifecycle: lifecycle as never,
        runLoop: opts.runLoop,
        hasActiveStreams: opts.hasActiveStreams ?? (() => false),
        readSystemPrompt: async () => "system prompt",
        emitLogEntry: async () => {},
        emit: (workspaceId, method, params) => {
            events.push({ workspaceId, method, params });
        },
    });

    return {
        drains,
        events,
        loops,
        sessions,
        openSubscriptions,
        liveObligations,
        ensureSession,
        enqueueLoop,
    };
};

describe("SessionProcess state machine & supervision invariants", () => {
    test("{§session-loop-lifecycle}: SessionProcess spawns on demand, transitions through Running/Parked, and self-reaps on quiescence", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000 });
        let calls = 0;
        const harness = createHarness({
            runLoop: async ({ loopId }) => {
                const row = harness.loops.get(loopId)!;
                if (++calls === 1) {
                    row.status = 202;
                    row.wait_revision = 1;
                    row.wait_poll_at = 6_000;
                    return { result: { status: 202 }, hitMaxTurns: false };
                }
                row.status = 200;
                row.terminal_result = { status: 200 };
                return { result: { status: 200 }, hitMaxTurns: false };
            },
        });
        harness.drains.start();
        assert.equal(harness.drains.activeSessionCount, 0);
        assert.equal(harness.drains.sessionState(10), "stopped");

        harness.ensureSession(10, 1);
        await harness.drains.inject({
            workspaceId: 1,
            sessionId: 10,
            prompt: "park then finish",
            providerSpec: PROVIDER_SPEC,
            effort: "adaptive",
            systemPrompt: "sys",
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.drains.sessionState(10), "parked");
        assert.equal(harness.drains.activeSessionCount, 1);
        assert.equal(harness.drains.activeTimerCount, 1);

        t.mock.timers.tick(1_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await harness.drains.idle();

        assert.equal(calls, 2);
        assert.equal(harness.drains.sessionState(10), "stopped", "actor self-reaps on quiescence");
        assert.equal(harness.drains.activeSessionCount, 0, "zero retained SessionProcess instances at idle");
        assert.equal(harness.drains.activeTimerCount, 0, "zero retained timers at idle");
        assert.equal(harness.drains.activeWorkspaceLockCount, 0, "zero retained workspace locks at idle");
    });

    test("{§session-loop-lifecycle}: nested suspendSession holds claiming while preserving single-consumer FIFO queue order", async () => {
        const claimedOrder: string[] = [];
        const harness = createHarness({
            runLoop: async ({ loopId, prompt }) => {
                claimedOrder.push(prompt);
                const row = harness.loops.get(loopId)!;
                row.status = 200;
                row.terminal_result = { status: 200 };
                return { result: { status: 200 }, hitMaxTurns: false };
            },
        });
        harness.drains.start();
        harness.ensureSession(4, 1);

        const resumeOuter = harness.drains.suspendSession(4);
        const resumeInner = harness.drains.suspendSession(4);
        assert.equal(harness.drains.sessionState(4), "suspended");

        const [first, second, third] = await Promise.all([
            harness.drains.inject({ workspaceId: 1, sessionId: 4, prompt: "one", providerSpec: PROVIDER_SPEC, effort: "adaptive", systemPrompt: "sys" }),
            harness.drains.inject({ workspaceId: 1, sessionId: 4, prompt: "two", providerSpec: PROVIDER_SPEC, effort: "adaptive", systemPrompt: "sys" }),
            harness.drains.inject({ workspaceId: 1, sessionId: 4, prompt: "three", providerSpec: PROVIDER_SPEC, effort: "adaptive", systemPrompt: "sys" }),
        ]);

        assert.deepEqual([first.action, second.action, third.action], [
            "enqueued_new_loop",
            "enqueued_new_loop",
            "enqueued_new_loop",
        ]);
        assert.equal(
            [first, second, third].filter((r) => r.drainPromise !== undefined).length,
            1,
            "exactly one consumer incarnation owns the suspended queue",
        );
        assert.deepEqual(claimedOrder, [], "no loop is claimed while suspended");

        await resumeOuter();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(claimedOrder, [], "outer resume alone does not claim while inner suspend remains");

        await resumeInner();
        await harness.drains.idle();

        assert.deepEqual(claimedOrder, ["one", "two", "three"]);
        assert.equal(harness.drains.activeSessionCount, 0);
    });

    for (const boundaryCase of ["unpublished_message", "settled_event"] as const) {
        test(`{§session-loop-lifecycle} {§session-wait-timing}: atomic park boundary immediately re-queues ${boundaryCase} in the same incarnation`, async () => {
            let segment = 0;
            let parkedEventSeen: boolean | null = null;
            const harness = createHarness({
                runLoop: async ({ loopId }) => {
                    const row = harness.loops.get(loopId)!;
                    if (++segment === 1) {
                        row.status = 202;
                        row.wait_revision = 1;
                        row.wait_poll_at = Date.now() + 60_000;
                        if (boundaryCase === "unpublished_message") row.unpublishedMessages = 1;
                        else row.eventReady = true;
                        return { result: { status: 202 }, hitMaxTurns: false };
                    }
                    row.status = 200;
                    row.terminal_result = { status: 200 };
                    return { result: { status: 200 }, hitMaxTurns: false };
                },
            });
            harness.drains.observe({
                onParked: ({ remainedParked }) => {
                    parkedEventSeen = remainedParked;
                },
            });
            harness.drains.start();
            harness.ensureSession(8, 1);

            const admitted = await harness.drains.inject({
                workspaceId: 1,
                sessionId: 8,
                prompt: "atomic park race",
                providerSpec: PROVIDER_SPEC,
                effort: "adaptive",
                systemPrompt: "sys",
            });
            const outcome = await admitted.firstLoopPromise;
            await harness.drains.idle();

            assert.equal(outcome?.result.status, 200);
            assert.equal(segment, 2, "same incarnation immediately reclaimed the re-queued loop");
            assert.equal(parkedEventSeen, false, "remainedParked accurately reports immediate boundary wake");
            assert.equal(harness.drains.activeTimerCount, 0, "poll timer armed during park was cleared upon boundary wake");
            assert.equal(harness.drains.activeSessionCount, 0);
        });
    }

    test("{§session-causal-admission}: rotated cancellation epochs classify cancelled streams as skipped-aborted without contaminating subsequent streams or single-command KILL", async () => {
        const runningTurn = Promise.withResolvers<void>();
        let turnCount = 0;
        const sub1Payload: WakeSessionPayload = {
            workspaceId: 1,
            sessionId: 5,
            entryId: 1,
            target: "sh:///1/1/1/sh",
            subscriptionId: 101,
            result: { status: 499 },
            scheme: "sh",
            summary: "cancelled",
        };
        const conclusionWaiters = new Map<number, PromiseWithResolvers<void>>([
            [101, Promise.withResolvers<void>()],
        ]);
        const harness = createHarness({
            engine: {
                cancelSubscription: async (id) => {
                    harness.openSubscriptions.get(5)?.delete(id);
                    if (id === 101) {
                        harness.drains.notifyWakeSession(sub1Payload);
                        conclusionWaiters.get(101)!.resolve();
                    }
                    return true;
                },
                subscriptionConcluded: async (id) => {
                    await conclusionWaiters.get(id)?.promise;
                },
            },
            runLoop: async ({ loopId, signal }) => {
                const row = harness.loops.get(loopId)!;
                if (++turnCount === 1) {
                    harness.openSubscriptions.set(5, new Set([101]));
                    runningTurn.resolve();
                    await new Promise<never>((_resolve, reject) => {
                        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                        if (signal.aborted) reject(signal.reason);
                    });
                }
                row.status = 202;
                row.wait_revision = 1;
                row.wait_poll_at = Date.now() + 30_000;
                row.eventReady = true;
                return { result: { status: 202 }, hitMaxTurns: false };
            },
        });
        harness.drains.start();
        harness.ensureSession(5, 1);

        await harness.drains.inject({
            workspaceId: 1,
            sessionId: 5,
            prompt: "first loop",
            providerSpec: PROVIDER_SPEC,
            effort: "adaptive",
            systemPrompt: "sys",
        });
        await runningTurn.promise;

        await harness.drains.cancelSessionTree(5, "user_cancelled");
        await harness.drains.idle();

        // Subsequent stream conclusion on the SAME sessionId after cancellation must NEVER see a stale abort!
        harness.drains.notifyWakeSession({
            ...sub1Payload,
            subscriptionId: 102,
            result: { status: 499 },
            summary: "single-command kill after prior cancel",
        });
        await harness.drains.idle();

        const concluded = harness.events
            .filter((e) => e.method === "stream/concluded")
            .map((e) => e.params as { subscriptionId: number; wakeAction: string });
        assert.deepEqual(concluded, [
            { ...sub1Payload, workspaceId: undefined, wakeAction: "skipped-aborted" },
            {
                ...sub1Payload,
                workspaceId: undefined,
                subscriptionId: 102,
                summary: "single-command kill after prior cancel",
                wakeAction: "no-loop",
            },
        ].map(({ workspaceId: _w, ...rest }) => rest));
        assert.equal(harness.drains.activeSessionCount, 0);
    });

    for (const winner of ["natural_200", "cancel_tree_499", "shutdown_499"] as const) {
        test(`{§session-causal-admission} {§notifications}: loop/terminated publishes once when ${winner} wins the exit race`, async () => {
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const harness = createHarness({
                runLoop: async ({ loopId, signal }) => {
                    entered.resolve();
                    if (winner === "shutdown_499") {
                        await new Promise<never>((_res, rej) => {
                            signal.addEventListener("abort", () => rej(signal.reason), { once: true });
                            if (signal.aborted) rej(signal.reason);
                        });
                    }
                    await release.promise;
                    if (winner === "natural_200") {
                        const row = harness.loops.get(loopId)!;
                        row.status = 200;
                        row.terminal_result = { status: 200 };
                    }
                    return { result: { status: 200 }, hitMaxTurns: false };
                },
            });
            harness.drains.start();
            harness.ensureSession(9, 1);
            await harness.drains.inject({
                workspaceId: 1,
                sessionId: 9,
                prompt: `race ${winner}`,
                providerSpec: PROVIDER_SPEC,
                effort: "adaptive",
                systemPrompt: "sys",
            });
            await entered.promise;

            if (winner === "cancel_tree_499") {
                const cancelTask = harness.drains.cancelSessionTree(9, "operator_cancelled");
                await new Promise<void>((r) => setImmediate(r));
                release.resolve();
                await cancelTask;
            } else if (winner === "natural_200") {
                release.resolve();
                await new Promise<void>((r) => setImmediate(r));
                await harness.drains.cancelSessionTree(9, "late_cancel");
            } else {
                harness.drains.beginStop("daemon_stopping");
            }
            await harness.drains.idle();

            const terminals = harness.events.filter((e) => e.method === "loop/terminated");
            assert.equal(terminals.length, 1, `expected exactly 1 loop/terminated in ${winner}`);
            const status = (terminals[0].params as { result: { status: number } }).result.status;
            assert.equal(status, winner === "natural_200" ? 200 : 499);
            assert.equal(harness.drains.activeSessionCount, 0);
        });
    }

    test("{§session-loop-lifecycle} {§session-causal-admission}: 200 concurrent sessions across 10 workspaces with parks, streams, cancellations, and restarts settle with zero leaks or duplicate terminals", async () => {
        const SESSION_COUNT = 200;
        const WORKSPACE_COUNT = 10;
        const stepCounts = new Map<number, number>();
        const harness = createHarness({
            runLoop: async ({ sessionId, loopId, signal }) => {
                const count = (stepCounts.get(loopId) ?? 0) + 1;
                stepCounts.set(loopId, count);
                await new Promise<void>((resolve, reject) => {
                    const t = setTimeout(resolve, (sessionId % 5) + 1);
                    const onAbort = (): void => {
                        clearTimeout(t);
                        reject(signal.reason ?? new Error("aborted"));
                    };
                    signal.addEventListener("abort", onAbort, { once: true });
                    if (signal.aborted) onAbort();
                });
                const row = harness.loops.get(loopId)!;
                // Every 3rd session parks once at 202 with a short deadline before finishing on segment 2.
                if (sessionId % 3 === 0 && count === 1 && row.status === 102) {
                    row.status = 202;
                    row.wait_revision = 1;
                    row.wait_poll_at = Date.now() + 4;
                    return { result: { status: 202 }, hitMaxTurns: false };
                }
                if (row.status === 102) {
                    row.status = 200;
                    row.terminal_result = { status: 200 };
                }
                return { result: { status: 200 }, hitMaxTurns: false };
            },
        });
        harness.drains.start();

        for (let s = 1; s <= SESSION_COUNT; s++) {
            const wsId = ((s - 1) % WORKSPACE_COUNT) + 1;
            const parentId = s > 20 && s % 10 === 0 ? s - 10 : null;
            harness.ensureSession(s, wsId, parentId);
        }

        // Wave 1: launch all 200 sessions concurrently, plus concurrent stream conclusions and cancellations.
        const ops: Array<Promise<unknown>> = [];
        for (let s = 1; s <= SESSION_COUNT; s++) {
            const wsId = ((s - 1) % WORKSPACE_COUNT) + 1;
            ops.push(
                harness.drains.inject({
                    workspaceId: wsId,
                    sessionId: s,
                    prompt: `wave1-${s}`,
                    providerSpec: PROVIDER_SPEC,
                    effort: "adaptive",
                    systemPrompt: "sys",
                }),
            );
            if (s % 4 === 0) {
                harness.drains.notifyWakeSession({
                    workspaceId: wsId,
                    sessionId: s,
                    entryId: s,
                    target: `sh:///1/1/${s}/sh`,
                    subscriptionId: 10_000 + s,
                    result: { status: 200 },
                    scheme: "sh",
                    summary: "stream done",
                });
            }
            if (s % 7 === 0) {
                ops.push(
                    new Promise<void>((resolve) => setTimeout(resolve, 2)).then(() =>
                        harness.drains.cancelSessionTree(s, "stress_cancel"),
                    ),
                );
            }
        }
        await Promise.allSettled(ops);
        await harness.drains.idle();

        // Wait for any short 4ms parked timers from Wave 1 to fire and drain to completion.
        while (harness.drains.activeTimerCount > 0 || harness.drains.activeSessionCount > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            await harness.drains.idle();
        }

        // Wave 2: re-run every cancelled session (s % 7 === 0) to prove zero stale-abort / epoch contamination!
        const wave2Loops: number[] = [];
        const wave2 = [];
        for (let s = 7; s <= SESSION_COUNT; s += 7) {
            const wsId = ((s - 1) % WORKSPACE_COUNT) + 1;
            wave2.push(
                harness.drains.inject({
                    workspaceId: wsId,
                    sessionId: s,
                    prompt: `wave2-after-cancel-${s}`,
                    providerSpec: PROVIDER_SPEC,
                    effort: "adaptive",
                    systemPrompt: "sys",
                }).then((res) => {
                    wave2Loops.push(res.loopId);
                }),
            );
        }
        await Promise.all(wave2);
        while (harness.drains.activeTimerCount > 0 || harness.drains.activeSessionCount > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            await harness.drains.idle();
        }

        const terminalEvents = harness.events
            .filter((e) => e.method === "loop/terminated")
            .map((e) => e.params as { loopId: number; result: { status: number } });
        const countsByLoop = new Map<number, number>();
        for (const ev of terminalEvents) {
            countsByLoop.set(ev.loopId, (countsByLoop.get(ev.loopId) ?? 0) + 1);
        }

        for (const loopRow of harness.loops.values()) {
            assert.ok(![100, 102, 202].includes(loopRow.status), `loop ${loopRow.id} must be terminal`);
            assert.equal(
                countsByLoop.get(loopRow.id),
                1,
                `loop ${loopRow.id} (status ${loopRow.status}) must publish loop/terminated exactly once`,
            );
        }
        for (const loopId of wave2Loops) {
            assert.equal(harness.loops.get(loopId)?.status, 200, `post-cancel loop ${loopId} must complete 200`);
        }
        assert.equal(harness.drains.activeSessionCount, 0, "all 200 SessionProcess actors self-reaped");
        assert.equal(harness.drains.activeTimerCount, 0, "zero timers remain");
        assert.equal(harness.drains.activeWorkspaceLockCount, 0, "zero workspace locks remain");
    });

    for (const coalesceExit of ["quiescent", "deadline", "cancelled"] as const) {
        test(`{§session-causal-admission}: Coalescing state settles via ${coalesceExit} and self-reaps cleanly`, async (t) => {
            const prevWindow = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "50";
            t.after(() => {
                if (prevWindow === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prevWindow;
            });

            let calls = 0;
            const harness = createHarness({
                runLoop: async ({ loopId }) => {
                    const row = harness.loops.get(loopId)!;
                    if (++calls === 1) {
                        row.status = 202;
                        row.wait_revision = 1;
                        row.wait_poll_at = null;
                        return { result: { status: 202 }, hitMaxTurns: false };
                    }
                    row.status = 200;
                    row.terminal_result = { status: 200 };
                    return { result: { status: 200 }, hitMaxTurns: false };
                },
            });
            harness.drains.start();
            harness.ensureSession(15, 1);
            harness.liveObligations.set(15, { streams: 1, sessions: 1 });

            await harness.drains.inject({
                workspaceId: 1,
                sessionId: 15,
                prompt: "park and coalesce",
                providerSpec: PROVIDER_SPEC,
                effort: "adaptive",
                systemPrompt: "sys",
            });
            await harness.drains.idle();

            const loopRow = [...harness.loops.values()][0];
            loopRow.eventReady = true;

            const coalescing = harness.drains.settleCompletionWake(1, 15, "sys");
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(harness.drains.sessionState(15), "coalescing");

            if (coalesceExit === "quiescent") {
                harness.liveObligations.set(15, { streams: 0, sessions: 0 });
                const joined = harness.drains.settleCompletionWake(1, 15, "sys");
                await Promise.all([coalescing, joined]);
            } else if (coalesceExit === "deadline") {
                await coalescing;
            } else {
                await harness.drains.cancelSessionTree(15, "cancel_coalesce");
                await coalescing;
            }
            await harness.drains.idle();

            assert.equal(loopRow.status, coalesceExit === "cancelled" ? 499 : 200);
            assert.equal(harness.drains.sessionState(15), "stopped");
            assert.equal(harness.drains.activeSessionCount, 0);
        });
    }
});
