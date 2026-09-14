// {§completion-defers-to-results}: same-turn failures are unobserved pending results, so a
// completion or an abandonment over them defers one packet, never strikes, and the same TASK
// concludes once the packet has shown the failure.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("{§completion-defers-to-results}: a failed op defers same-turn 200 until the next packet observes it", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // KILL of a nonexistent entry → 404 (a failure that is NOT a retrieval, isolating this gate
        // from the retrievals leg); the same-turn [200] defers.
        makeMockResponse("\n```KILL (worker:///no-such-entry)```\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
        // Next turn: the 404 is in-log and weighed; concluding now is legitimate.
        makeMockResponse("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "failgate" });
            const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, failures weighed");
            assert.equal(turnIds.length, 3, "initialization plus two model turns — the deferral cost one observation turn, no more");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = (rows ?? []).filter((r) => r.op === "TASK" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 102, "the first [200] was deferred over the unseen failure");
            assert.match(sends[0]?.rx ?? "", /operation failed in the same turn/, "the deferral names the failure, not a generic error");
            assert.doesNotMatch(sends[0]?.rx ?? "", /"problem"/, "a deferral carries no Problem and no strike");
        } finally { ws.close(); }
    });
});

test("{§completion-defers-to-results}: FAIL over a same-turn failure takes the same look, then abandons", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("\n```KILL (worker:///no-such-entry)```\n```SEND\ngiving up\n```\n```TASK\n[{\"content\":\"Task failed.\",\"status\":\"failed\"}]\n```", 10),
        makeMockResponse("\n```TASK\n[{\"content\":\"Task failed.\",\"status\":\"failed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "abandon" });
            const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 499, "the abandon lands on the packet after the failure was shown");
            assert.equal(turnIds.length, 3, "packetless initialization, the deferred abandonment, then the abandoning turn");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const tasks = rows.filter((r) => r.op === "TASK" && r.origin === "model");
            assert.deepEqual(tasks.map((r) => r.status_rx), [102, 499]);
            assert.match(tasks[0]?.rx ?? "", /^\{"status":102,"detail":"Abandonment deferred: 1 operation failed in the same turn\./, "the deferral speaks in the abandonment's own voice");
        } finally { ws.close(); }
    });
});
