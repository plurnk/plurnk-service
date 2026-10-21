import { serverProposals } from "./_approval.ts";
// {§exec-lifetime} — a bounded `[{"lifetime": …}]` caps the spawn. At the deadline the service
// aborts it (bounded reap) and stamps the stream 504, distinct from a deliberate kill (499).
// Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import { viableWindow } from "./_provider.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

test("{§exec-lifetime} a bounded lifetime kills the spawn at its deadline and closes the stream 504", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // `sleep 30` under a 2-second lifetime: the spawn MUST be killed at its deadline, never run to completion.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        // Park on the stream: its only conclusion is the reap, so turn 2 sees the 504 close.
        makeMockResponse("````sh [{\"lifetime\": \"2s\"}]\nsleep 30\n````\n\n````WAIT\nwaiting for the reap\n````", 10),
        makeMockResponse("````SEND [200]\nthe spawn timed out; done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go" }, { timeoutMs: 45_000 });
            const elapsed = Date.now() - t0;
            // The proof: the deadline is never early, and a working lifetime ends the loop far short of the 30s the sleep
            // would take — a correctness check about the contract's own time, not a race.
            assert.ok(elapsed >= 2_000 && elapsed < 25_000, `the spawn was reaped at its 2s deadline, not run to 30s; elapsed=${elapsed}ms`);
            const closes = await waitFor(
                () => concluded() as Array<{ scheme: string; result: { status: number; problem?: { type: string } } }>,
                (events) => events.some(({ scheme }) => scheme === "sh"),
            );
            assert.ok(
                closes.some((c) => c.result.status === 504
                    && c.result.problem?.type === "https://problems.plurnk.xyz/scheme/exec/execution-timeout"),
                `the exec stream closed with the exact lifetime Problem; got ${JSON.stringify(closes.map((c) => c.result))}`,
            );
        } finally { ws.close(); }
    });
});
