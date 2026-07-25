// #358 — look on the seam ({§op-look}): the pure READ-projection query. The module parses at its
// edge (LOOK→READ) and hands the statement over; the resolution returns content and writes NO log
// row — off-run inspection, invisible to the model.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon, parseDsl } from "./_rpc.ts";

test("seam look: resolves a READ in one closed, rowless observation segment (#358)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "seam-look" });
            const workspaceId = (created.result as { id: number }).id;
            const workerId = await daemon.ensureModelWorker(workspaceId);
            // Seed an entry through the seam (the client-op path), then look it up.
            const edit = parseDsl("<<PLAN::PLAN\n<<EDIT(worker:///notes/target.md):the looked-up body:EDIT")[1];
            await daemon.dispatchAsClient({ workspaceId, workerId, statement: edit });
            const before = (await db.test_count_log_entries.get<{ n: number }>({}))?.n;
            const loopsBefore = await db.test_loops_list_ids.all<{ id: number }>({ worker_id: workerId });
            const read = parseDsl("<<PLAN::PLAN\n<<READ(worker:///notes/target.md)::READ")[1];
            const result = await daemon.look({ workspaceId, workerId, statement: read });
            assert.equal(result.status, 200);
            assert.match(String((result as { content?: string }).content ?? ""), /the looked-up body/, "look returns the entry's content");
            const after = (await db.test_count_log_entries.get<{ n: number }>({}))?.n;
            assert.equal(after, before, "look minted NO log row — off-run inspection is invisible");
            const loopsAfter = await db.test_loops_list_ids.all<{ id: number }>({ worker_id: workerId });
            assert.equal(loopsAfter.length, loopsBefore.length + 1, "look minted exactly one observation segment");
            const loopId = loopsAfter[loopsAfter.length - 1].id;
            assert.deepEqual(await db.test_list_turns_in_loop.all({ loop_id: loopId }), [], "the observation segment is rowless");
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200, "the observation segment is terminal");
        } finally { ws.close(); }
    });
});
