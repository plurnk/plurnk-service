// {§send-premature-terminate}: a successful same-turn mutation's receipt lands in the next packet,
// so SEND[200] over it is refused 409 — the model sees what it changed before it claims done.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("{§send-premature-terminate}: an EDIT receipt blocks same-turn 200 until the next packet shows it", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("# PLAN0\nwrite then conclude\n\n## EDIT0 (worker:///notes.md)\nhello\n\n## SEND0 [200]\ndone", 10),
        makeMockResponse("# PLAN0\nthe edit receipt is in the log; concluding\n\n## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
            const { finalStatus, turnIds = [], loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, the edit observed");
            assert.equal(turnIds.length, 3, "initialization plus two model turns — the refusal forced one observation turn, no more");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 409, "the first [200] was refused over the unseen receipt");
            assert.match(sends[0]?.rx ?? "", /EDIT\/COPY\/MOVE effects land in the NEXT packet/, "the refusal names the receipts");
            assert.match(sends[0]?.rx ?? "", /Retrievals and mutations force an additional turn/);
            assert.equal(sends[1]?.status_rx, 200);
        } finally { ws.close(); }
    });
});
