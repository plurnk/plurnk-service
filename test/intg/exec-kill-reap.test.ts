// The teardown-reap half of the KILL wire onto @plurnk/plurnk-execs (§run-lifecycle-total-reap).
// A background exec that IGNORES the polite signals (HUP/TERM) is endable ONLY by the bounded
// housekeeping SIGKILL — so this is the positive proof that the service hands the executor
// `{ housekeeping, graceMs }` on teardown, not a bare abort the executor can't escalate past SIGHUP.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitFor, waitForDb } from "./_rpc.ts";
import type { PrepMethod } from "../../src/core/Db.ts";

const mockTurn = (dsl: string) => ({
    assistant: { content: `<<PLAN::PLAN\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A host exec that arms itself against the polite signals, then sleeps. Only the housekeeping
// SIGKILL (delivered to the whole process group) can end it — a bare HUP/TERM is trapped away.
const stubbornSpawn = `<<EXEC[sh]:trap '' HUP TERM; sleep 30:EXEC\n<<SEND[202]:parked with a stubborn spawn:SEND`;

test("teardown hard-kills a SIGHUP/SIGTERM-ignoring background spawn — the bounded housekeeping reap", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
    process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = "50";  // a fast SIGKILL grace — deterministic, far under the waitFor budget
    try {
        const mock = new Mock({ contextSize: 8192, responses: [mockTurn(stubbornSpawn)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "exec-stubborn-reap" });
                const concluded = subscribeNotifications(ws, "stream/concluded");
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a stubborn exec then park", flags: { yolo: true } });
                const loopId = (run.result as { loopId: number }).loopId;

                // The loop parks (202) only AFTER its EXEC has spawned, so a 202 status is the
                // deterministic "the stubborn spawn is live" gate — never a fixed-sleep race.
                await waitForDb(
                    () => (db.engine_loop_status as PrepMethod).get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 202,
                    { timeoutMs: 5000 },
                );

                // Cancel fires the run-level total reap. The spawn traps HUP+TERM, so the polite
                // signal can't end it; only the housekeeping SIGKILL (after the 50ms grace) does.
                // Its 499 conclusion is the positive proof the service sent { housekeeping, graceMs }.
                const cancel = await rpcCall(ws, 3, "loop.cancel", {});
                assert.equal((cancel.result as { cancelled: boolean }).cancelled, true, "cancel saw the live spawn as work");

                await waitFor(
                    () => concluded() as Array<{ scheme: string; closeStatus: number }>,
                    (cs) => cs.some((c) => c.scheme === "sh" && c.closeStatus === 499),
                    { timeoutMs: 5000 },
                );
            } finally { ws.close(); }
        });
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS;
        else process.env.PLURNK_SERVICE_EXEC_KILL_GRACE_MS = prior;
    }
});
