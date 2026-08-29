// {§worker-settings} — the worker's own behavioral rules: default-empty,
// client-declared at creation, mutable between loops through the seam surface,
// rejected unknown keys never persist.

import test from "node:test";
import assert from "node:assert/strict";
import { connect, rpcCall, withDaemon } from "./_rpc.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

const emptyProjection = {
    service: {},
    workspace: {},
    workerBound: {},
    worker: {},
    effective: {},
};

test("{§capability-policy-projection}: a fresh worker projects every empty policy layer", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);
            const read = await daemon.readWorkerCapabilities({ workspaceId: workspace.id, workerId });
            assert.deepEqual(read, emptyProjection, "no declaration means no attenuation at any scope");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-settings}: capability policy replacement between loops persists and remains distinguishable from effective authority", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);

            const set = await daemon.setWorkerCapabilities({
                workspaceId: workspace.id,
                workerId,
                policy: { deny: [{ traits: ["interaction"] }] },
            });
            assert.deepEqual(set.worker, { deny: [{ traits: ["interaction"] }] });
            assert.deepEqual(set.effective, set.worker, "the empty broader layers leave Worker policy effective");
            const read = await daemon.readWorkerCapabilities({ workspaceId: workspace.id, workerId });
            assert.deepEqual(read.worker, { deny: [{ traits: ["interaction"] }] }, "the declaration persists across the loop boundary");

            const off = await daemon.setWorkerCapabilities({
                workspaceId: workspace.id,
                workerId,
                policy: {},
            });
            assert.deepEqual(off, emptyProjection, "the client can replace its mutable attenuation between loops");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-settings}: a declaration at creation rides the conversation worker", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const envelope = await daemon.createWorkspace({ name: `worker-settings-create-${crypto.randomUUID()}` });
        const workerId = await daemon.ensureModelWorker(envelope.workspaceId, { capabilities: { only: [{ access: "observe" }] } });
        const read = await daemon.readWorkerCapabilities({ workspaceId: envelope.workspaceId, workerId });
        assert.deepEqual(read.worker, { only: [{ access: "observe" }] }, "the creation-time declaration is durable");
        const named = await daemon.createConversationWorker({
            workspaceId: envelope.workspaceId,
            name: "interactive-sister",
            settings: { capabilities: { deny: [{ access: "execute" }] } },
        });
        const sister = await daemon.readWorkerCapabilities({ workspaceId: envelope.workspaceId, workerId: named.workerId });
        assert.deepEqual(sister.worker, { deny: [{ access: "execute" }] });
        const fresh = await daemon.createConversationWorker({ workspaceId: envelope.workspaceId, name: "quiet-sister" });
        const quiet = await daemon.readWorkerCapabilities({ workspaceId: envelope.workspaceId, workerId: fresh.workerId });
        assert.deepEqual(quiet.worker, {}, "an undeclared sibling starts unrestricted");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§capability-policy-projection}: broader ceilings remain visible beside the mutable Worker layer", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const envelope = await daemon.createWorkspace({
            name: `worker-capability-projection-${crypto.randomUUID()}`,
            settings: { capabilities: { deny: [{ scheme: "https" }] } },
        });
        const workerId = await daemon.ensureModelWorker(envelope.workspaceId, {
            capabilities: { deny: [{ access: "execute" }] },
        });
        const projection = await daemon.readWorkerCapabilities({
            workspaceId: envelope.workspaceId,
            workerId,
        });
        assert.deepEqual(projection.workspace, { deny: [{ scheme: "https" }] });
        assert.deepEqual(projection.worker, { deny: [{ access: "execute" }] });
        assert.deepEqual(projection.effective, {
            deny: [{ access: "execute" }, { scheme: "https" }],
        });
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§worker-delegation-inherits-policy}: a client fork snapshots effective authority into an immutable child bound", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const envelope = await daemon.createWorkspace({
            name: `worker-client-fork-bound-${crypto.randomUUID()}`,
            settings: { capabilities: { deny: [{ scheme: "https" }] } },
        });
        const parentId = await daemon.ensureModelWorker(envelope.workspaceId, {
            capabilities: { deny: [{ operation: "EXEC" }] },
        });
        const child = await daemon.forkWorker({
            workspaceId: envelope.workspaceId,
            workerId: parentId,
            name: "bounded-child",
        });

        await daemon.setWorkerCapabilities({
            workspaceId: envelope.workspaceId,
            workerId: parentId,
            policy: {},
        });
        await db.test_set_workspace_settings.run({
            id: envelope.workspaceId,
            settings: JSON.stringify({ capabilities: {} }),
        });

        const projection = await daemon.readWorkerCapabilities({
            workspaceId: envelope.workspaceId,
            workerId: child.workerId,
        });
        assert.deepEqual(projection.workerBound, {
            deny: [
                { operation: "EXEC" },
                { scheme: "https" },
            ],
        });
        assert.deepEqual(projection.worker, {}, "the child starts with an independently mutable empty layer");
        assert.deepEqual(projection.effective, projection.workerBound, "later parent and workspace widening cannot enlarge the child");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§worker-settings}: an invalid capability policy is rejected at the boundary, never persisted", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);
            await assert.rejects(
                () => daemon.setWorkerCapabilities({
                    workspaceId: workspace.id,
                    workerId,
                    policy: { deny: [{}] } as never,
                }),
                /settings\.capabilities is not a valid capability policy/,
            );
            const read = await daemon.readWorkerCapabilities({ workspaceId: workspace.id, workerId });
            assert.deepEqual(read, emptyProjection, "the rejected policy left the rules untouched");
        } finally {
            ws.close();
        }
    });
});
