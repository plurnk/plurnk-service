import test from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { connect, rpcCall, withDaemon } from "./_rpc.ts";
import { editStmt, readStmt, urlPath } from "./_dsl.ts";

test("{§capability-admission}: workspace policy changes apply to independent workers, descendants, and clients without private bounds", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `shared-policy-${crypto.randomUUID()}` });
        const parent = await daemon.ensureModelWorker(workspace.workspaceId);
        const sibling = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "sibling" });
        const target = urlPath("worker", "/shared.txt");
        const source = await daemon.dispatchAsClient({ ...workspace, statement: editStmt(target, "shared content") });
        assert.equal(source.status, 201);
        const denied = { deny: [{ access: "observe" as const, scheme: "worker" }] };
        const projection = await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: denied });
        assert.deepEqual(projection, { service: {}, workspace: denied, effective: denied });
        const child = await daemon.forkWorker({ workspaceId: workspace.workspaceId, workerId: parent, name: "child" });
        const actors = [workspace.workerId, parent, sibling.workerId, child.workerId];
        for (const workerId of actors) {
            const result = await daemon.look({ workspaceId: workspace.workspaceId, workerId, statement: readStmt(target) });
            assert.equal(result.status, 403);
            assert.equal((result.problem as { policyScope: string }).policyScope, "workspace");
        }
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} });
        for (const workerId of actors) {
            const result = await daemon.look({ workspaceId: workspace.workspaceId, workerId, statement: readStmt(target) });
            assert.equal(result.status, 200, "existing descendants see workspace widening without inherited restrictions");
            assert.match(String(result.content), /shared content/);
        }
        const other = await daemon.createWorkspace({ name: `other-policy-${crypto.randomUUID()}` });
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: denied });
        assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: other.workspaceId }), {
            service: {}, workspace: {}, effective: {},
        });
        assert.equal((await daemon.look({ ...other, statement: readStmt(target) })).status, 404,
            "a workspace policy does not create access to another workspace's resources");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§workspace-capability-inspection}: client actions inspect and replace policy without creating a model worker", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `policy-client-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace);
            const before = await daemon.listWorkers(workspace.id);
            const empty = { service: {}, workspace: {}, effective: {} };
            const read = await rpcCall(ws, 2, "workspace.capabilities.get", {});
            assert.deepEqual(read.result, empty);
            const policy = { deny: [{ traits: ["interaction"] }] };
            const updated = await rpcCall(ws, 3, "workspace.capabilities.set", { policy });
            assert.deepEqual(updated.result, { service: {}, workspace: policy, effective: policy });
            assert.deepEqual(await daemon.listWorkers(workspace.id), before, "policy management allocates no conversation worker");
            await assert.rejects(daemon.setWorkspaceCapabilities({ workspaceId: workspace.id, policy: { deny: [{}] } as never }),
                /settings\.capabilities is not a valid capability policy/);
            assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: workspace.id }), updated.result,
                "invalid policy cannot replace the current declaration");
            await daemon.setWorkspaceCapabilities({ workspaceId: workspace.id, policy: {} });
            assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: workspace.id }), empty);
        } finally { ws.close(); }
    });
});

test("{§capability-policy-projection}: service ceilings remain effective and workspace replacement preserves other settings", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const previous = process.env.PLURNK_SERVICE_CAPABILITIES;
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `policy-ceiling-${crypto.randomUUID()}`,
            settings: { filesItems: 7, capabilities: { deny: [{ scheme: "https" }] } } });
        const service = { deny: [{ access: "execute" }] };
        process.env.PLURNK_SERVICE_CAPABILITIES = JSON.stringify(service);
        assert.deepEqual(await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} }), {
            service, workspace: {}, effective: service,
        });
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspace.workspaceId });
        assert.deepEqual(JSON.parse(row!.settings), { filesItems: 7, capabilities: {} });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_CAPABILITIES;
        else process.env.PLURNK_SERVICE_CAPABILITIES = previous;
        await daemon.stop();
        await db.close();
    }
});

test("{§workspace-capability-inspection}: existing workers reconcile their tool catalog after workspace policy changes", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `policy-docs-${crypto.randomUUID()}` });
        const model = await daemon.ensureModelWorker(workspace.workspaceId);
        const sibling = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "sibling" });
        const look = (workerId: number, runtime: string) => daemon.look({ workspaceId: workspace.workspaceId, workerId,
            statement: readStmt({ ...urlPath("worker", `/_plurnk/plurnk/${runtime}.md`), hostname: null }) });
        for (const workerId of [model, sibling.workerId]) assert.equal((await look(workerId, "node")).status, 200);
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: { deny: [{ runtime: "node" }] } });
        for (const workerId of [model, sibling.workerId]) {
            assert.equal((await look(workerId, "node")).status, 404, "the withdrawn reference cannot leak through a stale catalog");
            assert.equal((await look(workerId, "sh")).status, 200, "unrelated admitted tooling stays discoverable");
        }
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} });
        for (const workerId of [model, sibling.workerId]) assert.equal((await look(workerId, "node")).status, 200);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
