import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import {
    insertWorker,
    insertWorkspace,
    openMigrated,
    seedEntryWithChannel,
} from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";

const providerSpec = {
    alias: "recovery",
    provider: "openai",
    model: "lifecycle-recovery",
} as const;

const enqueueLoop = async (
    db: Parameters<typeof insertWorker>[0],
    workerId: number,
    sequence: number,
    prompt: string,
): Promise<number> => {
    const row = await db.drain_enqueue_loop.get<{ id: number }>({
        worker_id: workerId,
        sequence,
        prompt,
        provider_spec: JSON.stringify(providerSpec),
        max_turns: 50,
    });
    if (row === undefined) throw new Error("recovery fixture failed to enqueue loop");
    return row.id;
};

test("boot restores a drain for accepted queued work", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("<<SEND[200]:recovered queued work:SEND")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-queue-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await enqueueLoop(db, workerId, 1, "accepted before restart");

        await daemon.start();

        const status = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(status, 200);
        assert.equal(mock.remaining, 0, "the recovered queue was executed, not merely relabelled");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("boot settles vanished owners and resumes the now-unblocked parent topology", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("<<SEND[200]:parent observed the interrupted child:SEND")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-topology-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId, null, "parent");
        const childId = await insertWorker(db, workspaceId, parentId, "child");
        const parentLoopId = await enqueueLoop(db, parentId, 1, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, "waiting for child"), true);
        const childLoopId = await enqueueLoop(db, childId, 1, "interrupted child");
        await db.engine_reclaim_queued_loop.run({ loop_id: childLoopId });

        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            ownerId: childId,
            scheme: "sh",
            pathname: "/interrupted",
            channel: "stdout",
            state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            workerId: childId,
            entryId,
            scheme: "sh",
            handle: "lost process",
        });

        await daemon.start();

        const child = await waitForDb(
            () => db.test_list_loops_all.all<{
                id: number;
                status: number;
                terminal_message: string | null;
            }>({}).then((rows) => rows.find((row) => row.id === childLoopId)),
            (row) => row?.status === 500,
        );
        assert.match(child?.terminal_message ?? "", /daemon restarted/);

        const subscription = await db.test_get_subscription.get<{
            close_status: number | null;
            close_result: string | null;
        }>({ id: subscriptionId });
        assert.equal(subscription?.close_status, 500);
        const result = JSON.parse(subscription?.close_result ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string };
        } | null;
        assert.equal(result?.status, 500);
        assert.equal(result?.problem?.status, 500);
        assert.equal(result?.problem?.type, "https://problems.plurnk.dev/lifecycle/recovery/owner-vanished");
        assert.match(result?.problem?.detail ?? "", /process-local owner no longer exists/);
        const channel = await db.test_get_channel.get<{ state: string }>({
            entry_id: entryId,
            name: "stdout",
        });
        assert.equal(channel?.state, "errored");

        const parentStatus = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(parentStatus, 200, "the settled child propagated a wake through the parent edge");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("a child drain exception still propagates the parent wake edge", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("<<SEND[200]:parent handled child failure:SEND")],
    });
    const generate = mock.generate.bind(mock);
    let calls = 0;
    mock.generate = async (request) => {
        calls += 1;
        if (calls === 1) throw new Error("child provider failed");
        return generate(request);
    };
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const realError = console.error;
    console.error = () => {};
    try {
        const workspaceId = await insertWorkspace(db, `recovery-child-error-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId, null, "parent");
        const childId = await insertWorker(db, workspaceId, parentId, "child");
        const parentLoopId = await enqueueLoop(db, parentId, 1, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, "waiting for child"), true);
        const childLoopId = await enqueueLoop(db, childId, 1, "fail while running");

        await daemon.start();

        const parentStatus = await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
            (value) => value === 200,
        );
        assert.equal(parentStatus, 200);
        const childStatus = await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId });
        assert.equal(childStatus?.status, 500);
        assert.equal(calls, 2, "the failed child terminal woke exactly one parent continuation");
    } finally {
        console.error = realError;
        await daemon.stop();
        await db.close();
    }
});
