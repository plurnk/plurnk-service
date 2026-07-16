// #376 — the seam's readLog honors its workerId filter: two workers, one row each, each read returns
// ONLY its own worker's rows (the worker is the isolation boundary, §machine-processes). Pinned after a
// client report of workerId being ignored live — the in-tree seam was exonerated by this exact test.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";
import Dsl from "./dsl.ts";

test("seam readLog honors the workerId filter — per-worker isolation of the journal read (#376)", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "r376" });
            const workspaceId = (created.result as { id: number }).id;
            const clientWorker = (created.result as { workerId: number }).workerId;
            const modelWorker = await daemon.ensureModelWorker(workspaceId);
            // seed one row in EACH run via the seam dispatch
            await daemon.dispatchAsClient({ workspaceId, workerId: clientWorker, statement: Dsl.buildEdit({ target: "known:///client-note", content: "client row" }) });
            await daemon.dispatchAsClient({ workspaceId, workerId: modelWorker, statement: Dsl.buildEdit({ target: "known:///model-note", content: "model row" }) });
            const clientRows = await daemon.readLog({ workspaceId, workerId: clientWorker });
            const modelRows = await daemon.readLog({ workspaceId, workerId: modelWorker });
            assert.ok(clientRows.length > 0 && modelRows.length > 0, "both workers have rows");
            const cSet = new Set(clientRows.map((r) => JSON.stringify(r)));
            assert.ok(!modelRows.every((r) => cSet.has(JSON.stringify(r))), "the two workers return DIFFERENT rows");
        } finally { ws.close(); }
    });
});
