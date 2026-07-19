// #358 — look on the seam ({§op-look}): the pure READ-projection query. The module parses at its
// edge (LOOK→READ) and hands the statement over; the resolution returns content and writes NO log
// row — off-run inspection, invisible to the model.
import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, parseDsl } from "./_rpc.ts";

test("[§op-look] seam look: resolves a READ's content and mints NO log row (#358)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "seam-look" });
            const workspaceId = (created.result as { id: number }).id;
            const workerId = await daemon.ensureModelWorker(workspaceId);
            // Seed an entry through the seam (the client-op path), then look it up.
            const edit = parseDsl("<<PLAN::PLAN\n<<EDIT(worker:///notes/target.md):the looked-up body:EDIT")[1];
            await daemon.dispatchAsClient({ workspaceId, workerId, statement: edit });
            const before = (await (db.test_count_log_entries as PrepMethod).get<{ n: number }>({}))?.n;
            const read = parseDsl("<<PLAN::PLAN\n<<READ(worker:///notes/target.md)::READ")[1];
            const result = await daemon.look({ workspaceId, workerId, statement: read });
            assert.equal(result.status, 200);
            assert.match(String((result as { content?: string }).content ?? ""), /the looked-up body/, "look returns the entry's content");
            const after = (await (db.test_count_log_entries as PrepMethod).get<{ n: number }>({}))?.n;
            assert.equal(after, before, "look minted NO log row — off-run inspection is invisible");
        } finally { ws.close(); }
    });
});
