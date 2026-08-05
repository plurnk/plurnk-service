// {§methods-model-worker}: the stable default is idempotent at the seam and fork-resistant.
import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("{§methods-model-worker}, {§worker-auto-name}, #159: concurrent ensureModelWorker calls return ONE conversation worker", async () => {
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

test("{§methods-model-worker}, {§methods-conversation-worker}: a fresh root cannot claim the stable default", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "fresh-before-default" });
            const workspaceId = (created.result as { id: number }).id;
            const fresh = await daemon.createConversationWorker({ workspaceId, name: "thread-first" });

            const [a, b] = await Promise.all([
                daemon.ensureModelWorker(workspaceId),
                daemon.ensureModelWorker(workspaceId),
            ]);

            assert.notEqual(a, fresh.workerId, "the named fresh conversation remains a distinct root");
            assert.equal(a, b, "concurrent default ensures resolve one stable identity");
            assert.equal(await daemon.ensureModelWorker(workspaceId), a, "the durable default remains stable");
            const roots = await db.test_workers_by_workspace.all<{
                id: number; origin: string; parent_worker_id: number | null; default_conversation: number;
            }>({ workspace_id: workspaceId });
            assert.deepEqual(
                roots
                    .filter(({ origin, parent_worker_id: parent }) => origin === "model" && parent === null)
                    .map(({ id, default_conversation: isDefault }) => ({ id, isDefault })),
                [{ id: fresh.workerId, isDefault: 0 }, { id: a, isDefault: 1 }],
                "both roots remain separate and only the stable conversation owns the durable role",
            );
        } finally { ws.close(); }
    });
});
