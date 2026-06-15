// PLURNK_EXEC_WAIT_MS — the post-EXEC breath. After a turn backgrounds an exec
// whose spawn is still in flight at the next turn boundary, the loop waits a
// tunable beat before assembling the next packet (so a fast exec's output lands
// in it). Verified by a lower-bound timing assertion (the breath deterministically
// delays ≥ its ms); own file so the env override is process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

test("PLURNK_EXEC_WAIT_MS breathes before the next turn while a spawn is in flight (#exec-wait)", async () => {
    const prev = process.env.PLURNK_EXEC_WAIT_MS;
    process.env.PLURNK_EXEC_WAIT_MS = "300";
    try {
        // Turn 1 backgrounds a slow exec + continues (102); turn 2 ends (200). At
        // turn 2's boundary the sleep is still in flight → the 300ms breath fires.
        const mock = new Mock({ contextSize: 8192, responses: [
            makeMockResponse("<<EXEC[sh]:sleep 2:EXEC\n<<SEND[102]:running:SEND", 10),
            makeMockResponse("<<SEND[200]:done:SEND", 10),
        ] });
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "exec-wait" });
                const t0 = Date.now();
                const r = await rpcCall(ws, 2, "loop.run", { prompt: "go", flags: { yolo: true } });
                const elapsed = Date.now() - t0;
                assert.equal((r.result as { finalStatus: number }).finalStatus, 200);
                assert.ok(elapsed >= 250, `the 300ms breath fired before turn 2 (backgrounded spawn in flight); elapsed=${elapsed}ms`);
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_EXEC_WAIT_MS;
        else process.env.PLURNK_EXEC_WAIT_MS = prev;
    }
});
