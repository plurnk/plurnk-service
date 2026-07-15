// grammar 0.74.20 — EXEC `<T>` (the repurposed `<L>` slot) caps the spawn's lifetime at T
// seconds. After T the service aborts the spawn (bounded reap) and stamps the stream 504, distinct
// from a deliberate kill (499). Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, flush } from "./_rpc.ts";

test("[§exec-timeout] EXEC <T> kills the spawn after T seconds and closes the stream 504", async () => {
    // `sleep 30` under a 1s timeout: the spawn MUST be killed near 1s, never run to completion.
    const mock = new Mock({ contextSize: viableWindow(), responses: [
        makeMockResponse("<<EXEC[sh]<1>:sleep 30:EXEC\n<<SEND[102]:running:SEND", 10),
        makeMockResponse("<<SEND[200]:the spawn timed out; done:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
            const elapsed = Date.now() - t0;
            // The proof: a working timeout terminates the loop far under the 30s the sleep would take.
            // Wide margin (12s vs ~1-2s actual vs 30s no-timeout) — a correctness check, not a race.
            assert.ok(elapsed < 12000, `spawn timeout-killed near 1s, not run to 30s; elapsed=${elapsed}ms`);
            await flush();
            const closes = concluded() as Array<{ closeStatus: number }>;
            assert.ok(
                closes.some((c) => c.closeStatus === 504),
                `the exec stream closed 504 (timed out), distinct from a kill; got ${JSON.stringify(closes.map((c) => c.closeStatus))}`,
            );
        } finally { ws.close(); }
    });
});
