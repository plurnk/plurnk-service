import test, { describe } from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Turn from "../../src/core/Turn.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, insertTurn } from "./_db.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon, rpcCall, subscribeNotifications, connect, waitFor } from "./_rpc.ts";
import { routeForSpec } from "../../src/server/model-route.ts";

describe("Daemon.lifecycle-recovery", () => {
const providerSpec = {
    alias: "recovery",
    provider: "openai",
    model: "lifecycle-recovery",
} as const;

const enqueueLoop = async (
    db: Parameters<typeof insertSession>[0],
    sessionId: number,
    prompt: string,
): Promise<number> => {
    const row = await db.drain_enqueue_loop.get<{ id: number }>({
        session_id: sessionId,
        prompt,
        prompt_source: null,
        model_route_id: await routeForSpec(db, providerSpec),
        spawn_model_route_id: null,
        effort: "adaptive",
        max_turns: 50,
    });
    if (row === undefined) throw new Error("recovery fixture failed to enqueue loop");
    // {§message-arrival} — as the daemon's enqueue does: the assignment is ordinal 1 of the inbox.
    const seeded = await db.drain_enqueue_message.get<{ id: number }>({ loop_id: row.id, source: null, body: prompt, open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
    if (seeded === undefined) throw new Error("recovery fixture failed to seed the loop's message");
    return row.id;
};

test("{§message-arrival} boot restores a drain for accepted queued work", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nrecovered queued work\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const activations: number[] = [];
    daemon.registerModule({
        setup: (seam) => {
            seam.registerWorkspaceCapabilityProvider("recovery activation fixture", {
                activate: async ({ workspaceId }) => {
                    activations.push(workspaceId);
                    await seam.replaceWorkspaceCapabilities({
                        workspaceId,
                        namespaceOwner: "recovery activation fixture",
                        state: null,
                        runtimes: [],
                    });
                },
                deactivate: async () => undefined,
            });
        },
    }, "test-module");
    try {
        const workspaceId = await insertWorkspace(db, `recovery-queue-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "accepted before restart");

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
            "durable queued work activates workspace Functionality without a client attachment",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-wait-timing}: restart settles an interrupted child and wakes the parent parked on it", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 65536, responses: [makeMockResponse("````SEND [200]\nThe child was interrupted.\n````")] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "recovery-completion-before-clock");
        const sessionId = await insertSession(db, workspaceId, null, "parent", "model");
        const loopId = await enqueueLoop(db, sessionId, "Observe the child's outcome.");
        const child = await insertSession(db, workspaceId, sessionId, "child", "model");
        const childLoop = await enqueueLoop(db, child, "Interrupted work.");
        for (const id of [loopId, childLoop]) await db.engine_reclaim_queued_loop.run({ loop_id: id });
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(loopId, { wakenBy: "test-fixture" });
        await daemon.start();
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200);
        assert.equal((await lifecycle.result(childLoop))?.status, 500);
        assert.equal(mock.received.length, 1, "parent observes the durable completion at boot");
        assert.equal((await lifecycle.parked(sessionId)).length, 0);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§machine-processes}: boot rejects queued provider work owned by a non-model actor", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nmust remain unused\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-runtime-queue-${crypto.randomUUID()}`);
        const runtimeSessionId = await RuntimeSession.ensure(db, workspaceId);
        await enqueueLoop(db, runtimeSessionId, "illegal queued inference");

        await assert.rejects(
            () => daemon.start(),
            /Queued provider work belongs to _plurnk session .* only model sessions may enter inference/,
        );
        assert.equal(mock.remaining, 1, "recovery fails before acquiring a provider for an invalid actor");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§message-arrival} boot settles a crash-open physical request as unknown and closes its emission attempt", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-unscoped-accounting-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "interrupted unscoped provider call");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const turnId = turn.id;
        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
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
            inference_call_id: modelCall.id,
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

test("{§session-causal-admission}: failed database settlement rolls back before any work resumes", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "recovery-atomic-settlement");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await enqueueLoop(db, sessionId, "Interrupted work.");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.test_refuse_recovery_turn_settlement({});

        await assert.rejects(() => daemon.start(), /recovery settlement fixture/);

        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102,
            "a later settlement failure rolls back the loop's earlier owner-loss transition");
        assert.equal((await db.test_get_turn.get<{ completed_at: string | null }>({ id: turn.id }))?.completed_at, null);
        assert.equal(mock.received.length, 0, "failed settlement starts no inference");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const pending of [false, true]) {
    test(`{§session-causal-admission} {§loop-completion}: database recovery respects pending messages (${pending})`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `recovery-message-${pending}`);
            const sender = await insertSession(db, workspaceId, null, "sender");
            const receiver = await insertSession(db, workspaceId, null, "receiver");
            const senderLoop = await enqueueLoop(db, sender, "Wait for a reply.");
            const receiverLoop = await enqueueLoop(db, receiver, "Other work.");
            await db.engine_reclaim_queued_loop.run({ loop_id: senderLoop });
            const turn = await Turn.open(db, { loopId: senderLoop, producer: "model", kind: "inference" });
            if (pending) {
                await db.drain_enqueue_message.get({
                    loop_id: receiverLoop, source: "session://sender", body: "A question.",
                    open_paths: "[]", evidence: "{}", address: null,
                    opened_turn_id: turn.id, opened_sequence: 1,
                });
            }
            assert.equal(await new LoopLifecycle(db).park(senderLoop, { wakenBy: "test-fixture" }), true);
            for (let attempt = 0; attempt < 2; attempt++) {
                await db.recovery_settle_process_owners({});
                assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: senderLoop }))?.status,
                    pending ? 202 : 100, "only an empty obligation set requeues without a completion");
            }
        } finally { await db.close(); }
    });
}

