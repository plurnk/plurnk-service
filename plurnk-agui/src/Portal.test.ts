// The orchestration engine, tested against a mock seam — the pieces compose: a worker
// re-surfaces pending + drives the loop, live events fan to the bound thread as AG-UI,
// a proposal reaches the thread as a tool-call, and a resume resolves it. No daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import Portal from "./Portal.ts";
import type {
    ApplicationPort,
    ClientInteractionProjection,
    ProposalProjection,
    ProposalResolution,
} from "@plurnk/plurnk-contracts";
import { EventType, type AguiEvent } from "./types.ts";
import { DEFAULT_LOOP_FLAGS, type ClientInteractionResolution } from "@plurnk/plurnk-contracts";
import { loopUsage } from "../test/accounting-fixture.ts";
import { termination } from "../test/notification-fixture.ts";

const proposal = (over: Partial<ProposalProjection> = {}): ProposalProjection => ({
    logEntryId: 5,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", authority: null, pathname: "a" },
    body: "diff",
    attrs: {},
    flags: DEFAULT_LOOP_FLAGS,
    disposition: { owner: "client" },
    ...over,
});

const interaction = (over: Partial<ClientInteractionProjection> = {}): ClientInteractionProjection => ({
    interactionId: 12,
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

const mockSeam = (
    pending: ProposalProjection[] = [],
    pendingInteractions: ClientInteractionProjection[] = [],
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
    const seam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => pending,
        pendingClientInteractions: async () => pendingInteractions,
        resolveProposal: (logEntryId, resolution) => { resolves.push({ logEntryId, resolution }); },
        resolveClientInteraction: async (interactionId, resolution) => {
            interactionResolves.push({ interactionId, resolution });
        },
        runLoop: async (a) => { workers.push({ workspaceId: a.workspaceId, prompt: a.prompt }); return { status: 100, action: "enqueued_new_loop" as const, loopId: 77 }; },
        cancelDrain: (workerId) => { cancelled = workerId; return true; },
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        readLog: async () => [],
        listProviders: () => ({ aliases: [] }),
    } satisfies Pick<ApplicationPort, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "pendingClientInteractions" | "resolveClientInteraction" | "runLoop" | "cancelDrain" | "dispatchClientAction" | "readLog" | "listProviders">;
    return {
        seam,
        fire: (s: number | null, m: string, p: unknown) => handlers.forEach((h) => h(s, m, p)),
        workers,
        resolves,
        interactionResolves,
        cancelled: () => cancelled,
    };
};

test("a worker without pending interrupts drives the loop, then live events fan as AG-UI", async () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", notificationScope: "conversation", emit: (evs) => seen.push(...evs) });

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
    m.fire(3, "log/entry", { entry: { id: 2, worker_id: 10, loop_id: 77, origin: "model", op: "SEND", coordinate: "1.1.1", tx: { body: "hi" }, turn_id: 1 } });
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
                instance: "loop:///88",
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
    m.fire(99, "log/entry", { entry: { id: 3, worker_id: 1, loop_id: 1, origin: "model", op: "SEND", tx: { body: "x" } } });
    assert.equal(seen.length, 0, "events for other workspaces don't leak into this thread");
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
        threadId: "conversation",
        notificationScope: "conversation",
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
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "nvim", notificationScope: "conversation", emit: (events) => seen.push(...events) });
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

test("a worker with a durable proposal re-presents its interrupt instead of starting new work", async () => {
    const pending: ProposalProjection[] = [proposal({ op: "EXEC", target: { scheme: null, authority: null, pathname: null }, body: "ls" })];
    const m = mockSeam(pending);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", notificationScope: "conversation", emit: (events) => seen.push(...events) });

    assert.equal(await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "new work" }), null);
    assert.equal(m.workers.length, 0, "a pending interrupt blocks a new internal loop");
    assert.ok(seen.some((event) => event.type === "TOOL_CALL_END"), "the durable interrupt is presented again");
    portal.stop();
});

test("a durable client interaction re-surfaces with its exact standard Interrupt and resumes through core", async () => {
    const m = mockSeam([], [interaction({ interactionId: 30, loopId: 7 })]);
    const seen: AguiEvent[] = [];
    let interrupt: unknown;
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "tui",
        notificationScope: "conversation",
        emit: (events) => {
            seen.push(...events);
            const end = events.find((event) => event.type === "TOOL_CALL_END") as { toolCallId?: string } | undefined;
            if (end?.toolCallId !== undefined) interrupt = portal.interruptForToolCall(end.toolCallId);
        },
    });

    assert.equal(await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "new work" }), null);
    assert.equal(m.workers.length, 0);
    assert.deepEqual(interrupt, {
        id: "int:30",
        reason: "tool_call",
        toolCallId: "int:30",
        message: "Choose one color.",
        responseSchema: interaction().request.responseSchema,
    });
    await portal.resolve(3, thread, [{
        interruptId: "int:30",
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
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", notificationScope: "conversation", emit: (evs) => seen.push(...evs) });

    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, loopId: 7, target: { scheme: "file", authority: null, pathname: "a.ts" } }));
    const start = seen.find((e) => e.type === "TOOL_CALL_START") as { toolCallId: string; toolCallName: string } | undefined;
    assert.equal(start?.toolCallId, "prop:42", "proposal fanned to the thread as a tool-call");
    assert.equal(start?.toolCallName, "request_approval");

    await portal.resolve(3, thread, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept" } }]);
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept" } });

    assert.equal(portal.cancel(10), true);
    assert.equal(m.cancelled(), 10, "cancel cancels the worker's drain");
    portal.stop();
});

