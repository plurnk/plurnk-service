import test from "node:test";
import assert from "node:assert/strict";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ClientInteractions from "../../src/core/ClientInteractions.ts";
import CapabilityPolicies from "../../src/core/CapabilityPolicies.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";

const downProvider = (): Mock => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };
    return provider;
};

// {§provider-recovery} A park waits for a person: approving alone, as a yolo client does, attends nothing.
for (const [label, owner] of [
    ["parks for an interactive owner", { tools: ["request_approval", "question", "mcp_input_required"], interactive: true }],
    ["concludes for an owner that approves but is not interactive", { tools: ["request_approval"], interactive: false }],
    ["concludes for the runtime owner", null],
] as const) {
    const parks = owner?.interactive === true;
    test(`{§session-ownership}: exhausted provider recovery ${label}`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${label.split(" ").at(-1)}-${owner === null ? "runtime" : owner.interactive}`);
        const sessionId = await insertSession(db, workspaceId);
        if (owner !== null) await ownSession(db, workspaceId, sessionId, [...owner.tools], owner.interactive);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const notices: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_sid, { notice }) => {
            if (notice.source === "engine:provider" && notice.level === "error") notices.push(notice.message ?? "");
        } });
        const run = await engine.runLoop({ workspaceId, sessionId, loopId, provider: downProvider(), messages: [], maxTurns: 2 });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(run.reason, "provider_unavailable");
        if (parks) {
            assert.equal(run.result.status, 202);
            assert.equal(await lifecycle.status(loopId), 202);
            assert.equal(await lifecycle.result(loopId), null);
            assert.match(notices.at(-1)!, /parked and resumes on the next prompt or wake/);
        } else {
            assert.equal(run.result.status, 503);
            assert.equal(run.result.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
            assert.equal(run.result.problem?.detail, "connection refused");
            assert.equal((await lifecycle.result(loopId))?.status, 503);
            assert.match(notices.at(-1)!, /nobody attends the session's owner, so the loop ends here/);
        }
    });
}

test("{§session-ownership}: a delegated child inherits its owner's attendance, so exhausted recovery concludes when nobody attends", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "recovery-delegated");
    const parentId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, parentId, ["request_approval"], false);
    const childId = await insertSession(db, workspaceId, parentId, "child", "model");
    const loopId = await insertLoop(db, childId, 1, "delegated task");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const run = await engine.runLoop({ workspaceId, sessionId: childId, loopId, provider: downProvider(), messages: [], maxTurns: 2 });
    assert.equal(run.reason, "provider_unavailable");
    assert.equal(run.result.status, 503, "the child concludes on the provider's exact failure instead of parking for nobody");
    assert.equal((await new LoopLifecycle(db).result(loopId))?.status, 503);
});

test("{§client-interaction-routing}: unsupported requests fail without parking; supported requests wait for their recipient", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "interaction-capabilities");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const turnId = await insertTurn(db, loopId, 1);
    const ids = { workspaceId, sessionId, loopId, turnId };
    const interactions = new ClientInteractions(db);
    const request = { toolName: "question" as const, mode: "form" as const, message: "Answer?", requestedSchema: { type: "object" } };
    await assert.rejects(interactions.request(request, ids), (error: unknown) => {
        const result = (error as { result: { status: number; problem: { detail: string } } }).result;
        assert.equal(result.status, 501);
        assert.equal(result.problem.detail, "No recipient implements 'question' for this session.");
        return true;
    });
    assert.deepEqual(await interactions.list(workspaceId), []);
    await ownSession(db, workspaceId, sessionId, ["question"], false);
    await assert.rejects(interactions.request(request, ids), (error: unknown) => {
        assert.equal((error as { result: { status: number } }).result.status, 501, "a declared tool with nobody attending is no recipient");
        return true;
    });
    await ownSession(db, workspaceId, sessionId, ["question"]);
    const response = interactions.request(request, ids);
    const [pending] = await waitForDb(() => interactions.list(workspaceId), (items) => items.length === 1);
    assert.equal(pending.recipient, TEST_OWNER);
    await assert.rejects(interactions.resolve(pending.interactionId, { action: "accept", content: {} }, { workspaceId, address: "test://other" }), /Only the interaction's recipient/);
    assert.equal((await interactions.list(workspaceId)).length, 1);
    await interactions.resolve(pending.interactionId, { action: "accept", content: { answer: "main" } }, { workspaceId, address: TEST_OWNER });
    assert.deepEqual(await response, { action: "accept", content: { answer: "main" } });
    assert.deepEqual(await interactions.list(workspaceId), []);
});

test("{§session-ownership}: parking requires either an obligation or an interactive owner", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "park-waker");
    const sessionId = await insertSession(db, workspaceId);
    const lifecycle = new LoopLifecycle(db);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    await assert.rejects(lifecycle.park(loopId, { wakenBy: null }), /cannot park without a waker or an interactive owner/);
    assert.notEqual(await lifecycle.status(loopId), 202);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "obligations" }), true);
    await ownSession(db, workspaceId, sessionId, ["request_approval"], false);
    const approving = await insertLoop(db, sessionId, 3, "go");
    await assert.rejects(lifecycle.park(approving, { wakenBy: null }), /cannot park without a waker or an interactive owner/, "approval alone attends nothing");
    await ownSession(db, workspaceId, sessionId);
    const owned = await insertLoop(db, sessionId, 2, "go");
    assert.equal(await lifecycle.park(owned, { wakenBy: null }), true);
});

test("{§owner-interaction-ring}: the workspace layers carry no owner ring; ownership shapes only what an asking session is offered", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "capability-rings");
    const sessionId = await insertSession(db, workspaceId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
    await ownSession(db, workspaceId, sessionId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
});
