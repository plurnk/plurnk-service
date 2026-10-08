import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, waitForDb } from "./_rpc.ts";
import { insertWorker } from "./_db.ts";
import type { WorkerOwner } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

const owner: WorkerOwner = { address: "agui://local/threads/primary", tools: ["request_approval", "question"], interactive: true };

test("{§worker-owner-creation}: every worker has a durable runtime owner before client attachment", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: "owner-default" });
        const model = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "conversation" });
        const workers = await daemon.listWorkers(workspace.workspaceId);
        assert.ok(workers.some(({ id }) => id === model.workerId));
        for (const worker of workers) {
            assert.equal(Reflect.get(worker, "owner"), "_plurnk", `${worker.name} must have a real owner, not an absent binding`);
        }
    });
});

test("{§worker-ownership}: control claims runtime descendants; later delegation inherits and other owners survive", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-inheritance" });
        const parent = await daemon.createConversationWorker({ workspaceId, name: "parent" });
        const before = await daemon.forkWorker({ workspaceId, workerId: parent.workerId, name: "before" });
        await daemon.registerWorkerOwner(workspaceId, owner);
        assert.deepEqual(await daemon.claimWorkerOwner({ workspaceId, workerId: parent.workerId, owner: owner.address }), owner);
        const after = await daemon.forkWorker({ workspaceId, workerId: parent.workerId, name: "after" });
        const grandchild = await daemon.forkWorker({ workspaceId, workerId: after.workerId, name: "grandchild" });
        for (const workerId of [parent.workerId, before.workerId, after.workerId, grandchild.workerId]) {
            assert.equal((await daemon.readWorker({ workspaceId, identity: { id: workerId } }))?.owner, owner.address);
        }
        const stranger: WorkerOwner = { address: "agui://local/threads/other", tools: [], interactive: false };
        await daemon.registerWorkerOwner(workspaceId, stranger);
        assert.deepEqual(await daemon.claimWorkerOwner({ workspaceId, workerId: parent.workerId, owner: stranger.address }), owner,
            "opening an already-owned conversation is not a transfer");
        const runtimeId = await insertWorker(db, workspaceId, null, "_plurnk", "_plurnk");
        assert.deepEqual(await daemon.claimWorkerOwner({ workspaceId, workerId: runtimeId, owner: owner.address }),
            { address: "_plurnk", tools: [], interactive: false }, "the runtime actor itself is never claimable");
    });
});

test("{§worker-ownership}: disconnected owners keep their declared capabilities and addresses are workspace-scoped", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-first" });
        const second = await daemon.createWorkspace({ name: "owner-second" });
        const one = await daemon.createConversationWorker({ workspaceId: first.workspaceId, name: "primary" });
        const two = await daemon.createConversationWorker({ workspaceId: second.workspaceId, name: "primary" });
        await daemon.registerWorkerOwner(first.workspaceId, owner);
        await daemon.registerWorkerOwner(second.workspaceId, { ...owner, tools: [] });
        assert.deepEqual(await daemon.claimWorkerOwner({ workspaceId: first.workspaceId, workerId: one.workerId, owner: owner.address }), owner);
        assert.deepEqual(await daemon.claimWorkerOwner({ workspaceId: second.workspaceId, workerId: two.workerId, owner: owner.address }), { ...owner, tools: [] });
        assert.equal((await daemon.readWorker({ workspaceId: first.workspaceId, identity: { id: one.workerId } }))?.owner, owner.address);
    });
});

