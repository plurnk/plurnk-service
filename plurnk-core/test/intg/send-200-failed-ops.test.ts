// §send-200-failed-ops (#363, owner ruling) — a worker must not conclude 200 over a failed op.
// A turn's failed operation results are UNSEEN until the next packet; a same-turn
// SEND[200] is refused 409 (weigh, then conclude), SEND[499] is never gated,
// and the gate judges only the current turn. Untrustworthy frames never dispatch;
// bounded syntax failures enter this same failed-operation gate.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("a failed op + SEND[200] same turn → 409; the NEXT turn's [200] concludes", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // KILL of a nonexistent entry → 404 (a failure that is NOT a retrieval, isolating this gate
        // from the retrievals leg); the same-turn [200] must be refused.
        makeMockResponse("<<PLAN:clean up then conclude:PLAN\n<<KILL(worker:///no-such-entry)::KILL\n<<SEND[200]:done:SEND", 10),
        // Next turn: the 404 is in-log and weighed; concluding now is legitimate.
        makeMockResponse("<<PLAN:the KILL 404d — nothing to clean; concluding:PLAN\n<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "failgate" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, failures weighed");
            assert.equal(turnIds.length, 2, "exactly two turns — the refusal forced one weigh turn, no more");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: 2 });
            const sends = (rows ?? []).filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 409, "the first [200] was refused over the unseen failure");
            assert.match(sends[0]?.rx ?? "", /failed operation/, "the refusal names the failure, not a generic error");
        } finally { ws.close(); }
    });
});

test("SEND[499] over a same-turn failure abandons unimpeded — declaring failure IS weighing it", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<PLAN:abort:PLAN\n<<KILL(worker:///no-such-entry)::KILL\n<<SEND[499]:giving up:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "abandon" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(finalStatus, 499, "the abandon went through in ONE turn — 499 is never gated");
            assert.equal(turnIds.length, 1);
        } finally { ws.close(); }
    });
});
