// The orchestration engine, tested against a mock seam — the pieces compose: a worker
// re-surfaces pending + drives the loop, live events fan to the bound thread as AG-UI,
// a proposal reaches the thread as a tool-call, and a resume resolves it. No daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import Portal from "./Portal.ts";
import { spendState, stateSnapshot, statusState } from "./AguiPlus.ts";
import type {
    ApplicationLoopProjection,
    ApplicationWorkerProjection,
    ClientInteractionProjection,
    ProposalProjection,
    ProposalResolution,
    ProviderAccounting,
} from "@plurnk/plurnk-contracts";
import { EventType, type AguiEvent } from "./types.ts";
import type { Interrupt } from "@ag-ui/core";
import type { ClientInteractionResolution } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { loopUsage } from "../test/accounting-fixture.ts";
import { streamEvent, termination } from "../test/notification-fixture.ts";
import { wireRow } from "../test/log-fixture.ts";

const OWNER = "agui://anonymous/threads/tui";

const capture = (portal: Portal, events: AguiEvent[]) => {
    const interrupts = new Map<string, Interrupt>();
    return {
        emit(batch: AguiEvent[]): void {
            events.push(...batch);
            for (const event of batch) {
                if (event.type !== "TOOL_CALL_END") continue;
                const interrupt = portal.interruptForToolCall(event.toolCallId);
                if (interrupt !== null) interrupts.set(event.toolCallId, interrupt);
            }
        },
        interrupt(toolCallId: string): Interrupt {
            const interrupt = interrupts.get(toolCallId);
            assert.ok(interrupt, `missing presented interrupt for ${toolCallId}`);
            return interrupt;
        },
    };
};

const proposal = (over: Partial<ProposalProjection> = {}): ProposalProjection => ({
    logEntryId: 5,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", authority: null, pathname: "a" },
    body: "diff",
    attrs: {},
    owner: OWNER,
    disposition: { decision: "review" },
    ...over,
});

const interaction = (over: Partial<ClientInteractionProjection> = {}): ClientInteractionProjection => ({
    interactionId: 12,
    recipient: OWNER,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    request: {
        toolName: "choose_color",
        arguments: { palette: "warm" },
        message: "Choose one color.",
        responseSchema: {
            type: "object",
            properties: { color: { type: "string" } },
            required: ["color"],
        },
    },
    ...over,
});

const worker = (
    id: number,
    parentWorkerId: number | null = null,
): ApplicationWorkerProjection => ({
    id,
    name: `worker-${id}`,
    created_at: "2026-08-28 12:00:00",
    origin: "model",
    owner: OWNER,
    parentWorkerId,
    kind: (parentWorkerId === null ? "root" : "work") as "root" | "fork" | "work",
    lifecycle: "idle" as const,
});

const loop = (workerId: number, id: number): ApplicationLoopProjection => ({
    id,
    workerId,
    sequence: 1,
    status: 202,
    prompt: "",
    promptSource: null,
    claimedAt: null,
    terminatedAt: null,
    terminalResult: null,
    packetCount: 1,
    waitUntil: null, invocation: null,
});

const mockSeam = (
    pending: ProposalProjection[] = [],
    pendingInteractions: ClientInteractionProjection[] = [],
    topology: {
        workers?: ApplicationWorkerProjection[];
        loops?: ReadonlyMap<number, ApplicationLoopProjection[]>;
    } = {},
) => {
    // The real seam holds a Set of handlers (Portal subscribes twice: render + HITL);
    // mirror that so both fire, not just the last registered.
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const workers: Array<{ workspaceId: number; prompt: string }> = [];
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const interactionResolves: Array<{
        interactionId: number;
        resolution: ClientInteractionResolution;
    }> = [];
    let cancelled: number | null = null;
    const cancelledLoops: Array<{ workspaceId: number; loopId: number; reason?: string }> = [];
    const seam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => pending,
        pendingClientInteractions: async () => pendingInteractions,
        listWorkers: async () => topology.workers ?? [worker(10)],
        listWorkerLoops: async ({ workerId }) => topology.loops?.get(workerId) ?? [],
        workerAccounting: async () => ({ requests: [], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null }),
        resolveProposal: async (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            const index = pending.findIndex((item) => item.logEntryId === logEntryId);
            if (index >= 0) pending.splice(index, 1);
        },
        resolveClientInteraction: async (interactionId, resolution) => {
            interactionResolves.push({ interactionId, resolution });
            const index = pendingInteractions.findIndex((item) => item.interactionId === interactionId);
            if (index >= 0) pendingInteractions.splice(index, 1);
        },
        runLoop: async (a) => { workers.push({ workspaceId: a.workspaceId, prompt: a.prompt }); return { status: 100, action: "enqueued_new_loop" as const, loopId: 77 }; },
        cancelDrain: (workerId) => { cancelled = workerId; return true; },
        cancelLoop: async (args) => { cancelledLoops.push(args); return true; },
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        readLog: async () => [],
        listProviders: () => ({ aliases: [] }),
    } satisfies Pick<ApplicationPort, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "pendingClientInteractions" | "resolveClientInteraction" | "listWorkers" | "listWorkerLoops" | "workerAccounting" | "runLoop" | "cancelDrain" | "cancelLoop" | "dispatchClientAction" | "readLog" | "listProviders">;
    return {
        seam,
        fire: (s: number | null, m: string, p: unknown) => handlers.forEach((h) => h(s, m, p)),
        workers,
        resolves,
        interactionResolves,
        cancelled: () => cancelled,
        cancelledLoops,
    };
};

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("{§agui-status-spend} {§agui-status-children}: status deltas follow the snapshot and patch only what the client does not hold; a stale read never lands", async () => {
    const m = mockSeam();
    const request = { provider: "openai", model: "mocktest", outcome: "response" as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        cost: { kind: "estimated" as const, amount: { amount: "0.01", currency: "USD" }, source: "fixture" } };
    const accounting = (count: number): ProviderAccounting => ({
        requests: Array.from({ length: count }, () => request),
        usage: { inputTokens: 10 * count, outputTokens: 2 * count, totalTokens: 12 * count },
        knownUsage: { inputTokens: 10 * count, outputTokens: 2 * count, totalTokens: 12 * count },
        costUsd: null, knownCostUsd: null,
    });
    let spent = 1;
    let hold = false;
    const held: Array<() => void> = [];
    const portal = new Portal({ ...m.seam, workerAccounting: async () => {
        const count = spent;
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        return accounting(count);
    } });
    portal.start();
    const events: AguiEvent[] = [];
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", notificationScope: "worker", emit: (batch) => events.push(...batch) });
    // Another worker's turn settled: a moment the bound worker's spend may have changed, and nothing else to route.
    const settled = () => m.fire(3, "notice/event", { workerId: 20, loopId: 5, notice: { source: "engine:turn", kind: "turn_generated", level: "info" } });
    const spends = () => events.flatMap((event) => event.type === "STATE_DELTA" ? event.delta : [])
        .filter((op) => op.path === "/plurnk/status/spend").map((op) => ("value" in op ? (op.value as { requests: number }).requests : null));
    const drain = async () => { for (let i = 0; i < 4; i++) await nextTask(); };

    spent = 2;
    settled();
    await drain();
    assert.equal(events.length, 0, "nothing patches a gauge the client does not hold yet");
    events.push(...portal.runStarted(thread, stateSnapshot({ status: statusState(null, null, spendState(accounting(1))) })));
    await drain();
    assert.deepEqual(events.slice(0, 2).map(({ type }) => type), ["RUN_STARTED", "STATE_SNAPSHOT"]);
    assert.deepEqual(spends(), [2], "the spend that settled while the snapshot was read follows it");

    settled();
    await drain();
    assert.deepEqual(spends(), [2], "what the client holds is not published again");

    hold = true;
    spent = 3;
    settled();
    spent = 4;
    settled();
    assert.equal(held.length, 2);
    held[1]!();
    await drain();
    held[0]!();
    await drain();
    assert.deepEqual(spends(), [2, 4], "the later read is published; the earlier one, completing last, is not");
    hold = false;

    spent = 5;
    events.push(...portal.replaceStatus(thread, statusState(null, null, spendState(accounting(5)))));
    await drain();
    settled();
    await drain();
    assert.deepEqual(spends(), [2, 4], "a whole-gauge replacement is what the client holds from then on");
    portal.stop();
});

