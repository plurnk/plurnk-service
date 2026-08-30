// {§engine-rails} #425 F1 — a red test suite is evidence, never a strike. run14's shape:
// every turn runs a command that exits 1; the engine materializes each failure as a
// completion READ[500] carrying executor identity. Under the shipped MAX_STRIKES the
// loop must run through all of them and conclude on the model's own SEND[200].
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const maxStrikes = Number(process.env.PLURNK_SERVICE_MAX_STRIKES);

test("{§engine-rails} consecutive failed commands never strike the loop out", async () => {
    assert.ok(Number.isInteger(maxStrikes) && maxStrikes > 0, "PLURNK_SERVICE_MAX_STRIKES must be set for the witness");
    const failing = maxStrikes + 2;
    const mock = new Mock({ contextWindow: 100000, responses: [
        ...Array.from({ length: failing }, (_, i) => makeMockResponse(`## EXEC0 [sh]\necho attempt-${i} >&2; exit 1\n\n## SEND0 [102]\nfixing the tests`, 10)),
        makeMockResponse("## SEND0 [200]\ngreen", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "strike-evidence" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "make the tests pass", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, `the loop concludes on the model's SEND[200] after ${failing} red runs, never the engine's 500`);
            assert.equal(turnIds?.length, failing + 2, "initialization + every failing turn + the concluding turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ loop_id: 1 });
            const evidence = rows.filter((r) => r.op === "READ" && r.origin === "_plurnk" && r.status_rx === 500);
            assert.ok(evidence.length >= failing, `every failed command surfaced as a completion READ[500]; got ${evidence.length}`);
            assert.ok(evidence.every((r) => JSON.parse(r.rx).problem?.type === "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit"), "the completion rows carry executor identity");
        } finally { ws.close(); }
    });
});
