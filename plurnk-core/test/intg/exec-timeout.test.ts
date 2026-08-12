// grammar 0.74.20 — EXEC `<T>` (the repurposed `<L>` slot) caps the spawn's lifetime at T
// seconds. After T the service aborts the spawn (bounded reap) and stamps the stream 504, distinct
// from a deliberate kill (499). Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, flush } from "./_rpc.ts";

test("EXEC <T> kills the spawn after T seconds and closes the stream 504", async () => {
    // `sleep 30` under a 1s timeout: the spawn MUST be killed near 1s, never run to completion.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("## EXEC1 [sh] <1>\nsleep 30\n\n## SEND1 [102]\nrunning", 10),
        makeMockResponse("## SEND1 [200]\nthe spawn timed out; done", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            const elapsed = Date.now() - t0;
            // The proof: a working timeout terminates the loop far under the 30s the sleep would take.
            // Wide margin (12s vs ~1-2s actual vs 30s no-timeout) — a correctness check, not a race.
            assert.ok(elapsed < 12000, `spawn timeout-killed near 1s, not run to 30s; elapsed=${elapsed}ms`);
            await flush();
            const closes = concluded() as Array<{ result: { status: number; problem?: { type: string } } }>;
            assert.ok(
                closes.some((c) => c.result.status === 504
                    && c.result.problem?.type === "https://problems.plurnk.dev/scheme/exec/execution-timeout"),
                `the exec stream closed with the exact timeout Problem; got ${JSON.stringify(closes.map((c) => c.result))}`,
            );
        } finally { ws.close(); }
    });
});
