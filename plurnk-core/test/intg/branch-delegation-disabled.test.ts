// {§branch-delegation-disabled} — a WORK/FORK signal is refused up front unless the operator enables
// branch delegation (#396): a 501 on the row naming the signal-less form, the loop continues, and no
// child, batch, or branch comes into being. The committed .env.defaults leaves the knob at 0.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("a WORK/FORK signal is refused as branch-delegation-disabled unless the operator enables it", async () => {
    delete process.env.PLURNK_SERVICE_BRANCH_DELEGATION;
    const mock = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse("## WORK0 [feature/one] (worker://one)\nfirst child\n\n## FORK0 [feature/two] (worker://two)\nsecond child\n\n## SEND0 [102]\nspawning", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "branch-delegation-disabled" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "delegate", policy: { proposals: "accept" } });
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const spawns = rows.filter((r) => r.origin === "model" && (r.op === "WORK" || r.op === "FORK"));
            assert.deepEqual(spawns.map((r) => [r.op, r.status_rx]), [["WORK", 501], ["FORK", 501]], "both signalled spawns refuse up front");
            for (const row of spawns) {
                const rx = JSON.parse(row.rx) as { problem?: { type?: string; detail?: string; recovery?: string; signal?: string } };
                assert.equal(rx.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/branch-delegation-disabled");
                assert.equal(rx.problem?.detail, `${row.op} takes no signal; branch delegation is not offered.`);
                assert.equal(rx.problem?.recovery, `Spawn without a signal: \`## ${row.op}0 (worker://${row.op === "WORK" ? "one" : "two"})\` with the prompt as the body.`);
            }
            assert.equal(finalStatus, 200, "the loop continues past the refusal");
            assert.equal((await db.branch_batch_active.all({})).length, 0, "no batch came into being");
            assert.equal((await db.test_workers_by_workspace.all<{ name: string }>({ workspace_id: 1 })).filter((w) => w.name === "one" || w.name === "two").length, 0, "no child worker came into being");
        } finally { ws.close(); }
    });
});
