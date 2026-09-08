// {§send-premature-terminate}: same-turn failures are unobserved pending results, so DONE
// refuses 409 until the next packet observes them; FAIL may abandon them deliberately.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("{§send-premature-terminate}: a failed op blocks same-turn 200 until the next packet observes it", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // KILL of a nonexistent entry → 404 (a failure that is NOT a retrieval, isolating this gate
        // from the retrievals leg); the same-turn [200] must be refused.
        makeMockResponse("```PLAN\nclean up then conclude\n```\n\n```KILL (worker:///no-such-entry)```\n```DONE\ndone\n```", 10),
        // Next turn: the 404 is in-log and weighed; concluding now is legitimate.
        makeMockResponse("```PLAN\nthe KILL 404d — nothing to clean; concluding\n```\n\n```DONE\ndone\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "failgate" });
            const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, failures weighed");
            assert.equal(turnIds.length, 3, "initialization plus two model turns — the refusal forced one observation turn, no more");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = (rows ?? []).filter((r) => r.op === "DONE" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 409, "the first [200] was refused over the unseen failure");
            assert.match(sends[0]?.rx ?? "", /failed operation/, "the refusal names the failure, not a generic error");
        } finally { ws.close(); }
    });
});

test("{§send-premature-terminate}: FAIL deliberately abandons a same-turn failure", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```PLAN\nabort\n```\n\n```KILL (worker:///no-such-entry)```\n```FAIL\ngiving up\n```", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "abandon" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 499, "the abandon went through in ONE turn — 499 is never gated");
            assert.equal(turnIds.length, 2, "packetless initialization precedes the one abandoning model turn");
        } finally { ws.close(); }
    });
});
