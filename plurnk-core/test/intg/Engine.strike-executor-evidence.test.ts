import { serverProposals } from "./_approval.ts";
// {§engine-rails} {§executor-exit-code} #425 F1 — a red test suite is an answer, never a strike. Every turn runs a
// command that exits 1; each conclusion is a 200 READ carrying its exit code. Under the shipped MAX_STRIKES the
// loop must run through all of them and conclude on the model's own completed inventory.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

const maxStrikes = Number(process.env.PLURNK_SERVICE_MAX_STRIKES);

test("{§engine-rails} {§executor-exit-code} consecutive nonzero exits never strike the loop out", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    assert.ok(Number.isInteger(maxStrikes) && maxStrikes > 0, "PLURNK_SERVICE_MAX_STRIKES must be set for the witness");
    const failing = maxStrikes + 2;
    const mock = new Mock({ contextWindow: 100000, responses: [
        ...Array.from({ length: failing }, (_, i) => makeMockResponse(`\`\`\`\`sh
echo attempt-${i} >&2; exit 1
\`\`\`\`

\`\`\`\`NOTE
fixing the tests
\`\`\`\``, 10)),
        makeMockResponse("````SEND [200]\ngreen\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "strike-evidence" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "make the tests pass" });
            assert.equal(finalStatus, 200, `the loop concludes on the model's completed inventory after ${failing} red runs, never the engine's 500`);
            assert.equal(turnIds?.length, failing + 2, "initialization + every failing turn + the concluding turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ loop_id: 1 });
            const answers = rows.filter((r) => r.op === "READ" && r.origin === "_plurnk" && JSON.parse(r.rx).exitCode === 1);
            assert.ok(answers.length >= failing, `every command surfaced as a completion READ carrying its exit code; got ${answers.length}`);
            assert.ok(answers.every((r) => r.status_rx === 200 && JSON.parse(r.rx).problem === undefined), "each completion is a 200 answer with no Problem");
        } finally { ws.close(); }
    });
});
