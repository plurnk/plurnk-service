import { serverProposals } from "./_approval.ts";
// {§worker-wait-timing} Real subprocesses exercise wait expiry independently of their lifetime.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import NoticeChannel from "../../src/core/NoticeChannel.ts";

// Observation begins only after optimistic settlement declines to keep waiting.
// This file isolates the parked observation itself.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

test("{§notice-drain-on-read} cancelling a parked loop releases its undelivered feedback", async (t) => {
    serverProposals(t, "accept");
    const pushed = t.mock.method(NoticeChannel.prototype, "push");
    const deleted = t.mock.method(NoticeChannel.prototype, "delete");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse("````sh\nsleep 30\n````\n\n````WAIT 15\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cancel-wait-feedback" });
            const notices = subscribeNotifications(ws, "notice/event");
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            const { loopId } = response.result as { loopId: number };
            await waitFor(() => notices() as Array<{ loopId: number; notice: { kind: string; status?: number } }>,
                (items) => items.some((item) => item.loopId === loopId && item.notice.kind === "loop_status" && item.notice.status === 202));
            const warning = pushed.mock.calls.find(({ arguments: args }) => args[2] === loopId && args[3].kind === "parse_advisory");
            assert.ok(warning, "the real parser generated feedback for the parked loop");
            const channel = warning.this as NoticeChannel;
            assert.equal(deleted.mock.calls.some((call) => call.this === channel && call.arguments[0] === loopId), false,
                "parking is not terminal cleanup");
            await rpcCall(ws, 3, "loop.cancel", {});
            await waitFor(() => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (items) => items.some((item) => item.loopId === loopId && item.result.status === 499));
            assert.deepEqual(channel.drain(loopId), [], "cancellation releases feedback without another model call");
            assert.equal(mock.received.length, 1);
        } finally { ws.close(); }
    });
});

for (const header of ["WAIT", "WAIT <0>"]) {
    test(`{§worker-lifecycle-poll-matrix} ${header} resumes a loop without closing its open stream`, async (t) => {
    serverProposals(t, "accept");
        const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
        process.env.PLURNK_SERVICE_WAIT_SEC = "1";
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse(`\`\`\`\`sh [{"lifetime": "30m"}]\nsleep 30\n\`\`\`\`\n\n\`\`\`\`${header}\nawait the result\n\`\`\`\``, 10),
            makeMockResponse("````SEND\nobserved the still-open stream\n````\n````KILL (worker://root)\n````", 10),
        ] });
        try {
            await withDaemon(mock, async (db, daemon, addr) => {
                const ws = await connect(addr);
                const notices = subscribeNotifications(ws, "notice/event");
                try {
                    const workspace = await rpcCall(ws, 1, "workspace.create", { name: "wait-duration" });
                    const { workerId } = await daemon.createConversationWorker({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                    const generate = mock.generate.bind(mock);
                    let observedLiveStream = false;
                    t.mock.method(mock, "generate", async (args: Parameters<typeof mock.generate>[0]) => {
                        if (mock.received.length === 1) {
                            assert.equal((await db.worker_live_obligations.get({ worker_id: workerId }))?.streams, 1,
                                "continuation preserves the still-running subprocess");
                            const loops = await daemon.listWorkerLoops({ workspaceId: (workspace.result as { id: number }).id, workerId });
                            assert.equal(loops.at(-1)?.waitUntil, null, "the resumed application projection clears the deadline");
                            observedLiveStream = true;
                        }
                        return generate(args);
                    });
                    const started = Date.now();
                    const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", workerId });
                    assert.equal(finalStatus, 499);
                    assert.ok(Date.now() - started < 10_000, "the wait expired before the 30-second stream conclusion");
                    assert.equal(mock.remaining, 0);
                    assert.equal(observedLiveStream, true);
                    const parks = (notices() as Array<{ notice: { kind: string; status?: number } }>)
                        .filter(({ notice }) => notice.kind === "loop_status" && notice.status === 202);
                    assert.equal(parks.length, header === "WAIT" ? 1 : 0, "zero bypasses parking rather than creating an immediate timer");
                } finally { ws.close(); }
            });
        } finally {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
            else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
        }
    });
}

test("{§worker-lifecycle-poll-matrix} closure wakes the parked loop exactly once before its wait expires", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
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
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "go" });
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