test("{§agui-shutdown}: close bypasses stream deferral, releases Runs once and rejects new binding", () => {
    const m = mockSeam();
    const portal = new Portal(m.seam);
    portal.start();
    const events: AguiEvent[] = [];
    const args = { workspaceId: 3, workerId: 10, threadId: "tui", notificationScope: "worker" as const,
        emit: (batch: AguiEvent[]) => events.push(...batch) };
    const thread = portal.openThread(args);
    m.fire(3, "stream/event", streamEvent({ entryId: 5, workerId: 10, target: "sh:///abcd1234", scheme: "sh", contentLength: 5 }));
    portal.finishThread(thread, []);
    assert.ok(!events.some(({ type }) => type === "RUN_FINISHED"));
    portal.stop();
    portal.stop();
    assert.equal(events.filter(({ type }) => type === "RUN_ERROR").length, 1);
    assert.equal(events.at(-1)?.type, "RUN_ERROR");
    assert.equal(m.cancelled(), null);
    assert.throws(() => portal.openThread(args), /The PLURNK service is shutting down/u);
});

test("{§agui-worker-owner}: an idle owner receives a gate without an ancestor loop; an observer cannot claim it", async () => {
    const m = mockSeam([], [], { workers: [worker(10), worker(20)] });
    const ownerEvents: AguiEvent[] = [];
    const observerEvents: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER,
        notificationScope: "worker", emit: (events) => ownerEvents.push(...events) });
    portal.openThread({ workspaceId: 3, workerId: 20, threadId: "observer",
        notificationScope: "worker", emit: (events) => observerEvents.push(...events) });
    m.fire(3, "loop/proposal", proposal({ workerId: 20, loopId: 22 }));
    await nextTask();
    assert.ok(ownerEvents.some(({ type }) => type === "TOOL_CALL_START"));
    assert.equal(observerEvents.some(({ type }) => type === "TOOL_CALL_START"), false);
    portal.stop();
});

test("a worker without pending interrupts drives the loop, then live events fan as AG-UI", async () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (evs) => seen.push(...evs) });

    const ack = await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "go" });
    assert.ok(ack !== null);
    assert.equal(ack.loopId, 77, "loop driven via runLoop");
    assert.deepEqual(m.workers[0], { workspaceId: 3, prompt: "go" });

    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "start" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "content", delta: "working" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "end" });
    assert.ok(seen.some((e) => e.type === "REASONING_MESSAGE_CONTENT"), "live reasoning reaches the bound thread before a log row exists");

    // A live model SEND fans to the thread as assistant speech.
    seen.length = 0;
    m.fire(3, "log/entry", { entry: { id: 2, worker_id: 10, loop_id: 77, origin: "model", op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/tui/messages/m1"] }, loop_seq: 1, turn_seq: 1, sequence: 1, tx: { body: "hi" }, turn_id: 1 } });
    assert.ok(seen.some((e) => e.type === "TEXT_MESSAGE_CONTENT"), "live speech rendered to the bound thread");

    // Workspace topology is visible, but another loop's terminal must never
    // conclude this AG-UI Run.
    seen.length = 0;
    m.fire(3, "loop/terminated", termination({
        workerId: 10,
        loopId: 88,
        result: {
            status: 499,
            problem: {
                type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled",
                title: "Loop cancelled",
                status: 499,
                detail: "The foreign loop was cancelled.",
                instance: "ops://worker/88",
            },
        },
        hitMaxTurns: false,
        turnIds: [],
        usage: loopUsage({ curationBudget: 1000 }),
    }));
    assert.equal(seen.length, 0, "a foreign loop terminal cannot end this AG-UI Run");

    m.fire(3, "loop/terminated", termination({
        workerId: 10,
        loopId: 77, result: { status: 200 }, hitMaxTurns: false, turnIds: [1],
        usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
    }));
    assert.ok(seen.some((e) => e.type === "RUN_FINISHED"), "the bound loop terminal ends this AG-UI Run");

    // An event for an UNbound workspace is dropped, not misrouted.
    seen.length = 0;
    m.fire(99, "log/entry", { entry: { id: 3, worker_id: 1, loop_id: 1, origin: "model", op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/unbound/messages/m1"] }, tx: { body: "x" } } });
    assert.equal(seen.length, 0, "events for other workspaces don't leak into this thread");
    portal.stop();
});

test("{§agui-sync}: synchronization observes an already-active loop without taking cancellation ownership", async () => {
    const m = mockSeam([], [], {
        workers: [worker(10)],
        loops: new Map([[10, [
            { ...loop(10, 77), sequence: 1, status: 102 },
            { ...loop(10, 78), sequence: 2, status: 100 },
            { ...loop(10, 79), sequence: 3, status: 200, terminatedAt: "2026-09-15T00:00:00.000Z", terminalResult: { status: 200 } },
        ]]]),
    });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "observer",
        notificationScope: "worker",
        emit: (events) => seen.push(...events),
    });

    assert.equal(await portal.synchronize(3, thread), true, "the active loop remains attached");
    m.fire(3, "log/entry", {
        entry: {
            id: 2,
            worker_id: 10,
            loop_id: 77,
            origin: "model",
            op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/observer/messages/m1"] },
            loop_seq: 1, turn_seq: 1, sequence: 2,
            tx: { body: "Observed answer." },
            turn_id: 1,
        },
    });
    assert.ok(seen.some(({ type }) => type === "TEXT_MESSAGE_CONTENT"), "new work reaches the observer");
    m.fire(3, "loop/terminated", termination({
        workerId: 10,
        loopId: 77,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1],
        usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
    }));
    assert.equal(seen.at(-1)?.type, "RUN_FINISHED", "the observed loop owns the terminal");
    assert.equal(m.cancelled(), null, "observation never acquires cancellation ownership");
    portal.stop();
});

test("live stopped-worlds select their exact loop Run before the worker fallback", async () => {
    const m = mockSeam();
    const owningSeen: AguiEvent[] = [];
    const concurrentSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const owning = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "owning", owner: OWNER,
        notificationScope: "worker",
        emit: (events) => owningSeen.push(...events),
    });
    await portal.run(owning, { workspaceId: 3, workerId: 10, prompt: "go" });
    portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "concurrent-action",
        notificationScope: "result",
        emit: (events) => concurrentSeen.push(...events),
    });

    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, loopId: 77 }));
    assert.ok(
        owningSeen.some((event) => event.type === "TOOL_CALL_END"),
        "the proposal reaches its loop-bound Run",
    );
    assert.equal(concurrentSeen.length, 0, "the proposal does not interrupt an unbound action Run");

    owningSeen.length = 0;
    m.fire(3, "loop/interaction", interaction({ interactionId: 43, loopId: 77 }));
    assert.ok(
        owningSeen.some((event) => event.type === "TOOL_CALL_END"),
        "the generic interaction reaches its loop-bound Run",
    );
    assert.equal(concurrentSeen.length, 0, "the interaction does not interrupt an unbound action Run");
    portal.stop();
});

