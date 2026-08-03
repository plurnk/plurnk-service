// #371 — ensureModelWorker is idempotent at the seam: the connection's per-workspace cache used to
// mask an insert-only implementation (26 workers in one e2e workspace once the seam exposed it). The
// canonical conversation is the workspace's earliest model-origin root worker; forks and spawned
// workers (which inherit origin='model' but carry parent_worker_id) never shadow it.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("{§worker-auto-name} #159: concurrent ensureModelWorker calls return ONE conversation worker", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "one-conversation" });
            const workspaceId = (created.result as { id: number }).id;
            const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => daemon.ensureModelWorker(workspaceId)));
            assert.equal(a, b); assert.equal(b, c);
            const workers = await db.test_workers_by_workspace.all<{ id: number; origin: string }>({ workspace_id: workspaceId });
            assert.equal((workers ?? []).filter((r) => r.origin === "model").length, 1, "exactly one model worker minted across three ensures");
            // A fork of the conversation never shadows it — ensure still returns the root.
            const fork = await daemon.forkWorker({ workspaceId, workerId: a, name: "branch" });
            assert.notEqual(fork.workerId, a);
            assert.equal(await daemon.ensureModelWorker(workspaceId), a, "the fork (origin-inherited, parented) does not shadow the canonical root");
        } finally { ws.close(); }
    });
});
