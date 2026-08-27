// grammar 0.74.20 — EXEC `<T,P>` poll cadence. While a loop hibernates (SEND[202]) with a polled
// stream, the daemon wakes it every P MINUTES to inspect progress ({§exec-poll}). Proof: a 1-minute
// poll resumes the parked loop before its 90s spawn would conclude — and a non-polled 202 would just
// hang. Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Polling begins only after optimistic settlement declines to keep waiting.
// This file isolates the parked poll policy itself.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

test("a polled EXEC <T,P> wakes a hibernating (202) loop every P minutes", { timeout: 120_000 }, async () => {
    // 16384: base-packet growth (grammar 0.76.5 + sibling teaching) crested this accumulation's 8192 edge — headroom scaffolding, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: background a long spawn with a 1-minute poll, then hibernate.
        makeMockResponse("## EXEC0 [sh] <30,1>\nsleep 90\n\n## SEND0 [202] <-1>\nhibernating; will poll", 10),
        // Turn 2 only happens if something resumed the parked loop. The spawn is still running at ~60s,
        // so a stream conclusion did NOT wake it — the poll did. Abandon (499 reaps the live spawn).
        makeMockResponse("## SEND0 [499]\nwoke via poll; abandoning", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-poll" });
            const t0 = Date.now();
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } }, { timeoutMs: 110_000 });
            const elapsed = Date.now() - t0;
            assert.equal(finalStatus, 499, "the loop reached turn 2 and terminated — it was resumed from 202");
            // ~60s (poll) < 90s (conclusion). A non-polled 202 would hang (runLoopToTerminal would time out),
            // so reaching a terminal at all proves a wake fired; the window proves it was the 1-minute poll.
            assert.ok(elapsed >= 55_000 && elapsed < 85_000, `the 1-minute poll woke the parked loop before the 90s spawn concluded; elapsed=${elapsed}ms`);
        } finally { ws.close(); }
    });
});

test("an EXEC without an explicit cadence wakes on the exponential-backoff floor while still open", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
    process.env.PLURNK_SERVICE_EXEC_POLL_SEC = "1";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## EXEC0 [sh] <30>\nsleep 30\n\n## SEND0 [202]\nwaiting under backoff", 10),
        makeMockResponse("## SEND0 [499]\nobserved the still-open stream on a backoff wake", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-poll-backoff" });
                const started = Date.now();
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
                assert.equal(finalStatus, 499);
                assert.ok(Date.now() - started < 10_000, "the backoff wake preceded the 30-second stream conclusion");
                assert.equal(mock.remaining, 0);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
        else process.env.PLURNK_SERVICE_EXEC_POLL_SEC = previous;
    }
});

test("an explicit zero cadence stays blind while open but still wakes exactly once on closure", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
    process.env.PLURNK_SERVICE_EXEC_POLL_SEC = "0.1";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## EXEC0 [sh] <10,0>\nsleep 3; echo closed\n\n## SEND0 [202]\nwaiting blindly for closure", 10),
        makeMockResponse("## SEND0 [200]\nobserved terminal closure", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-poll-blind" });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3, "initialization plus two model turns; no pre-closure poll consumed the terminal response");
                assert.equal(mock.remaining, 0, "closure produced the only continuation");
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
        else process.env.PLURNK_SERVICE_EXEC_POLL_SEC = previous;
    }
});
