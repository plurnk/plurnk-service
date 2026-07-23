// grammar 0.74.20 — EXEC `<T,P>` poll cadence. While a loop hibernates (SEND[202]) with a polled
// stream, the daemon wakes it every P seconds to inspect progress (§exec-poll). Proof: a 1s poll
// resumes the parked loop well before its 30s spawn would conclude — and a non-polled 202 would just
// hang. Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("[§exec-poll] a polled EXEC <T,P> wakes a hibernating (202) loop every P seconds", async () => {
    // 16384: base-packet growth (grammar 0.76.5 + sibling teaching) crested this accumulation's 8192 edge — headroom scaffolding, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: background a long spawn with a 1s poll, then hibernate.
        makeMockResponse("<<EXEC[sh]<30,1>:sleep 30:EXEC\n<<SEND[102]<-1>:hibernating; will poll:SEND", 10),
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