test("{§message-arrival} boot closes an open operation turn even when its loop already parked", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-parked-turn-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "parked after its operation committed");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        assert.equal(await new LoopLifecycle(db).park(loopId, { wakenBy: "test-fixture" }), true);

        await daemon.start();

        const recovered = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
        assert.equal(recovered?.status, 500);
        assert.ok(recovered?.completed_at !== null, "boot leaves no open producer corpse");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const staged of ["loop", "messages"] as const) {
    test(`{§message-arrival}: boot completes recovery with ${staged} staged without replay`, async () => {
        const db = await openMigrated();
        const firstProvider = new Mock({
            contextWindow: 16384,
            responses: [makeMockResponse("````SEND [200]\nFirst orphan recovered.\n````\n\n````SEND [200]\nSecond orphan recovered.\n````")],
        });
        ProviderInstantiate.registerInstance(firstProvider, providerSpec);
        const firstDaemon = new Daemon({ db, provider: firstProvider });
        let secondDaemon: Daemon | undefined;
        try {
            const workspaceId = await insertWorkspace(db, `recovery-orphans-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
            const sourceLoopId = await enqueueLoop(db, sessionId, "concluded source");
            for (const [index, content] of ["first orphan", "second orphan"].entries()) {
                const message = await db.drain_enqueue_message.get({ loop_id: sourceLoopId, source: `session://sender-${index + 1}`, body: content, open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
                assert.ok(message !== undefined, "the unfinished source admitted the message before forced termination");
            }
            await db.test_set_loop_status.run({
                id: sourceLoopId,
                status: 200,
                terminal_result: JSON.stringify({ status: 200 }),
            });

            const recovery = await db.drain_enqueue_orphan_recovery_loop.get<{
                id: number; sequence: number; message_count: number;
            }>({
                session_id: sessionId,
                orphan_source_loop_id: sourceLoopId,
            });
            assert.ok(recovery !== undefined);
            assert.equal(recovery.sequence, 2);
            if (staged === "messages") {
                const moved = await db.drain_rehome_orphaned_messages.run({
                    source_loop_id: sourceLoopId,
                    target_loop_id: recovery.id,
                });
                assert.equal(moved.changes, 2, "the prior process moved both messages before disappearing");
            }

            await firstDaemon.start();
            assert.equal(await waitForDb(
                async () => (await db.test_get_loop_status.get<{ status: number }>({ id: recovery.id }))?.status,
                (status) => status === 200,
            ), 200);
            const frames = (await db.test_log_entries_by_loop.all<{
                op: string; origin: string; tx: string; source: string | null;
            }>({ loop_id: recovery.id })).filter((row) => row.op === "SEND" && row.origin === "_plurnk");
            assert.deepEqual(
                frames.map((row) => ({
                    content: (JSON.parse(row.tx) as { body: { raw: string } }).body.raw,
                    source: row.source,
                })),
                [
                    { content: "first orphan", source: "session://sender-1" },
                    { content: "second orphan", source: "session://sender-2" },
                ],
                "boot completed the existing queued recovery before its drain claimed it",
            );
            const inbox = (await db.test_messages_by_loop.all({ loop_id: recovery.id })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
            assert.deepEqual(inbox.map(({ ordinal, body }) => ({ ordinal, body })), [{ ordinal: 1, body: "first orphan" }, { ordinal: 2, body: "second orphan" }], "the orphans moved into the recovery loop's inbox, renumbered");
            assert.ok(inbox.every(({ log_entry_id }) => log_entry_id !== null), "the recovery loop published them once");
            await firstDaemon.stop();

            const secondProvider = new Mock({
                contextWindow: 16384,
                responses: [makeMockResponse("````SEND [200]\nmust remain unused\n````")],
            });
            ProviderInstantiate.registerInstance(secondProvider, providerSpec);
            secondDaemon = new Daemon({ db, provider: secondProvider });
            await secondDaemon.start();
            const modelLoops = (await db.application_list_session_loops.all<{ prompt: string }>({
                session_id: sessionId,
            })).filter(({ prompt }) => prompt.length > 0);
            assert.equal(modelLoops.length, 2, "a later boot neither remints nor replays the completed recovery");
            assert.equal(secondProvider.remaining, 1, "no provider call was replayed");
        } finally {
            await secondDaemon?.stop();
            await firstDaemon.stop();
            await db.close();
        }
    });
}

test("{§session-causal-admission}: cancelled undelivered messages stay cancelled across restart", async () => {
    const db = await openMigrated();
    const mock = new Mock({ contextWindow: 65536, responses: [makeMockResponse("````SEND [200]\nMust not execute.\n````")] });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, "cancelled-prompt-recovery");
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "Original task.");
        await db.drain_enqueue_message.get({ loop_id: loopId, source: null, body: "A follow-up admitted before cancellation.", open_paths: "[]", evidence: "{}", address: null, opened_turn_id: null, opened_sequence: null });
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.cancelTree(sessionId, "Cancel the whole assignment.", true);
        await daemon.start();
        assert.equal(await lifecycle.status(loopId), 499);
        assert.equal((await db.test_loop_queue_by_session.all({ session_id: sessionId })).length, 1,
            "boot must not promote a cancelled prompt into fresh work");
        assert.equal(mock.received.length, 0);
        const inbox = (await db.test_messages_by_loop.all({ loop_id: loopId })) as Array<{ ordinal: number; body: string; log_entry_id: number | null }>;
        assert.deepEqual(inbox.filter(({ ordinal }) => ordinal > 1).map(({ body }) => body), ["A follow-up admitted before cancellation."],
            "cancellation preserves the message as evidence without executing it");
        assert.ok(inbox.every(({ log_entry_id }) => log_entry_id === null), "nothing was published");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const accepted of [false, true]) test(`{§proposal}: boot terminalizes interrupted ${accepted ? "accepted" : "undecided"} proposals without replay`, async () => {
    const db = await openMigrated();
    const first = new Daemon({ db, provider: null });
    const second = new Daemon({ db, provider: null });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-proposal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, undefined, "model");
        const loopId = await enqueueLoop(db, sessionId, "interrupted proposal");
        await db.engine_reclaim_queued_loop.run({ loop_id: loopId });
        const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 1,
            origin: "model",
            source: null,
            model_call_id: null,
            op: "EDIT",
            scheme: "workspace",
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
        if (accepted) await db.proposal_record_decision.run({
            log_entry_id: inserted.id, decision: "accept", resolver: "_plurnk", body: "approved replacement", outcome: null,
        });

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
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished");
        assert.equal(result?.problem?.status, 500);
        assert.match(result?.problem?.detail ?? "", accepted
            ? /after approval.*whether the effect completed is unknown.*not replayed/
            : /proposal.*process-local owner no longer exists/);
        const decision = await db.test_proposal_decision.get({ id: inserted.id });
        if (accepted) {
            assert.equal(decision?.decision, "accept");
            assert.equal(decision?.body, "approved replacement");
        } else assert.equal(decision, undefined, "restart never invents an approval decision");
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
        const rendered = await db.engine_render_log.all<{ sequence: number; op: string; state: string; status_rx: number }>({ session_id: sessionId });
        assert.ok(
            rendered.some((row) => row.sequence === 1 && row.op === "EDIT" && row.state === "failed" && row.status_rx === 500),
            "the reconciled operation is visible as a truthful failed occurrence",
        );

        await first.stop();
        await second.start();
        const recoveredAgain = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null; rx: string }>({ id: inserted.id });
        assert.deepEqual(recoveredAgain, recovered, "a later boot leaves the terminal occurrence unchanged");
        assert.deepEqual(await db.test_proposal_decision.get({ id: inserted.id }), decision);
    } finally {
        await Promise.allSettled([first.stop(), second.stop()]);
        await db.close();
    }
});

