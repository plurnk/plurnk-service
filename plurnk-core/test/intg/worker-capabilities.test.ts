import test from "node:test";
import assert from "node:assert/strict";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ClientInteractions from "../../src/core/ClientInteractions.ts";
import CapabilityPolicies from "../../src/core/CapabilityPolicies.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_db.ts";
import { ownWorker, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";

const downProvider = (): Mock => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };
    return provider;
};

for (const reviewable of [true, false]) {
    test(`{§worker-ownership}: exhausted provider recovery ${reviewable ? "parks for the owner" : "concludes without a reviewer"}`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${reviewable}`);
        const workerId = await insertWorker(db, workspaceId);
        if (reviewable) await ownWorker(db, workspaceId, workerId, ["request_approval"]);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const notices: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_sid, { notice }) => {
            if (notice.source === "engine:provider" && notice.level === "error") notices.push(notice.message ?? "");
        } });
        const run = await engine.runLoop({ workspaceId, workerId, loopId, provider: downProvider(), messages: [], maxTurns: 2 });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(run.reason, "provider_unavailable");
        if (reviewable) {
            assert.equal(run.result.status, 202);
            assert.equal(await lifecycle.status(loopId), 202);
            assert.equal(await lifecycle.result(loopId), null);
            assert.match(notices.at(-1)!, /parked and resumes on the next prompt or wake/);
        } else {
            assert.equal(run.result.status, 503);
            assert.equal(run.result.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
            assert.equal(run.result.problem?.detail, "connection refused");
            assert.equal((await lifecycle.result(loopId))?.status, 503);
            assert.match(notices.at(-1)!, /no review-capable owner is assigned/);
        }
    });
}

test("{§client-interaction-routing}: unsupported requests fail without parking; supported requests wait for their recipient", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "interaction-capabilities");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    const turnId = await insertTurn(db, loopId, 1);
    const ids = { workspaceId, workerId, loopId, turnId };
    const interactions = new ClientInteractions(db);
    const request = { toolName: "question", arguments: {}, responseSchema: { type: "object" } };
    await assert.rejects(interactions.request(request, ids), (error: unknown) => {
        const result = (error as { result: { status: number; problem: { detail: string } } }).result;
        assert.equal(result.status, 501);
        assert.equal(result.problem.detail, "No recipient implements 'question' for this conversation.");
        return true;
    });
    assert.deepEqual(await interactions.list(workspaceId), []);
    await ownWorker(db, workspaceId, workerId, ["question"]);
    const response = interactions.request(request, ids);
    const [pending] = await waitForDb(() => interactions.list(workspaceId), (items) => items.length === 1);
    assert.equal(pending!.recipient, TEST_OWNER);
    await assert.rejects(interactions.resolve(pending!.interactionId, { status: "resolved", payload: {} }, { workspaceId, address: "test://other" }), /Only the interaction's recipient/);
    assert.equal((await interactions.list(workspaceId)).length, 1);
    await interactions.resolve(pending!.interactionId, { status: "resolved", payload: { answer: "main" } }, { workspaceId, address: TEST_OWNER });
    assert.deepEqual(await response, { status: "resolved", payload: { answer: "main" } });
    assert.deepEqual(await interactions.list(workspaceId), []);
});

test("{§client-interaction-routing}: protocol routing supersedes owner delivery and refuses ambiguous recipients", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "protocol-recipient");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "go");
    await ownWorker(db, workspaceId, workerId, ["question"]);
    const interactions = new ClientInteractions(db);
    const context = { workspaceId, workerId, loopId, toolName: "question" };
    const remove = interactions.registerRoute(async () => "a2a://remote/task");
    assert.equal(await interactions.recipient(context), "a2a://remote/task");
    const removeSame = interactions.registerRoute(async () => "a2a://remote/task");
    assert.equal(await interactions.recipient(context), "a2a://remote/task", "two exposures of the same recipient do not create another authority");
    removeSame();
    const removeDuplicate = interactions.registerRoute(async () => "a2a://other/task");
    await assert.rejects(interactions.recipient(context), /Multiple interaction routes/);
    removeDuplicate();
    remove();
    assert.equal(await interactions.recipient(context), TEST_OWNER);
    interactions.registerRoute(async () => "");
    await assert.rejects(interactions.recipient(context), /empty recipient/);
});

test("{§worker-ownership}: parking requires either an obligation or a review-capable owner", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "park-waker");
    const workerId = await insertWorker(db, workspaceId);
    const lifecycle = new LoopLifecycle(db);
    const loopId = await insertLoop(db, workerId, 1, "go");
    await assert.rejects(lifecycle.park(loopId, { wakenBy: null }), /cannot park without a waker or review-capable owner/);
    assert.notEqual(await lifecycle.status(loopId), 202);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "obligations" }), true);
    await ownWorker(db, workspaceId, workerId);
    const owned = await insertLoop(db, workerId, 2, "go");
    assert.equal(await lifecycle.park(owned, { wakenBy: null }), true);
});

test("{§workspace-capability-policy}: owner capabilities do not create a resource-policy ring", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "capability-rings");
    const workerId = await insertWorker(db, workspaceId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
    await ownWorker(db, workspaceId, workerId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
});
