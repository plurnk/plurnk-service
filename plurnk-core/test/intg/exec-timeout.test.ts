// grammar 0.74.20 — EXEC `<T>` (the repurposed `<L>` slot) caps the spawn's lifetime at T
// MINUTES. After T the service aborts the spawn (bounded reap) and stamps the stream 504, distinct
// from a deliberate kill (499). Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications, flush } from "./_rpc.ts";

test("EXEC <T> kills the spawn after T minutes and closes the stream 504", { timeout: 150_000 }, async () => {
    // `sleep 120` under a 1-minute timeout: the spawn MUST be killed near 60s, never run to completion.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        // Park on the stream: its only conclusion is the reap, so turn 2 sees the 504 close.
        makeMockResponse("## EXEC0 [sh] <1>\nsleep 120\n\n## SEND0 [202] <-1>\nwaiting for the reap", 10),
        makeMockResponse("## SEND0 [200]\nthe spawn timed out; done", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } }, { timeoutMs: 130_000 });
            const elapsed = Date.now() - t0;
            // The proof: a working timeout terminates the loop well under the 120s the sleep would take.
            // Wide margin (100s vs ~60-62s actual vs 120s no-timeout) — a correctness check, not a race.
            assert.ok(elapsed >= 55_000 && elapsed < 100_000, `spawn timeout-killed near 60s, not run to 120s; elapsed=${elapsed}ms`);
            await flush();
            const closes = concluded() as Array<{ result: { status: number; problem?: { type: string } } }>;
            assert.ok(
                closes.some((c) => c.result.status === 504
                    && c.result.problem?.type === "https://problems.plurnk.xyz/scheme/exec/execution-timeout"),
                `the exec stream closed with the exact timeout Problem; got ${JSON.stringify(closes.map((c) => c.result))}`,
            );
        } finally { ws.close(); }
    });
});
