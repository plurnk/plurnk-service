import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Turn from "../../src/core/Turn.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { routeForSpec } from "../../src/server/model-route.ts";
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
        model_route_id: await routeForSpec(db, providerSpec),
        spawn_model_route_id: null,
        reasoning_policy: "adaptive",
        max_turns: 50,
    });
    if (row === undefined) throw new Error("recovery fixture failed to enqueue loop");
    return row.id;
};

test("boot restores a drain for accepted queued work", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("## SEND0 [200]\nrecovered queued work")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const activations: number[] = [];
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("recovery activation fixture", {
                activate: async (workspaceId) => {
                    activations.push(workspaceId);
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId,
                        namespaceOwner: "recovery activation fixture",
                        state: null,
                        runtimes: [],
                    });
                },
            });
        },
    });
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
        assert.deepEqual(
            activations,
            [workspaceId],
            "durable queued work activates its workspace without a client attachment",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("boot settles a crash-open physical request as unknown and closes its emission attempt", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-unscoped-accounting-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await enqueueLoop(db, workerId, 1, "interrupted unscoped provider call");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const turnId = turn.id;
        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            sequence: 1,
            kind: "emission",
            attributions: "[]",
            model: mock.model,
        });
        assert.ok(modelCall !== undefined);
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            model_call_id: modelCall.id,
        });
        assert.ok(attempt !== undefined);
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            model_call_id: modelCall.id,
            sequence: 1,
            provider: "provider:mock",
            model: mock.model,
        });
        assert.ok(request !== undefined);

        await daemon.start();

        const requests = await db.test_provider_requests.all<{
            state: string;
            outcome: string;
            cost_kind: string;
            cost_reason: string;
        }>({ turn_id: turnId });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.state, "settled");
        assert.equal(requests[0]?.outcome, "error");
        assert.equal(requests[0]?.cost_kind, "unknown");
        assert.match(requests[0]?.cost_reason ?? "", /restarted before provider request evidence/);
        const calls = await db.test_model_calls.all<{ state: string; failure: string | null }>({ turn_id: turnId });
        assert.equal(calls[0]?.state, "error");
        assert.match(calls[0]?.failure ?? "", /owner-vanished/);
        const recoveredTurn = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turnId });
        assert.equal(recoveredTurn?.status, 500);
        assert.ok(recoveredTurn?.completed_at !== null, "the vanished producer's turn is completed");
        const usage = await daemon.engine.loopUsage(loopId);
        assert.equal(usage.accounting.costUsd, null);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("boot closes an open operation turn even when its loop already parked", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-parked-turn-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await enqueueLoop(db, workerId, 1, "parked after its operation committed");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        assert.equal(await new LoopLifecycle(db).park(loopId), true);

        await daemon.start();

        const recovered = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
        assert.equal(recovered?.status, 500);
        assert.ok(recovered?.completed_at !== null, "boot leaves no open producer corpse");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§prompt-loop-containment}: boot completes one partially staged orphan recovery without replay", async () => {
    const db = await openMigrated();
    const firstProvider = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("## SEND0 [200]\nrecovered orphan frames")],
    });
    ProviderInstantiate.registerInstance(firstProvider, providerSpec);
    const firstDaemon = new Daemon({ db, provider: firstProvider });
    let secondDaemon: Daemon | undefined;
    try {
        const workspaceId = await insertWorkspace(db, `recovery-orphans-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const sourceLoopId = await enqueueLoop(db, workerId, 1, "concluded source");
        await db.test_set_loop_status.run({
            id: sourceLoopId,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });

        for (const [ordinal, content] of ["first orphan", "second orphan"].entries()) {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                ownerId: workerId,
                scheme: "prompt",
                pathname: `/1/${ordinal + 2}`,
                content,
                mimetype: "text/markdown",
            });
            await db.crud_set_entry_attributes.run({
                entry_id: entryId,
                attributes: JSON.stringify({ openPaths: [] }),
            });
        }

        const recovery = await db.drain_enqueue_orphan_recovery_loop.get<{
            id: number; sequence: number; status: number;
        }>({
            worker_id: workerId,
            sequence: 2,
            prompt: "first orphan",
            flags: "{}",
            model_route_id: await routeForSpec(db, providerSpec),
            spawn_model_route_id: null,
            reasoning_policy: "adaptive",
            max_turns: 50,
            open_paths: "[]",
            orphan_source_loop_id: sourceLoopId,
        });
        assert.ok(recovery !== undefined);
        assert.equal(recovery.sequence, 2);

        await firstDaemon.start();
        assert.equal(await waitForDb(
            async () => (await db.test_get_loop_status.get<{ status: number }>({ id: recovery.id }))?.status,
            (status) => status === 200,
        ), 200);
        const frames = (await db.test_log_entries_by_loop.all<{
            op: string; pathname: string; rx: string;
        }>({ loop_id: recovery.id })).filter((row) => row.op === "prompt");
        assert.deepEqual(
            frames.map((row) => ({
                pathname: row.pathname,
                content: (JSON.parse(row.rx) as { content: string }).content,
            })),
            [
                { pathname: "/2/1", content: "first orphan" },
                { pathname: "/2/2", content: "second orphan" },
            ],
            "boot completed the existing queued recovery before its drain claimed it",
        );
        await firstDaemon.stop();

        const secondProvider = new Mock({
            contextWindow: 16384,
            responses: [makeMockResponse("## SEND0 [200]\nmust remain unused")],
        });
        ProviderInstantiate.registerInstance(secondProvider, providerSpec);
        secondDaemon = new Daemon({ db, provider: secondProvider });
        await secondDaemon.start();
        const loopCount = await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: workerId });
        assert.equal(loopCount?.n, 2, "a later boot neither remints nor replays the completed recovery");
        assert.equal(secondProvider.remaining, 1, "no provider call was replayed");
    } finally {
        await secondDaemon?.stop();
        await firstDaemon.stop();
        await db.close();
    }
});

test("boot terminalizes a proposed occurrence whose process-local resolution owner vanished", async () => {
    const db = await openMigrated();
    const first = new Daemon({ db, provider: null });
    const second = new Daemon({ db, provider: null });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-proposal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await enqueueLoop(db, workerId, 1, "interrupted proposal");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 1,
            origin: "model",
            source: null,
            model_call_id: null,
            op: "EDIT",
            delimiter: "",
            signal: null,
            scheme: "worker",
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: "/interrupted",
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ op: "EDIT" }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 202, body: "review material" }),
            mimetype_rx: "application/json",
            status_rx: 202,
            weight: 0,
            state: "proposed",
            outcome: null,
            attrs: "{}",
        });
        assert.ok(inserted !== undefined);

        await first.start();

        const recovered = await db.test_get_log_entry_by_id.get<{
            state: string;
            status_rx: number;
            outcome: string | null;
            rx: string;
        }>({ id: inserted.id });
        assert.equal(recovered?.state, "failed");
        assert.equal(recovered?.status_rx, 500);
        assert.equal(recovered?.outcome, "owner_vanished");
        const result = JSON.parse(recovered?.rx ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string; instance?: string };
        } | null;
        assert.equal(result?.status, 500);
        assert.equal(result?.problem?.type, "https://problems.plurnk.dev/lifecycle/recovery/owner-vanished");
        assert.equal(result?.problem?.status, 500);
        assert.match(result?.problem?.detail ?? "", /proposal.*process-local owner no longer exists/);
        assert.equal(result?.problem?.instance, "log:///1/1/1/EDIT");
        const loop = await db.lifecycle_loop_status.get<{
            status: number;
            terminal_result: string | null;
        }>({ loop_id: loopId });
        assert.equal(loop?.status, 500);
        const loopResult = JSON.parse(loop?.terminal_result ?? "null") as {
            status?: number;
            problem?: { type?: string };
        } | null;
        assert.equal(loopResult?.status, 500);
        assert.equal(loopResult?.problem?.type, result?.problem?.type, "the loop and its interrupted operation share one owner-loss disposition");
        assert.deepEqual(await first.pendingProposals(workspaceId), []);
        const rendered = await db.engine_render_log.all<{ sequence: number; op: string; state: string; status_rx: number }>({ worker_id: workerId });
        assert.ok(
            rendered.some((row) => row.sequence === 1 && row.op === "EDIT" && row.state === "failed" && row.status_rx === 500),
            "the reconciled operation is visible as a truthful failed occurrence",
        );

        await first.stop();
        await second.start();
        const recoveredAgain = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null; rx: string }>({ id: inserted.id });
        assert.deepEqual(recoveredAgain, recovered, "a later boot leaves the terminal occurrence unchanged");
    } finally {
        await Promise.allSettled([first.stop(), second.stop()]);
        await db.close();
    }
});

test("boot settles vanished owners and resumes the now-unblocked parent topology", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("## SEND0 [200]\nparent observed the interrupted child")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-topology-${crypto.randomUUID()}`);
        const parentId = await insertWorker(db, workspaceId, null, "parent");
        const childId = await insertWorker(db, workspaceId, parentId, "child");
        const parentLoopId = await enqueueLoop(db, parentId, 1, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId), true);
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
                terminal_result: string | null;
            }>({}).then((rows) => rows.find((row) => row.id === childLoopId)),
            (row) => row?.status === 500,
        );
        const childResult = JSON.parse(child?.terminal_result ?? "null") as {
            problem?: { detail?: string };
        } | null;
        assert.match(childResult?.problem?.detail ?? "", /daemon restarted/);

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
        responses: [makeMockResponse("## SEND0 [200]\nparent handled child failure")],
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
        assert.equal(await new LoopLifecycle(db).park(parentLoopId), true);
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
