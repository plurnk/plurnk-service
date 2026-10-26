import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";

test("{§session-external-reference} concurrent allocation is durable, folderless and independent of names and owners", async () => {
    const path = join(await testArtifactDirectory("session-references"), `identity-${crypto.randomUUID()}.db`);
    const reference = { namespace: "fixture", reference: "customer/分析 #blue?100%" };
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null });
    let identity: { workspaceId: number; sessionId: number };
    try {
        assert.equal(await daemon.readSessionReference(reference), null);
        assert.deepEqual(await daemon.listWorkspaces(), []);
        const created: unknown[] = [];
        const off = daemon.subscribeToEvents((_scope, event, payload) => {
            if (event === "workspace/created") created.push(payload);
        });
        const identities = await Promise.all(Array.from({ length: 12 }, () => daemon.ensureSessionReference(reference)));
        identity = identities[0]!;
        assert.ok(identities.every((item) => item.workspaceId === identity.workspaceId && item.sessionId === identity.sessionId));
        assert.equal(created.length, 1, "only the allocator publishes workspace creation");
        off();
        const [workspace] = await daemon.listWorkspaces();
        assert.equal((await daemon.listWorkspaces()).length, 1);
        assert.equal(workspace?.project_root, null);
        assert.match(workspace.name, /^(?=.*[A-Za-z])[A-Za-z0-9]{5}$/u);
        const [session] = await daemon.listSessions(identity.workspaceId);
        assert.equal((await daemon.listSessions(identity.workspaceId)).length, 1);
        assert.equal(session?.id, identity.sessionId);
        assert.equal(session?.origin, "model");
        assert.equal(session?.owner, "_plurnk");
        assert.equal(session?.parentSessionId, null);
        assert.match(session.name, /^[0-9a-f]{8}$/u);
        await daemon.renameWorkspace(identity.workspaceId, "Renamed # workspace");
        await daemon.registerSessionOwner(identity.workspaceId, { address: "fixture://owner", tools: [], interactive: false });
        await daemon.claimSessionOwner({ ...identity, owner: "fixture://owner" });
        assert.deepEqual(await daemon.ensureSessionReference(reference), identity);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.deepEqual(await daemon.listSessionReferences({ ...identity, namespace: "another" }), []);
        assert.deepEqual(await daemon.listSessionLoops(identity), [], "binding does not start work");
    } finally { await daemon.stop(); await db.close(); }
    const reopened = await openMigrated(path);
    const next = new Daemon({ db: reopened, provider: null });
    try {
        assert.deepEqual(await next.readSessionReference(reference), identity);
        assert.deepEqual(await next.ensureSessionReference(reference), identity);
        assert.deepEqual(await next.listSessionReferences({ ...identity, namespace: reference.namespace }), [reference.reference]);
        assert.equal((await next.listWorkspaces())[0]?.name, "Renamed # workspace");
    } finally { await next.stop(); await reopened.close(); }
});

test("{§session-external-reference} namespaces and exact reference bytes isolate identities", async () => {
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
        const identities = await Promise.all(inputs.map((input) => daemon.ensureSessionReference(input)));
        assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, inputs.length);
        assert.equal((await daemon.listWorkspaces()).length, inputs.length);
        for (const [i, input] of inputs.entries()) assert.deepEqual(await daemon.readSessionReference(input), identities[i]);
    } finally { await daemon.stop(); await db.close(); }
});

test("{§session-external-reference} independent database connections converge without process-local serialization", async () => {
    const path = join(await testArtifactDirectory("session-references"), `concurrent-${crypto.randomUUID()}.db`);
    const firstDb = await openMigrated(path);
    const secondDb = await openMigrated(path);
    const first = new Daemon({ db: firstDb, provider: null });
    const second = new Daemon({ db: secondDb, provider: null });
    const reference = { namespace: "fixture", reference: "parallel" };
    try {
        const [a, b] = await Promise.all([first.ensureSessionReference(reference), second.ensureSessionReference(reference)]);
        assert.deepEqual(a, b);
        assert.equal((await first.listWorkspaces()).length, 1);
        assert.equal((await second.listSessions(a.workspaceId)).length, 1);
    } finally {
        await first.stop(); await second.stop();
        await firstDb.close(); await secondDb.close();
    }
});

test("{§session-external-reference} allocation rolls back on failure and leaves existing names untouched", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        const input = { namespace: "fixture", reference: "rollback", workspace_name: "NewWs", session_name: "" };
        await assert.rejects(db.session_reference_allocate.get(input), /CHECK constraint failed/u);
        assert.deepEqual(await daemon.listWorkspaces(), [], "failure at session creation rolls back the workspace too");
        assert.equal(await daemon.readSessionReference(input), null);
        const existing = await daemon.createWorkspace({ name: "NewWs" });
        assert.equal(await db.session_reference_allocate.get({ ...input, session_name: "valid" }), undefined);
        assert.deepEqual(await daemon.listSessions(existing.workspaceId), [], "a random name collision never adopts an existing workspace");
        const allocated = await daemon.ensureSessionReference(input);
        assert.notEqual(allocated.workspaceId, existing.workspaceId);
        await db.test_session_reference_delete_session.run({ session_id: allocated.sessionId });
        assert.equal(await daemon.readSessionReference(input), null, "deletion cascades through the association");
    } finally { await daemon.stop(); await db.close(); }
});
