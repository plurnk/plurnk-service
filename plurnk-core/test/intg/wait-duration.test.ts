// {§worker-wait-timing} Real subprocesses exercise wait expiry independently of their lifetime.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

// Observation begins only after optimistic settlement declines to keep waiting.
// This file isolates the parked observation itself.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

test("{§worker-lifecycle-poll-matrix} the configured wait bound wakes a loop with an open stream", async (t) => {
    const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
    process.env.PLURNK_SERVICE_WAIT_SEC = "1";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh [{\"lifetime\": \"30m\"}]\nsleep 30\n````\n\n````WAIT\nawait the result\n````", 10),
        makeMockResponse("````SEND\nobserved the still-open stream after wait expiry\n````\n````KILL (worker://root)\n````", 10),
    ] });
    try {
        await withDaemon(mock, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspace = await rpcCall(ws, 1, "workspace.create", { name: "wait-duration" });
                const { workerId } = await daemon.createConversationWorker({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                const generate = mock.generate.bind(mock);
                let observedLiveStream = false;
                t.mock.method(mock, "generate", async (args: Parameters<typeof mock.generate>[0]) => {
                    if (mock.received.length === 1) {
                        assert.equal((await db.worker_live_obligations.get({ worker_id: workerId }))?.streams, 1,
                            "wait expiry preserves the still-running subprocess");
                        const loops = await daemon.listWorkerLoops({ workspaceId: (workspace.result as { id: number }).id, workerId });
                        assert.equal(loops.at(-1)?.waitUntil, null, "the resumed application projection clears the deadline");
                        observedLiveStream = true;
                    }
                    return generate(args);
                });
                const started = Date.now();
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", workerId, policy: { proposals: "accept" } });
                assert.equal(finalStatus, 499);
                assert.ok(Date.now() - started < 10_000, "the wait expired before the 30-second stream conclusion");
                assert.equal(mock.remaining, 0);
                assert.equal(observedLiveStream, true);
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
    }
});

test("{§worker-lifecycle-poll-matrix} closure wakes the parked loop exactly once before its wait expires", async () => {
    const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
    // The duration is far longer than the spawn: the only wake that can arrive is closure.
    process.env.PLURNK_SERVICE_WAIT_SEC = "600";
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 3; echo closed\n````\n\n````WAIT\nwaiting for closure\n````", 10),
        makeMockResponse("````KILL\nobserved terminal closure\n````", 10),
    ] });
    try {
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "wait-closure" });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3, "initialization plus two model turns; no pre-closure wake consumed the terminal response");
                assert.equal(mock.remaining, 0, "closure produced the only continuation");
            } finally { ws.close(); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
    }
});