test("a terminal arriving before the loop acknowledgement settles only its matching AG-UI Run", async () => {
    const m = mockSeam();
    const entered = Promise.withResolvers<void>();
    let acknowledge!: (value: { status: number; action: "enqueued_new_loop"; loopId: number }) => void;
    m.seam.runLoop = async () => new Promise((resolve) => {
        acknowledge = resolve;
        entered.resolve();
    });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "client", owner: OWNER, notificationScope: "worker", emit: (events) => seen.push(...events) });
    const running = portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "fast" });
    await entered.promise;

    const terminal = (loopId: number) => termination({
        workerId: 10,
        loopId,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [],
        usage: loopUsage({ curationBudget: 1000 }),
    });
    m.fire(3, "loop/terminated", terminal(88));
    m.fire(3, "loop/terminated", terminal(77));
    assert.equal(seen.length, 0, "pre-ack terminals are buffered, never guessed");

    acknowledge({ status: 100, action: "enqueued_new_loop", loopId: 77 });
    assert.deepEqual(await running, { loopId: 77 });
    assert.equal(seen.filter((event) => event.type === "RUN_FINISHED").length, 1, "only the acknowledged loop settles the AG-UI Run");
    portal.stop();
});

test("{§agui-message-before-gate}: a message run during a durable proposal is delivered, then the interrupt is re-presented", async () => {
    const pending: ProposalProjection[] = [proposal({ op: "sh", target: { scheme: null, authority: null, pathname: null }, body: "ls" })];
    const m = mockSeam(pending);
    const seen: AguiEvent[] = [];
    const deliveredBeforeGate: number[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (events) => {
        seen.push(...events);
        if (events.some((event) => event.type === "TOOL_CALL_END")) deliveredBeforeGate.push(m.workers.length);
    } });

    assert.equal(
        await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "new work" }),
        null,
        "the Run ends with the re-presented interrupt, not a loop binding",
    );
    assert.deepEqual(m.workers, [{ workspaceId: 3, prompt: "new work" }], "the message reaches Core");
    assert.deepEqual(deliveredBeforeGate, [1], "the message is durable before the gate is re-presented");
    assert.ok(seen.some((event) => event.type === "TOOL_CALL_END"), "the durable interrupt is presented again");
    portal.stop();
});

test("{§agui-gate-deferral}: a descendant gate arriving during the bound worker's reasoning is presented when the lifecycle ends", async () => {
    const m = mockSeam([], [], {
        workers: [worker(10), worker(20, 10)],
        loops: new Map([
            [10, [loop(10, 77)]],
            [20, [loop(20, 88)]],
        ]),
    });
    const seen: AguiEvent[] = [];
    const registered: Array<Interrupt | null> = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (events) => {
        seen.push(...events);
        for (const event of events) {
            if (event.type !== "TOOL_CALL_END") continue;
            registered.push(portal.interruptForToolCall((event as { toolCallId: string }).toolCallId));
        }
    } });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });

    const call = { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1 };
    m.fire(3, "reasoning/event", { ...call, phase: "start" });
    m.fire(3, "reasoning/event", { ...call, phase: "content", delta: "weighing the child's request" });
    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, workerId: 20, loopId: 88 }));
    await nextTask();
    assert.ok(!seen.some((event) => event.type === "TOOL_CALL_END"), "a gate cannot split the open reasoning lifecycle");

    m.fire(3, "reasoning/event", { ...call, phase: "end" });
    const types = seen.map((event) => event.type);
    assert.ok(types.includes(EventType.TOOL_CALL_END), "the held gate is presented once the lifecycle ends");
    assert.ok(types.indexOf(EventType.REASONING_END) < types.indexOf(EventType.TOOL_CALL_END), "the reasoning message closes before the gate");
    assert.ok(types.indexOf(EventType.TOOL_CALL_END) < types.lastIndexOf(EventType.STEP_FINISHED), "the active step closes after the gate, before the interrupt terminal");
    assert.deepEqual(registered.map((interrupt) => interrupt?.toolCallId ?? null), ["prop:42"], "the interrupt is registered while its tool call is emitted");
    portal.stop();
});

test("{§agui-gate-deferral}: a terminal during a held gate settles the Run and leaves the gate for the next Run", async () => {
    const pending: ProposalProjection[] = [];
    const gate = proposal({ logEntryId: 42, workerId: 20, loopId: 88 });
    const m = mockSeam(pending, [], {
        workers: [worker(10), worker(20, 10)],
        loops: new Map([
            [10, [loop(10, 77)]],
            [20, [loop(20, 88)]],
        ]),
    });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (events) => seen.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });

    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "start" });
    m.fire(3, "loop/proposal", gate);
    await nextTask();
    m.fire(3, "loop/terminated", termination({
        workerId: 10,
        loopId: 77,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1],
        usage: loopUsage({ curationBudget: 1000 }),
    }));
    assert.ok(seen.some((event) => event.type === "RUN_FINISHED"), "the bound terminal settles the Run");
    assert.ok(!seen.some((event) => event.type === "TOOL_CALL_END"), "a settled Run presents no gate");
    portal.closeRun(3, thread);

    pending.push(gate);
    const next: AguiEvent[] = [];
    const nextThread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (events) => next.push(...events) });
    assert.equal(await portal.run(nextThread, { workspaceId: 3, workerId: 10, prompt: "again" }), null);
    assert.deepEqual(
        next.filter((event) => event.type === "TOOL_CALL_END").map((event) => (event as { toolCallId: string }).toolCallId),
        ["prop:42"],
        "the durable gate is re-presented by the next Run",
    );
    portal.stop();
});

