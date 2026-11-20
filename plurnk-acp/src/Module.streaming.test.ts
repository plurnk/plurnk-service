import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    ContentBlock,
    methods,
    PlanUpdateContent,
    PROTOCOL_VERSION,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
    Validator,
    type Notice,
    type ReasoningEventNotification,
} from "@plurnk/plurnk-contracts";
import SessionTranslator from "./SessionTranslator.ts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    makeLogEntry,
    makeTerminatedEvent,
    waitFor,
} from "../test/harness.ts";

describe("{§acp-event-translation} plurnk-acp streaming & projection", { concurrency: true }, () => {
    test("{§acp-plurnk-metadata} {§acp-body-reference} {§acp-status-descendants} {§acp-action-binding} {§acp-topology-scope}: event projection for thoughts, tool calls, diffs, terminals, subagents, notices, and entry route", async () => {
        const h = await createHarness();
        try {
            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                const session = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                assert.ok(session.configOptions);

                const reasoningEvent: ReasoningEventNotification = {
                    sessionId: 1,
                    loopId: 1,
                    turnId: 1,
                    loopSeq: 1,
                    turnSeq: 1,
                    modelCallId: 1,
                    requestSequence: 1,
                    phase: "content",
                    delta: "Thinking step 1...",
                };
                h.port.emitEvent(1, "reasoning/event", reasoningEvent);

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 10,
                        session_id: 1,
                        sequence: 2,
                        op: "edit",
                        tx: { op: "edit", aside: "update x" },
                        attrs: {
                            path: "/workspace/alpha/file.ts",
                            original: "const x = 1;\n",
                            patched: "const x = 2;\n",
                        },
                        rx: { status: 200, content: "const x = 2;\n", mimetype: "text/plain" },
                    }),
                });

                h.port.entryContents.set("exec:///sh/00000011#stdout", "hi\n");
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 11,
                        session_id: 1,
                        sequence: 3,
                        op: "sh",
                        status_rx: 202,
                        tx: { op: "sh", aside: "echo hi" },
                        attrs: { tag: "sh", body: "echo hi", stream: "exec:///sh/00000011" },
                        rx: { status: 202, content: "", mimetype: "text/plain" },
                    }),
                });
                h.port.emitEvent(1, "stream/event", {
                    sessionId: 1,
                    entryId: 11,
                    target: "exec:///sh/00000011",
                    channel: "stdout",
                    state: "active",
                    contentLength: 3,
                });
                h.port.emitEvent(1, "stream/concluded", {
                    sessionId: 1,
                    entryId: 11,
                    target: "exec:///sh/00000011",
                    result: { status: 200 },
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 12,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 1,
                        origin: "_plurnk",
                        op: "read",
                        source: "exec:///sh/00000011",
                        attrs: { invocation: "1/1/3" },
                        rx: { status: 200, content: "hi\n", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 13,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 2,
                        op: "error",
                        status_rx: 400,
                        attrs: { attempt: { verb: "read", text: "plurnk.read(bad)" } },
                        rx: { status: 400, content: "Refused read", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 15,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 3,
                        op: "note",
                        tx: { op: "note", aside: "fact", body: "Observed invariant." },
                        rx: { status: 200, content: "Observed invariant.", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 16,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 4,
                        op: "sh",
                        status_rx: 202,
                        tx: { op: "sh", aside: "run background watcher" },
                        attrs: { tag: "sh", body: "watch", stream: "exec:///sh/00000016" },
                        rx: { status: 202, content: "", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 17,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 5,
                        op: "work",
                        status_rx: 200,
                        attrs: { session: "helper", message: "message://helper/1" },
                        rx: { status: 200, content: "", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 18,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 6,
                        op: "wait",
                        status_rx: 202,
                        attrs: { waiting: 30 },
                        rx: { status: 202, content: "", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 19,
                        session_id: 1,
                        turn_seq: 3,
                        sequence: 1,
                        origin: "_plurnk",
                        op: "send",
                        source: "session://helper",
                        answering: "log:///1/2/5/work",
                        attrs: { body: "Intermediate progress" },
                        rx: { status: 200, content: "Intermediate progress", mimetype: "text/markdown" },
                    }),
                });

                const notice: Notice = {
                    source: "acp",
                    kind: "test-notice",
                    level: "warn",
                    message: "Watch out",
                };
                h.port.emitEvent(1, "notice/event", { notice });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 20,
                        session_id: 1,
                        turn_seq: 3,
                        sequence: 2,
                        op: "note",
                        tx: { op: "note", aside: "Plan", body: "Next steps." },
                        rx: { status: 200, content: "Next steps.", mimetype: "text/plain" },
                    }),
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 21,
                        session_id: 1,
                        loop_id: 3,
                        loop_seq: 2,
                        turn_id: 4,
                        turn_seq: 1,
                        sequence: 1,
                        op: "sh",
                        status_rx: 202,
                        tx: { op: "sh", aside: "ephemeral check" },
                        attrs: { tag: "sh", body: "check", stream: "exec:///sh/00000021" },
                        rx: { status: 202, content: "", mimetype: "text/plain" },
                    }),
                });
                h.port.emitEvent(1, "loop/packet", {
                    sessionId: 1,
                    loopId: 3,
                    loopSeq: 2,
                    packetCount: 1,
                    gauge: {
                        curationWeight: 420,
                        curationBudget: 4000,
                        contextTokens: 840,
                        contextCapacity: 8000,
                    },
                });

                h.port.sessions.push({
                    id: 2,
                    workspaceId: 1,
                    name: "helper",
                    created_at: "2026-10-25T00:00:00.000Z",
                    origin: "model",
                    owner: "acp://operator",
                    parentSessionId: 1,
                    kind: "work",
                    lifecycle: "running",
                    archived_at: null,
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 14,
                        session_id: 2,
                        session_name: "helper",
                        loop_id: 2,
                        turn_id: 2,
                        op: "send",
                        attrs: { kind: "message", to: "session://user", body: "Child progress" },
                        rx: { status: 200, content: "Child progress", mimetype: "text/markdown" },
                        mimetype_rx: "text/markdown",
                    }),
                });
                h.port.emitEvent(1, "notice/event", {
                    sessionId: 2,
                    loopId: 2,
                    notice: {
                        source: "engine:lifecycle",
                        kind: "loop_status",
                        level: "info",
                        status: 102,
                        loopId: 2,
                        loopSeq: 1,
                    },
                });
                h.port.emitEvent(1, "notice/event", {
                    sessionId: 2,
                    loopId: 2,
                    notice: {
                        source: "engine:turn",
                        kind: "turn_generated",
                        level: "info",
                    },
                });
                h.port.emitEvent(1, "loop/packet", {
                    sessionId: 1,
                    loopId: 1,
                    loopSeq: 1,
                    packetCount: 1,
                    gauge: {
                        curationWeight: 420,
                        curationBudget: 4000,
                        contextTokens: 840,
                        contextCapacity: 8000,
                    },
                });
                h.port.emitEvent(
                    1,
                    "loop/terminated",
                    makeTerminatedEvent({ sessionId: 2, loopId: 2 }),
                );

                await ctx.notify(methods.agent.session.cancel, {
                    sessionId: "1#helper",
                });

                await waitFor(
                    () =>
                        updates.some((u) => u.sessionUpdate === "usage_update") &&
                        updates.some(
                            (u) =>
                                u.sessionUpdate === "_plurnk_telemetry" &&
                                (u._meta as { plurnk?: { status?: { spend?: unknown } } } | undefined)?.plurnk?.status
                                    ?.spend !== undefined,
                        ) &&
                        updates.some(
                            (u) =>
                                u.sessionUpdate === "subagent_update" &&
                                u.sessionId === "1#helper" &&
                                (u.state as { state?: string } | undefined)?.state === "idle",
                        ),
                );

                assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "tool_call_update" &&
                            Array.isArray(u.content) &&
                            u.content.some((c: { type?: string }) => c.type === "diff"),
                    ),
                );
                assert.ok(updates.some((u) => u.sessionUpdate === "terminal_update"));
                assert.ok(updates.some((u) => u.sessionUpdate === "terminal_output_chunk"));
                const chunkIdx = updates.findIndex((u) => u.sessionUpdate === "terminal_output_chunk");
                const shCompletedIdx = updates.findIndex(
                    (u) =>
                        u.sessionUpdate === "tool_call_update" &&
                        u.toolCallId === "1/1/3" &&
                        u.status === "completed",
                );
                assert.ok(
                    chunkIdx >= 0 && shCompletedIdx > chunkIdx,
                    "terminal_output_chunk must arrive before the concluding completed tool_call_update",
                );
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "tool_call_update" &&
                            u.toolCallId === "1/2/5" &&
                            u.name === "work" &&
                            u.status === "completed" &&
                            Array.isArray(u.locations) &&
                            (u.locations[0] as { path?: string } | undefined)?.path === "session://helper",
                    ),
                );
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "tool_call_update" &&
                            u.toolCallId === "1/2/6" &&
                            u.name === "wait" &&
                            u.status === "completed",
                    ),
                );
                assert.ok(
                    updates.some((u) => {
                        if (u.sessionUpdate !== "user_message_chunk") return false;
                        const plurnk = (u._meta as { plurnk?: { answering?: string; source?: string } } | undefined)?.plurnk;
                        return plurnk?.answering === "log:///1/2/5/work" && plurnk?.source === "session://helper";
                    }),
                );
                assert.ok(updates.some((u) => u.sessionUpdate === "notice"));
                const planSnapshots = updates
                    .filter((u) => SessionUpdate.isPlanUpdate(u) && PlanUpdateContent.isItems(u.plan))
                    .map((u) => (u as Extract<typeof u, { sessionUpdate: "plan_update" }>).plan);
                assert.ok(
                    planSnapshots.some(
                        (plan) =>
                            PlanUpdateContent.isItems(plan) &&
                            plan.planId === "plan" &&
                            plan.entries.length === 3 &&
                            plan.entries[0]?.content === "update x" &&
                            plan.entries[0]?.status === "completed" &&
                            plan.entries[1]?.content === "echo hi" &&
                            plan.entries[1]?.status === "completed" &&
                            plan.entries[2]?.content === "run background watcher" &&
                            plan.entries[2]?.status === "in_progress",
                    ),
                    "active stream tool aside enters plan_update as in_progress while fact/Plan note asides are excluded",
                );
                assert.ok(
                    planSnapshots.some(
                        (plan) =>
                            PlanUpdateContent.isItems(plan) &&
                            plan.planId === "plan" &&
                            plan.entries.length === 2 &&
                            plan.entries[0]?.content === "update x" &&
                            plan.entries[0]?.status === "completed" &&
                            plan.entries[1]?.content === "echo hi" &&
                            plan.entries[1]?.status === "completed",
                    ),
                    "advancing to turn 3 discards the prior turn's unresolved in_progress entry",
                );
                assert.ok(
                    planSnapshots.every(
                        (plan) =>
                            !PlanUpdateContent.isItems(plan) ||
                            plan.entries.every((e) => !/^(?:fact|idea|plan)$/iu.test(e.content)),
                    ),
                    "fact/idea/plan note asides never appear in plan_update",
                );
                assert.ok(
                    updates.some(
                        (u) => SessionUpdate.isPlanRemoved(u) && u.planId === "plan",
                    ),
                    "pruning a loop whose only plan entry was in_progress emits plan_removed",
                );
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "subagent_update" &&
                            u.sessionId === "1#helper" &&
                            (u.capabilities as { cancel?: unknown } | undefined)?.cancel !== undefined,
                    ),
                );
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "subagent_update" &&
                            u.sessionId === "1#helper" &&
                            (u.state as { state?: string } | undefined)?.state === "idle" &&
                            (u.capabilities as { cancel?: unknown } | undefined)?.cancel !== undefined,
                    ),
                );
                assert.ok(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "session_message" &&
                            u.senderSessionId === "1#helper" &&
                            u.recipientSessionId === "1#user",
                    ),
                );
                assert.ok(
                    updates.some((u) => {
                        if (u.sessionUpdate !== "usage_update") return false;
                        const plurnk = (
                            u._meta as
                                | {
                                      plurnk?: {
                                          budget?: Record<string, unknown>;
                                          status?: Record<string, unknown>;
                                      };
                                  }
                                | undefined
                        )?.plurnk;
                        return (
                            plurnk?.budget?.curationWeight === 420 &&
                            plurnk?.budget?.curationBudget === 4000 &&
                            plurnk?.budget?.contextTokens === 840 &&
                            plurnk?.budget?.contextCapacity === 8000 &&
                            plurnk?.status?.loopSeq === 1 &&
                            plurnk?.status?.packetCount === 1 &&
                            plurnk?.status?.spend !== undefined
                        );
                    }),
                );
                assert.equal(
                    updates.some(
                        (u) =>
                            u.sessionUpdate === "notice" &&
                            (u.title === "engine:lifecycle:loop_status" || u.title === "engine:turn:turn_generated"),
                    ),
                    false,
                    "session-scoped notices for child session 2 must never leak directly to parent session 1",
                );

                // Resuming a parked session emits engine:lifecycle:loop_status (status 202) and status.lifecycle === "parked"
                const origListLoops = h.port.listSessionLoops.bind(h.port);
                h.port.listSessionLoops = async ({ sessionId }) => [
                    {
                        id: 7,
                        sessionId,
                        sequence: 7,
                        status: 202,
                        prompt: "Parked loop",
                        promptSource: "acp://operator/sessions/1%23user/messages/msg-7",
                        claimedAt: "2026-10-25T00:00:00.000Z",
                        terminatedAt: null,
                        terminalResult: null,
                        packetCount: 3,
                        waitUntil: 1700000010000,
                        invocation: null,
                    },
                ];
                try {
                    const beforeParkedResume = updates.length;
                    const parkedResumed = await ctx.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });
                    const parkedStatus = (
                        parkedResumed._meta as { plurnk?: { status?: Record<string, unknown> } } | undefined
                    )?.plurnk?.status;
                    assert.equal(parkedStatus?.lifecycle, "parked");
                    assert.equal(parkedStatus?.loopId, 7);
                    assert.equal(parkedStatus?.loopSeq, 7);
                    assert.equal(parkedStatus?.packetCount, 3);
                    assert.equal(parkedStatus?.waitUntil, 1700000010000);
                    await waitFor(() =>
                        updates.slice(beforeParkedResume).some(
                            (u) =>
                                u.sessionUpdate === "state_update" &&
                                u.state === "running" &&
                                (
                                    u._meta as
                                        | { plurnk?: { status?: { lifecycle?: unknown }; notice?: { kind?: unknown; status?: unknown } } }
                                        | undefined
                                )?.plurnk?.status?.lifecycle === "parked",
                        ),
                    );
                    assert.equal(
                        updates.slice(beforeParkedResume).some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                        false,
                        "resuming a parked session must not emit a bogus idle state_update",
                    );
                } finally {
                    h.port.listSessionLoops = origListLoops;
                }

                const entryUrl = `${h.baseUrl}/1/1/entry?target=${encodeURIComponent("log:///1/1/2/edit")}`;
                const entryRes = await fetch(entryUrl);
                assert.equal(entryRes.status, 200);
                assert.equal(await entryRes.text(), "Body for log:///1/1/2/edit");

                const missingTarget = await fetch(`${h.baseUrl}/1/1/entry`);
                assert.equal(missingTarget.status, 400);

                // Cancelled termination without a calibrated turn omits fabricated usage_update and duplicate notice
                const beforeCount = updates.length;
                h.port.emitEvent(
                    1,
                    "loop/terminated",
                    makeTerminatedEvent({
                        sessionId: 1,
                        loopId: 9,
                        loopSeq: 9,
                        turnIds: [],
                        result: {
                            status: 499,
                            problem: {
                                type: "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled",
                                title: "Session scope cancelled",
                                status: 499,
                                detail: "The session scope was cancelled: Cancelled by ACP client.",
                            },
                        },
                        usage: {
                            curationWeight: null,
                            curationBudget: null,
                            contextTokens: null,
                            contextCapacity: null,
                            accounting: {
                                requests: [],
                                knownUsage: null,
                                knownCostUsd: null,
                                usage: { inputTokens: 0, outputTokens: 0 },
                                costUsd: null,
                            },
                            meta: {},
                        },
                    }),
                );
                await waitFor(() =>
                    updates.slice(beforeCount).some(
                        (u) => u.sessionUpdate === "state_update" && u.state === "idle",
                    ),
                );
                const cancelledUpdates = updates.slice(beforeCount);
                assert.equal(
                    cancelledUpdates.filter((u) => u.sessionUpdate === "notice").length,
                    0,
                    "terminated problem is carried on state_update without a duplicate notice",
                );
                assert.equal(
                    cancelledUpdates.filter((u) => u.sessionUpdate === "usage_update").length,
                    0,
                    "uncalibrated cancellation omits fabricated 0/128k usage_update",
                );
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-plurnk-metadata} {§acp-history-window}: SessionTranslator correlates stream conclusion by target across entryId namespaces, settles raced logEntry, and closes replayed final-turn streams (#1378)", () => {
        const translator = new SessionTranslator({
            acpSessionId: "1#user",
            workspaceId: 1,
            sessionId: 1,
        });

        // 1. logEntry (log_entries.id = 500) followed by terminalConcluded (entries.id = 42) matched via meta.target
        const startUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 500,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 3,
                origin: "model",
                op: "gitea",
                state: "resolved",
                status_rx: 202,
                pathname: "list_my_repos",
                tx: JSON.stringify({ target: { raw: "list_my_repos" }, aside: "List repos" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "gitea://1", aside: "List repos" }),
            }),
        });
        assert.equal(startUpdates[0]?.update.sessionUpdate, "tool_call_update");
        if (startUpdates[0]?.update.sessionUpdate === "tool_call_update") {
            assert.equal(startUpdates[0].update.toolCallId, "1/1/3");
            assert.equal(startUpdates[0].update.status, "in_progress");
        }

        const concludedUpdates = translator.terminalConcluded(42, 200, {
            sessionId: 1,
            target: "gitea://1",
        });
        assert.equal(concludedUpdates.length, 3);
        assert.equal(concludedUpdates[1]?.update.sessionUpdate, "tool_call_update");
        if (concludedUpdates[1]?.update.sessionUpdate === "tool_call_update") {
            assert.equal(concludedUpdates[1].update.toolCallId, "1/1/3");
            assert.equal(concludedUpdates[1].update.status, "completed");
        }
        assert.equal(concludedUpdates[2]?.update.sessionUpdate, "plan_update");

        // 2. Raced order: terminalConcluded (entries.id = 43, target = "exec:///sh/00000002") arrives BEFORE logEntry (log_entries.id = 501)
        const preConcluded = translator.terminalConcluded(43, 200, {
            sessionId: 1,
            target: "exec:///sh/00000002",
        });
        assert.equal(preConcluded.length, 1);
        const racedLogUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 501,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 4,
                origin: "model",
                op: "sh",
                state: "resolved",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo fast", aside: "Fast command" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/00000002", aside: "Fast command" }),
            }),
        });
        assert.equal(racedLogUpdates[0]?.update.sessionUpdate, "tool_call_update");
        if (racedLogUpdates[0]?.update.sessionUpdate === "tool_call_update") {
            assert.equal(racedLogUpdates[0].update.toolCallId, "1/1/4");
            assert.equal(racedLogUpdates[0].update.status, "completed");
        }

        // 3. Replay closes final-turn stream when openStreamTargets does not include its target
        const replayTranslator = new SessionTranslator({
            acpSessionId: "1#user",
            workspaceId: 1,
            sessionId: 1,
        });
        replayTranslator.reasoning({
            sessionId: 1,
            loopId: 2,
            loopSeq: 2,
            turnId: 2,
            turnSeq: 1,
            modelCallId: 9,
            requestSequence: 1,
            phase: "content",
            delta: "Considering sh.",
        });
        const replayed = SessionTranslator.replay(
            replayTranslator,
            [
                makeLogEntry({
                    id: 600,
                    session_id: 1,
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "model",
                    op: "sh",
                    state: "resolved",
                    status_rx: 202,
                    reasoning: "Considering sh.",
                    tx: JSON.stringify({ body: "echo done" }),
                    rx: JSON.stringify({ status: 202 }),
                    attrs: JSON.stringify({ stream: "exec:///sh/00000009" }),
                }),
            ],
            [],
            { openStreamTargets: new Set() },
        );
        assert.equal(
            replayed.some((u) => u.update.sessionUpdate === "agent_thought_chunk"),
            true,
            "replay must emit agent_thought_chunk even when live reasoning was previously streamed on the same translator",
        );
        const completedToolUpdate = replayed.find(
            (u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
        );
        assert.ok(completedToolUpdate, "replay must emit completed tool_call_update when stream is not in openStreamTargets");
    });

    test("{§acp-action-binding} {§acp-plurnk-metadata} {§acp-status-descendants} {§acp-history-window}: preserves empty supportedEfforts, projects verb-less error and emissionAttempt notices, normalizes wildcard Host origins and loop epoch timestamps, and replays cancelled unobserved inbox messages (#1380 #1384 #1386 #1387)", async () => {
        const translator = new SessionTranslator({
            acpSessionId: "1#user",
            workspaceId: 1,
            sessionId: 1,
            origin: "http://127.0.0.1:1066",
        });

        // 1. Verb-less error row projects to notice (#1384)
        const errorUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 700,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 2,
                origin: "model",
                source: "grammar",
                op: "error",
                state: "failed",
                status_rx: 400,
                rx: JSON.stringify({
                    status: 400,
                    problem: {
                        type: "https://problems.plurnk.xyz/grammar:parser/invalid-expression-syntax",
                        title: "Invalid Expression Syntax",
                        detail: "Unrecognized heading.",
                    },
                }),
                attrs: JSON.stringify({}),
            }),
        });
        assert.equal(errorUpdates.length, 1);
        assert.equal(errorUpdates[0]?.update.sessionUpdate, "notice");
        if (errorUpdates[0]?.update.sessionUpdate === "notice") {
            assert.equal(errorUpdates[0].update.severity, "warning");
            assert.equal(errorUpdates[0].update.title, "grammar:error");
            assert.equal(errorUpdates[0].update.description, "Unrecognized heading.");
            const grammarNotice = (errorUpdates[0].update._meta as { plurnk?: { notice?: unknown } } | undefined)
                ?.plurnk?.notice;
            assert.equal(Validator.assertNotice(grammarNotice).level, "warn");
        }

        // 1b. Error-row matrix across provider strikes, provider retries, terminal provider faults, and engine rails (#1478)
        const providerStrikeUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 710,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 2,
                turn_seq: 2,
                sequence: 1,
                origin: "_plurnk",
                source: "provider",
                op: "error",
                state: "failed",
                status_rx: 502,
                rx: JSON.stringify({
                    status: 502,
                    problem: {
                        type: "https://problems.plurnk.xyz/providers/generation-failed",
                        title: "Generation Failed",
                        detail: "The provider ended generation with an error (MALFORMED_FUNCTION_CALL).",
                        providerKind: "generation_failed",
                    },
                }),
                attrs: JSON.stringify({}),
            }),
        });
        assert.equal(providerStrikeUpdates.length, 1);
        if (providerStrikeUpdates[0]?.update.sessionUpdate === "notice") {
            assert.equal(providerStrikeUpdates[0].update.severity, "warning");
            assert.equal(providerStrikeUpdates[0].update.title, "provider:error");
            assert.equal(
                providerStrikeUpdates[0].update.description,
                "The provider ended generation with an error (MALFORMED_FUNCTION_CALL).",
            );
            const strikeNotice = (
                providerStrikeUpdates[0].update._meta as { plurnk?: { notice?: unknown } } | undefined
            )?.plurnk?.notice;
            const checkedStrikeNotice = Validator.assertNotice(strikeNotice);
            assert.equal(checkedStrikeNotice.source, "provider");
            assert.equal(checkedStrikeNotice.level, "warn");
        }

        const providerRetryEntry = makeLogEntry({
            id: 711,
            session_id: 1,
            loop_id: 1,
            loop_seq: 1,
            turn_id: 2,
            turn_seq: 2,
            sequence: 2,
            origin: "_plurnk",
            source: "provider",
            op: "error",
            state: "failed",
            status_rx: 429,
            rx: JSON.stringify({
                status: 429,
                problem: {
                    type: "https://problems.plurnk.xyz/providers/rate-limit",
                    title: "Rate Limit",
                    detail: "Provider rate limit exceeded.",
                    providerKind: "rate_limit",
                },
            }),
            attrs: JSON.stringify({ retry: true }),
        });
        assert.deepEqual(translator.logEntry({ entry: providerRetryEntry }), []);

        const providerTerminalUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 712,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 2,
                turn_seq: 2,
                sequence: 3,
                origin: "_plurnk",
                source: "provider",
                op: "error",
                state: "failed",
                status_rx: 401,
                rx: JSON.stringify({
                    status: 401,
                    problem: {
                        type: "https://problems.plurnk.xyz/providers/unauthorized",
                        title: "Unauthorized",
                        detail: "The provider rejected the configured credentials.",
                        providerKind: "unauthorized",
                    },
                }),
                attrs: JSON.stringify({}),
            }),
        });
        assert.equal(providerTerminalUpdates.length, 1);
        if (providerTerminalUpdates[0]?.update.sessionUpdate === "notice") {
            assert.equal(providerTerminalUpdates[0].update.severity, "error");
            assert.equal(providerTerminalUpdates[0].update.title, "provider:error");
            const termNotice = (
                providerTerminalUpdates[0].update._meta as { plurnk?: { notice?: unknown } } | undefined
            )?.plurnk?.notice;
            assert.equal(Validator.assertNotice(termNotice).level, "error");
        }

        const railMaxCommandsUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 713,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 2,
                turn_seq: 2,
                sequence: 4,
                origin: "_plurnk",
                source: "rail",
                op: "error",
                state: "failed",
                status_rx: 429,
                rx: JSON.stringify({
                    status: 429,
                    problem: {
                        type: "https://problems.plurnk.xyz/engine/rail/max-commands-exceeded",
                        title: "Max Commands Exceeded",
                        detail: "The turn exceeded the configured operation limit.",
                    },
                }),
                attrs: JSON.stringify({}),
            }),
        });
        assert.equal(railMaxCommandsUpdates.length, 1);
        if (railMaxCommandsUpdates[0]?.update.sessionUpdate === "notice") {
            assert.equal(railMaxCommandsUpdates[0].update.severity, "warning");
            assert.equal(railMaxCommandsUpdates[0].update.title, "rail:error");
            const railNotice = (
                railMaxCommandsUpdates[0].update._meta as { plurnk?: { notice?: unknown } } | undefined
            )?.plurnk?.notice;
            assert.equal(Validator.assertNotice(railNotice).level, "warn");
        }

        const noOperationEntry = makeLogEntry({
            id: 714,
            session_id: 1,
            loop_id: 1,
            loop_seq: 1,
            turn_id: 2,
            turn_seq: 2,
            sequence: 5,
            origin: "_plurnk",
            source: "rail",
            op: "error",
            state: "failed",
            status_rx: 422,
            rx: JSON.stringify({
                status: 422,
                problem: {
                    type: "https://problems.plurnk.xyz/engine/rail/no-operation",
                    title: "No Operation",
                    detail: "The turn performed no operation.",
                },
            }),
            attrs: JSON.stringify({}),
        });
        assert.deepEqual(translator.logEntry({ entry: noOperationEntry }), []);
        assert.deepEqual(
            [...SessionTranslator.replay(translator, [providerRetryEntry, noOperationEntry])],
            [],
        );

        // 2. Actionless emissionAttempt row (op === null) projects to notice with /attempt body link (#1384)
        const attemptUpdates = translator.logEntry({
            entry: makeLogEntry({
                id: 701,
                session_id: 1,
                loop_id: 1,
                loop_seq: 1,
                turn_id: 1,
                turn_seq: 1,
                sequence: 3,
                origin: "model",
                op: null,
                state: "resolved",
                status_rx: 200,
                tx: "",
                rx: JSON.stringify({ content: "raw rejected bytes", mimetype: "text/vnd.plurnk" }),
                attrs: JSON.stringify({ kind: "emissionAttempt" }),
            }),
        });
        assert.equal(attemptUpdates.length, 1);
        assert.equal(attemptUpdates[0]?.update.sessionUpdate, "notice");
        if (attemptUpdates[0]?.update.sessionUpdate === "notice") {
            assert.equal(attemptUpdates[0].update.title, "emissionAttempt");
            const meta = (attemptUpdates[0].update._meta as { plurnk?: { body?: { url?: string } } } | undefined)
                ?.plurnk;
            assert.equal(
                meta?.body?.url,
                `http://127.0.0.1:1066/acp/1/1/entry?target=${encodeURIComponent("log:///1/1/3/attempt")}`,
            );
        }

        // 3. replaySessionHistory retains cancelled unobserved inbox messages while deduplicating published ones (#1387)
        const replayed = SessionTranslator.replay(
            translator,
            [
                makeLogEntry({
                    id: 702,
                    session_id: 1,
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "_plurnk",
                    source: "acp://operator/sessions/1%23user/messages/msg-published",
                    op: "send",
                    state: "resolved",
                    status_rx: 200,
                    tx: JSON.stringify({ body: "Already published" }),
                    rx: JSON.stringify({ status: 200 }),
                    attrs: JSON.stringify({ kind: "message" }),
                }),
            ],
            [
                {
                    path: "message://user/msg-cancelled",
                    source: "acp://operator/sessions/1%23user/messages/msg-cancelled",
                    body: "Stopped before turn 1",
                    loopId: 2,
                    lifecycle: "cancelled",
                },
                {
                    path: "message://user/msg-published",
                    source: "acp://operator/sessions/1%23user/messages/msg-published",
                    body: "Already published",
                    loopId: 1,
                    lifecycle: "cancelled",
                },
            ],
        );
        const cancelledChunk = replayed.find(
            (u) => u.update.sessionUpdate === "user_message_chunk" && u.update.messageId === "msg-cancelled",
        );
        assert.ok(cancelledChunk, "cancelled unobserved inbox message must be replayed");
        assert.equal(
            (cancelledChunk?.update._meta as { plurnk?: { lifecycle?: string; published?: boolean } } | undefined)
                ?.plurnk?.lifecycle,
            "cancelled",
        );
        assert.equal(
            (cancelledChunk?.update._meta as { plurnk?: { published?: boolean } } | undefined)?.plurnk?.published,
            false,
        );
        const publishedChunks = replayed.filter(
            (u) => u.update.sessionUpdate === "user_message_chunk" && u.update.messageId === "msg-published",
        );
        assert.equal(publishedChunks.length, 1, "already-published message must not be duplicated from inbox");

        // 4. Wildcard listener Host origin & epoch-ms loop timestamps & empty supportedEfforts (#1380 #1386)
        const h = await createHarness();
        try {
            const addr = h.port.httpAddress();
            h.port.httpAddress = () => ({ host: "0.0.0.0", port: addr.port });
            h.port.readSessionEffort = async () => ({
                effort: "medium",
                source: "default",
                supportedEfforts: [],
            });
            const ws = new WebSocket(h.wsUrl.replace("127.0.0.1", "localhost"));
            await new Promise<void>((resolve, reject) => {
                ws.onopen = () => resolve();
                ws.onerror = () => reject(new Error("WebSocket error"));
            });
            const sendRpc = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
                new Promise((resolve, reject) => {
                    const prev = ws.onmessage;
                    ws.onmessage = (ev: MessageEvent) => {
                        const rawText = typeof ev.data === "string" ? ev.data : String(ev.data);
                        const parsed = JSON.parse(rawText) as {
                            id?: number;
                            result?: Record<string, unknown>;
                            error?: { message: string };
                        };
                        if (parsed.id !== id) return;
                        ws.onmessage = prev;
                        if (parsed.error) reject(new Error(parsed.error.message));
                        else resolve(parsed.result ?? {});
                    };
                    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
                });

            await sendRpc(1, "initialize", {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "raw-rpc-test", version: "1.0.0" },
            });
            await sendRpc(2, "session/new", { cwd: "/workspace/alpha" });
            const listed = await sendRpc(3, "session/list", { cwd: "/workspace/alpha" });
            const firstSession = (
                listed.sessions as Array<{ _meta?: { plurnk?: { reply?: { body?: { url?: string } } } } }>
            )[0];
            assert.ok(
                firstSession?._meta?.plurnk?.reply?.body?.url?.startsWith(`http://localhost:${addr.port}/acp/`),
                `expected localhost origin from Host header, got ${firstSession?._meta?.plurnk?.reply?.body?.url}`,
            );

            const resumed = await sendRpc(4, "session/resume", {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            const configOptions = resumed.configOptions as Array<{
                configId: string;
                options?: unknown[];
            }>;
            const thoughtOpt = configOptions.find((o) => o.configId === "thought_level");
            assert.deepEqual(thoughtOpt?.options, [], "supportedEfforts: [] must not fabricate fallback efforts");

            const status = (resumed._meta as { plurnk?: { status?: { claimedAt?: unknown; terminatedAt?: unknown } } })
                ?.plurnk?.status;
            assert.equal(status?.claimedAt, Date.parse("2026-10-25T00:00:00.000Z"));
            assert.equal(status?.terminatedAt, Date.parse("2026-10-25T00:00:01.000Z"));

            // 5. workspace.archive, workspace.list includeArchived, session/archive, session/unarchive, session/set_title, session/status, auth/status, and live reasoning/inbox entry URLs (#1388, #1396)
            const wsCreated = await sendRpc(5, "_plurnk/action", {
                kind: "workspace.create",
                params: { name: "ws-to-archive" },
            });
            const archivedWsId = wsCreated.id as number;
            const wsArchived = await sendRpc(6, "_plurnk/action", {
                kind: "workspace.archive",
                params: { workspaceId: archivedWsId },
            });
            assert.equal(wsArchived.id, archivedWsId);
            assert.equal(typeof wsArchived.archivedAt, "string");

            const listedDefault = await sendRpc(7, "_plurnk/action", {
                kind: "workspace.list",
                params: {},
            });
            assert.ok(
                !(listedDefault.workspaces as Array<{ id: number }>).some((w) => w.id === archivedWsId),
                "workspace.list omits archived workspaces by default",
            );

            const listedWithArchived = await sendRpc(8, "_plurnk/action", {
                kind: "workspace.list",
                params: { includeArchived: true },
            });
            assert.ok(
                (listedWithArchived.workspaces as Array<{ id: number }>).some((w) => w.id === archivedWsId),
                "workspace.list includes archived workspaces when includeArchived: true",
            );

            const wsUnarchived = await sendRpc(9, "_plurnk/action", {
                kind: "workspace.archive",
                params: { workspaceId: archivedWsId, archived: false },
            });
            assert.equal(wsUnarchived.archivedAt, null);

            await sendRpc(10, "session/archive", { sessionId: "1#user" });
            const wsSessionsDefault = await sendRpc(101, "_plurnk/action", {
                kind: "workspace.sessions",
                workspace: "alpha",
                params: {},
            });
            assert.ok(
                !(wsSessionsDefault.sessions as Array<{ name: string }>).some((s) => s.name === "user"),
                "workspace.sessions omits archived sessions by default",
            );
            const wsSessionsWithArchived = await sendRpc(102, "_plurnk/action", {
                kind: "workspace.sessions",
                workspace: "alpha",
                params: { includeArchived: true },
            });
            assert.ok(
                (wsSessionsWithArchived.sessions as Array<{ name: string }>).some((s) => s.name === "user"),
                "workspace.sessions includes archived sessions when includeArchived: true",
            );
            const listedAfterArchive = await sendRpc(11, "session/list", { cwd: "/workspace/alpha" });
            assert.ok(
                !(listedAfterArchive.sessions as Array<{ sessionId: string }>).some((s) => s.sessionId === "1#user"),
            );
            const listedOnlyArchived = await sendRpc(110, "session/list", {
                cwd: "/workspace/alpha",
                archived: "only",
            });
            assert.ok(
                (listedOnlyArchived.sessions as Array<{ sessionId: string; archived?: boolean }>).some(
                    (s) => s.sessionId === "1#user" && s.archived === true,
                ),
            );
            const savedStatus = await sendRpc(111, "session/status", { sessionId: "1#user" });
            assert.equal(savedStatus.status, "saved");

            await sendRpc(12, "session/unarchive", {
                sessionId: "1#user",
            });
            const listedAfterUnarchive = await sendRpc(13, "session/list", { cwd: "/workspace/alpha" });
            assert.ok(
                (listedAfterUnarchive.sessions as Array<{ sessionId: string; archived?: boolean }>).some(
                    (s) => s.sessionId === "1#user" && s.archived === false,
                ),
            );
            const titled = await sendRpc(130, "session/set_title", {
                sessionId: "1#user",
                title: "  Primary Session  ",
            });
            assert.equal(titled.title, "Primary Session");
            const listedAfterTitle = await sendRpc(131, "session/list", { cwd: "/workspace/alpha" });
            const userSessionInfo = (
                listedAfterTitle.sessions as Array<{ sessionId: string; title?: string }>
            ).find((s) => s.sessionId === "1#user");
            assert.equal(userSessionInfo?.title, "Primary Session");
            const authStatus = await sendRpc(132, "auth/status", {});
            assert.equal(authStatus.state, "authenticated");
            assert.ok(Array.isArray(authStatus.accounts) && authStatus.accounts.length > 0);

            const liveThoughtUpdates = translator.reasoning({
                sessionId: 1,
                loopId: 1,
                turnId: 2,
                loopSeq: 1,
                turnSeq: 2,
                modelCallId: 9,
                requestSequence: 1,
                phase: "content",
                delta: "Live reasoning chunk",
            });
            assert.equal(liveThoughtUpdates.length, 1);
            assert.deepEqual(
                (liveThoughtUpdates[0]?.update._meta as { plurnk?: unknown } | undefined)?.plurnk,
                {
                    sessionId: 1,
                    sessionName: "user",
                    loopId: 1,
                    loopSeq: 1,
                    turnId: 2,
                    turnSeq: 2,
                    coordinate: "1/2",
                    body: {
                        url: "http://127.0.0.1:1066/acp/1/1/entry?target=reasoning%3A%2F%2Fuser%2F1%2F2",
                        mimeType: "text/plain",
                    },
                },
            );

            const loggedWithReasoning = translator.logEntry({
                entry: makeLogEntry({
                    id: 503,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 2,
                    turn_id: 4,
                    loop_seq: 2,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "model",
                    op: "note",
                    status_rx: 200,
                    reasoning: "Logged reasoning chunk",
                    attrs: { body: "note body" },
                    rx: { status: 200 },
                }),
            });
            const loggedThought = loggedWithReasoning.find((u) => u.update.sessionUpdate === "agent_thought_chunk");
            assert.deepEqual(
                (loggedThought?.update._meta as { plurnk?: unknown } | undefined)?.plurnk,
                {
                    sessionId: 1,
                    sessionName: "user",
                    loopId: 2,
                    loopSeq: 2,
                    turnId: 4,
                    turnSeq: 1,
                    coordinate: "2/1",
                    body: {
                        url: "http://127.0.0.1:1066/acp/1/1/entry?target=reasoning%3A%2F%2Fuser%2F2%2F1",
                        mimeType: "text/plain",
                    },
                },
            );
            const loggedOp = loggedWithReasoning.find((u) => u.update.sessionUpdate !== "agent_thought_chunk");
            assert.equal(
                (loggedOp?.update._meta as { plurnk?: { sessionName?: string } } | undefined)?.plurnk?.sessionName,
                "user",
            );

            const ambientWithReasoning = translator.logEntry({
                entry: makeLogEntry({
                    id: 502,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 1,
                    turn_id: 3,
                    loop_seq: 1,
                    turn_seq: 3,
                    sequence: 1,
                    origin: "_plurnk",
                    op: null,
                    state: "failed",
                    status_rx: 422,
                    reasoning: "Reasoning on rejected emission attempt",
                    attrs: { kind: "emissionAttempt", body: "bad attempt" },
                    rx: { status: 422 },
                }),
            });
            assert.deepEqual(
                (ambientWithReasoning[0]?.update._meta as { plurnk?: { reasoning?: unknown } } | undefined)?.plurnk
                    ?.reasoning,
                {
                    url: "http://127.0.0.1:1066/acp/1/1/entry?target=reasoning%3A%2F%2Fuser%2F1%2F3",
                    mimeType: "text/plain",
                },
            );

            assert.deepEqual(
                (cancelledChunk?.update._meta as { plurnk?: { body?: unknown } } | undefined)?.plurnk?.body,
                {
                    url: "http://127.0.0.1:1066/acp/1/1/entry?target=message%3A%2F%2Fuser%2Fmsg-cancelled",
                    mimeType: "text/plain",
                },
            );

            // Fresh unseeded session (readSessionModel.model === null) projects active alias effort in configOptions (#1389)
            h.port.readSessionModel = async () => ({ model: null, spawnModel: null });
            h.port.listProviders = () => ({
                aliases: [
                    {
                        alias: "rtx5070",
                        provider: "vllm",
                        model: "qwen3-coder",
                        effort: "medium",
                        effortSource: "default" as const,
                        inputCapacity: 128000,
                        active: true,
                    },
                ],
            });
            const freshSessionRes = await sendRpc(14, "session/new", { cwd: "/workspace/alpha" });
            const freshConfigOptions = freshSessionRes.configOptions as
                | Array<{
                      configId: string;
                      currentValue?: string;
                      options?: Array<{ value: string }>;
                  }>
                | undefined;
            assert.equal(
                freshConfigOptions?.find((o) => o.configId === "model")?.currentValue,
                "rtx5070",
            );
            assert.equal(
                freshConfigOptions?.find((o) => o.configId === "thought_level")?.currentValue,
                "medium",
            );
            assert.deepEqual(
                freshConfigOptions
                    ?.find((o) => o.configId === "thought_level")
                    ?.options?.map((o) => o.value),
                ["medium"],
            );

            ws.close();
        } finally {
            await h.close();
        }
    });

    test("{§acp-plurnk-metadata} {§acp-event-translation} {§acp-session-owner}: evicts settled stream correlations and offsets, bounds unconsumed raced tombstones FIFO, and clears translator state on session/close", async () => {
        const translator = new SessionTranslator({
            acpSessionId: "1#user",
            workspaceId: 1,
            sessionId: 1,
            streamTombstones: 2,
        });

        // 1. Normal order evicts active correlation once settled so duplicate conclusions do not replay tool_call_update
        translator.logEntry({
            entry: makeLogEntry({
                id: 700,
                session_id: 1,
                sequence: 1,
                op: "sh",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo one" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/00000700" }),
            }),
        });
        const firstSettled = translator.terminalConcluded(70, 200, { sessionId: 1, target: "exec:///sh/00000700" });
        assert.equal(firstSettled.some((u) => u.update.sessionUpdate === "tool_call_update"), true);
        const duplicateSettled = translator.terminalConcluded(70, 200, { sessionId: 1, target: "exec:///sh/00000700" });
        assert.equal(duplicateSettled.some((u) => u.update.sessionUpdate === "tool_call_update"), false);

        // 2. Raced tombstones evict upon projection and bound unconsumed entries FIFO at streamTombstones
        const clearTranslator = new SessionTranslator({
            acpSessionId: "1#user",
            workspaceId: 1,
            sessionId: 1,
            streamTombstones: 2,
        });
        clearTranslator.terminalConcluded(81, 200, { sessionId: 1, target: "exec:///sh/000000a1" });
        clearTranslator.terminalConcluded(82, 200, { sessionId: 1, target: "exec:///sh/000000a2" });
        clearTranslator.terminalConcluded(83, 500, { sessionId: 1, target: "exec:///sh/000000a3" });

        const evictedOld = clearTranslator.logEntry({
            entry: makeLogEntry({
                id: 701,
                session_id: 1,
                sequence: 2,
                op: "sh",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo old" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/000000a1" }),
            }),
        });
        assert.equal(
            evictedOld[0]?.update.sessionUpdate === "tool_call_update" ? evictedOld[0].update.status : null,
            "in_progress",
            "oldest unconsumed raced tombstone is evicted FIFO",
        );

        const settledMid = clearTranslator.logEntry({
            entry: makeLogEntry({
                id: 702,
                session_id: 1,
                sequence: 3,
                op: "sh",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo mid" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/000000a2" }),
            }),
        });
        assert.equal(
            settledMid[0]?.update.sessionUpdate === "tool_call_update" ? settledMid[0].update.status : null,
            "completed",
        );

        // Consumed tombstone is evicted immediately after projection
        const reprojectedMid = clearTranslator.logEntry({
            entry: makeLogEntry({
                id: 703,
                session_id: 1,
                sequence: 4,
                op: "sh",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo mid again" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/000000a2" }),
            }),
        });
        assert.equal(
            reprojectedMid[0]?.update.sessionUpdate === "tool_call_update" ? reprojectedMid[0].update.status : null,
            "in_progress",
            "raced tombstone is evicted once consumed by logEntry",
        );

        // clear() wipes remaining unconsumed tombstones ("exec:///sh/000000a3") and configuration notice dedup state
        const configNotice: Notice = {
            source: "engine:configuration",
            kind: "model_missing",
            level: "warn",
            message: "No default model configured.",
        };
        assert.equal(clearTranslator.notice(configNotice).length, 1);
        assert.equal(clearTranslator.notice(configNotice).length, 0);
        clearTranslator.clear();
        assert.equal(clearTranslator.notice(configNotice).length, 1);
        const afterClearNew = clearTranslator.logEntry({
            entry: makeLogEntry({
                id: 704,
                session_id: 1,
                sequence: 5,
                op: "sh",
                status_rx: 202,
                tx: JSON.stringify({ body: "echo new" }),
                rx: JSON.stringify({ status: 202 }),
                attrs: JSON.stringify({ stream: "exec:///sh/000000a3" }),
            }),
        });
        assert.equal(
            afterClearNew[0]?.update.sessionUpdate === "tool_call_update" ? afterClearNew[0].update.status : null,
            "in_progress",
        );

        // 3. Module stream/concluded evicts streamOffsets and session/close detaches cleanly
        const h = await createHarness();
        try {
            const chunks: string[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                if (params.update.sessionUpdate === "terminal_output_chunk" && typeof params.update.data === "string") {
                    chunks.push(Buffer.from(params.update.data, "base64").toString("utf8"));
                }
            });
            await app.connectWith(stream, async (ctx) => {
                await ctx.initialized;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                h.port.entryContents.set("exec:///sh/00000900#stdout", "alpha\n");
                h.port.emitEvent(1, "stream/event", {
                    sessionId: 1,
                    entryId: 900,
                    target: "exec:///sh/00000900",
                    channel: "stdout",
                    state: "active",
                    contentLength: 6,
                });
                await waitFor(() => chunks.length === 1);
                assert.deepEqual(chunks, ["alpha\n"]);

                h.port.emitEvent(1, "stream/concluded", {
                    sessionId: 1,
                    entryId: 900,
                    target: "exec:///sh/00000900",
                    result: { status: 200 },
                });

                // Reusing entryId 900 from offset 0 after stream/concluded emits again because its offset was evicted
                h.port.entryContents.set("exec:///sh/00000900#stdout", "bravo\n");
                h.port.emitEvent(1, "stream/event", {
                    sessionId: 1,
                    entryId: 900,
                    target: "exec:///sh/00000900",
                    channel: "stdout",
                    state: "active",
                    contentLength: 6,
                });
                await waitFor(() => chunks.length === 2);
                assert.deepEqual(chunks, ["alpha\n", "bravo\n"]);

                await ctx.request(methods.agent.session.close, { sessionId: "1#user" });
                h.port.entryContents.set("exec:///sh/00000900#stdout", "bravo\ncharlie\n");
                h.port.emitEvent(1, "stream/event", {
                    sessionId: 1,
                    entryId: 900,
                    target: "exec:///sh/00000900",
                    channel: "stdout",
                    state: "active",
                    contentLength: 14,
                });
                await new Promise((r) => setTimeout(r, 30));
                assert.equal(chunks.length, 2, "closed session receives no further stream chunks");
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-body-reference} {§acp-history-window} {§acp-action-binding} {§acp-plurnk-metadata}: negotiated reasoning/bodies link mode, body-stripped attrs, alias-scoped configOptions, SQL-windowed readLog, and intra-loop turn trimming (#1539)", async () => {
        const h = await createHarness();
        try {
            // Seed extra ready catalog models to verify configOptions stays scoped to declared aliases + active routes
            const origListModels = h.port.listModels.bind(h.port);
            h.port.listModels = (query) => {
                const base = origListModels(query);
                const template = origListModels({}).items[0];
                const extra = {
                    ...template,
                    provider: "mocktest",
                    providerName: "MockTest",
                    model: "catalog-extra",
                    modelName: "Catalog Extra",
                    selector: "mocktest/catalog-extra",
                    limits: { contextTokens: 128000, inputTokens: 128000, outputTokens: 8192 },
                    readiness: { ready: true, causes: [] },
                };
                const unused = {
                    ...extra,
                    model: "catalog-unused",
                    modelName: "Catalog Unused",
                    selector: "mocktest/catalog-unused",
                };
                const extras = [extra, unused].filter(
                    (item) => !query.search || item.selector.includes(query.search),
                );
                return { ...base, items: [...base.items, ...extras], total: base.total + extras.length };
            };

            const seenReadLogArgs: Array<Record<string, unknown>> = [];
            const origReadLog = h.port.readLog.bind(h.port);
            h.port.readLog = async (args) => {
                seenReadLogArgs.push({ ...args });
                return await origReadLog(args);
            };

            // Seed 3 loops on session 1 ("user"), with Loop 3 containing multiple turns + large bodies/reasoning/diffs
            h.port.logs.push(
                makeLogEntry({
                    id: 10,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 1,
                    at: "2026-11-20T00:00:00.000Z",
                    origin: "_plurnk",
                    source: "acp://operator/sessions/1%23user/messages/m-loop-1",
                    op: "send",
                    scheme: "message",
                    hostname: "user",
                    pathname: "/m-loop-1",
                    tx: "Loop 1 prompt",
                    rx: JSON.stringify({ status: 200 }),
                    status_rx: 200,
                    attrs: JSON.stringify({ kind: "message" }),
                }),
                makeLogEntry({
                    id: 20,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    at: "2026-11-20T00:01:00.000Z",
                    origin: "_plurnk",
                    source: "acp://operator/sessions/1%23user/messages/m-loop-2",
                    op: "send",
                    scheme: "message",
                    hostname: "user",
                    pathname: "/m-loop-2",
                    tx: "Loop 2 prompt",
                    rx: JSON.stringify({ status: 200 }),
                    status_rx: 200,
                    attrs: JSON.stringify({ kind: "message" }),
                }),
                makeLogEntry({
                    id: 30,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 3,
                    loop_seq: 3,
                    turn_id: 3,
                    turn_seq: 1,
                    sequence: 1,
                    at: "2026-11-20T00:02:00.000Z",
                    origin: "_plurnk",
                    source: "acp://operator/sessions/1%23user/messages/m-loop-3",
                    op: "send",
                    scheme: "message",
                    hostname: "user",
                    pathname: "/m-loop-3",
                    tx: "Loop 3 opening prompt",
                    rx: JSON.stringify({ status: 200 }),
                    status_rx: 200,
                    attrs: JSON.stringify({ kind: "message" }),
                }),
                makeLogEntry({
                    id: 31,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 3,
                    loop_seq: 3,
                    turn_id: 4,
                    turn_seq: 2,
                    sequence: 1,
                    at: "2026-11-20T00:02:01.000Z",
                    origin: "model",
                    source: null,
                    op: "read",
                    scheme: "file",
                    hostname: null,
                    pathname: "/workspace/alpha/huge.ts",
                    tx: JSON.stringify({ target: { raw: "huge.ts" } }),
                    rx: JSON.stringify({
                        status: 200,
                        content: `${"const x = 1;\n".repeat(400)}\n<mcp://playwright/shot.png> — image/png`,
                        mimetype: "text/typescript",
                        range: { unit: "line", returned: [1, 401] },
                    }),
                    mimetype_rx: "text/typescript",
                    status_rx: 200,
                    reasoning: "Deep reasoning trace ".repeat(100),
                    reasoning_model_call_id: 77,
                    reasoning_request_sequence: 1,
                    attrs: JSON.stringify({ path: "huge.ts" }),
                }),
                makeLogEntry({
                    id: 32,
                    session_id: 1,
                    session_name: "user",
                    loop_id: 3,
                    loop_seq: 3,
                    turn_id: 5,
                    turn_seq: 3,
                    sequence: 1,
                    at: "2026-11-20T00:02:02.000Z",
                    origin: "model",
                    source: null,
                    op: "edit",
                    scheme: "file",
                    hostname: null,
                    pathname: "/workspace/alpha/huge.ts",
                    tx: JSON.stringify({ target: { raw: "huge.ts" }, body: "export const y = 2;\n" }),
                    rx: JSON.stringify({ status: 200 }),
                    status_rx: 200,
                    attrs: JSON.stringify({
                        path: "huge.ts",
                        aside: "update export",
                        original: "const oldLine = 1;\n".repeat(300),
                        patched: "export const y = 2;\n".repeat(300),
                    }),
                }),
            );

            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            });

            await app.connectWith(stream, async (ctx) => {
                await ctx.initialized;
                // 1. Verify configOptions omits catalog-extra while session/new initial configOptions accepts it
                const catalogBound = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    _meta: { plurnk: { sessionName: "catcheck" } },
                    configOptions: [{ configId: "model", type: "id", value: "mocktest/catalog-extra" }],
                });
                const catModelOpt = catalogBound.configOptions?.find((o) => o.configId === "model");
                assert.equal(catModelOpt?.currentValue, "mocktest/catalog-extra");

                updates.length = 0;

                seenReadLogArgs.length = 0;
                const resumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                    _meta: {
                        plurnk: {
                            control: false,
                            window: true,
                            historyLoops: 2,
                            reasoning: "link",
                            bodies: "link",
                        },
                    },
                });
                await waitFor(() => updates.some((u) => u.sessionUpdate === "replay_complete"));

                // Verify SQL loop windowing passed lastLoops: 3 (historyLoops + 1)
                assert.ok(
                    seenReadLogArgs.some((a) => a.sessionId === 1 && a.lastLoops === 3),
                    `expected lastLoops=3 in readLog calls, got ${JSON.stringify(seenReadLogArgs)}`,
                );

                // Verify model/spawn_model options omit raw catalog entries ("mocktest/catalog-unused") when unselected
                const userModelOpt = resumed.configOptions?.find((o) => o.configId === "model");
                const userSpawnOpt = resumed.configOptions?.find((o) => o.configId === "spawn_model");
                assert.ok(
                    userModelOpt &&
                        SessionConfigOption.isSelect(userModelOpt) &&
                        !userModelOpt.options.some((o) => "value" in o && o.value === "mocktest/catalog-unused"),
                    "model configOptions must not dump unreferenced catalog models",
                );
                assert.ok(
                    userSpawnOpt &&
                        SessionConfigOption.isSelect(userSpawnOpt) &&
                        !userSpawnOpt.options.some((o) => "value" in o && o.value === "mocktest/catalog-unused"),
                    "spawn_model configOptions must not dump unreferenced catalog models",
                );

                // Verify reasoning: "link" projected resource_link instead of raw reasoning text
                const thought = updates.find(SessionUpdate.isAgentThoughtChunk);
                assert.ok(thought);
                assert.equal(thought.content.type, "resource_link");

                // Verify bodies: "link" projected resource_link + preserved raster channel line on read, omitted diff.patch on edit, and stripped body attrs
                const readCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        SessionUpdate.isToolCallUpdate(u) && u.toolCallId === "3/2/1",
                );
                assert.ok(readCall);
                assert.equal(readCall.content?.length, 2, "expected channel image line + resource_link");
                assert.ok(
                    readCall.content?.some(
                        (c) => ToolCallContent.isContent(c) && ContentBlock.isResourceLink(c.content),
                    ),
                );
                assert.ok(
                    readCall.content?.some(
                        (c) =>
                            ToolCallContent.isContent(c) &&
                            ContentBlock.isText(c.content) &&
                            c.content.text === "<mcp://playwright/shot.png> — image/png",
                    ),
                );

                const editCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        SessionUpdate.isToolCallUpdate(u) && u.toolCallId === "3/3/1",
                );
                assert.ok(editCall);
                const diffBlock = editCall.content?.find((c) => c.type === "diff");
                assert.ok(diffBlock && diffBlock.type === "diff");
                assert.equal(diffBlock.patch, undefined, "settled diff omits patch under bodies: link");
                const editMetaAttrs = (
                    editCall._meta as { plurnk?: { attrs?: Record<string, unknown> } } | undefined
                )?.plurnk?.attrs;
                assert.equal(editMetaAttrs?.aside, "update export");
                assert.equal(editMetaAttrs?.original, undefined, "original file copy stripped from _meta.plurnk.attrs");
                assert.equal(editMetaAttrs?.patched, undefined, "patched file copy stripped from _meta.plurnk.attrs");

                // Verify live reasoning/event streams text deltas during content and emits closing resource_link on end
                updates.length = 0;
                h.port.emitEvent(1, "reasoning/event", {
                    sessionId: 1,
                    loopId: 3,
                    turnId: 99,
                    loopSeq: 3,
                    turnSeq: 9,
                    modelCallId: 88,
                    requestSequence: 1,
                    phase: "content",
                    delta: "Live thought delta",
                });
                h.port.emitEvent(1, "reasoning/event", {
                    sessionId: 1,
                    loopId: 3,
                    turnId: 99,
                    loopSeq: 3,
                    turnSeq: 9,
                    modelCallId: 88,
                    requestSequence: 1,
                    phase: "end",
                    delta: "",
                });
                await waitFor(() => updates.filter(SessionUpdate.isAgentThoughtChunk).length === 2);
                const liveThoughts = updates.filter(SessionUpdate.isAgentThoughtChunk);
                assert.equal(liveThoughts[0]?.content.type, "text");
                assert.equal(liveThoughts[1]?.content.type, "resource_link");

                // Verify intra-loop turn trimming when a single loop exceeds historyPageChars
                updates.length = 0;
                const trimmedResumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                    _meta: {
                        plurnk: {
                            control: false,
                            window: true,
                            historyLoops: 1,
                            historyPageChars: 900,
                            reasoning: "link",
                            bodies: "link",
                        },
                    },
                });
                await waitFor(() => updates.some((u) => u.sessionUpdate === "replay_complete"));
                assert.ok(
                    updates.some((u) => u.sessionUpdate === "user_message_chunk" && u.messageId === "m-loop-3"),
                    "intra-loop trimming retains the loop's opening user prompt",
                );
                assert.ok(
                    !updates.some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "3/2/1"),
                    "older turn 3/2/1 trimmed to fit historyPageChars",
                );
                assert.ok(
                    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "3/3/1"),
                    "newest turn 3/3/1 retained",
                );
                const olderLoopUrl = (
                    trimmedResumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
                )?.plurnk?.history?.older;
                assert.ok(
                    olderLoopUrl?.includes("&reasoning=link&bodies=link&loop=3"),
                    `expected ?...&reasoning=link&bodies=link&loop=3, got ${olderLoopUrl}`,
                );
                const fullLoopRes = await fetch(olderLoopUrl!);
                assert.equal(fullLoopRes.status, 200);
                const fullLoopJson = (await fullLoopRes.json()) as {
                    updates: SessionUpdate[];
                    history: { older?: string };
                };
                assert.ok(
                    fullLoopJson.updates.some(
                        (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "3/2/1",
                    ),
                    "GET /messages?loop=3 returns the complete untruncated loop",
                );
                assert.ok(
                    fullLoopJson.history.older?.includes("&before=3"),
                    `expected full loop page to link &before=3, got ${fullLoopJson.history.older}`,
                );
            });
        } finally {
            await h.close();
        }
    });
});
