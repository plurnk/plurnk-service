// The orchestration engine, tested against a mock seam — the pieces compose: a worker
// re-surfaces pending + drives the loop, live events fan to the bound thread as AG-UI,
// a proposal reaches the thread as a tool-call, and a resume resolves it. No daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import Portal from "./Portal.ts";
import type { DaemonSeam, PendingProposal, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";
import { DEFAULT_LOOP_FLAGS } from "@plurnk/plurnk-contracts";

const proposal = (over: Partial<PendingProposal> = {}): PendingProposal => ({
    logEntryId: 5,
    workerId: 10,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", pathname: "a" },
    body: "diff",
    attrs: {},
    flags: DEFAULT_LOOP_FLAGS,
    staleClobberRisk: false,
    disposition: { owner: "client" },
    ...over,
});

const mockSeam = (pending: PendingProposal[] = []) => {
    // The real seam holds a Set of handlers (Portal subscribes twice: render + HITL);
    // mirror that so both fire, not just the last registered.
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const workers: Array<{ workspaceId: number; prompt: string }> = [];
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    let cancelled: number | null = null;
    const seam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => pending,
        resolveProposal: (logEntryId, resolution) => { resolves.push({ logEntryId, resolution }); },
        runLoop: async (a) => { workers.push({ workspaceId: a.workspaceId, prompt: a.prompt }); return { status: 100, action: "enqueued_new_loop" as const, loopId: 77 }; },
        cancelDrain: (workerId) => { cancelled = workerId; return true; },
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        readLog: async () => [],
        listProviders: () => ({ aliases: [] }),
    } satisfies Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "runLoop" | "cancelDrain" | "dispatchClientAction" | "readLog" | "listProviders">;
    return { seam, fire: (s: number | null, m: string, p: unknown) => handlers.forEach((h) => h(s, m, p)), workers, resolves, cancelled: () => cancelled };
};

test("a worker without pending interrupts drives the loop, then live events fan as AG-UI", async () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", emit: (evs) => seen.push(...evs) });

    const ack = await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "go" });
    assert.ok(ack !== null);
    assert.equal(ack.loopId, 77, "loop driven via runLoop");
    assert.deepEqual(m.workers[0], { workspaceId: 3, prompt: "go" });

    // A live model SEND fans to the thread as assistant speech.
    seen.length = 0;
    m.fire(3, "log/entry", { entry: { id: 2, worker_id: 10, origin: "model", op: "SEND", coordinate: "1.1.1", tx: { body: "hi" }, turn_id: 1 } });
    assert.ok(seen.some((e) => e.type === "TEXT_MESSAGE_CONTENT"), "live speech rendered to the bound thread");

    // Workspace topology is visible, but another loop's terminal must never
    // conclude this AG-UI Run.
    seen.length = 0;
    m.fire(3, "loop/terminated", {
        loopId: 88,
        result: {
            status: 499,
            problem: {
                type: "https://problems.plurnk.dev/lifecycle/cancel/loop-cancelled",
                title: "Loop cancelled",
                status: 499,
                detail: "The foreign loop was cancelled.",
                instance: "loop:///88",
            },
        },
        hitMaxTurns: false,
        turnIds: [],
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, contextTokens: 0, promptBudget: 1000, meta: {} },
    });
    assert.equal(seen.length, 0, "a foreign loop terminal cannot end this AG-UI Run");

    m.fire(3, "loop/terminated", {
        loopId: 77, result: { status: 200 }, hitMaxTurns: false, turnIds: [1],
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0, contextTokens: 2, promptBudget: 1000, meta: {} },
    });
    assert.ok(seen.some((e) => e.type === "RUN_FINISHED"), "the bound loop terminal ends this AG-UI Run");

    // An event for an UNbound workspace is dropped, not misrouted.
    seen.length = 0;
    m.fire(99, "log/entry", { entry: { id: 3, worker_id: 1, origin: "model", op: "SEND", tx: { body: "x" } } });
    assert.equal(seen.length, 0, "events for other workspaces don't leak into this thread");
    portal.stop();
});

test("a terminal arriving before the loop acknowledgement settles only its matching AG-UI Run", async () => {
    const m = mockSeam();
    let acknowledge!: (value: { status: number; action: "enqueued_new_loop"; loopId: number }) => void;
    m.seam.runLoop = async () => new Promise((resolve) => { acknowledge = resolve; });
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "nvim", emit: (events) => seen.push(...events) });
    const running = portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "fast" });
    await Promise.resolve();
    await Promise.resolve();

    const termination = (loopId: number) => ({
        loopId, result: { status: 200 }, hitMaxTurns: false, turnIds: [],
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, contextTokens: 0, promptBudget: 1000, meta: {} },
    });
    m.fire(3, "loop/terminated", termination(88));
    m.fire(3, "loop/terminated", termination(77));
    assert.equal(seen.length, 0, "pre-ack terminals are buffered, never guessed");

    acknowledge({ status: 100, action: "enqueued_new_loop", loopId: 77 });
    assert.deepEqual(await running, { loopId: 77 });
    assert.equal(seen.filter((event) => event.type === "RUN_FINISHED").length, 1, "only the acknowledged loop settles the AG-UI Run");
    portal.stop();
});

test("a worker with a durable proposal re-presents its interrupt instead of starting new work", async () => {
    const pending: PendingProposal[] = [proposal({ op: "EXEC", target: { scheme: null, pathname: null }, body: "ls" })];
    const m = mockSeam(pending);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", emit: (events) => seen.push(...events) });

    assert.equal(await portal.run(thread, { workspaceId: 3, workerId: 10, prompt: "new work" }), null);
    assert.equal(m.workers.length, 0, "a pending interrupt blocks a new internal loop");
    assert.ok(seen.some((event) => event.type === "TOOL_CALL_END"), "the durable interrupt is presented again");
    portal.stop();
});

test("a live proposal reaches the bound thread as a tool-call; resume resolves it; cancel cancels", async () => {
    const m = mockSeam([proposal({ logEntryId: 42, loopId: 7 })]);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    const thread = portal.openThread({ workspaceId: 3, workerId: 10, threadId: "tui", emit: (evs) => seen.push(...evs) });

    m.fire(3, "loop/proposal", proposal({ logEntryId: 42, loopId: 7, target: { scheme: "file", pathname: "a.ts" } }));
    const start = seen.find((e) => e.type === "TOOL_CALL_START") as { toolCallId: string; toolCallName: string } | undefined;
    assert.equal(start?.toolCallId, "prop:42", "proposal fanned to the thread as a tool-call");
    assert.equal(start?.toolCallName, "request_approval");

    await portal.resolve(3, thread, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept" } }]);
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept" } });

    assert.equal(portal.cancel(10), true);
    assert.equal(m.cancelled(), 10, "cancel cancels the worker's drain");
    portal.stop();
});