test("a durable client interaction re-surfaces with its exact standard Interrupt and resumes through core", async () => {
    const m = mockSeam([], [interaction({ interactionId: 30, loopId: 7 })]);
    const seen: AguiEvent[] = [];
    let interrupt: Interrupt | null = null;
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui", owner: OWNER,
        notificationScope: "worker",
        emit: (events) => {
            seen.push(...events);
            const end = events.find((event) => event.type === "TOOL_CALL_END") as { toolCallId?: string } | undefined;
            if (end?.toolCallId !== undefined) interrupt = portal.interruptForToolCall(end.toolCallId);
        },
    });

    assert.equal(await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "new work" }), null);
    assert.equal(m.workers.length, 1, "{§agui-message-before-gate}: the message reaches Core before the gate is re-presented");
    const presented = interrupt as Interrupt | null;
    assert.ok(presented);
    assert.deepEqual(presented, {
        id: presented.id,
        reason: "tool_call",
        toolCallId: "int:30",
        message: "Choose one color.",
        responseSchema: interaction().request.responseSchema,
    });
    await portal.resolve(3, thread, [{
        interruptId: presented.id,
        status: "resolved",
        payload: { color: "orange" },
    }]);
    assert.deepEqual(m.interactionResolves, [{
        interactionId: 30,
        resolution: { status: "resolved", payload: { color: "orange" } },
    }]);
    assert.ok(seen.some((event) => event.type === "TOOL_CALL_END"));
    portal.stop();
});

test("a live proposal reaches the bound thread as a tool-call; resume resolves it; cancel cancels", async () => {
    const m = mockSeam([proposal({ logEntryId: 42, loopId: 7 })]);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, seen);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: view.emit });

    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, loopId: 7, target: { scheme: "file", authority: null, pathname: "a.ts" } }));
    const start = seen.find((e) => e.type === "TOOL_CALL_START") as { toolCallId: string; toolCallName: string } | undefined;
    assert.equal(start?.toolCallId, "prop:42", "proposal fanned to the thread as a tool-call");
    assert.equal(start?.toolCallName, "request_approval");

    await portal.resolve(3, thread, [{ interruptId: view.interrupt("prop:42").id, status: "resolved", payload: { decision: "accept" } }]);
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept" } });

    assert.equal(portal.cancel(10), true);
    assert.equal(m.cancelled(), 10, "cancel cancels the worker's drain");
    portal.stop();
});

test("a descendant proposal interrupts its owning thread and resumes the exact child", async () => {
    const pending = proposal({ logEntryId: 42, workerId: 20, loopId: 88 });
    const m = mockSeam([pending], [], {
        workers: [worker(10), worker(20, 10)],
        loops: new Map([
            [10, [loop(10, 77)]],
            [20, [loop(20, 88)]],
        ]),
    });
    const firstSeen: AguiEvent[] = [];
    const resumedSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, firstSeen);
    portal.start();
    const first = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui", owner: OWNER,
        notificationScope: "worker",
        emit: view.emit,
    });
    await portal.run(first, { workspaceId: 3, workerId: 10, prompt: "delegate" });

    m.fire(3, "loop/proposal", pending);
    await nextTask();
    assert.ok(
        firstSeen.some((event) => event.type === "TOOL_CALL_END"),
        "the owning thread receives the child's gate",
    );
    portal.closeRun(3, first);

    const resume = [{
        interruptId: view.interrupt("prop:42").id,
        status: "resolved" as const,
        payload: { decision: "accept" },
    }];
    const resumed = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui", owner: OWNER,
        notificationScope: "worker",
        resume,
        emit: (events) => resumedSeen.push(...events),
    });
    await portal.resolve(3, resumed, resume);
    assert.deepEqual(m.resolves, [{
        logEntryId: 42,
        resolution: { decision: "accept" },
    }], "the resolution preserves the child's exact durable gate identity");

    m.fire(3, "loop/terminated", termination({
        workerId: 10,
        loopId: 77,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1],
        usage: loopUsage({ curationBudget: 1000 }),
    }));
    assert.ok(
        resumedSeen.some((event) => event.type === "RUN_FINISHED"),
        "the resumed AG-UI Run remains bound to the owning thread",
    );
    portal.stop();
});

test("a queued descendant gate precedes a later controlling terminal", async () => {
    const workers = Promise.withResolvers<ApplicationWorkerProjection[]>();
    const m = mockSeam([], [], {
        workers: [worker(10), worker(20, 10)],
        loops: new Map([
            [10, [loop(10, 77)]],
            [20, [loop(20, 88)]],
        ]),
    });
    m.seam.listWorkers = () => workers.promise;
    const controlling: AguiEvent[] = [];
    const independent: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    let thread: unknown = null;
    thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "controlling", owner: OWNER,
        notificationScope: "worker",
        emit: (events) => {
            controlling.push(...events);
            if (events.some((event) => event.type === "TOOL_CALL_END")) {
                portal.closeRun(3, thread);
            }
        },
    });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    const independentThread = portal.openThread({
        workspaceId: 4,
        workerId: 10,
        threadId: "independent",
        notificationScope: "worker",
        emit: (events) => independent.push(...events),
    });
    await portal.run(independentThread, { workspaceId: 4, workerId: 10, prompt: "finish" });

    const terminal = (workerId: number, loopId: number) => termination({
        workerId,
        loopId,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1],
        usage: loopUsage({ curationBudget: 1000 }),
    });
    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, workerId: 20, loopId: 88 }));
    m.fire(3, "loop/terminated", terminal(10, 77));
    m.fire(4, "loop/terminated", terminal(10, 77));

    assert.equal(
        controlling.some((event) => event.type === "RUN_FINISHED"),
        false,
        "a terminal cannot overtake the queued descendant gate",
    );
    assert.ok(
        independent.some((event) => event.type === "RUN_FINISHED"),
        "an unrelated workspace does not wait for the queued gate",
    );

    workers.resolve([worker(10), worker(20, 10)]);
    await nextTask();
    await nextTask();
    assert.ok(controlling.some((event) => event.type === "TOOL_CALL_END"));
    assert.equal(
        controlling.some((event) => event.type === "RUN_FINISHED"),
        false,
        "the interrupted Run never receives the terminal queued behind its gate",
    );
    portal.stop();
});

test("an owning thread re-surfaces a durable descendant interaction after reconnect", async () => {
    const pendingInteraction = interaction({ interactionId: 30, workerId: 20, loopId: 88 });
    const m = mockSeam([], [pendingInteraction], {
        workers: [worker(10), worker(20, 10)],
        loops: new Map([
            [10, [loop(10, 77), { ...loop(10, 79), sequence: 2, status: 100 }]],
            [20, [loop(20, 88)]],
        ]),
    });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, seen);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "client", owner: OWNER,
        notificationScope: "worker",
        emit: view.emit,
    });

    assert.equal(
        await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "continue" }),
        null,
        "a durable descendant gate stops a new parent prompt",
    );
    assert.equal(m.workers.length, 1, "{§agui-message-before-gate}: the message reaches Core before the gate is re-presented");
    assert.ok(seen.some((event) => event.type === "TOOL_CALL_END"));

    portal.closeRun(3, thread);
    const resume = [{
        interruptId: view.interrupt("int:30").id,
        status: "resolved" as const,
        payload: { color: "orange" },
    }];
    const resumed = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "client", owner: OWNER,
        notificationScope: "worker",
        resume,
        emit: (events) => seen.push(...events),
    });
    await portal.resolve(3, resumed, resume);
    assert.deepEqual(m.interactionResolves, [{
        interactionId: 30,
        resolution: { status: "resolved", payload: { color: "orange" } },
    }]);
    const beforeTerminal = seen.length;
    m.fire(3, "loop/terminated", termination({ workerId: 10, loopId: 77 }));
    assert.ok(seen.slice(beforeTerminal).some((event) => event.type === "RUN_FINISHED"),
        "the future queued task does not steal the resumed controlling loop's binding");
    portal.stop();
});

