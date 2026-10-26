import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, waitForDb, HARNESS_WAIT_MS } from "./_rpc.ts";
import { insertSession } from "./_db.ts";
import { modelOperation } from "./_sessions.ts";
import type { SessionOwner } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

const owner: SessionOwner = { address: "acp://operator", tools: ["request_approval", "question"], interactive: true };

test("{§session-owner-creation}: every session has a durable runtime owner before client attachment", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: "owner-default" });
        const model = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "model" });
        const sessions = await daemon.listSessions(workspace.workspaceId);
        assert.ok(sessions.some(({ id }) => id === model.sessionId));
        for (const session of sessions) {
            assert.equal(Reflect.get(session, "owner"), "_plurnk", `${session.name} must have a real owner, not an absent binding`);
        }
    });
});

test("{§session-ownership}: control claims model descendants; later delegation inherits and the runtime actor is never claimable", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-inheritance" });
        const parent = await daemon.createSession({ workspaceId, name: "parent" });
        const before = await daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "before" });
        await daemon.registerSessionOwner(workspaceId, owner);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: parent.sessionId, owner: owner.address }), owner);
        const after = await daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "after" });
        const grandchild = await daemon.forkSession({ workspaceId, sessionId: after.sessionId, name: "grandchild" });
        for (const sessionId of [parent.sessionId, before.sessionId, after.sessionId, grandchild.sessionId]) {
            assert.equal((await daemon.readSession({ workspaceId, identity: { id: sessionId } }))?.owner, owner.address);
        }
        const successor: SessionOwner = { address: "acp://operator", tools: ["request_approval"], interactive: true };
        await daemon.registerSessionOwner(workspaceId, successor);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: parent.sessionId, owner: successor.address }), successor,
            "claiming a model session transfers it and its model descendants to the claiming owner");
        for (const sessionId of [parent.sessionId, before.sessionId, after.sessionId, grandchild.sessionId]) {
            assert.equal((await daemon.readSession({ workspaceId, identity: { id: sessionId } }))?.owner, successor.address);
        }
        const runtimeId = await insertSession(db, workspaceId, null, "_plurnk", "_plurnk");
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: runtimeId, owner: owner.address }),
            { address: "_plurnk", tools: [], interactive: false }, "the runtime actor itself is never claimable");
    });
});

test("{§session-ownership}: disconnected owners keep their declared capabilities and addresses are workspace-scoped", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-first" });
        const second = await daemon.createWorkspace({ name: "owner-second" });
        const one = await daemon.createSession({ workspaceId: first.workspaceId, name: "primary" });
        const two = await daemon.createSession({ workspaceId: second.workspaceId, name: "primary" });
        await daemon.registerSessionOwner(first.workspaceId, owner);
        await daemon.registerSessionOwner(second.workspaceId, { ...owner, tools: [] });
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId: first.workspaceId, sessionId: one.sessionId, owner: owner.address }), owner);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: two.sessionId, owner: owner.address }), { ...owner, tools: [] });
        assert.equal((await daemon.readSession({ workspaceId: first.workspaceId, identity: { id: one.sessionId } }))?.owner, owner.address);
    });
});

test("{§session-owner-creation}: fresh model children inherit an existing parent without copying its history or origin", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-fresh-model" });
        await daemon.registerSessionOwner(workspaceId, owner);
        const parent = await daemon.createSession({ workspaceId, name: "parent", owner: owner.address });
        const child = await daemon.createSession({ workspaceId, name: "context", parentSessionId: parent.sessionId });
        const projected = await daemon.readSession({ workspaceId, identity: { id: child.sessionId } });
        assert.equal(projected?.parentSessionId, parent.sessionId);
        assert.equal(projected?.owner, owner.address);
        assert.equal(projected?.origin, "model");
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId: child.sessionId }), []);
        const runtimeId = await insertSession(db, workspaceId, null, "_plurnk", "_plurnk");
        const runtimeChild = await daemon.createSession({ workspaceId, name: "runtime-context", parentSessionId: runtimeId });
        const runtimeProjection = await daemon.readSession({ workspaceId, identity: { id: runtimeChild.sessionId } });
        assert.equal(runtimeProjection?.origin, "model");
        assert.equal(runtimeProjection?.owner, "_plurnk");
        assert.equal(runtimeProjection?.parentSessionId, runtimeId);
    });
});

test("{§session-owner-creation}: unknown owners and parents from another workspace fail without creating sessions", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-invalid-first" });
        const second = await daemon.createWorkspace({ name: "owner-invalid-second" });
        const parent = await daemon.createSession({ workspaceId: second.workspaceId, name: "parent" });
        const failure = (code: string) => (error: unknown): boolean => error instanceof OperationFailureError &&  error.result.problem?.type.endsWith(`/${code}`);
        await assert.rejects(daemon.createSession({ workspaceId: first.workspaceId, name: "unowned", owner: owner.address }), failure("owner-not-found"));
        await assert.rejects(daemon.createSession({ workspaceId: first.workspaceId, name: "wrong-parent", parentSessionId: parent.sessionId }), failure("session-not-found"));
        assert.equal((await daemon.listSessions(first.workspaceId)).some(({ name }) => name === "unowned" || name === "wrong-parent"), false);
        await daemon.registerSessionOwner(second.workspaceId, owner);
        await daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: parent.sessionId, owner: owner.address });
        await assert.rejects(daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: parent.sessionId, owner: "not-registered" }), failure("owner-not-found"));
    });
});

test("{§session-owner-resolution}: only the recorded owner resolves a proposal, including while no client is connected", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-resolution" });
        await daemon.registerSessionOwner(workspaceId, owner);
        const { sessionId } = await daemon.createSession({ workspaceId, name: "controlled", owner: owner.address });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo owner-approved")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        // The session's own operation: its owner reviews it.
        const operation = modelOperation(daemon, db, { workspaceId, sessionId, statement: statement.statement });
        try {
            const [proposal] = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
            assert.equal(proposal.owner, owner.address);
            assert.deepEqual(proposal.disposition, { decision: "review" });
            await daemon.registerSessionOwner(workspaceId, { ...owner, tools: [] });
            assert.deepEqual((await daemon.pendingProposals(workspaceId))[0]?.disposition, { decision: "review" },
                "a later capability declaration cannot hide or reinterpret an outstanding review");
            await assert.rejects(daemon.resolveProposal(proposal.logEntryId, { decision: "accept" }, {
                workspaceId, address: "acp://somebody-else",
            }), (error: unknown) => error instanceof OperationFailureError && error.result.problem.type.endsWith("/owner-mismatch"));
            assert.equal((await daemon.pendingProposals(workspaceId)).length, 1, "an unrelated sender does not consume the gate");
            await daemon.resolveProposal(proposal.logEntryId, { decision: "accept" }, { workspaceId, address: owner.address });
            assert.equal((await operation).status, 200);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});

test("{§session-owner-resolution}: runtime-owned work cannot hang awaiting a reviewer it does not have", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-incapable" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "unclaimed" });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo must-not-run")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        const operation = modelOperation(daemon, db, { workspaceId, sessionId, statement: statement.statement });
        try {
            const result = await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("runtime-owned proposal never settled")), HARNESS_WAIT_MS).unref()),
            ]);
            assert.equal(result.status, 400);
            assert.match((result.problem as { type: string }).type, /\/rejected$/);
            assert.equal(result.outcome, "no_review_channel");
            assert.deepEqual(await daemon.pendingProposals(workspaceId), []);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});
