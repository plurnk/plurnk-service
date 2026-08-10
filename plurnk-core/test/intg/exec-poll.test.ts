// grammar 0.74.20 — EXEC `<T,P>` poll cadence. While a loop hibernates (SEND[202]) with a polled
// stream, the daemon wakes it every P seconds to inspect progress ({§exec-poll}). Proof: a 1s poll
// resumes the parked loop well before its 30s spawn would conclude — and a non-polled 202 would just
// hang. Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Polling begins only after optimistic settlement declines to keep waiting.
// This file isolates the parked poll policy itself.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

test("a polled EXEC <T,P> wakes a hibernating (202) loop every P seconds", async () => {
    // 16384: base-packet growth (grammar 0.76.5 + sibling teaching) crested this accumulation's 8192 edge — headroom scaffolding, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: background a long spawn with a 1s poll, then hibernate.
        makeMockResponse("<<EXEC[sh]<30,1>:sleep 30:EXEC\n<<SEND[202]<-1>:hibernating; will poll:SEND", 10),
        // Turn 2 only happens if something resumed the parked loop. The spawn is still running at ~1s,
        // so a stream conclusion did NOT wake it — the poll did. Abandon (499 reaps the live spawn).
        makeMockResponse("<<SEND[499]:woke via poll; abandoning:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-poll" });
            const t0 = Date.now();
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            const elapsed = Date.now() - t0;
            assert.equal(finalStatus, 499, "the loop reached turn 2 and terminated — it was resumed from 202");
            // ~1s (poll) ≪ 30s (conclusion). A non-polled 202 would hang (runLoopToTerminal would time out),
            // so reaching a terminal at all proves a wake fired; the <10s bound proves it was the 1s poll.
            assert.ok(elapsed < 10000, `the 1s poll woke the parked loop before the 30s spawn concluded; elapsed=${elapsed}ms`);
        } finally { ws.close(); }
    });
});

test("an EXEC without an explicit cadence wakes on the exponential-backoff floor while still open", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
    process.env.PLURNK_SERVICE_EXEC_POLL_SEC = "1";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<EXEC[sh]<30>:sleep 30:EXEC\n<<SEND[202]:waiting under backoff:SEND", 10),
        makeMockResponse("<<SEND[499]:observed the still-open stream on a backoff wake:SEND", 10),
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
        makeMockResponse("<<EXEC[sh]<10,0>:sleep 3; echo closed:EXEC\n<<SEND[202]:waiting blindly for closure:SEND", 10),
        makeMockResponse("<<SEND[200]:observed terminal closure:SEND", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-poll-blind" });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 2, "no pre-closure poll turn consumed the terminal response");
                assert.equal(mock.remaining, 0, "closure produced the only continuation");
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
        else process.env.PLURNK_SERVICE_EXEC_POLL_SEC = previous;
    }
});