test("multiple descendant gates serialize through one owning thread", async () => {
    const firstPending = proposal({ logEntryId: 42, workerId: 20, loopId: 88 });
    const secondPending = proposal({ logEntryId: 43, workerId: 30, loopId: 99 });
    const m = mockSeam([firstPending, secondPending], [], {
        workers: [worker(10), worker(20, 10), worker(30, 10)],
        loops: new Map([
            [10, [loop(10, 77)]],
            [20, [loop(20, 88)]],
            [30, [loop(30, 99)]],
        ]),
    });
    const firstSeen: AguiEvent[] = [];
    const secondSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, firstSeen);
    portal.start();
    const first = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui", owner: OWNER,
        notificationScope: "worker",
        emit: view.emit,
    });

    assert.equal(await portal.run(first, {
        workspaceId: 3,
        workerId: 10,
        prompt: "continue",
    }), null);
    assert.deepEqual(
        firstSeen
            .filter((event) => event.type === "TOOL_CALL_END")
            .map((event) => (event as { toolCallId: string }).toolCallId),
        ["prop:42"],
        "only one descendant Worker is exposed in each stopped AG-UI Run",
    );
    portal.closeRun(3, first);

    const firstResume = [{
        interruptId: view.interrupt("prop:42").id,
        status: "resolved" as const,
        payload: { decision: "accept" },
    }];
    const second = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui", owner: OWNER,
        notificationScope: "worker",
        resume: firstResume,
        emit: (events) => secondSeen.push(...events),
    });
    await portal.resolve(3, second, firstResume);
    assert.deepEqual(
        secondSeen
            .filter((event) => event.type === "TOOL_CALL_END")
            .map((event) => (event as { toolCallId: string }).toolCallId),
        ["prop:43"],
        "resolving one child immediately presents the next durable child gate",
    );
    assert.deepEqual(m.resolves, [{
        logEntryId: 42,
        resolution: { decision: "accept" },
    }]);
    portal.stop();
});

test("a descendant gate never leaks to an unrelated thread", async () => {
    const m = mockSeam([], [], {
        workers: [worker(10), worker(30), worker(40, 30)],
    });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "unrelated",
        notificationScope: "worker",
        emit: (events) => seen.push(...events),
    });

    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, workerId: 40, loopId: 88 }));
    await nextTask();
    assert.equal(seen.length, 0);
    portal.stop();
});

test("{§agui-proposal-resolve}: resume binds the persisted loop before releasing its proposal", async () => {
    const pending = proposal({ logEntryId: 42, loopId: 7 });
    const m = mockSeam([pending]);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, seen);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "client", owner: OWNER,
        notificationScope: "worker",
        emit: view.emit,
    });
    await portal.synchronize(3, thread);
    m.seam.resolveProposal = async () => {
        m.fire(3, "loop/terminated", termination({
            workerId: 10,
            loopId: 7,
            result: { status: 200 },
            hitMaxTurns: false,
            turnIds: [1],
            usage: loopUsage({ curationBudget: 1000 }),
        }));
    };

    await portal.resolve(3, thread, [{
        interruptId: view.interrupt("prop:42").id,
        status: "resolved",
        payload: { decision: "accept" },
    }]);

    assert.equal(
        seen.filter((event) => event.type === "RUN_FINISHED").length,
        1,
        "a same-stack terminal reaches the already-bound resume Run",
    );
    portal.stop();
});

test("{§agui-readable-reasoning}: an interrupt resume retains delivered reasoning evidence", async () => {
    const pending = proposal({ logEntryId: 42, loopId: 77 });
    const m = mockSeam([pending]);
    const firstSeen: AguiEvent[] = [];
    const resumedSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, firstSeen);
    portal.start();
    const first = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 10,
        threadId: "client", owner: OWNER,
        notificationScope: "worker",
        inputRunId: "run-a",
        emit: view.emit,
    });
    await portal.run(first, { workspaceId: 3, workerId: 10, prompt: "go" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "start" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "content", delta: "working" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "end" });
    m.fire(3, "loop/proposal", pending);
    portal.closeRun(3, first);

    const resume = [{
        interruptId: view.interrupt("prop:42").id,
        status: "resolved" as const,
        payload: { decision: "accept" },
    }];
    const second = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 10,
        threadId: "client", owner: OWNER,
        notificationScope: "worker",
        inputRunId: "run-b",
        resume,
        emit: (events) => resumedSeen.push(...events),
    });
    await portal.resolve(3, second, resume);
    m.fire(3, "log/entry", {
        entry: {
            id: 45,
            worker_id: 10,
            loop_id: 77,
            origin: "model",
            op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/client/messages/m1"] },
            loop_seq: 1, turn_seq: 1, sequence: 3,
            tx: { body: "continued" },
            reasoning: "working",
            turn_id: 1,
        },
    });

    assert.equal(
        firstSeen.filter((event) => event.type === "REASONING_MESSAGE_CONTENT").length,
        1,
        "Run A delivered the readable reasoning once",
    );
    assert.equal(
        resumedSeen.filter((event) => event.type === "REASONING_MESSAGE_CONTENT").length,
        0,
        "Run B does not replay reasoning already delivered by its interrupted predecessor",
    );
    assert.equal(
        resumedSeen.filter((event) => event.type === "CUSTOM" && event.name === "plurnk.row").length,
        1,
        "the continued SEND row still projects normally",
    );
    portal.stop();
});

const startedExec = (over: Record<string, unknown> = {}) => ({
    entry: {
        id: 55, worker_id: 10, loop_id: 6, turn_id: 6, origin: "client", op: "sh", status_rx: 200, loop_seq: 1, turn_seq: 1, sequence: 1,
        rx: { status: 200, outcome: "started" }, tx: { runtime: "sh", body: "sleep 1; printf late" },
        attrs: { runtime: "sh", stream: "sh:///b1e0977e", coordinate: { loop_seq: 1, turn_seq: 1, sequence: 1 }, ...over },
    },
});
const label = (event: AguiEvent): string => event.type === "CUSTOM" ? (event as { name: string }).name : event.type;
// {§agui-broadcast-fan} An operation Run as the Run handler opens it: no worker until its dispatch announces the loop
// it opened in the runtime worker (10).
const openOperation = (portal: Portal, inputRunId: string, seen: AguiEvent[], loopId = 6) => {
    const thread = portal.openThread({ workspaceId: 3, workerId: null, threadId: "tui", inputRunId, notificationScope: "operation",
        cancelOnDisconnect: true, emit: (events) => seen.push(...events) });
    portal.bindOperation(thread, { workerId: 10, loopId });
    return thread;
};
const actionResult: AguiEvent = { type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 200, outcome: "started" } } };
const concluded = (target: string) => ({ entryId: 170, workerId: 10, target, subscriptionId: 1, scheme: "sh", result: { status: 200, exitCode: 0 }, summary: `${target} completed (exit 0)`, wakeAction: "no-loop" });