test("{§message-arrival} boot settles vanished owners and resumes the now-unblocked parent topology", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nparent observed the interrupted child\n````")],
    });
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    try {
        const workspaceId = await insertWorkspace(db, `recovery-topology-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "parent", "model");
        const childId = await insertSession(db, workspaceId, parentId, "child", "model");
        const parentLoopId = await enqueueLoop(db, parentId, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, { wakenBy: "test-fixture" }), true);
        const childLoopId = await enqueueLoop(db, childId, "interrupted child");
        await db.engine_reclaim_queued_loop.run({ loop_id: childLoopId });

        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "sh",
            pathname: "/interrupted",
            channel: "stdout",
            state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId: childId,
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
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/lifecycle/recovery/owner-vanished");
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

test("{§message-arrival} a child drain exception still propagates the parent wake edge", async () => {
    const db = await openMigrated();
    const mock = new Mock({
        contextWindow: 16384,
        responses: [makeMockResponse("````SEND [200]\nparent handled child failure\n````")],
    });
    const generate = mock.generate.bind(mock);
    let calls = 0;
    let childProviderIdentity = "";
    mock.generate = async (request) => {
        calls += 1;
        if (request.sessionId === childProviderIdentity) throw new Error("child provider failed");
        return generate(request);
    };
    ProviderInstantiate.registerInstance(mock, providerSpec);
    const daemon = new Daemon({ db, provider: mock });
    const realError = console.error;
    console.error = () => {};
    try {
        const workspaceId = await insertWorkspace(db, `recovery-child-error-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "parent", "model");
        const childId = await insertSession(db, workspaceId, parentId, "child", "model");
        childProviderIdentity = (await db.test_sessions_get_provider_identity.get<{
            provider_identity: string;
        }>({ id: childId }))?.provider_identity ?? "";
        assert.notEqual(childProviderIdentity, "", "the fixture addresses the failed child by its provider identity");
        const parentLoopId = await enqueueLoop(db, parentId, "wait for child");
        await db.engine_reclaim_queued_loop.run({ loop_id: parentLoopId });
        assert.equal(await new LoopLifecycle(db).park(parentLoopId, { wakenBy: "test-fixture" }), true);
        const childLoopId = await enqueueLoop(db, childId, "fail while running");

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
});

