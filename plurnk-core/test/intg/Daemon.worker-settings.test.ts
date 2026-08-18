// {§worker-settings} — the worker's own behavioral rules: default-empty,
// client-declared at creation, mutable between loops through the seam surface,
// rejected unknown keys never persist.

import test from "node:test";
import assert from "node:assert/strict";
import { connect, rpcCall, withDaemon } from "./_rpc.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

test("{§worker-settings}: a fresh worker carries the default empty rules", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);
            const read = await daemon.readWorkerSettings({ workspaceId: workspace.id, workerId });
            assert.deepEqual(read, { requestUserInput: false }, "no declaration means no rules");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-settings}: settings set between loops persist and partial merges keep other keys", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);

            const set = await daemon.setWorkerSettings({
                workspaceId: workspace.id,
                workerId,
                settings: { requestUserInput: true },
            });
            assert.deepEqual(set, { requestUserInput: true }, "the normalized bag is the returned truth");
            const read = await daemon.readWorkerSettings({ workspaceId: workspace.id, workerId });
            assert.equal(read.requestUserInput, true, "the declaration persists across the loop boundary");

            const unchanged = await daemon.setWorkerSettings({ workspaceId: workspace.id, workerId, settings: {} });
            assert.deepEqual(unchanged, { requestUserInput: true }, "a partial merge never clobbers unmentioned keys");

            const off = await daemon.setWorkerSettings({
                workspaceId: workspace.id,
                workerId,
                settings: { requestUserInput: false },
            });
            assert.equal(off.requestUserInput, false, "the client can change its mind between loops");
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
        const workerId = await daemon.ensureModelWorker(envelope.workspaceId, { requestUserInput: true });
        const read = await daemon.readWorkerSettings({ workspaceId: envelope.workspaceId, workerId });
        assert.equal(read.requestUserInput, true, "the creation-time declaration is durable");
        const named = await daemon.createConversationWorker({
            workspaceId: envelope.workspaceId,
            name: "interactive-sister",
            settings: { requestUserInput: true },
        });
        const sister = await daemon.readWorkerSettings({ workspaceId: envelope.workspaceId, workerId: named.workerId });
        assert.equal(sister.requestUserInput, true);
        const fresh = await daemon.createConversationWorker({ workspaceId: envelope.workspaceId, name: "quiet-sister" });
        const quiet = await daemon.readWorkerSettings({ workspaceId: envelope.workspaceId, workerId: fresh.workerId });
        assert.equal(quiet.requestUserInput, false, "an undeclared sibling starts with the default rules");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§worker-settings}: an unknown key is rejected at the boundary, never persisted", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `worker-settings-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const workerId = await daemon.ensureModelWorker(workspace.id);
            await assert.rejects(
                () => daemon.setWorkerSettings({
                    workspaceId: workspace.id,
                    workerId,
                    settings: { yolo: true } as unknown as { requestUserInput?: boolean },
                }),
                /settings\.yolo is not supported/,
            );
            const read = await daemon.readWorkerSettings({ workspaceId: workspace.id, workerId });
            assert.deepEqual(read, { requestUserInput: false }, "the rejected bag left the rules untouched");
        } finally {
            ws.close();
        }
    });
});
