// {§send-directed-scope} — a session takes no numeric scope on SEND: timed and recurring delivery
// belong to the schedule family, so a scoped SEND is refused and admits nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";

test("{§send-directed-scope}: a scoped session SEND is refused and admits no task", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````SEND (session://scheduler) <0,60>\nUnadmitted scheduled instruction.\n````\n````NOTE\nInspect the refusal.\n````"),
        makeMockResponse("````SEND [200]\nThe scope was refused.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "send-scope" });
        const sessionId = (await daemon.createSession({ workspaceId, name: "scheduler" })).sessionId;
        try {
            const initial = await daemon.runLoop({ workspaceId, sessionId, prompt: "Send yourself a scoped message." });
            await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 200);
            const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
            const refusal = receipts.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("/scope-unsupported"));
            assert.equal(refusal?.status, 400);
            assert.equal(refusal.problem.detail, "A session SEND takes no scope."); // {§problems-entries}
            assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId }))
                .filter(({ prompt }) => prompt !== "").map(({ id }) => id), [initial.loopId], "the scoped SEND admitted no task");
            assert.equal(provider.received.length, 2);
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});
