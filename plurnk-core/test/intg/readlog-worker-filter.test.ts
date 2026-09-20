// {§methods-log-read}, {§machine-processes-model-worker-readable}: readLog selects one
// ownership-verified worker without mixing sibling journal rows.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";
import Dsl from "./dsl.ts";

test("{§methods-log-read}: readLog honors per-worker journal isolation", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "r376" });
            const workspaceId = (created.result as { id: number }).id;
            const clientWorker = (created.result as { workerId: number }).workerId;
            const modelWorker = await daemon.ensureModelWorker(workspaceId);
            // Seed one row in each worker via the seam dispatch.
            await daemon.dispatchAsClient({ workspaceId, workerId: clientWorker, statement: Dsl.buildEdit({ target: "worker:///client-note", content: "client row" }) });
            await daemon.dispatchAsClient({ workspaceId, workerId: modelWorker, statement: Dsl.buildEdit({ target: "worker:///model-note", content: "model row" }) });
            const clientRows = await daemon.readLog({ workspaceId, workerId: clientWorker });
            const modelRows = await daemon.readLog({ workspaceId, workerId: modelWorker });
            assert.ok(clientRows.length > 0 && modelRows.length > 0, "both workers have rows");
            const cSet = new Set(clientRows.map((r) => JSON.stringify(r)));
            assert.ok(!modelRows.every((r) => cSet.has(JSON.stringify(r))), "the two workers return DIFFERENT rows");
        } finally { ws.close(); }
    });
});

test("{§methods-log-read}: the panel is the page of a read that names no limit, and the ceiling of one that does", async () => {
    const prior = { page: process.env.PLURNK_SERVICE_LOG_READ_PAGE, max: process.env.PLURNK_SERVICE_LOG_READ_MAX };
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "readlog-page" });
            const workspaceId = (created.result as { id: number }).id;
            const workerId = (created.result as { workerId: number }).workerId;
            for (let n = 1; n <= 5; n += 1) {
                await daemon.dispatchAsClient({ workspaceId, workerId, statement: Dsl.buildEdit({ target: `worker:///note-${n}`, content: `row ${n}` }) });
            }
            process.env.PLURNK_SERVICE_LOG_READ_PAGE = "2";
            process.env.PLURNK_SERVICE_LOG_READ_MAX = "4";
            assert.equal((await daemon.readLog({ workspaceId, workerId })).length, 2, "no limit named: the page");
            assert.equal((await daemon.readLog({ workspaceId, workerId, limit: 3 })).length, 3, "a named limit beneath the ceiling stands");
            assert.equal((await daemon.readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER })).length, 4, "as many as it likes: the ceiling");
        } finally {
            ws.close();
            for (const [name, value] of [["PLURNK_SERVICE_LOG_READ_PAGE", prior.page], ["PLURNK_SERVICE_LOG_READ_MAX", prior.max]] as const) {
                if (value === undefined) delete process.env[name]; else process.env[name] = value;
            }
        }
    });
});