for (const status of [400, 403, 499, 503]) {
    test(`{§agui-broadcast-fan} failed execution ${status} does not open its proposed stream`, () => {
        const m = mockSeam();
        const seen: AguiEvent[] = [];
        const portal = new Portal(m.seam);
        portal.start();
        const thread = openOperation(portal, "refused-op", seen);
        const { entry } = startedExec();
        m.fire(3, "log/entry", { entry: { ...entry, status_rx: status, rx: { status } } });
        portal.finishThread(thread, [{ type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status } } }]);
        assert.equal(seen.at(-1)?.type, "RUN_FINISHED", "a stream address is not evidence that execution started");
        portal.stop();
    });
}

test("{§agui-broadcast-fan} queued execution remains an obligation even when approval supplies the outcome", () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = openOperation(portal, "queued-op", seen);
    const { entry } = startedExec();
    m.fire(3, "log/entry", { entry: { ...entry, status_rx: 202, rx: { status: 202, outcome: "auto: sh" } } });
    portal.finishThread(thread, [{ type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 202 } } }]);
    assert.equal(seen.some(({ type }) => type === "RUN_FINISHED"), false);
    m.fire(3, "stream/concluded", { entryId: 170, workerId: 10, target: "sh:///b1e0977e", subscriptionId: 1, scheme: "sh", result: { status: 200, exitCode: 0 }, summary: "completed", wakeAction: "no-loop" });
    assert.equal(seen.at(-1)?.type, "RUN_FINISHED");
    portal.stop();
});

test("{§agui-broadcast-fan} an operation Run owns an execution from the row that announces it, so a late-writing command concludes inside the Run", () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = openOperation(portal, "op-1", seen);
    m.fire(3, "log/entry", startedExec());
    const result: AguiEvent = { type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 200, outcome: "started" } } };
    portal.finishThread(thread, [result]);
    assert.equal(seen.some((e) => e.type === "RUN_FINISHED"), false, "the result waits for the execution the row announced, no channel write needed");

    m.fire(3, "stream/event", { entryId: 170, workerId: 10, target: "sh:///b1e0977e", channel: "stdout", state: "active", contentLength: 4 });
    m.fire(3, "stream/concluded", { entryId: 170, workerId: 10, target: "sh:///b1e0977e", subscriptionId: 1, scheme: "sh", result: { status: 200, exitCode: 0 }, summary: "sh:///b1e0977e completed (exit 0)", wakeAction: "no-loop" });
    const order = seen.map(label);
    const conclusion = order.lastIndexOf("plurnk.stream");
    assert.ok(conclusion !== -1 && conclusion < order.indexOf("plurnk.action.result") && order.indexOf("plurnk.action.result") < order.indexOf("RUN_FINISHED"),
        `the conclusion, then the result, then the finish: ${order.join(" → ")}`);
    portal.stop();
});

test("{§agui-broadcast-fan} a detached execution (<-1>) is nobody's obligation: its row never defers the action result", () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = openOperation(portal, "op-2", seen);
    m.fire(3, "log/entry", startedExec({ detached: true }));
    portal.finishThread(thread, [{ type: EventType.CUSTOM, name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 200, outcome: "started" } } }]);
    assert.equal(seen.at(-1)?.type, "RUN_FINISHED", "the Run settles at once; the detached spawn outlives it");
    portal.stop();
});

test("{§agui-broadcast-fan} an operation Run observes exactly its own loop of the shared runtime worker, and a result Run observes nothing", () => {
    const m = mockSeam();
    const mine: AguiEvent[] = [];
    const theirs: AguiEvent[] = [];
    const management: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = openOperation(portal, "mine", mine, 6);
    openOperation(portal, "theirs", theirs, 7);
    portal.openThread({ workspaceId: 3, workerId: null, threadId: "tui", inputRunId: "management", notificationScope: "result", emit: (events) => management.push(...events) });

    m.fire(3, "log/entry", startedExec());
    m.fire(3, "log/entry", { entry: { ...startedExec({ stream: "sh:///7777aaaa" }).entry, id: 56, loop_id: 7 } });
    m.fire(3, "stream/event", streamEvent({ entryId: 171, workerId: 10, target: "sh:///7777aaaa", scheme: "sh", contentLength: 9 }));
    m.fire(3, "loop/terminated", termination({ workerId: 10, loopId: 6 }));
    m.fire(3, "stream/concluded", concluded("sh:///b1e0977e"));
    portal.finishThread(thread, [actionResult]);

    const rows = (events: AguiEvent[]) => events.filter((event) => label(event) === "plurnk.row").map((event) => (event as { value: { loop_id: number } }).value.loop_id);
    assert.deepEqual(rows(mine), [6], "only its own loop's rows");
    assert.deepEqual(rows(theirs), [7]);
    assert.equal(mine.filter((event) => label(event) === "plurnk.stream").length, 1, "another operation's stream never reaches it");
    assert.equal(mine.filter(({ type }) => type === "RUN_FINISHED").length, 1, "its loop's terminal does not settle it; its result does, once its own stream concluded");
    assert.equal(theirs.some(({ type }) => type === "RUN_FINISHED"), false, "the other operation's stream is still open");
    assert.equal(management.length, 0);
    portal.stop();
});

test("{§agui-broadcast-fan} stream activity that precedes the row announcing it follows that row, and a stream concluded before its row defers nothing", () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = openOperation(portal, "fast", seen);
    m.fire(3, "stream/event", streamEvent({ entryId: 170, workerId: 10, target: "sh:///b1e0977e", scheme: "sh", contentLength: 2 }));
    m.fire(3, "stream/event", streamEvent({ entryId: 170, workerId: 10, target: "sh:///b1e0977e", scheme: "sh", contentLength: 4 }));
    m.fire(3, "stream/concluded", concluded("sh:///b1e0977e"));
    assert.equal(seen.length, 0, "no row of its loop has announced the stream yet");

    m.fire(3, "log/entry", startedExec());
    const order = seen.map(label);
    assert.deepEqual(order.filter((name) => name === "plurnk.row" || name === "plurnk.stream"), ["plurnk.row", "plurnk.stream", "plurnk.stream"],
        `the row, then the latest snapshot, then the conclusion: ${order.join(" → ")}`);
    assert.equal((seen.find((event) => label(event) === "plurnk.stream") as { value: { contentLength: number } }).value.contentLength, 4);
    portal.finishThread(thread, [actionResult]);
    assert.equal(seen.at(-1)?.type, "RUN_FINISHED", "a concluded stream leaves nothing open");
    portal.stop();
});

test("{§agui-run-disconnect} an operation Run's disconnect cancels exactly its own loop, even before its dispatch opened it", () => {
    const m = mockSeam();
    const portal = new Portal(m.seam);
    portal.start();
    const bound = openOperation(portal, "bound", [], 6);
    portal.disconnect(bound);
    assert.deepEqual(m.cancelledLoops, [{ workspaceId: 3, loopId: 6, reason: "client_disconnected" }]);

    const early = portal.openThread({ workspaceId: 3, workerId: null, threadId: "tui", inputRunId: "early", notificationScope: "operation",
        cancelOnDisconnect: true, emit: () => undefined });
    portal.disconnect(early);
    assert.equal(m.cancelledLoops.length, 1, "nothing to cancel before the loop exists");
    portal.bindOperation(early, { workerId: 10, loopId: 7 });
    assert.deepEqual(m.cancelledLoops.at(-1), { workspaceId: 3, loopId: 7, reason: "client_disconnected" });
    assert.equal(m.cancelled(), null, "the runtime worker itself is never cancelled");
    portal.stop();
});

