// #371 — ensureModelWorker is IDEMPOTENT at the seam: the WS connection's per-workspace cache used to
// mask an insert-only implementation (26 runs in one e2e workspace once the seam exposed it). The
// canonical conversation is the workspace's earliest model-origin ROOT run; forks and spawned
// workers (which inherit origin='model' but carry parent_worker_id) never shadow it.
import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("ensureModelWorker finds first — repeated calls return ONE conversation worker (#371)", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "one-conversation" });
            const workspaceId = (created.result as { id: number }).id;
            const a = await daemon.ensureModelWorker(workspaceId);
            const b = await daemon.ensureModelWorker(workspaceId);
            const c = await daemon.ensureModelWorker(workspaceId);
            assert.equal(a, b); assert.equal(b, c);
            const runs = await (db.test_runs_by_session as PrepMethod).all<{ id: number; origin: string }>({ workspace_id: workspaceId });
            assert.equal((runs ?? []).filter((r) => r.origin === "model").length, 1, "exactly one model worker minted across three ensures");
            // A fork of the conversation never shadows it — ensure still returns the root.
            const fork = await daemon.forkWorker({ workspaceId, workerId: a, name: "branch" });
            assert.notEqual(fork.workerId, a);
            assert.equal(await daemon.ensureModelWorker(workspaceId), a, "the fork (origin-inherited, parented) does not shadow the canonical root");
        } finally { ws.close(); }
    });
});
