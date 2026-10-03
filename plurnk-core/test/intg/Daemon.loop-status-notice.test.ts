// {§loop-status-notice} — the drain's lifecycle beat on the notice channel: running when it claims a
// loop, parked when it leaves one suspended, queued then running when a message wakes it. Transient and
// broadcast; the packet never carries it.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { holdChild } from "./_db.ts";
import { connect, rpcCall, subscribeNotifications, waitForDb, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

type LoopStatusNotice = { workerId: number; loopId: number; notice: { source: string; kind: string; level: string; status: number; waitUntil: number | null } };

test("{§loop-status-notice}: claim, park and wake each broadcast the loop's status as a lifecycle notice", async () => {
    const provider = new Mock({
        contextWindow: 65536,
        responses: [
            makeMockResponse("````WAIT\nWaiting on the child.\n````"),
            makeMockResponse("````NOTE\nWoken by the message.\n````\n````WAIT\n````"),
        ],
    });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const { workspaceId } = await daemon.createWorkspace({ name: "loop-status-notice" });
            await rpcAttach(ws, workspaceId);
            const workerId = await daemon.ensureModelWorker(workspaceId);
            await holdChild(db, workspaceId, workerId);
            const captured = subscribeNotifications(ws, "notice/event");
            const lifecycle = (): LoopStatusNotice[] => (captured() as LoopStatusNotice[])
                .filter(({ notice }) => notice.source === "engine:lifecycle" && notice.kind === "loop_status");
            try {
                const accepted = await daemon.inject({
                    workspaceId, workerId,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive", systemPrompt: "test system", prompt: "Delegate and wait.",
                });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId }), (row) => row?.status === 202);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 2);
                assert.deepEqual(lifecycle().map(({ loopId, notice }) => [loopId, notice.status, notice.level]), [[accepted.loopId, 102, "info"], [accepted.loopId, 202, "info"]],
                    "running when claimed, parked when suspended, both naming the loop");
                const firstDeadline = lifecycle()[1]!.notice.waitUntil;
                assert.ok(typeof firstDeadline === "number" && firstDeadline > Date.now(), "the parked notice names a future wake deadline");
                assert.equal(lifecycle()[0]!.notice.waitUntil, null, "running has no countdown");
                assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId })).find(({ id }) => id === accepted.loopId)?.waitUntil,
                    firstDeadline, "reattachment and live updates describe the same durable deadline");

                const delivered = await daemon.runLoop({ workspaceId, workerId, prompt: "A message wakes it." });
                assert.equal(delivered.loopId, accepted.loopId);
                await waitForDb(async () => lifecycle(), (notices) => notices.length >= 5);
                assert.deepEqual(lifecycle().slice(2).map(({ notice }) => notice.status), [100, 102, 202], "waking queues the loop, then claim and WAIT move it through running to parked");
                assert.deepEqual(lifecycle().slice(2, 4).map(({ notice }) => notice.waitUntil), [null, null], "the countdown clears before inference begins");
                const nextDeadline = lifecycle()[4]!.notice.waitUntil;
                assert.ok(typeof nextDeadline === "number" && nextDeadline > firstDeadline, "the next WAIT starts a fresh bounded park");
                assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId })).find(({ id }) => id === accepted.loopId)?.waitUntil, nextDeadline);
                assert.ok(lifecycle().every(({ workerId: owner }) => owner === workerId), "every beat names the owning worker");
                const packets = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: accepted.loopId });
                assert.ok(packets.every(({ rx }) => !rx.includes("loop_status")), "the beat is transient: no log row, nothing for a packet");
            } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
        } finally { ws.close(); }
    });
});

const rpcAttach = async (ws: Awaited<ReturnType<typeof connect>>, workspaceId: number): Promise<void> => {
    const response = await rpcCall(ws, 1, "workspace.attach", { id: workspaceId });
    if ("error" in response && response.error !== undefined) throw new Error(`attach failed: ${JSON.stringify(response.error)}`);
};
