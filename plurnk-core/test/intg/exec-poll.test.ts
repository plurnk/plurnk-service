// {§exec-lifetime} — cadence is the daemon's, never the model's. While a loop hibernates with an
// open stream the daemon wakes it on its own exponential backoff to inspect progress, and the
// stream's closure is a wake edge regardless. Own file: real subprocess + timing, process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Observation begins only after optimistic settlement declines to keep waiting.
// This file isolates the parked observation itself.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

test("{§worker-lifecycle-poll-matrix} an open stream wakes a hibernating (202) loop on the daemon's backoff", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
    process.env.PLURNK_SERVICE_EXEC_POLL_SEC = "1";
    // 16384: base-packet growth (grammar 0.76.5 + sibling teaching) crested this accumulation's 8192 edge — headroom scaffolding, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh [{\"lifetime\": \"30m\"}]\nsleep 30\n````\n\n````WAIT\nwaiting under backoff\n````", 10),
        makeMockResponse("````SEND\nobserved the still-open stream on a backoff wake\n````\n````KILL (worker://root)\n````", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspace = await rpcCall(ws, 1, "workspace.create", { name: "exec-poll-backoff" });
                const { workerId } = await daemon.createConversationWorker({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                const started = Date.now();
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", workerId, policy: { proposals: "accept" } });
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

test("{§worker-lifecycle-poll-matrix} closure wakes the parked loop exactly once, whatever the backoff was doing", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
    // A backoff far longer than the spawn: the only wake that can arrive is the closure.
    process.env.PLURNK_SERVICE_EXEC_POLL_SEC = "600";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 3; echo closed\n````\n\n````WAIT\nwaiting for closure\n````", 10),
        makeMockResponse("````SEND\nobserved terminal closure\n````", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-poll-closure" });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3, "initialization plus two model turns; no pre-closure wake consumed the terminal response");
                assert.equal(mock.remaining, 0, "closure produced the only continuation");
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_POLL_SEC;
        else process.env.PLURNK_SERVICE_EXEC_POLL_SEC = previous;
    }
});