describe("Daemon.stop-pending-proposal", () => {
// {§session-causal-admission}: shutdown cancels a pending stopped-world proposal
// before awaiting its drain.

test("{§session-causal-admission}: Daemon.stop terminates with a pending proposal", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // A non-auto host execution proposes (202) and stops the world; nobody ever resolves it.
        makeMockResponse("\n````sh\necho pending\n````\n\n````NOTE\nproposed\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stop-pending" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "go" });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            // Leave the proposal UNRESOLVED — withDaemon's finally now runs daemon.stop against a
            // stopped world. The assertion IS this test completing: a deadlocked stop times out.
        } finally { ws.close(); }
    });
    assert.ok(true, "stop returned with a pending proposal outstanding");
});
});

describe("cancel-provenance", () => {
// {§loop-completion}, {§methods}: external cancellation is durable and explicit.

type LoopRow = { id: number; status: number; terminal_result: string | null; terminated_by: string | null };

const terminalResult = (row: LoopRow): {
    status: number;
    problem?: { detail?: string; reason?: string };
} => {
    assert.notEqual(row.terminal_result, null, "a terminal loop carries its exact result");
    return JSON.parse(row.terminal_result!) as {
        status: number;
        problem?: { detail?: string; reason?: string };
    };
};

test("{§turn-record}: cancellation during packet preparation completes the turn without inventing a provider failure", async (t) => {
    serverProposals(t, "accept");
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const build = PacketBuilder.prototype.buildRequestPacket;
    t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, ...args: Parameters<typeof build>) {
        // The initialization turn builds packets too ({§tokenomics}); the witness holds the inference turn's.
        if (args[0].currentTurnSeq > 1) {
            preparing.resolve();
            await release.promise;
        }
        return build.apply(this, args);
    });
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````")] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cancel-preparation" });
            const running = rpcCall(ws, 2, "loop.run", { prompt: "prepare a packet" });
            await preparing.promise;
            const cancelled = rpcCall(ws, 3, "loop.cancel", { reason: "cancel during preparation" });
            const loop = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find(({ status }) => status === 499),
                (row) => row !== undefined,
            );
            release.resolve();
            await cancelled;
            await running;
            const turns = await waitForDb(
                () => db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: loop!.id }),
                (rows) => rows.every(({ completed_at }) => completed_at !== null),
            );
            assert.equal(turns.find(({ kind }) => kind === "inference")?.status, 499);
            assert.equal(mock.received.length, 0, "cancelled preparation makes no provider request");
            assert.equal(terminalResult(loop!).problem?.reason, "cancel during preparation");
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loop!.id });
            assert.deepEqual(await db.test_error_rows_for_session.all({ session_id: session!.session_id }), [], "cancellation does not publish a provider failure");
        } finally { release.resolve(); ws.close(); }
    });
});

