// PLURNK_SERVICE_EXEC_WAIT_MS — the post-EXEC breath. After a turn backgrounds an exec
// whose spawn is still in flight at the next turn boundary, the loop waits a
// tunable beat before assembling the next packet (so a fast exec's output lands
// in it). Verified by a lower-bound timing assertion (the breath deterministically
// delays ≥ its ms); own file so the env override is process-isolated.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("PLURNK_SERVICE_EXEC_WAIT_MS breathes before the next turn while a spawn is in flight (#exec-wait)", async () => {
    const prev = process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
    process.env.PLURNK_SERVICE_EXEC_WAIT_MS = "300";
    try {
        // Turn 1 backgrounds a slow exec + continues (102); at turn 2's boundary the sleep is still in
        // flight → the 300ms breath fires. The spawn is still live at turn 2's close, so a SEND[200]
        // would be premature (§send the terminal contract) — turn 2 takes the 499 exit the steer sanctions.
    // 16384: base-packet growth (grammar 0.76.5 + sibling teaching) crested this accumulation's 8192 edge — headroom scaffolding, not a budget probe.
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("<<EXEC[sh]:sleep 2:EXEC\n<<SEND[102]:running:SEND", 10),
            makeMockResponse("<<SEND[499]:abandoning while the spawn runs:SEND", 10),
        ] });
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-wait" });
                const t0 = Date.now();
                // loop.run returns immediately (Model 3); runLoopToTerminal awaits the
                // loop/terminated event, so `elapsed` spans the full loop incl. the breath.
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
                const elapsed = Date.now() - t0;
                assert.equal(finalStatus, 499);
                assert.ok(elapsed >= 250, `the 300ms breath fired before turn 2 (backgrounded spawn in flight); elapsed=${elapsed}ms`);
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
        else process.env.PLURNK_SERVICE_EXEC_WAIT_MS = prev;
    }
});