test("{§worker-owner-creation}: fresh model children inherit an existing parent without copying its history or origin", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-fresh-model" });
        await daemon.registerWorkerOwner(workspaceId, owner);
        const parent = await daemon.createConversationWorker({ workspaceId, name: "parent", owner: owner.address });
        const child = await daemon.createConversationWorker({ workspaceId, name: "context", parentWorkerId: parent.workerId });
        const projected = await daemon.readWorker({ workspaceId, identity: { id: child.workerId } });
        assert.equal(projected?.parentWorkerId, parent.workerId);
        assert.equal(projected?.owner, owner.address);
        assert.equal(projected?.origin, "model");
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId, workerId: child.workerId }), []);
        const runtimeId = await insertWorker(db, workspaceId, null, "_plurnk", "_plurnk");
        const runtimeChild = await daemon.createConversationWorker({ workspaceId, name: "runtime-context", parentWorkerId: runtimeId });
        const runtimeProjection = await daemon.readWorker({ workspaceId, identity: { id: runtimeChild.workerId } });
        assert.equal(runtimeProjection?.origin, "model");
        assert.equal(runtimeProjection?.owner, "_plurnk");
        assert.equal(runtimeProjection?.parentWorkerId, runtimeId);
    });
});

test("{§worker-owner-creation}: unknown owners and parents from another workspace fail without creating workers", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-invalid-first" });
        const second = await daemon.createWorkspace({ name: "owner-invalid-second" });
        const parent = await daemon.createConversationWorker({ workspaceId: second.workspaceId, name: "parent" });
        const failure = (code: string) => (error: unknown): boolean => error instanceof OperationFailureError && error.result.problem?.type.endsWith(`/${code}`) === true;
        await assert.rejects(daemon.createConversationWorker({ workspaceId: first.workspaceId, name: "unowned", owner: owner.address }), failure("owner-not-found"));
        await assert.rejects(daemon.createConversationWorker({ workspaceId: first.workspaceId, name: "wrong-parent", parentWorkerId: parent.workerId }), failure("worker-not-found"));
        assert.equal((await daemon.listWorkers(first.workspaceId)).some(({ name }) => name === "unowned" || name === "wrong-parent"), false);
        await daemon.registerWorkerOwner(second.workspaceId, owner);
        await daemon.claimWorkerOwner({ workspaceId: second.workspaceId, workerId: parent.workerId, owner: owner.address });
        await assert.rejects(daemon.claimWorkerOwner({ workspaceId: second.workspaceId, workerId: parent.workerId, owner: "not-registered" }), failure("owner-not-found"));
    });
});

test("{§worker-owner-resolution}: only the recorded owner resolves a proposal, including while no client is connected", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-resolution" });
        await daemon.registerWorkerOwner(workspaceId, owner);
        const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "controlled", owner: owner.address });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo owner-approved")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        const operation = daemon.dispatchAsClient({ workspaceId, workerId, statement: statement.statement });
        try {
            const [proposal] = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
            assert.equal(proposal!.owner, owner.address);
            assert.deepEqual(proposal!.disposition, { decision: "review" });
            await daemon.registerWorkerOwner(workspaceId, { ...owner, tools: [] });
            assert.deepEqual((await daemon.pendingProposals(workspaceId))[0]?.disposition, { decision: "review" },
                "a later capability declaration cannot hide or reinterpret an outstanding review");
            await assert.rejects(daemon.resolveProposal(proposal!.logEntryId, { decision: "accept" }, {
                workspaceId, address: "agui://somebody-else",
            }), (error: unknown) => error instanceof OperationFailureError && error.result.problem.type.endsWith("/owner-mismatch"));
            assert.equal((await daemon.pendingProposals(workspaceId)).length, 1, "an unrelated sender does not consume the gate");
            await daemon.resolveProposal(proposal!.logEntryId, { decision: "accept" }, { workspaceId, address: owner.address });
            assert.equal((await operation).status, 200);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});

test("{§worker-owner-resolution}: runtime-owned work cannot hang awaiting a reviewer it does not have", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-incapable" });
        const { workerId } = await daemon.createConversationWorker({ workspaceId, name: "unclaimed" });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo must-not-run")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        const operation = daemon.dispatchAsClient({ workspaceId, workerId, statement: statement.statement });
        try {
            const result = await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("runtime-owned proposal never settled")), 2000).unref()),
            ]);
            assert.equal(result.status, 400);
            assert.match(String((result.problem as { type: string }).type), /\/rejected$/);
            assert.equal(result.outcome, "no_review_channel");
            assert.deepEqual(await daemon.pendingProposals(workspaceId), []);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});