test("{§agui-proposal-resolve}: resume binds the persisted loop before releasing its proposal", async () => {
    const pending = proposal({ logEntryId: 42, loopId: 7 });
    const m = mockSeam([pending]);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "nvim",
        notificationScope: "conversation",
        emit: (events) => seen.push(...events),
    });
    m.seam.resolveProposal = () => {
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
        interruptId: "prop:42",
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
    portal.start();
    const first = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 10,
        threadId: "nvim",
        notificationScope: "conversation",
        inputRunId: "run-a",
        emit: (events) => firstSeen.push(...events),
    });
    await portal.run(first, { workspaceId: 3, workerId: 10, prompt: "go" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "start" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "content", delta: "working" });
    m.fire(3, "reasoning/event", { workerId: 10, loopId: 77, turnId: 1, modelCallId: 8, requestSequence: 1, phase: "end" });
    m.fire(3, "loop/proposal", pending);
    portal.closeRun(3, first);

    const resume = [{
        interruptId: "prop:42",
        status: "resolved" as const,
        payload: { decision: "accept" },
    }];
    const second = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 10,
        threadId: "nvim",
        notificationScope: "conversation",
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
            op: "SEND",
            coordinate: "1/1/3/SEND",
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

test("{§agui-broadcast-fan}: an interrupted operation restores its owner scope without leaking into a result-only Run", async () => {
    const pending = proposal({ logEntryId: 42, workerId: 10, loopId: 7 });
    const m = mockSeam([pending]);
    const interruptedSeen: AguiEvent[] = [];
    const resumedSeen: AguiEvent[] = [];
    const managementSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const first = portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 20,
        threadId: "nvim",
        inputRunId: "operation-a",
        notificationScope: "operation",
        emit: (events) => interruptedSeen.push(...events),
    });
    m.fire(3, "loop/proposal", pending);
    assert.ok(interruptedSeen.some((event) => event.type === "TOOL_CALL_END"));
    portal.closeRun(3, first);

    const resume = [{
        interruptId: "prop:42",
        status: "resolved" as const,
        payload: { decision: "accept" },
    }];
    const resumed = portal.openThread({
        workspaceId: 3,
        workerId: 20,
        modelWorkerId: 20,
        threadId: "nvim",
        inputRunId: "operation-b",
        notificationScope: "conversation",
        resume,
        emit: (events) => resumedSeen.push(...events),
    });
    portal.openThread({
        workspaceId: 3,
        workerId: 10,
        modelWorkerId: 20,
        threadId: "nvim",
        inputRunId: "management",
        notificationScope: "result",
        emit: (events) => managementSeen.push(...events),
    });
    await portal.resolve(3, resumed, resume);
    m.fire(3, "log/entry", {
        entry: {
            id: 43,
            worker_id: 10,
            loop_id: 7,
            origin: "client",
            op: "EXEC",
            coordinate: "1/1/1/EXEC",
            tx: { body: "printf done" },
            rx: { status: 200 },
            turn_id: 1,
        },
    });
    portal.finishRun(3, 10, "nvim", [{
        type: EventType.CUSTOM,
        name: "plurnk.action.result",
        value: { kind: "op.exec", ok: true, result: { status: 200 } },
    }]);

    assert.equal(
        resumedSeen.filter((event) => event.type === "CUSTOM" && event.name === "plurnk.row").length,
        1,
        "the resumed operation receives its settled row once",
    );
    assert.ok(resumedSeen.some((event) => event.type === "RUN_FINISHED"), "the action result settles its resumed Run");
    assert.equal(managementSeen.length, 0, "the concurrent result-only Run receives no operation evidence");
    portal.stop();
});

test("{§agui-broadcast-fan}: branch-batch status reaches only its owning conversation Run", () => {
    const m = mockSeam();
    const conversationSeen: AguiEvent[] = [];
    const operationSeen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "conversation",
        notificationScope: "conversation",
        emit: (events) => conversationSeen.push(...events),
    });
    portal.openThread({
        workspaceId: 3,
        workerId: 10,
        threadId: "operation",
        notificationScope: "operation",
        emit: (events) => operationSeen.push(...events),
    });

    m.fire(3, "workspace/branch-batch", {
        batchId: 4,
        parentWorkerId: 10,
        state: "completed",
        completed: 1,
        total: 1,
    });

    assert.ok(conversationSeen.some((event) => event.type === "CUSTOM" && event.name === "plurnk.branch_batch"));
    assert.equal(operationSeen.length, 0, "an operation Run does not receive workspace status");
    portal.stop();
});
