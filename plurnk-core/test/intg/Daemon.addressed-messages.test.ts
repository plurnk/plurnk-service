import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { holdChild } from "./_helpers.ts";
import { makeMockResponse, waitForDb, withDaemon } from "./_rpc.ts";

// Exercise reply delivery with a bounded coalescing window; sibling tests cover
// quiescence, deadlines, and mixed reply/stream/child settlement.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";

test("{§message-reply-delivery}: a client-authored answer wakes its assigned worker without making another request", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("```WAIT\nA collaborator may answer the request.\n```"),
        makeMockResponse("```WAIT\nThe collaborator answered; the held child is still running.\n```"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "client-answer-wake" });
        const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "assigned" });
        const collaborator = await daemon.createConversationWorker({ workspaceId, name: "collaborator" });
        await holdChild(db, workspaceId, workerId);
        const address = "worker://assigned/?message=12345678";
        const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "What is the result?", messageAddress: address });
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(`SEND (${address})`, "The result is 42."));
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0]!;
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("The reply fixture did not parse.");
        const result = await daemon.dispatchAsClient({ workspaceId, workerId: collaborator.workerId, statement: item.statement });
        assert.equal(result.status, 200);
        await waitForDb(async () => provider.received.length, (count) => count === 2);
        await waitForDb(() => db.test_get_loop_status.get({ id: accepted.loopId }), (row) => row?.status === 202);
        assert.match(JSON.stringify(provider.received[1]), /The result is 42\./);
        assert.equal((await db.message_unanswered_count.get({ loop_id: accepted.loopId }))?.count, 0);
        assert.equal((await db.test_messages_by_worker.all({ worker_id: workerId })).length, 1, "a reply is not another incoming obligation");
        assert.equal((await db.test_loop_queue_by_worker.all({ worker_id: workerId })).length, 1, "the same parked loop resumed");
        const history = await daemon.readMessages({ workspaceId, workerId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "What is the result?" },
            { direction: "outbound", body: "The result is 42." },
        ]);
        await daemon.cancelWorker({ workspaceId, workerId });
    });
});