test("{§agui-delegation-observation}: a Run that asks for its delegation receives descendants' rows and streams as foreign rows, introduced once each, never a stranger's", async () => {
    const m = mockSeam([], [], {
        workers: [worker(10), worker(20, 10), worker(30, 20), worker(40)],
        loops: new Map([[10, [loop(10, 77)]]]),
    });
    const seen: AguiEvent[] = [];
    const quiet: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "plain", notificationScope: "worker", emit: (events) => quiet.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });

    const row = (id: number, workerId: number) => ({ entry: { id, worker_id: workerId, loop_id: 80 + workerId, origin: "model", op: "READ", status_rx: 200, rx: {}, loop_seq: 1, turn_seq: 1, sequence: id, tx: { body: "" }, turn_id: 1 } });
    m.fire(3, "log/entry", row(2, 20));
    m.fire(3, "log/entry", row(3, 30));
    m.fire(3, "log/entry", row(4, 40));
    m.fire(3, "log/entry", row(5, 20));
    m.fire(3, "stream/event", streamEvent({ entryId: 5, workerId: 20, target: "sh:///c1", scheme: "sh", contentLength: 5 }));
    m.fire(3, "loop/terminated", termination({ workerId: 20, loopId: 100, result: { status: 500 }, hitMaxTurns: false, turnIds: [1], usage: loopUsage({ curationBudget: 1000 }) }));
    await nextTask();
    await nextTask();
    const customs = seen.filter((event) => event.type === "CUSTOM").map((event) => {
        const e = event as { name: string; value: { workerId?: number; depth?: number; parentWorkerId?: number; name?: string; worker_id?: number; id?: number } };
        if (e.name === "plurnk.descendant") return `descendant:${e.value.workerId}:${e.value.depth}:${e.value.parentWorkerId}:${e.value.name}`;
        if (e.name === "plurnk.row") return `row:${e.value.worker_id}:${e.value.id}`;
        if (e.name === "plurnk.stream") return `stream:${e.value.workerId}`;
        return e.name;
    }).filter((label) => !label.startsWith("plurnk."));
    assert.deepEqual(customs, [
        "descendant:20:1:10:worker-20", "row:20:2",
        "descendant:30:2:20:worker-30", "row:30:3",
        "row:20:5", "stream:20",
    ], "each descendant is introduced once with its generation, in order; the stranger never arrives");
    assert.ok(!seen.some((event) => event.type === "RUN_FINISHED"), "a descendant's terminal never settles this Run");
    assert.ok(!seen.some((event) => event.type === "TOOL_CALL_START"), "a descendant's row never enters the core vocabulary");
    assert.equal(quiet.filter((event) => event.type === "CUSTOM").length, 0, "without the request, a Run observes its bound Worker alone");

    m.fire(3, "loop/terminated", termination({ workerId: 10, loopId: 77, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: loopUsage({ curationBudget: 1000 }) }));
    assert.ok(seen.some((event) => event.type === "RUN_FINISHED"), "the bound Loop's terminal settles the Run; a descendant's open stream never defers it");
    portal.stop();
});

// {§agui-subagents} A delegation of worker 10: worker 20 beneath it and worker 30 beneath that, each loop opened as given.
const delegation = (loops: ReadonlyMap<number, ApplicationLoopProjection[]>, pending: ProposalProjection[] = []) =>
    mockSeam(pending, [], { workers: [worker(10), worker(20, 10), worker(30, 20)], loops });
const openedBy = (workerId: number, id: number, invocation: ApplicationLoopProjection["invocation"],
    over: Partial<ApplicationLoopProjection> = {}): ApplicationLoopProjection => ({ ...loop(workerId, id), invocation, ...over });
const concludedLoop = { status: 200, terminatedAt: "2026-10-16T00:00:00.000Z", terminalResult: { status: 200 } } satisfies Partial<ApplicationLoopProjection>;
const delegated = (id: number, workerId: number, loopId: number) => ({ entry: wireRow({ id, worker_id: workerId, loop_id: loopId, turn_id: 100 + workerId }) });
const lifecycle = (events: readonly AguiEvent[]) => events.filter(({ type }) => type.startsWith("SUBAGENT_"));
const attributed = (events: readonly AguiEvent[]) => events.map((event) => `${event.type}:${(event as { subagentRunId?: string }).subagentRunId ?? ""}`);
const FAILED = { type: "https://problems.plurnk.xyz/loop/failed", title: "Failed", status: 500, detail: "The helper failed." };

test("{§agui-subagents}: a loop a call in view opened is that call's subagent: started by its first row after the subagent whose call opened it, ended by its conclusion, suspended when the Run finishes", async () => {
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" })]],
        [30, [openedBy(30, 110, { workerId: 20, address: "log:///1/1/3/WORK" })]],
    ]));
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    m.fire(3, "log/entry", delegated(2, 20, 100));
    m.fire(3, "log/entry", delegated(3, 30, 110));
    m.fire(3, "loop/terminated", termination({ workerId: 30, loopId: 110, result: { status: 500, problem: FAILED } }));
    await nextTask();
    m.fire(3, "loop/terminated", termination({ workerId: 10, loopId: 77 }));
    await nextTask();

    assert.deepEqual(lifecycle(seen), [
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-20/1", name: "worker-20", parentToolCallId: "1/1/2" },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-30/1", name: "worker-30", parentToolCallId: "worker://worker-20#1/1/3", parentSubagentRunId: "ops://worker-20/1" },
        { type: EventType.SUBAGENT_ERROR, subagentRunId: "ops://worker-30/1", message: FAILED.detail, code: FAILED.type },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "ops://worker-20/1", outcome: { type: "suspended" } },
    ], "the WORK's child is its subagent and the grandchild the child's; a failed conclusion is an error; the Run's end suspends the one still running");
    assert.deepEqual(seen.filter(({ type }) => type === EventType.TOOL_CALL_START).map((event) => [(event as { toolCallId: string }).toolCallId, (event as { subagentRunId?: string }).subagentRunId]),
        [["worker://worker-20#1/1/2", "ops://worker-20/1"], ["worker://worker-30#1/1/3", "ops://worker-30/1"]],
        "a subagent's operations are calls in its own worker's namespace, attributed to it");
    const order = attributed(seen);
    assert.ok(order.indexOf("STEP_FINISHED:ops://worker-30/1") < order.indexOf("SUBAGENT_ERROR:ops://worker-30/1"), "a concluded subagent closes its step first");
    assert.ok(order.indexOf("STEP_FINISHED:ops://worker-20/1") < order.indexOf("SUBAGENT_FINISHED:ops://worker-20/1"), "and so does a suspended one");
    assert.ok(order.indexOf("SUBAGENT_FINISHED:ops://worker-20/1") < order.indexOf("RUN_FINISHED:"), "no subagent is still running when the Run finishes");
    portal.stop();
});

