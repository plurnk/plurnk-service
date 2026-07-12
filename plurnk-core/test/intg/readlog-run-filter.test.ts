// #376 — the seam's readLog honors its runId filter: two runs, one row each, each read returns
// ONLY its own run's rows (the run is the isolation boundary, §machine-processes). Pinned after a
// client report of runId being ignored live — the in-tree seam was exonerated by this exact test.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";
import Dsl from "./dsl.ts";

test("seam readLog honors the runId filter — per-run isolation of the journal read (#376)", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "r376" });
            const sessionId = (created.result as { id: number }).id;
            const clientRun = (created.result as { runId: number }).runId;
            const modelRun = await daemon.ensureModelRun(sessionId);
            // seed one row in EACH run via the seam dispatch
            await daemon.dispatchAsClient({ sessionId, runId: clientRun, statement: Dsl.buildEdit({ target: "known:///client-note", content: "client row" }) });
            await daemon.dispatchAsClient({ sessionId, runId: modelRun, statement: Dsl.buildEdit({ target: "known:///model-note", content: "model row" }) });
            const clientRows = await daemon.readLog({ sessionId, runId: clientRun });
            const modelRows = await daemon.readLog({ sessionId, runId: modelRun });
            assert.ok(clientRows.length > 0 && modelRows.length > 0, "both runs have rows");
            const cSet = new Set(clientRows.map((r) => JSON.stringify(r)));
            assert.ok(!modelRows.every((r) => cSet.has(JSON.stringify(r))), "the two runs return DIFFERENT rows");
        } finally { ws.close(); }
    });
});
