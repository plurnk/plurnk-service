import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";

test("{§worker-external-reference} concurrent allocation is durable, folderless and independent of names and owners", async () => {
    const path = join(await testArtifactDirectory("worker-references"), `identity-${crypto.randomUUID()}.db`);
    const reference = { namespace: "fixture", reference: "customer/分析 #blue?100%" };
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null });
    let identity: { workspaceId: number; workerId: number };
    try {
        assert.equal(await daemon.readWorkerReference(reference), null);
        assert.deepEqual(await daemon.listWorkspaces(), []);
        const created: unknown[] = [];
        const off = daemon.subscribeToEvents((_scope, event, payload) => {
            if (event === "workspace/created") created.push(payload);
        });
        const identities = await Promise.all(Array.from({ length: 12 }, () => daemon.ensureWorkerReference(reference)));
        identity = identities[0]!;
        assert.ok(identities.every((item) => item.workspaceId === identity.workspaceId && item.workerId === identity.workerId));
        assert.equal(created.length, 1, "only the allocator publishes workspace creation");
        off();
        const [workspace] = await daemon.listWorkspaces();
        assert.equal((await daemon.listWorkspaces()).length, 1);
        assert.equal(workspace?.project_root, null);
        assert.match(workspace.name, /^(?=.*[A-Za-z])[A-Za-z0-9]{5}$/u);
        const [worker] = await daemon.listWorkers(identity.workspaceId);
        assert.equal((await daemon.listWorkers(identity.workspaceId)).length, 1);
        assert.equal(worker?.id, identity.workerId);
        assert.equal(worker?.origin, "model");
        assert.equal(worker?.owner, "_plurnk");
        assert.equal(worker?.parentWorkerId, null);
        assert.match(worker.name, /^[0-9a-f]{8}$/u);
        await daemon.renameWorkspace(identity.workspaceId, "Renamed # workspace");
        await daemon.registerWorkerOwner(identity.workspaceId, { address: "fixture://owner", tools: [], interactive: false });
        await daemon.claimWorkerOwner({ ...identity, owner: "fixture://owner" });
        assert.deepEqual(await daemon.ensureWorkerReference(reference), identity);
        assert.deepEqual(await daemon.listWorkerReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.deepEqual(await daemon.listWorkerReferences({ ...identity, namespace: "another" }), []);
        assert.deepEqual(await daemon.listWorkerLoops(identity), [], "binding does not start work");
    } finally { await daemon.stop(); await db.close(); }
    const reopened = await openMigrated(path);
    const next = new Daemon({ db: reopened, provider: null });
    try {
        assert.deepEqual(await next.readWorkerReference(reference), identity);
        assert.deepEqual(await next.ensureWorkerReference(reference), identity);
        assert.deepEqual(await next.listWorkerReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.equal((await next.listWorkspaces())[0]?.name, "Renamed # workspace");
    } finally { await next.stop(); await reopened.close(); }
});

test("{§worker-external-reference} namespaces and exact reference bytes isolate identities", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const inputs = [
            { namespace: "one", reference: "" },
            { namespace: "two", reference: "" },
            { namespace: "one", reference: "é" },
            { namespace: "one", reference: "e\u0301" },
            { namespace: "one", reference: "quote'\"; --" },
        ];
        const identities = await Promise.all(inputs.map((input) => daemon.ensureWorkerReference(input)));
        assert.equal(new Set(identities.map(({ workerId }) => workerId)).size, inputs.length);
        assert.equal((await daemon.listWorkspaces()).length, inputs.length);
        for (const [i, input] of inputs.entries()) assert.deepEqual(await daemon.readWorkerReference(input), identities[i]);
    } finally { await daemon.stop(); await db.close(); }
});

test("{§worker-external-reference} independent database connections converge without process-local serialization", async () => {
    const path = join(await testArtifactDirectory("worker-references"), `concurrent-${crypto.randomUUID()}.db`);
    const firstDb = await openMigrated(path);
    const secondDb = await openMigrated(path);
    const first = new Daemon({ db: firstDb, provider: null });
    const second = new Daemon({ db: secondDb, provider: null });
    const reference = { namespace: "fixture", reference: "parallel" };
    try {
        const [a, b] = await Promise.all([first.ensureWorkerReference(reference), second.ensureWorkerReference(reference)]);
        assert.deepEqual(a, b);
        assert.equal((await first.listWorkspaces()).length, 1);
        assert.equal((await second.listWorkers(a.workspaceId)).length, 1);
    } finally {
        await first.stop(); await second.stop();
        await firstDb.close(); await secondDb.close();
    }
});

test("{§worker-external-reference} allocation rolls back on failure and leaves existing names untouched", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const input = { namespace: "fixture", reference: "rollback", workspace_name: "NewWs", worker_name: "" };
        await assert.rejects(db.worker_reference_allocate.get(input), /CHECK constraint failed/u);
        assert.deepEqual(await daemon.listWorkspaces(), [], "failure at worker creation rolls back the workspace too");
        assert.equal(await daemon.readWorkerReference(input), null);
        const existing = await daemon.createWorkspace({ name: "NewWs" });
        assert.equal(await db.worker_reference_allocate.get({ ...input, worker_name: "valid" }), undefined);
        assert.deepEqual(await daemon.listWorkers(existing.workspaceId), [], "a random name collision never adopts an existing workspace");
        const allocated = await daemon.ensureWorkerReference(input);
        assert.notEqual(allocated.workspaceId, existing.workspaceId);
        await db.test_worker_reference_delete_worker.run({ worker_id: allocated.workerId });
        assert.equal(await daemon.readWorkerReference(input), null, "deletion cascades through the association");
    } finally { await daemon.stop(); await db.close(); }
});