test("{§loop-completion}: cancelling a live loop records who and why", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 30\n````\n\n````NOTE\nrunning\n````"),
        makeMockResponse("````SEND [200]\ndone\n````"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-live" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job" });
            await waitForDb(
                async () => (await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" }))?.n ?? 0,
                (n) => n > 0,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "operator redirected the task" });
            // The ROW is the record: 499, provenanced, carrying the client's reason.
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 499),
                (l) => l !== undefined,
            );
            assert.equal(row!.terminated_by, "cancel", "the external act is named on the terminal record");
            assert.equal(terminalResult(row!).problem?.reason, "operator redirected the task", "the client's reason remains in the exact cancellation Problem");
            // The broadcast carries the same why.
            const notes = await waitFor(
                () => terminated() as Array<{ result: { status: number; problem?: {
                    type?: string;
                    detail?: string;
                    reason?: string;
                    stage?: string;
                    retryable?: boolean;
                } } }>,
                (ns) => ns.some((n) => n.result.status === 499),
            );
            const cancelled = notes.find((n) => n.result.status === 499);
            assert.equal(cancelled?.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
            assert.equal(cancelled?.result.problem?.detail, "The session scope was cancelled: operator redirected the task."); // {§operation-results}
            assert.equal(cancelled?.result.problem?.reason, "operator redirected the task");
            assert.equal(cancelled?.result.problem?.stage, "loop");
            assert.equal(cancelled?.result.problem?.retryable, false);
            const session = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: row!.id });
            assert.deepEqual(
                await db.test_error_rows_for_session.all({ session_id: session!.session_id }),
                [],
                "lifecycle cancellation never fabricates a provider failure",
            );
        } finally { ws.close(); }
    });
});

