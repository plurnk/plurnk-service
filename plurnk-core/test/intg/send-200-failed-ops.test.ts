import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, makeMockResponse, waitForDb } from "./_rpc.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { lastReply } from "./_helpers.ts";

for (const cancel of [false, true]) {
    test(`{§completion-defers-to-results}: a failed operation is observed before ${cancel ? "scope cancellation" : "explicit completion"}`, async () => {
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("\n````KILL (worker:///no-such-entry)\n````\n````SEND\nThe requested entry does not exist.\n````"),
            makeMockResponse(cancel ? "````KILL (worker://alice)\n````" : "````SEND\n````"),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "failed-op-observation" });
            const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "alice" });
                const result = await daemon.runLoop({ workspaceId, workerId, prompt: "go", policy: { proposals: "accept" } });
                const lifecycle = new LoopLifecycle(db);
                await waitForDb(() => lifecycle.status(result.loopId), (status) => status === (cancel ? 499 : 200));
                // {§turn-record}: cancellation status precedes the self-KILL receipt and turn completion.
                await waitForDb(
                    async () => (await db.test_list_turns_in_loop.all<{ producer: string; completed_at: string | null }>({ loop_id: result.loopId }))
                        .filter(({ producer }) => producer === "model"),
                    (turns) => turns.length === 2 && turns.every(({ completed_at }) => completed_at !== null),
                );
                assert.equal((await lifecycle.result(result.loopId))?.content, undefined);
                assert.equal(await lastReply(db, result.loopId), "The requested entry does not exist.");
                assert.equal(mock.received.length, 2);
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [
                    ["KILL", 404], ["SEND", 200], [cancel ? "KILL" : "SEND", 200],
                ]);
                const failure = rows.find(({ op, status_rx }) => op === "KILL" && status_rx === 404)!;
                const problem = JSON.parse(failure.rx).problem;
                assert.match(problem.type, /entry-not-found$/);
                assert.ok(JSON.stringify(mock.received[1]).includes(problem.type), "the actual failure reaches the observation packet");
        });
    });
}