test("{§agui-subagents}: a subagent's parent is presented before it, and a loop that concluded before the Run saw it ends as it starts", async () => {
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" }, concludedLoop)]],
        [30, [openedBy(30, 110, { workerId: 20, address: "log:///1/1/3/WORK" })]],
    ]));
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    m.fire(3, "log/entry", delegated(3, 30, 110));
    await nextTask();
    assert.deepEqual(lifecycle(seen), [
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-20/1", name: "worker-20", parentToolCallId: "1/1/2" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "ops://worker-20/1", outcome: { type: "success" }, result: { status: 200 } },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-30/1", name: "worker-30", parentToolCallId: "worker://worker-20#1/1/3", parentSubagentRunId: "ops://worker-20/1" },
    ], "the grandchild's first row presents the child that opened it, already concluded with its exact result");
    portal.stop();
});

test("{§agui-subagents}: a conclusion still on its way when its loop is judged ends the subagent after the rows published before it", async () => {
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" }, concludedLoop)]],
    ]));
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    m.fire(3, "log/entry", delegated(2, 20, 100));
    m.fire(3, "loop/terminated", termination({ workerId: 20, loopId: 100 }));
    await nextTask();
    const order = attributed(seen).filter((label) => label.endsWith(":ops://worker-20/1"));
    assert.equal(order[0], "SUBAGENT_STARTED:ops://worker-20/1");
    assert.deepEqual(order.slice(-2), ["STEP_FINISHED:ops://worker-20/1", "SUBAGENT_FINISHED:ops://worker-20/1"],
        "the daemon read the loop concluded, but the Run receives its row first and its conclusion after");
    assert.ok(order.includes("TOOL_CALL_RESULT:ops://worker-20/1"));
    portal.stop();
});

test("{§agui-subagents}: the bound Worker's events wait while a descendant's loop is judged, so the conversation keeps the order the daemon published", async () => {
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" })]],
    ]));
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    m.fire(3, "log/entry", delegated(2, 20, 100));
    m.fire(3, "log/entry", { entry: wireRow({ id: 3, loop_id: 77, turn_id: 2, turn_seq: 2, sequence: 1 }) });
    await nextTask();
    assert.deepEqual(seen.filter(({ type }) => type === EventType.TOOL_CALL_START).map((event) => (event as { toolCallId: string }).toolCallId),
        ["worker://worker-20#1/1/2", "1/2/1"], "the child's row, published first, is not overtaken by its parent's");
    portal.stop();
});

test("{§agui-subagents} {§agui-snapshot}: a snapshot replays each subagent's conversation, then presents its run; a running one goes on live", async () => {
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" }, concludedLoop)]],
        [30, [openedBy(30, 110, { workerId: 20, address: "log:///1/1/3/WORK" })]],
    ]));
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: (events) => seen.push(...events) });
    const logs = new Map([[20, [delegated(2, 20, 100).entry]], [30, [delegated(3, 30, 110).entry]]]);
    const subagents = await portal.subagentHistory(thread, async (workerId) => logs.get(workerId) ?? []);
    const [snapshot, ...presented] = portal.replay(thread, [wireRow({ id: 1, sequence: 2, op: "WORK", attrs: { message: "message://worker-20/ab12" } })], undefined, subagents);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) assert.fail("the snapshot leads");
    assert.deepEqual(snapshot.messages.map((message) => [message.id, message.role, (message as { subagentRunId?: string }).subagentRunId]), [
        ["1/1/2", "assistant", undefined],
        ["worker://worker-20#1/1/2", "assistant", "ops://worker-20/1"], ["worker://worker-20#1/1/2/result", "tool", "ops://worker-20/1"],
        ["worker://worker-30#1/1/3", "assistant", "ops://worker-30/1"], ["worker://worker-30#1/1/3/result", "tool", "ops://worker-30/1"],
    ], "one conversation in log order, each subagent's messages attributed to its run");
    assert.deepEqual(presented, [
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-20/1", name: "worker-20", parentToolCallId: "1/1/2" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "ops://worker-20/1", outcome: { type: "success" }, result: { status: 200 } },
        { type: EventType.SUBAGENT_STARTED, subagentRunId: "ops://worker-30/1", name: "worker-30", parentToolCallId: "worker://worker-20#1/1/3", parentSubagentRunId: "ops://worker-20/1" },
    ], "every subagent the snapshot holds is presented, parents first: a concluded one ends as it starts");
    m.fire(3, "log/entry", delegated(4, 30, 110));
    await nextTask();
    assert.deepEqual(lifecycle(seen), [], "the running subagent is not started twice");
    assert.ok(attributed(seen).includes("TOOL_CALL_START:ops://worker-30/1"), "its next row goes on in its run");
    portal.finishThread(thread, []);
    assert.deepEqual(lifecycle(seen), [{ type: EventType.SUBAGENT_FINISHED, subagentRunId: "ops://worker-30/1", outcome: { type: "suspended" } }],
        "an idle synchronization finishes with the running subagent suspended and the concluded one untouched");
    assert.deepEqual(attributed(seen).slice(-3), ["STEP_FINISHED:ops://worker-30/1", "SUBAGENT_FINISHED:ops://worker-30/1", "RUN_FINISHED:"]);
    portal.stop();
});

test("{§agui-subagents}: an interrupt that finishes the Run suspends its running subagents after the gate's call", async () => {
    const gate = proposal({ logEntryId: 42, loopId: 77 });
    const m = delegation(new Map([
        [10, [loop(10, 77)]],
        [20, [openedBy(20, 100, { workerId: 10, address: "log:///1/1/2/WORK" })]],
    ]), [gate]);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    const view = capture(portal, seen);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, modelWorkerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", descendants: true, emit: view.emit });
    await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "delegate" });
    m.fire(3, "log/entry", delegated(2, 20, 100));
    await nextTask();
    m.fire(3, "loop/proposal", gate);
    await nextTask();
    assert.ok(view.interrupt("prop:42"), "the gate is presented");
    const order = attributed(seen);
    const call = seen.findIndex((event) => event.type === EventType.TOOL_CALL_END && event.toolCallId === "prop:42");
    assert.ok(call !== -1 && order.indexOf("SUBAGENT_FINISHED:ops://worker-20/1") > call, "the subagent's segment ends after the gate's call, before the interrupt finishes the Run");
    assert.deepEqual(lifecycle(seen).at(-1), { type: EventType.SUBAGENT_FINISHED, subagentRunId: "ops://worker-20/1", outcome: { type: "suspended" } });
    portal.stop();
});

test("{§agui-outside-text}: outside/event fans to the bound thread for its worker and stays out for another worker", async () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", owner: OWNER, notificationScope: "worker", emit: (evs) => seen.push(...evs) });
    const ack = await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "go" });
    assert.ok(ack !== null);
    m.fire(3, "outside/event", { workerId: 10, loopId: 77, turnId: 1, coordinate: "w-77-1", text: "Thinking out loud.", tokens: 9 });
    m.fire(3, "outside/event", { workerId: 11, loopId: 78, turnId: 1, coordinate: "x-78-1", text: "Someone else's aside.", tokens: 11 });
    await nextTask();
    const outside = seen.filter((e) => e.type === EventType.CUSTOM && (e as { name?: string }).name === "plurnk.outside");
    assert.deepEqual(outside.map((e) => (e as { value: { text: string } }).value.text), ["Thinking out loud."], "one event for the thread's worker, none for the other");
    portal.stop();
});
