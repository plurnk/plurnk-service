// The orchestration engine, tested against a mock seam — the pieces compose: a run
// re-surfaces pending + drives the loop, live events fan to the bound thread as AG-UI,
// a proposal reaches the thread as a tool-call, and a resume resolves it. No daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import Portal from "./Portal.ts";
import type { DaemonSeam, PendingProposal, ProposalResolution } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";

const mockSeam = (pending: PendingProposal[] = []) => {
    // The real seam holds a Set of handlers (Portal subscribes twice: render + HITL);
    // mirror that so both fire, not just the last registered.
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const runs: Array<{ sessionId: number; prompt: string }> = [];
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    let cancelled: number | null = null;
    const seam = {
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => pending,
        resolveProposal: (logEntryId, resolution) => { resolves.push({ logEntryId, resolution }); },
        runLoop: async (a) => { runs.push({ sessionId: a.sessionId, prompt: a.prompt }); return { action: "enqueued_new_loop" as const, loopId: 77 }; },
        cancelDrain: (runId) => { cancelled = runId; return true; },
        dispatchAsClient: async () => ({ status: 200 }),
        readLog: async () => [],
        listProviders: () => ({ aliases: [] }),
    } satisfies DaemonSeam;
    return { seam, fire: (s: number | null, m: string, p: unknown) => handlers.forEach((h) => h(s, m, p)), runs, resolves, cancelled: () => cancelled };
};

test("a run re-surfaces pending, drives the loop, then live events fan as AG-UI", async () => {
    const pending: PendingProposal[] = [{ logEntryId: 5, runId: 1, loopId: 1, turnId: 1, op: "EXEC", suffix: "", scheme: "sh", pathname: null, tx: "ls", attrs: null }];
    const m = mockSeam(pending);
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    portal.openThread({ sessionId: 3, runId: 10, threadId: "tui", emit: (evs) => seen.push(...evs) });

    const ack = await portal.run({ sessionId: 3, runId: 10, prompt: "go" });
    assert.equal(ack.loopId, 77, "loop driven via runLoop");
    assert.deepEqual(m.runs[0], { sessionId: 3, prompt: "go" });
    assert.ok(seen.some((e) => e.type === "TOOL_CALL_START"), "the pending stopped-world re-surfaced as a tool-call");

    // A live model SEND fans to the thread as assistant speech.
    seen.length = 0;
    m.fire(3, "log/entry", { entry: { id: 2, run_id: 10, origin: "model", op: "SEND", coordinate: "1.1.1", tx: { body: "hi" }, turn_id: 1 } });
    assert.ok(seen.some((e) => e.type === "TEXT_MESSAGE_CONTENT"), "live speech rendered to the bound thread");

    // An event for an UNbound session is dropped, not misrouted.
    seen.length = 0;
    m.fire(99, "log/entry", { entry: { id: 3, run_id: 1, origin: "model", op: "SEND", tx: { body: "x" } } });
    assert.equal(seen.length, 0, "events for other sessions don't leak into this thread");
    portal.stop();
});

test("a live proposal reaches the bound thread as a tool-call; resume resolves it; cancel cancels", async () => {
    const m = mockSeam();
    const seen: AguiEvent[] = [];
    const portal = new Portal(m.seam);
    portal.start();
    portal.openThread({ sessionId: 3, runId: 10, threadId: "tui", emit: (evs) => seen.push(...evs) });

    m.fire(3, "loop/proposal", { logEntryId: 42, op: "EDIT", target: { scheme: "file", pathname: "a.ts" }, body: "diff", attrs: {} });
    const start = seen.find((e) => e.type === "TOOL_CALL_START") as { toolCallId: string; toolCallName: string } | undefined;
    assert.equal(start?.toolCallId, "prop:42", "proposal fanned to the thread as a tool-call");
    assert.equal(start?.toolCallName, "request_approval");

    assert.equal(portal.resolve({ toolCallId: "prop:42", content: JSON.stringify({ decision: "accept" }) }), true);
    assert.deepEqual(m.resolves[0], { logEntryId: 42, resolution: { decision: "accept" } });

    assert.equal(portal.cancel(10), true);
    assert.equal(m.cancelled(), 10, "cancel cancels the run's drain");
    portal.stop();
});