test("{§methods}: cancelling a parked loop terminalizes it", async (t) => {
    serverProposals(t, "accept");
    // A session parked on a live obligation has no active drain, so cancellation
    // terminalizes the durable 202 row directly.
    const previousSettlement = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    t.after(() => {
        if (previousSettlement === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousSettlement;
    });
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````sh\nsleep 30\n````\n\n````WAIT\nawaiting the slow job\n````"),
        makeMockResponse("````SEND [200]\ndone\n````"),
    ]});
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-parked" });
            const workspaceId = (created.result as { id: number }).id;
            void rpcCall(ws, 2, "loop.run", { prompt: "slow job" });
            // Parked: the loop row reaches 202 (the drain has exited by then).
            const parked = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.status === 202),
                (l) => l !== undefined,
            );
            await rpcCall(ws, 3, "loop.cancel", { reason: "shutting down the request" });
            const row = await waitForDb(
                async () => (await db.test_list_loops_all.all<LoopRow>({})).find((l) => l.id === parked!.id),
                (l) => l !== undefined && l.status !== 202,
            );
            assert.equal(row!.status, 499, "the parked loop went terminal — never a zombie 202");
            assert.equal(row!.terminated_by, "cancel");
            assert.equal(terminalResult(row!).problem?.reason, "shutting down the request");
            const sh = await db.test_count_open_subs_by_scheme.get<{ n: number }>({ workspace_id: workspaceId, scheme: "sh" });
            assert.ok(sh !== undefined, "workspace still readable"); // the reap itself is pinned elsewhere ({§notifications})
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: external cancellation terminalizes the durable subtree and emits each loop's turns", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "cancel-prov-tree" });
            const workspaceId = (created.result as { id: number }).id;
            const root = await insertSession(db, workspaceId, null, "root");
            const rootLoop = await insertLoop(db, root, 1, "root");
            const rootTurn = await insertTurn(db, rootLoop, 1, 102);
            const child = await insertSession(db, workspaceId, root, "child");
            const childLoop = await insertLoop(db, child, 1, "child");
            const childTurn = await insertTurn(db, childLoop, 1, 102);
            const grandchild = await insertSession(db, workspaceId, child, "grandchild");
            const grandchildLoop = await insertLoop(db, grandchild, 1, "grandchild");
            const grandchildTurn = await insertTurn(db, grandchildLoop, 1, 102);
            const terminated = subscribeNotifications(ws, "loop/terminated");

            assert.equal(daemon.cancelDrain(root, "operator cancelled the scope"), false,
                "no process-local drain was active; durable cancellation still proceeds");

            const rows = await waitForDb(
                () => db.test_list_loops_all.all<LoopRow>({}),
                (loops) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    loops.some((loop) => loop.id === id && loop.status === 499)),
            );
            for (const loopId of [rootLoop, childLoop, grandchildLoop]) {
                const row = rows.find(({ id }) => id === loopId);
                assert.ok(row);
                assert.equal(row?.terminated_by, "cancel");
                assert.equal(terminalResult(row).problem?.reason, "operator cancelled the scope");
            }

            const notes = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number }; turnIds: number[] }>,
                (events) => [rootLoop, childLoop, grandchildLoop].every((id) =>
                    events.some((event) => event.loopId === id && event.result.status === 499)),
            );
            assert.deepEqual(
                new Map(notes.map(({ loopId, turnIds }) => [loopId, turnIds])),
                new Map([
                    [rootLoop, [rootTurn]],
                    [childLoop, [childTurn]],
                    [grandchildLoop, [grandchildTurn]],
                ]),
                "each terminal event carries the turns belonging to that loop",
            );
        } finally { ws.close(); }
    });
});

for (const mode of ["immediate", "awaited"] as const) {
    test(`{§module-shutdown-order}: stop joins ${mode} cancellation before its final database read`, async (t) => {
        const collecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const mock = new Mock({ contextWindow: 16384, responses: [] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `cancel-stop-${mode}` });
            const sessionId = await insertSession(db, workspaceId, null, "cancelled");
            const loopId = await insertLoop(db, sessionId, 1, "cancel this task");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const events: Array<{ loopId: number; result: { status: number }; turnIds: number[] }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") {
                    events.push(params as typeof events[number]);
                    order.push("terminal event");
                }
            });
            const loopUsage = Engine.prototype.loopUsage;
            t.mock.method(Engine.prototype, "loopUsage", async function (this: Engine, id: number) {
                if (id === loopId) {
                    collecting.resolve();
                    await release.promise;
                    order.push("final database read");
                }
                return loopUsage.call(this, id);
            });
            const cancelSessionTree = DrainSupervisor.prototype.cancelSessionTree;
            let settlement: Promise<void> | undefined;
            t.mock.method(DrainSupervisor.prototype, "cancelSessionTree", function (this: DrainSupervisor, id: number, reason: string) {
                const result = cancelSessionTree.call(this, id, reason);
                if (id === sessionId) settlement = result;
                return result;
            });
            const cancellation = mode === "awaited"
                ? daemon.cancelSession({ workspaceId, sessionId, reason: "operator cancelled" })
                : daemon.cancelDrain(sessionId, "operator cancelled");
            if (mode === "immediate") assert.equal(cancellation, false, "no active drain does not mean no cancellation work");
            await collecting.promise;
            let stopped = false;
            const stopping = daemon.stop().then(() => { stopped = true; order.push("stopped"); });
            try {
                // A negative window: room for a stop that did not join the cancellation to finish. It can pass falsely on
                // a slow host, never fail falsely.
                await new Promise((resolve) => setTimeout(resolve, 50));
                assert.equal(stopped, false, "stop cannot authorize database closure while cancellation still uses it");
            } finally {
                release.resolve();
                await cancellation;
                await settlement;
                await stopping;
            }
            assert.deepEqual(order, ["final database read", "terminal event", "stopped"]);
            assert.deepEqual(events.map(({ loopId: id, result, turnIds }) => ({ loopId: id, status: result.status, turnIds })), [
                { loopId, status: 499, turnIds: [turnId] },
            ], "the durable cancellation is published once before shutdown completes");
        });
    });
}
});
