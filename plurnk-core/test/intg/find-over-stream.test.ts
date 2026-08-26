// {§exec-stream} — a FIND over an exec stream's channel resolves the runtime's own default channel
// (stdout), never the entry-manifest fallback `body`; it answers with the match, not a 500.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("FIND over an exec stream channel answers the match instead of throwing on the default channel", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## EXEC0 [sh]\nprintf 'alpha\\nbeta\\n'\n\n## SEND0 [202] <5>\nwaiting", 10),
        makeMockResponse("## FIND0 (sh:///1/2/3#stdout)\n/beta/\n\n## SEND0 [102]\nlooking", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "find-over-stream" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const find = rows.find((r) => r.op === "FIND" && r.origin === "model");
            assert.ok(find, "the model's FIND was dispatched");
            assert.equal(find.status_rx, 200, `FIND over the stream channel answers 200, got ${find.status_rx}: ${find.rx.slice(0, 200)}`);
            assert.match(find.rx, /"matched":"beta"/, "the regex row carries its match");
            assert.equal(finalStatus, 200);
        } finally { ws.close(); }
    });
});
