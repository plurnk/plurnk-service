// {§worker-lifecycle-total-reap}: shutdown cancels a pending stopped-world proposal
// before awaiting its drain.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor } from "./_rpc.ts";

test("{§worker-lifecycle-total-reap}: Daemon.stop terminates with a pending proposal", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // A non-auto host EXEC proposes (202) and stops the world; nobody ever resolves it.
        makeMockResponse("<<PLAN:run:PLAN\n<<EXEC[sh]:echo pending:EXEC\n<<SEND[102]:proposed:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stop-pending" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            // Leave the proposal UNRESOLVED — withDaemon's finally now runs daemon.stop against a
            // stopped world. The assertion IS this test completing: a deadlocked stop times out.
        } finally { ws.close(); }
    });
    assert.ok(true, "stop returned with a pending proposal outstanding");
});
