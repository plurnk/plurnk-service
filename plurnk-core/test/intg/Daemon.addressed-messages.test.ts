import assert from "node:assert/strict";
import test from "node:test";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { SchemeResult } from "../../src/core/results.ts";
import { holdChild } from "./_helpers.ts";
import { makeMockResponse, waitForDb, withDaemon } from "./_rpc.ts";

// Exercise reply delivery with a bounded coalescing window; sibling tests cover
// quiescence, deadlines, and mixed reply/stream/child settlement.
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";

test("{§worker-scheme-irc}: an empty directed SEND refuses before admission and the model can recover", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse([
            PlurnkParser.frame("SEND (worker://receiver)", null),
            PlurnkParser.frame("NOTE", "Keep the sibling operation."),
        ].join("\n\n")),
        makeMockResponse(PlurnkParser.frame("KILL", "No message was delivered to the receiver.")),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "empty-worker-message", projectRoot: null });
        const sender = await daemon.createConversationWorker({ workspaceId, name: "sender" });
        const receiver = await daemon.createConversationWorker({ workspaceId, name: "receiver" });
        const accepted = await daemon.runLoop({ workspaceId, workerId: sender.workerId, prompt: "Check delivery." });
        const loops = await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: sender.workerId }),
            (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
        assert.equal(loops.find((row) => row.id === accepted.loopId)?.status, 200);
        const rows = await daemon.readLog({ workspaceId, workerId: sender.workerId, loopId: accepted.loopId });
        const refused = rows.find((row) => row.origin === "model" && row.op === "SEND");
        assert.ok(refused);
        assert.equal(refused.status_rx, 422);
        const receipt = refused.rx as SchemeResult;
        assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/worker/message-empty");
        assert.equal(receipt.problem?.detail, "SEND has no message text or attachments.");
        assert.ok(rows.some((row) => row.origin === "model" && row.op === "NOTE" && row.status_rx === 200));
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId, workerId: receiver.workerId }), [], "no empty receiving loop is created");
        assert.deepEqual(await daemon.readMessages({ workspaceId, workerId: receiver.workerId }), [], "no empty message is stored");
        assert.equal(provider.received.length, 2, "only the sender ran and recovered");
        assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /SEND has no message text or attachments\./);
        const history = await daemon.readMessages({ workspaceId, workerId: sender.workerId });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), [
            "No message was delivered to the receiver.",
        ]);
    });
});

test("{§message-reply-delivery}: a client-authored answer wakes its assigned worker without making another request", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("````WAIT\nA collaborator may answer the request.\n````"),
        makeMockResponse("````WAIT\nThe collaborator answered; the held child is still running.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "client-answer-wake" });
        const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "assigned" });
        const collaborator = await daemon.createConversationWorker({ workspaceId, name: "collaborator" });
        await holdChild(db, workspaceId, workerId);
        const address = "message://assigned/12345678";
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
