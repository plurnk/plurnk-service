import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    methods,
    type ContentBlock,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import Module from "./Module.ts";
import type { AcpPlusState, ActionOutcome } from "./client.ts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    makeLogEntry,
    waitFor,
} from "../test/harness.ts";

describe("{§acp-daemon-client} plurnk-acp Module", { concurrency: true }, () => {
    test("{§acp-daemon-client} {§acp-http-authorization} {§acp-session-owner}: module lifecycle, configuration validation, and runtime-neutral client types", async () => {
        const sampleOutcome: ActionOutcome<string> = { ok: true, result: "ok" };
        assert.equal(sampleOutcome.ok, true);
        const sampleState: Partial<AcpPlusState> = {
            budget: { curationWeight: 10, curationBudget: 100, contextTokens: 20, contextCapacity: 200 },
        };
        assert.equal(sampleState.budget?.curationWeight, 10);

        assert.throws(
            () => Module.create({ env: { PLURNK_ACP_HEARTBEAT_MS: "invalid" } }),
            /PLURNK_ACP_HEARTBEAT_MS must be a safe integer/,
        );

        const h = await createHarness();
        try {
            h.acpModule.stop();
            const res = await fetch(h.baseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(res.status, 503);
            const body = (await res.json()) as Record<string, unknown>;
            assert.match(String(body.code ?? body.type), /service-stopping/);
        } finally {
            await h.close();
        }
    });

    test("{§acp-daemon-client} {§acp-action-binding} {§acp-plurnk-metadata} {§acp-session-owner}: session/new, session/resume, session/fork, session/list, session/delete, session/close, and qualified addresses", async () => {
        const h = await createHarness();
        try {
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    additionalDirectories: ["/workspace/beta"],
                    _meta: { plurnk: { name: "alice" } },
                });
                assert.equal(created.sessionId, "1#alice");
                assert.ok(Array.isArray(created.configOptions));
                assert.ok(created.configOptions?.some((opt) => opt.configId === "model"));
                assert.ok(created.configOptions?.some((opt) => opt.configId === "thought_level"));
                assert.ok(Array.isArray(created.availableCommands));
                const mcpCmd = created.availableCommands?.find((cmd) => cmd.name === "mcp");
                assert.ok(
                    mcpCmd &&
                        "input" in mcpCmd &&
                        mcpCmd.input !== null &&
                        typeof mcpCmd.input === "object" &&
                        "type" in mcpCmd.input &&
                        mcpCmd.input.type === "text",
                );
                const updateCmd = created.availableCommands?.find((cmd) => cmd.name === "update");
                assert.ok(updateCmd && (!("input" in updateCmd) || updateCmd.input === undefined));

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.resume, {
                            sessionId: "01#alice",
                            cwd: "/workspace/alpha",
                        }),
                    /session-address-invalid/,
                );

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.resume, {
                            sessionId: "1#nonexistent",
                            cwd: "/workspace/alpha",
                        }),
                    /session-not-found/,
                );

                const forked = await ctx.request(methods.agent.session.fork, {
                    sessionId: "1#alice",
                    cwd: "/workspace/alpha",
                });
                assert.match(forked.sessionId, /^1#/);

                let claimedCount = 0;
                const origClaim = h.port.claimSessionOwner;
                h.port.claimSessionOwner = async (args) => {
                    claimedCount += 1;
                    return origClaim(args);
                };
                const passiveResumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#alice",
                    cwd: "/workspace/alpha",
                    _meta: { plurnk: { control: false } },
                });
                assert.equal(claimedCount, 0, "passive resume (control: false) does not claim session ownership");
                const resumedDescendants = (
                    passiveResumed._meta as { plurnk?: { status?: { descendants?: Array<{ name?: string }> } } } | undefined
                )?.plurnk?.status?.descendants;
                assert.ok(Array.isArray(resumedDescendants) && resumedDescendants.length === 1);
                assert.equal(`1#${resumedDescendants[0]?.name ?? ""}`, forked.sessionId);

                const registeredOwners: Array<{ interactive?: boolean; tools: readonly string[] }> = [];
                const origRegister = h.port.registerSessionOwner;
                h.port.registerSessionOwner = async (workspaceId, owner) => {
                    registeredOwners.push({ interactive: owner.interactive, tools: owner.tools });
                    return origRegister(workspaceId, owner);
                };
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#alice",
                    cwd: "/workspace/alpha",
                    _meta: { plurnk: { interactive: false, tools: [] } },
                });
                assert.deepEqual(registeredOwners.at(-1), {
                    interactive: false,
                    tools: ["request_approval"],
                });

                const listedBefore = await ctx.request(methods.agent.session.list, {
                    cwd: "/workspace/alpha",
                });
                assert.ok(listedBefore.sessions.some((s) => s.sessionId === forked.sessionId));
                const aliceEntry = listedBefore.sessions.find((s) => s.sessionId === "1#alice");
                assert.deepEqual(aliceEntry?.additionalDirectories, ["/workspace/beta"]);

                await ctx.request(methods.agent.session.delete, {
                    sessionId: forked.sessionId,
                });
                const listedAfter = await ctx.request(methods.agent.session.list, {
                    cwd: "/workspace/alpha",
                });
                assert.ok(!listedAfter.sessions.some((s) => s.sessionId === forked.sessionId));

                await ctx.request(methods.agent.session.close, {
                    sessionId: "1#alice",
                });
                const listedFinal = await ctx.request(methods.agent.session.list, {
                    cwd: "/workspace/alpha",
                });
                assert.ok(listedFinal.sessions.some((s) => s.sessionId === "1#alice"));
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-http-authorization} {§acp-plurnk-metadata} {§acp-status-descendants} {§acp-session-owner}: session/prompt, idempotency, usage_update, and state_update", async () => {
        const h = await createHarness();
        try {
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                await ctx.buildSession("/workspace/alpha").withSession(async (session) => {
                    await assert.rejects(
                        () =>
                            ctx.request(methods.agent.session.prompt, {
                                sessionId: session.sessionId,
                                prompt: [{ type: "text", text: "   " }],
                            }),
                        /user-message-text-required/,
                    );

                    const promptRes = await ctx.request(methods.agent.session.prompt, {
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text: "Hello ACP v2" }],
                        _meta: { plurnk: { messageId: "msg-100" } },
                    });
                    assert.equal(promptRes.messageId, "msg-100");

                    const replyText = await session.readTextUntilIdle();
                    assert.match(replyText, /Echo: Hello ACP v2/);

                    await assert.rejects(
                        () =>
                            ctx.request(methods.agent.session.prompt, {
                                sessionId: session.sessionId,
                                prompt: [{ type: "text", text: "Different text" }],
                                _meta: { plurnk: { messageId: "msg-100" } },
                            }),
                        /message-address-reused/,
                    );

                    let capturedRunLoop: Parameters<typeof h.port.runLoop>[0] | undefined;
                    const origRunLoop = h.port.runLoop.bind(h.port);
                    h.port.runLoop = async (args) => {
                        capturedRunLoop = args;
                        return await origRunLoop(args);
                    };
                    try {
                        await ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [
                                { type: "text", text: "Inspect these" },
                                { type: "resource_link", uri: "file:///workspace/alpha/README.md", name: "README.md" },
                                {
                                    type: "resource",
                                    resource: { uri: "mem:///note.txt", mimeType: "text/plain", text: "embedded body" },
                                },
                                {
                                    type: "image",
                                    mimeType: "image/png",
                                    data: Buffer.from("png-bytes").toString("base64"),
                                    uri: "file:///workspace/alpha/diagram.png",
                                },
                                {
                                    type: "audio",
                                    mimeType: "audio/wav",
                                    data: Buffer.from("wav-bytes").toString("base64"),
                                },
                            ],
                        });
                        await session.readTextUntilIdle();
                        assert.deepEqual(capturedRunLoop?.openPaths, ["/workspace/alpha/README.md"]);
                        assert.equal(capturedRunLoop?.attachments?.length, 3);
                        assert.equal(capturedRunLoop?.attachments?.[0]?.name, "note.txt");
                        assert.equal(capturedRunLoop?.attachments?.[0]?.target, "mem:///note.txt");
                        assert.equal(capturedRunLoop?.attachments?.[1]?.name, "diagram.png");
                        assert.equal(capturedRunLoop?.attachments?.[1]?.target, "file:///workspace/alpha/diagram.png");
                        assert.equal(capturedRunLoop?.attachments?.[1]?.mediaType, "image/png");
                        assert.equal(capturedRunLoop?.attachments?.[2]?.name, "audio");
                        assert.equal(capturedRunLoop?.attachments?.[2]?.mediaType, "audio/wav");

                        const origListActions = h.port.listModuleActions.bind(h.port);
                        const origInvokeAction = h.port.invokeModuleAction.bind(h.port);
                        h.port.listModuleActions = () => [
                            ...origListActions(),
                            {
                                name: "workspace.skills.list",
                                scope: "workspace",
                                inputSchema: { type: "object" },
                                outputSchema: { type: "object" },
                            },
                        ];
                        h.port.invokeModuleAction = async (name, params, context) => {
                            if (name === "workspace.skills.list") {
                                return {
                                    definitions: [
                                        {
                                            alias: "triage",
                                            state: "active",
                                            detail: { description: "Triage repository issues" },
                                        },
                                    ],
                                };
                            }
                            if (name === "workspace.mcp.list") {
                                return {
                                    definitions: [
                                        {
                                            alias: "git-srv",
                                            state: "active",
                                            detail: {
                                                promptDefinitions: [
                                                    {
                                                        name: "review",
                                                        description: "Review git diff",
                                                        arguments: [{ name: "branch" }],
                                                    },
                                                ],
                                            },
                                        },
                                    ],
                                };
                            }
                            return await origInvokeAction(name, params, context);
                        };
                        try {
                            await ctx.request(methods.agent.session.prompt, {
                                sessionId: session.sessionId,
                                prompt: [
                                    { type: "text", text: "Use " },
                                    { type: "skill", name: "triage" },
                                    { type: "text", text: " to check bug #42" },
                                    {
                                        type: "command",
                                        name: "git-srv:review",
                                        input: "branch=main",
                                    } as unknown as ContentBlock,
                                ],
                            });
                            await session.readTextUntilIdle();
                            assert.deepEqual(capturedRunLoop?.openPaths, [
                                "skill://triage/SKILL.md",
                                "git-srv:///prompts/review?branch=main",
                            ]);
                            assert.equal(capturedRunLoop?.prompt, "Use $triage to check bug #42");

                            await ctx.request(methods.agent.session.prompt, {
                                sessionId: session.sessionId,
                                prompt: [{ type: "skill", name: "triage" }],
                            });
                            await session.readTextUntilIdle();
                            assert.deepEqual(capturedRunLoop?.openPaths, ["skill://triage/SKILL.md"]);
                            assert.equal(capturedRunLoop?.prompt, "<skill://triage/SKILL.md>");

                            await assert.rejects(
                                () =>
                                    ctx.request(methods.agent.session.prompt, {
                                        sessionId: session.sessionId,
                                        prompt: [{ type: "skill", name: "unknown-skill" }],
                                    }),
                                (err: { code?: number }) => err.code === -32602,
                            );
                        } finally {
                            h.port.listModuleActions = origListActions;
                            h.port.invokeModuleAction = origInvokeAction;
                        }
                    } finally {
                        h.port.runLoop = origRunLoop;
                    }
                });
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-history-window}: session/resume replay window and HTTP history pagination", async () => {
        const h = await createHarness({
            env: {
                PLURNK_ACP_HISTORY_LOOPS: "1",
                PLURNK_ACP_HISTORY_PAGE_CHARS: "500",
            },
        });
        try {
            h.port.logs.push(
                makeLogEntry({
                    id: 1,
                    session_id: 1,
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "system",
                    op: "send",
                    source: "acp://operator/sessions/1%23user/messages/m1",
                    attrs: { kind: "message", body: "Loop 1 question" },
                    rx: { status: 200, content: "Loop 1 question", mimetype: "text/markdown" },
                    mimetype_rx: "text/markdown",
                }),
                makeLogEntry({
                    id: 2,
                    session_id: 1,
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 2,
                    origin: "model",
                    op: "done",
                    attrs: { kind: "message", to: "acp://operator", body: "Loop 1 answer" },
                    rx: { status: 200, completion: 200, content: "Loop 1 answer", mimetype: "text/markdown" },
                    mimetype_rx: "text/markdown",
                }),
                makeLogEntry({
                    id: 3,
                    session_id: 1,
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    origin: "system",
                    op: "send",
                    source: "acp://operator/sessions/1%23user/messages/m2",
                    attrs: { kind: "message", body: "Loop 2 question" },
                    rx: { status: 200, content: "Loop 2 question", mimetype: "text/markdown" },
                    mimetype_rx: "text/markdown",
                }),
                makeLogEntry({
                    id: 4,
                    session_id: 1,
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 2,
                    origin: "model",
                    op: "fail",
                    attrs: { kind: "message", to: "acp://operator", body: "X".repeat(600) },
                    rx: { status: 200, completion: 499, content: "X".repeat(600), mimetype: "text/markdown" },
                    mimetype_rx: "text/markdown",
                }),
            );

            const replayed: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                replayed.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                // Omitted or null replayFrom does not replay historical turns and emits no replay_complete
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                await waitFor(() => replayed.some((u) => u.sessionUpdate === "state_update"));
                assert.equal(
                    replayed.some((u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk"),
                    false,
                    "omitted replayFrom skips replaying history",
                );
                assert.equal(
                    replayed.some((u) => u.sessionUpdate === "replay_complete"),
                    false,
                    "omitted replayFrom omits replay_complete",
                );

                replayed.length = 0;
                const emptyCreated = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    _meta: { plurnk: { sessionName: "empty-replay" } },
                });
                await ctx.request(methods.agent.session.close, { sessionId: emptyCreated.sessionId });
                replayed.length = 0;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: emptyCreated.sessionId,
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                });
                await waitFor(() => replayed.some((u) => u.sessionUpdate === "state_update"));
                const emptyReplayIdx = replayed.findIndex((u) => u.sessionUpdate === "replay_complete");
                const emptyStateIdx = replayed.findIndex((u) => u.sessionUpdate === "state_update");
                assert.ok(emptyReplayIdx >= 0, "empty-history replayFrom: start still emits replay_complete");
                assert.ok(emptyReplayIdx < emptyStateIdx, "replay_complete precedes live state_update");

                // Unsupported replayFrom cursor fails with -32602 Invalid params
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.resume, {
                            sessionId: "1#user",
                            cwd: "/workspace/alpha",
                            replayFrom: { type: "_unknown_cursor" },
                        }),
                    /Unsupported or malformed replayFrom cursor/,
                );

                // Standard ACPv2 replayFrom: { type: "start" } replays all retained conversation history, holds concurrent live updates until replay_complete, then flushes held updates
                replayed.length = 0;
                const origReadLog = h.port.readLog.bind(h.port);
                let injectedDuringReplay = false;
                h.port.readLog = async (args) => {
                    const rows = await origReadLog(args);
                    if (!injectedDuringReplay && args.sessionId === 1) {
                        injectedDuringReplay = true;
                        h.port.emitEvent(1, "reasoning/event", {
                            sessionId: 1,
                            loopId: 1,
                            turnId: 99,
                            loopSeq: 99,
                            turnSeq: 1,
                            modelCallId: 99,
                            requestSequence: 1,
                            phase: "content",
                            delta: "concurrent live thought during replay",
                        });
                    }
                    return rows;
                };
                let fullResumed;
                try {
                    fullResumed = await ctx.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                        replayFrom: { type: "start" },
                    });
                } finally {
                    h.port.readLog = origReadLog;
                }
                const fullHistoryMeta = (
                    fullResumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
                )?.plurnk?.history;
                assert.equal(fullHistoryMeta?.older, undefined, "unwindowed start replay replays all loops");
                await waitFor(
                    () =>
                        replayed.filter((u) => u.sessionUpdate === "user_message_chunk").length === 2 &&
                        replayed.filter((u) => u.sessionUpdate === "agent_message_chunk").length === 2 &&
                        replayed.some((u) => u.sessionUpdate === "replay_complete") &&
                        replayed.some((u) => u.sessionUpdate === "agent_thought_chunk"),
                );
                const replayCompleteIdx = replayed.findIndex((u) => u.sessionUpdate === "replay_complete");
                const lastReplayedMsgIdx = replayed.findLastIndex(
                    (u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk",
                );
                const heldThoughtIdx = replayed.findIndex((u) => u.sessionUpdate === "agent_thought_chunk");
                const stateAfterReplayIdx = replayed.findIndex((u) => u.sessionUpdate === "state_update");
                assert.ok(lastReplayedMsgIdx < replayCompleteIdx, "all replayed turns precede replay_complete");
                assert.ok(replayCompleteIdx < heldThoughtIdx, "held live update flushes after replay_complete");
                assert.ok(replayCompleteIdx < stateAfterReplayIdx, "current state_update follows replay_complete");

                // Opt-in _meta.plurnk.window: true replays the windowed tail and exposes older pagination link
                replayed.length = 0;
                const resumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                    _meta: { plurnk: { window: true } },
                });
                const historyMeta = (
                    resumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
                )?.plurnk?.history;
                assert.ok(historyMeta?.older, "older history link is present when window: true is requested");
                await waitFor(
                    () =>
                        replayed.some((u) => u.sessionUpdate === "user_message_chunk") &&
                        replayed.some((u) => u.sessionUpdate === "agent_message_chunk"),
                );
                assert.ok(replayed.some((u) => u.sessionUpdate === "user_message_chunk"));
                assert.ok(replayed.some((u) => u.sessionUpdate === "agent_message_chunk"));

                const pageRes = await fetch(historyMeta.older);
                assert.equal(pageRes.status, 200);
                const page = (await pageRes.json()) as {
                    updates?: unknown[];
                    history?: { older?: string; newer?: string };
                };
                assert.ok(Array.isArray(page.updates));
                assert.ok(page.history?.newer, "older page exposes newer pagination link");
                const newerRes = await fetch(page.history.newer);
                assert.equal(newerRes.status, 200);
                const newerPage = (await newerRes.json()) as { updates?: unknown[] };
                assert.ok(Array.isArray(newerPage.updates) && newerPage.updates.length > 0);

                const loopRes = await fetch(`${h.baseUrl}/1/1/messages?session=${encodeURIComponent("1#user")}&loop=1`);
                assert.equal(loopRes.status, 200);
                const loopPage = (await loopRes.json()) as Record<string, unknown>;
                assert.ok(Array.isArray(loopPage.updates));
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-body-reference} {§acp-plurnk-metadata} {§acp-http-authorization}: inline message text above historyPageChars, single user_message_chunk per prompt, and multi-principal stream scoping with per-principal idle state_update (#1436)", async () => {
        const h = await createHarness({
            authMode: "oauth",
            env: { PLURNK_ACP_HISTORY_PAGE_CHARS: "50" },
        });
        try {
            const operatorUpdates: SessionUpdate[] = [];
            const scoutUpdates: SessionUpdate[] = [];
            const hazoolUpdates: SessionUpdate[] = [];

            const operatorClient = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                operatorUpdates.push(params.update);
            });
            const scoutClient = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                scoutUpdates.push(params.update);
            });
            const hazoolClient = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                hazoolUpdates.push(params.update);
            });

            const operatorStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer valid-token" },
            });
            const scoutStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer scoutproxy-token" },
            });
            const hazoolStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer hazool17-token" },
            });

            await operatorClient.connectWith(operatorStream, async (opConn) => {
                await scoutClient.connectWith(scoutStream, async (scoutConn) => {
                    await hazoolClient.connectWith(hazoolStream, async (hazoolConn) => {
                        await opConn.request(methods.agent.session.resume, {
                            sessionId: "1#user",
                            cwd: "/workspace/alpha",
                        });
                        await scoutConn.request(methods.agent.session.resume, {
                            sessionId: "1#user",
                            cwd: "/workspace/alpha",
                        });
                        await hazoolConn.request(methods.agent.session.resume, {
                            sessionId: "1#user",
                            cwd: "/workspace/alpha",
                        });
                        await waitFor(
                            () =>
                                operatorUpdates.some((u) => u.sessionUpdate === "state_update") &&
                                scoutUpdates.some((u) => u.sessionUpdate === "state_update") &&
                                hazoolUpdates.some((u) => u.sessionUpdate === "state_update"),
                        );
                        const initialScoutIdle = scoutUpdates.find(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "state_update" }> =>
                                u.sessionUpdate === "state_update",
                        );
                        assert.equal(initialScoutIdle?.state, "idle");
                        assert.equal(
                            (initialScoutIdle as { stopReason?: unknown } | undefined)?.stopReason,
                            undefined,
                            "baseline idle state_update on session/resume must omit stopReason",
                        );

                        operatorUpdates.length = 0;
                        scoutUpdates.length = 0;
                        hazoolUpdates.length = 0;

                        h.port.runLoop = async ({ messageAddress }) => {
                            const isScout = typeof messageAddress === "string" && messageAddress.includes("scoutproxy");
                            const path = isScout ? "message://user/scoutproxy_00" : "message://user/hazool17_01";
                            h.port.inbox.push({
                                path,
                                source: messageAddress ?? null,
                                loopId: 1,
                                lifecycle: "running",
                                body: "prompt",
                            });
                            return { status: 200, action: "enqueued_new_loop" as const, sessionId: 1, loopId: 1, resource: path };
                        };

                        // 1. Prompt from scoutproxy transitions scoutproxy (and operator) to running, NOT hazool17
                        const scoutPromptRes = await scoutConn.request(methods.agent.session.prompt, {
                            sessionId: "1#user",
                            prompt: [{ type: "text", text: "Hello from scoutproxy with a long text above fifty chars!" }],
                            _meta: { plurnk: { messageId: "msg-scout-1" } },
                        });
                        assert.equal(scoutPromptRes.messageId, "msg-scout-1");
                        await waitFor(() =>
                            scoutUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                        );
                        assert.equal(
                            hazoolUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                            false,
                            "hazool17 must not transition to running when scoutproxy submits a prompt",
                        );

                        const hazoolPromptRes = await hazoolConn.request(methods.agent.session.prompt, {
                            sessionId: "1#user",
                            prompt: [{ type: "text", text: "Hello from hazool17!" }],
                            _meta: { plurnk: { messageId: "msg-hazool-1" } },
                        });
                        assert.equal(hazoolPromptRes.messageId, "msg-hazool-1");
                        await waitFor(() =>
                            hazoolUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                        );

                        // Pre-publication: zero user_message_chunk emitted yet
                        assert.equal(
                            scoutUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").length,
                            0,
                        );

                        // 2. Publish both user messages into the log (exceeding PLURNK_ACP_HISTORY_PAGE_CHARS=50)
                        h.port.emitEvent(1, "log/entry", {
                            entry: makeLogEntry({
                                id: 101,
                                session_id: 1,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://scoutproxy/sessions/1%23user/messages/msg-scout-1",
                                tx: "Hello from scoutproxy with a long text above fifty chars!",
                                attrs: { kind: "message" },
                            }),
                        });
                        h.port.emitEvent(1, "log/entry", {
                            entry: makeLogEntry({
                                id: 102,
                                session_id: 1,
                                sequence: 2,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://hazool17/sessions/1%23user/messages/msg-hazool-1",
                                tx: "Hello from hazool17!",
                                attrs: { kind: "message" },
                            }),
                        });

                        // Reasoning emitted during the turn projects as agent_thought_chunk (not agent_message_chunk)
                        h.port.emitEvent(1, "reasoning/event", {
                            sessionId: 1,
                            loopId: 1,
                            turnId: 1,
                            loopSeq: 1,
                            turnSeq: 1,
                            modelCallId: 1,
                            requestSequence: 1,
                            phase: "content",
                            delta: "Internal model reasoning",
                        });
                        // Internal _plurnk ops:// emission read, entry_materialized edit, and distilled note
                        // are suppressed from the ACP stream
                        h.port.emitEvent(1, "log/entry", {
                            entry: makeLogEntry({
                                id: 1021,
                                session_id: 1,
                                sequence: 21,
                                origin: "_plurnk",
                                op: "read",
                                pathname: "ops://user/1/1/1",
                                attrs: { kind: "emission" },
                            }),
                        });
                        h.port.emitEvent(1, "log/entry", {
                            entry: makeLogEntry({
                                id: 1022,
                                session_id: 1,
                                sequence: 22,
                                origin: "_plurnk",
                                op: "edit",
                                pathname: "/workspace/file.ts",
                                attrs: { kind: "entry_materialized" },
                            }),
                        });
                        h.port.emitEvent(1, "log/entry", {
                            entry: makeLogEntry({
                                id: 1023,
                                session_id: 1,
                                sequence: 23,
                                origin: "model",
                                op: "note",
                                attrs: { distilled: "log:///1/1/1" },
                            }),
                        });

                        // 3. Model resolves scoutproxy's message first with done (while hazool17's message stays running in inbox)
                        h.port.inbox.length = 0;
                        h.port.inbox.push({
                            path: "message://user/2",
                            source: "acp://hazool17/sessions/1%23user/messages/msg-hazool-1",
                            loopId: 1,
                            lifecycle: "running",
                            body: "Hello from hazool17!",
                        });
                        const longScoutReply =
                            "Dedicated reply to scoutproxy that is also well over the fifty-character page limit!";
                        h.port.emitEvent(1, "log/entry", {
                            entry: {
                                ...makeLogEntry({
                                    id: 103,
                                    session_id: 1,
                                    sequence: 3,
                                    origin: "model",
                                    op: "done",
                                    pathname: "message://user/1",
                                    tx: JSON.stringify({ op: "done", target: "message://user/1", body: longScoutReply }),
                                    rx: {
                                        status: 200,
                                        content: longScoutReply,
                                        mimetype: "text/markdown",
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://user/1"],
                                            completion: 200,
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://scoutproxy/sessions/1%23user/messages/msg-scout-1"],
                            },
                        });

                        await waitFor(() =>
                            scoutUpdates.some(
                                (u) => u.sessionUpdate === "state_update" && u.state === "idle",
                            ),
                        );

                        // Verify scoutproxy received ONLY its own user_message_chunk and its own agent_message_chunk (inline text, not resource_link)
                        const scoutUserChunks = scoutUpdates.filter(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }> =>
                                u.sessionUpdate === "user_message_chunk",
                        );
                        assert.equal(scoutUserChunks.length, 1);
                        assert.equal(scoutUserChunks[0]?.messageId, "msg-scout-1");
                        assert.equal(scoutUserChunks[0]?.content.type, "text");

                        const scoutAgentChunks = scoutUpdates.filter(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
                                u.sessionUpdate === "agent_message_chunk",
                        );
                        assert.equal(scoutAgentChunks.length, 1);
                        assert.equal(scoutAgentChunks[0]?.content.type, "text");
                        if (scoutAgentChunks[0]?.content.type === "text") {
                            assert.equal(scoutAgentChunks[0].content.text, longScoutReply);
                        }
                        const scoutReplyMeta = (
                            scoutAgentChunks[0]?._meta as { plurnk?: Record<string, unknown> } | undefined
                        )?.plurnk;
                        assert.equal(scoutReplyMeta?.voice, "scoutproxy");
                        assert.equal(scoutReplyMeta?.inReplyTo, "msg-scout-1");
                        assert.deepEqual(scoutReplyMeta?.repliedToMessageIds, ["msg-scout-1"]);
                        assert.ok(
                            typeof (scoutReplyMeta?.body as { url?: unknown } | undefined)?.url === "string",
                        );

                        // Verify hazool17 has NOT received scoutproxy's reply, thought chunks, or idle state_update yet
                        assert.equal(
                            hazoolUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").length,
                            0,
                        );
                        assert.equal(
                            hazoolUpdates.filter((u) => u.sessionUpdate === "agent_thought_chunk").length,
                            0,
                        );
                        assert.equal(
                            hazoolUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                            false,
                        );

                        // Verify operator received both user messages, reasoning as agent_thought_chunk, and scoutproxy's reply,
                        // and zero tool_call_update for internal emission/entry_materialized/distilled rows
                        await waitFor(
                            () =>
                                operatorUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").length === 2 &&
                                operatorUpdates.filter(
                                    (u) =>
                                        u.sessionUpdate === "agent_thought_chunk" &&
                                        u.messageId === "model-call-1/request-1/reasoning",
                                ).length === 1 &&
                                operatorUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").length === 1,
                        );
                        assert.equal(
                            operatorUpdates.some((u) => u.sessionUpdate === "tool_call_update"),
                            false,
                            "internal _plurnk emission reads, entry_materialized edits, and distilled notes must not emit tool_call_update",
                        );

                        // 4. Loop 1 terminates while hazool17's message is still queued for the next loop; hazool17 must stay running
                        h.port.inbox[0] = {
                            path: "message://user/2",
                            source: "acp://hazool17/sessions/1%23user/messages/msg-hazool-1",
                            loopId: 2,
                            lifecycle: "queued",
                            body: "Hello from hazool17!",
                        };
                        h.port.emitEvent(1, "loop/terminated", {
                            sessionId: 1,
                            loopId: 1,
                            loopSeq: 1,
                            turnIds: [1],
                            hitMaxTurns: false,
                            result: { status: 200 },
                            usage: {
                                curationWeight: 100,
                                curationBudget: 1000,
                                contextTokens: 100,
                                contextCapacity: 1000,
                            },
                        });
                        await waitFor(() =>
                            operatorUpdates.some(
                                (u) => u.sessionUpdate === "state_update" && u.state === "idle",
                            ),
                        );
                        assert.equal(
                            hazoolUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                            false,
                            "hazool17 must not receive idle state_update when loop terminates with its message still queued",
                        );

                        // 5. Model replies to hazool17 via send, then resolves message://user/2 with a speech-less done
                        const hazoolSendReply = "Dedicated reply to hazool17 delivered via send before speech-less done.";
                        h.port.emitEvent(1, "log/entry", {
                            entry: {
                                ...makeLogEntry({
                                    id: 104,
                                    session_id: 1,
                                    loop_id: 2,
                                    loop_seq: 2,
                                    sequence: 4,
                                    origin: "model",
                                    op: "send",
                                    pathname: "message://user/2",
                                    tx: JSON.stringify({ op: "send", target: "message://user/2", body: hazoolSendReply }),
                                    rx: {
                                        status: 200,
                                        content: hazoolSendReply,
                                        mimetype: "text/markdown",
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://user/2"],
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://hazool17/sessions/1%23user/messages/msg-hazool-1"],
                            },
                        });
                        h.port.inbox.length = 0;
                        h.port.emitEvent(1, "log/entry", {
                            entry: {
                                ...makeLogEntry({
                                    id: 105,
                                    session_id: 1,
                                    loop_id: 2,
                                    loop_seq: 2,
                                    sequence: 5,
                                    origin: "model",
                                    op: "done",
                                    pathname: "message://user/2",
                                    tx: "",
                                    rx: {
                                        status: 200,
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://user/2"],
                                            completion: 200,
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://hazool17/sessions/1%23user/messages/msg-hazool-1"],
                            },
                        });
                        await waitFor(() =>
                            hazoolUpdates.some(
                                (u) => u.sessionUpdate === "state_update" && u.state === "idle",
                            ),
                        );
                        const hazoolAgentChunks = hazoolUpdates.filter(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
                                u.sessionUpdate === "agent_message_chunk",
                        );
                        assert.equal(hazoolAgentChunks.length, 1);
                        if (hazoolAgentChunks[0]?.content.type === "text") {
                            assert.equal(hazoolAgentChunks[0].content.text, hazoolSendReply);
                        }

                        // 6. Replay and GET /messages scope history to the caller's principal across later other-principal loops,
                        // and tool_call_update delivers inline text content instead of JSON receipt metadata or resource_link
                        h.port.logs.push(
                            makeLogEntry({
                                id: 101,
                                session_id: 1,
                                loop_id: 1,
                                loop_seq: 1,
                                sequence: 1,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://scoutproxy/sessions/1%23user/messages/msg-scout-1",
                                pathname: "message://user/1",
                                attrs: { kind: "message", body: "Hello from scoutproxy with a long text above fifty chars!" },
                                rx: { status: 200, content: "Hello from scoutproxy with a long text above fifty chars!", mimetype: "text/plain" },
                            }),
                            {
                                ...makeLogEntry({
                                    id: 103,
                                    session_id: 1,
                                    loop_id: 1,
                                    loop_seq: 1,
                                    sequence: 3,
                                    origin: "model",
                                    op: "done",
                                    pathname: "message://user/1",
                                    tx: JSON.stringify({ op: "done", target: "message://user/1", body: longScoutReply }),
                                    rx: {
                                        status: 200,
                                        content: longScoutReply,
                                        mimetype: "text/markdown",
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://user/1"],
                                            completion: 200,
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://scoutproxy/sessions/1%23user/messages/msg-scout-1"],
                            },
                            makeLogEntry({
                                id: 102,
                                session_id: 1,
                                loop_id: 2,
                                loop_seq: 2,
                                sequence: 1,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://hazool17/sessions/1%23user/messages/msg-hazool-1",
                                pathname: "message://user/2",
                                attrs: { kind: "message", body: "Hello from hazool17!" },
                                rx: { status: 200, content: "Hello from hazool17!", mimetype: "text/plain" },
                            }),
                            makeLogEntry({
                                id: 106,
                                session_id: 1,
                                loop_id: 2,
                                loop_seq: 2,
                                sequence: 2,
                                origin: "model",
                                op: "read",
                                pathname: "/workspace/secret.txt",
                                tx: JSON.stringify({ op: "read", path: "/workspace/secret.txt" }),
                                rx: { status: 200, content: "inline tool output content", lines: 1 },
                            }),
                            {
                                ...makeLogEntry({
                                    id: 104,
                                    session_id: 1,
                                    loop_id: 2,
                                    loop_seq: 2,
                                    sequence: 4,
                                    origin: "model",
                                    op: "send",
                                    pathname: "message://user/2",
                                    tx: JSON.stringify({ op: "send", target: "message://user/2", body: hazoolSendReply }),
                                    rx: {
                                        status: 200,
                                        content: hazoolSendReply,
                                        mimetype: "text/markdown",
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://user/2"],
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://hazool17/sessions/1%23user/messages/msg-hazool-1"],
                            },
                            makeLogEntry({
                                id: 107,
                                session_id: 1,
                                loop_id: 3,
                                loop_seq: 3,
                                sequence: 1,
                                origin: "system",
                                op: "send",
                                source: "acp://operator/sessions/1%23user/messages/msg-op-3",
                                attrs: { kind: "message", body: "Operator loop 3" },
                                rx: { status: 200, content: "Operator loop 3", mimetype: "text/plain" },
                            }),
                        );

                        scoutUpdates.length = 0;
                        await scoutConn.request(methods.agent.session.resume, {
                            sessionId: "1#user",
                            cwd: "/workspace/alpha",
                            replayFrom: { type: "start" },
                        });
                        await waitFor(
                            () =>
                                scoutUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").length === 1 &&
                                scoutUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").length === 1,
                        );
                        assert.equal(
                            scoutUpdates.some((u) => u.sessionUpdate === "tool_call_update"),
                            false,
                            "named principal replay must never include tool_call_update or other principals' messages",
                        );

                        const scoutMessagesRes = await fetch(
                            `${h.baseUrl}/1/1/messages?session=${encodeURIComponent("1#user")}`,
                            { headers: { Authorization: "Bearer scoutproxy-token" } },
                        );
                        assert.equal(scoutMessagesRes.status, 200);
                        const scoutMessagesPage = (await scoutMessagesRes.json()) as {
                            updates: SessionUpdate[];
                        };
                        assert.equal(scoutMessagesPage.updates.length, 2);
                        assert.equal(scoutMessagesPage.updates[0]?.sessionUpdate, "user_message_chunk");
                        assert.equal(scoutMessagesPage.updates[1]?.sessionUpdate, "agent_message_chunk");

                        const opMessagesRes = await fetch(
                            `${h.baseUrl}/1/1/messages?session=${encodeURIComponent("1#user")}&loop=2`,
                            { headers: { Authorization: "Bearer valid-token" } },
                        );
                        assert.equal(opMessagesRes.status, 200);
                        const opMessagesPage = (await opMessagesRes.json()) as {
                            updates: SessionUpdate[];
                        };
                        const readToolUpdate = opMessagesPage.updates.find(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                                u.sessionUpdate === "tool_call_update" && u.name === "read",
                        );
                        assert.ok(readToolUpdate, "operator sees read tool_call_update");
                        assert.deepEqual(readToolUpdate.content, [
                            {
                                type: "content",
                                content: { type: "text", text: "inline tool output content" },
                            },
                        ]);

                        // 7. Internal telemetry uses _plurnk_telemetry (never bodiless session_info_update or redundant state_update)
                        // and never leaks to named principals
                        operatorUpdates.length = 0;
                        scoutUpdates.length = 0;
                        h.port.emitEvent(1, "notice/event", {
                            sessionId: 1,
                            notice: {
                                source: "engine:turn",
                                kind: "turn_awaiting_model",
                                level: "info",
                                message: "",
                            },
                        });
                        h.port.emitEvent(1, "notice/event", {
                            sessionId: 1,
                            notice: {
                                source: "exec:search",
                                kind: "search_progress",
                                level: "info",
                                message: "",
                                percent: 50,
                            },
                        });
                        h.port.emitEvent(1, "workspace/preparation", {
                            preparation: [{ family: "mcp", alias: "demo", phase: "connecting", since: 1000 }],
                        });
                        await waitFor(
                            () =>
                                operatorUpdates.filter((u) => u.sessionUpdate === "_plurnk_telemetry").length >= 3,
                        );
                        assert.equal(
                            operatorUpdates.some((u) => u.sessionUpdate === "session_info_update"),
                            false,
                            "internal telemetry must not emit bodiless session_info_update",
                        );
                        assert.equal(
                            operatorUpdates.some((u) => u.sessionUpdate === "state_update"),
                            false,
                            "engine:turn:* telemetry must not emit redundant state_update",
                        );
                        assert.equal(
                            scoutUpdates.length,
                            0,
                            "internal _plurnk_telemetry must never leak to named principals",
                        );

                        // 8. Resuming by bare session name or <workspaceName>#<sessionName> resolves a renamed workspace
                        h.port.workspaces.push({
                            id: 13,
                            name: "gookie",
                            project_root: "/home/hyzen/ptl/roblox-family-planner/gookie",
                            project_label: "~/ptl/roblox-family-planner/gookie",
                            created_at: "2026-10-25T00:00:00.000Z",
                            archived_at: null,
                        });
                        h.port.sessions.push({
                            id: 82,
                            workspaceId: 13,
                            name: "gookie",
                            created_at: "2026-10-25T00:00:00.000Z",
                            origin: "model",
                            owner: "acp://operator",
                            parentSessionId: null,
                            kind: "root",
                            lifecycle: "idle",
                            archived_at: null,
                        });
                        const resumedByBare = await opConn.request(methods.agent.session.resume, {
                            sessionId: "gookie",
                            cwd: "/home/hyzen/ptl/roblox-family-planner/gookie",
                        });
                        assert.ok(Array.isArray(resumedByBare.configOptions));
                        const resumedByNamedQualified = await opConn.request(methods.agent.session.resume, {
                            sessionId: "gookie#gookie",
                            cwd: "/home/hyzen/ptl/roblox-family-planner/gookie",
                        });
                        assert.ok(Array.isArray(resumedByNamedQualified.configOptions));
                        const statusByNamedQualified = await opConn.request(methods.agent.session.status, {
                            sessionId: "gookie#gookie",
                        });
                        assert.equal(statusByNamedQualified.status, "open");

                        // 9. History pagination (>100 log rows), qualified/unqualified messageId extraction,
                        // and running state for published-but-unanswered messages when inbox is empty (#1438, #1436)
                        h.port.inbox.length = 0;
                        const prevListLoops = h.port.listSessionLoops;
                        h.port.listSessionLoops = async ({ sessionId }) =>
                            sessionId === 82
                                ? [
                                      {
                                          id: 9,
                                          sessionId: 82,
                                          sequence: 2,
                                          status: 102,
                                          prompt: "Active scout prompt",
                                          promptSource: "acp://scoutproxy/sessions/gookie/messages/msg-gookie-active",
                                          claimedAt: "2026-10-25T00:01:00.000Z",
                                          terminatedAt: null,
                                          terminalResult: null,
                                          packetCount: 1,
                                          waitUntil: null,
                                          invocation: null,
                                      },
                                  ]
                                : prevListLoops({ workspaceId: 1, sessionId });
                        h.port.logs.push(
                            makeLogEntry({
                                id: 500,
                                session_id: 82,
                                session_name: "gookie",
                                loop_id: 8,
                                loop_seq: 1,
                                sequence: 1,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://scoutproxy/sessions/13%23gookie/messages/msg-gookie-early",
                                tx: "Early scoutproxy message before 110 operations",
                                attrs: { kind: "message" },
                            }),
                            {
                                ...makeLogEntry({
                                    id: 501,
                                    session_id: 82,
                                    session_name: "gookie",
                                    loop_id: 8,
                                    loop_seq: 1,
                                    sequence: 2,
                                    origin: "model",
                                    op: "done",
                                    pathname: "message://gookie/scoutproxy_00",
                                    tx: JSON.stringify({
                                        op: "done",
                                        target: "message://gookie/scoutproxy_00",
                                        body: "Early scoutproxy reply",
                                    }),
                                    rx: {
                                        status: 200,
                                        content: "Early scoutproxy reply",
                                        mimetype: "text/markdown",
                                        receipt: {
                                            delivered: true,
                                            repliedTo: ["message://gookie/scoutproxy_00"],
                                            completion: 200,
                                        },
                                    },
                                }),
                                replied_to_sources: ["acp://scoutproxy/sessions/13%23gookie/messages/msg-gookie-early"],
                            },
                        );
                        for (let i = 0; i < 110; i += 1) {
                            h.port.logs.push(
                                makeLogEntry({
                                    id: 502 + i,
                                    session_id: 82,
                                    session_name: "gookie",
                                    loop_id: 8,
                                    loop_seq: 1,
                                    sequence: 3 + i,
                                    origin: "model",
                                    op: "read",
                                    pathname: `/workspace/file-${i}.txt`,
                                    tx: JSON.stringify({ op: "read", path: `/workspace/file-${i}.txt` }),
                                    rx: { status: 200, content: `content ${i}`, lines: 1 },
                                }),
                            );
                        }
                        h.port.logs.push(
                            makeLogEntry({
                                id: 700,
                                session_id: 82,
                                session_name: "gookie",
                                loop_id: 9,
                                loop_seq: 2,
                                sequence: 1,
                                origin: "_plurnk",
                                op: "send",
                                source: "acp://scoutproxy/sessions/gookie/messages/msg-gookie-active",
                                tx: "Published scoutproxy message awaiting model reply",
                                attrs: { kind: "message" },
                            }),
                        );
                        h.port.openMessages.push({
                            path: "message://gookie/scoutproxy_01",
                            source: "acp://scoutproxy/sessions/gookie/messages/msg-gookie-active",
                            loopId: 9,
                            lifecycle: "running",
                            body: "Published scoutproxy message awaiting model reply",
                        });
                        scoutUpdates.length = 0;
                        const scoutGookieResumed = await scoutConn.request(methods.agent.session.resume, {
                            sessionId: "gookie",
                            cwd: "/home/hyzen/ptl/roblox-family-planner/gookie",
                            replayFrom: { type: "start" },
                        });
                        const scoutGookieStatusMeta = (
                            scoutGookieResumed._meta as { plurnk?: { status?: Record<string, unknown> } } | undefined
                        )?.plurnk?.status;
                        assert.equal(scoutGookieStatusMeta?.lifecycle, "running");
                        await waitFor(
                            () =>
                                scoutUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").length === 2 &&
                                scoutUpdates.filter((u) => u.sessionUpdate === "agent_message_chunk").length === 1 &&
                                scoutUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                        );
                        const gookieUserChunks = scoutUpdates.filter(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }> =>
                                u.sessionUpdate === "user_message_chunk",
                        );
                        assert.deepEqual(
                            gookieUserChunks.map((u) => u.messageId),
                            ["msg-gookie-early", "msg-gookie-active"],
                        );
                        const gookieAgentChunk = scoutUpdates.find(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
                                u.sessionUpdate === "agent_message_chunk",
                        );
                        assert.equal(
                            (gookieAgentChunk?._meta as { plurnk?: { inReplyTo?: string } } | undefined)?.plurnk
                                ?.inReplyTo,
                            "msg-gookie-early",
                        );
                        const scoutStatusWhilePublished = await scoutConn.request(methods.agent.session.status, {
                            sessionId: "gookie#gookie",
                        });
                        assert.deepEqual(scoutStatusWhilePublished.state, { state: "running" });
                    });
                });
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-plurnk-metadata}: readOpenMessages governs named principal state across loop/terminated, parked SEND+WAIT, and caller 'DOWN' fail discharge", async () => {
        const h = await createHarness({
            authMode: "oauth",
        });
        try {
            const operatorUpdates: SessionUpdate[] = [];
            const scoutUpdates: SessionUpdate[] = [];
            const operatorApp = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                operatorUpdates.push(params.update);
            });
            const scoutApp = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                scoutUpdates.push(params.update);
            });
            const operatorStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer valid-token" },
            });
            const scoutStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer scoutproxy-token" },
            });
            await operatorApp.connectWith(operatorStream, async (opConn) => {
                await opConn.initialized;
                await opConn.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                await scoutApp.connectWith(scoutStream, async (scoutConn) => {
                    await scoutConn.initialized;
                    await scoutConn.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });
                    await waitFor(() => scoutUpdates.some((u) => u.sessionUpdate === "state_update"));
                    operatorUpdates.length = 0;
                    scoutUpdates.length = 0;

                    // 1. Named principal prompt followed by 429 loop/terminated settles principal to idle via readOpenMessages with zero synthetic log rows.
                    const scoutSource1 = "acp://scoutproxy/sessions/1%23user/messages/msg-fail-1";
                    h.port.runLoop = async ({ messageAddress }) => {
                        const msg = {
                            path: "message://user/scoutproxy_00",
                            source: messageAddress ?? scoutSource1,
                            loopId: 1,
                            lifecycle: "running" as const,
                            body: "Prompt before 429",
                        };
                        h.port.inbox.push(msg);
                        h.port.openMessages.push(msg);
                        return {
                            status: 200,
                            action: "enqueued_new_loop" as const,
                            sessionId: 1,
                            loopId: 1,
                            resource: "message://user/scoutproxy_00",
                        };
                    };
                    await scoutConn.request(methods.agent.session.prompt, {
                        sessionId: "1#user",
                        prompt: [{ type: "text", text: "Prompt before 429" }],
                        _meta: { plurnk: { messageId: "msg-fail-1" } },
                    });
                    await waitFor(() =>
                        scoutUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                    );

                    // Message published into log (leaves inbox, stays in openMessages until loop/terminated)
                    h.port.inbox.length = 0;
                    h.port.emitEvent(1, "log/entry", {
                        entry: makeLogEntry({
                            id: 501,
                            session_id: 1,
                            origin: "_plurnk",
                            op: "send",
                            source: scoutSource1,
                            tx: "Prompt before 429",
                            attrs: { kind: "message" },
                        }),
                    });
                    const statusWhileRunning = await scoutConn.request(methods.agent.session.status, {
                        sessionId: "1#user",
                    });
                    assert.deepEqual(statusWhileRunning.state, { state: "running" });

                    // SQLite loops_settle_mailbox_on_terminate clears openMessages when loop terminates 429
                    h.port.openMessages.length = 0;
                    h.port.emitEvent(1, "loop/terminated", {
                        sessionId: 1,
                        loopId: 1,
                        loopSeq: 1,
                        turnIds: [1],
                        hitMaxTurns: true,
                        result: { status: 429 },
                        usage: { curationWeight: 50, curationBudget: 1000, contextTokens: 50, contextCapacity: 1000 },
                    });

                    await waitFor(() =>
                        scoutUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                    );
                    const scoutIdle = scoutUpdates.filter(
                        (u): u is Extract<SessionUpdate, { sessionUpdate: "state_update"; state: "idle" }> =>
                            u.sessionUpdate === "state_update" && u.state === "idle",
                    );
                    assert.equal(scoutIdle.length, 1, "named principal receives exactly one terminal idle state_update");
                    assert.equal(scoutIdle[0]?.stopReason, "max_turn_requests");
                    assert.equal(
                        scoutUpdates.some(
                            (u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "tool_call_update",
                        ),
                        false,
                        "named principal receives no synthetic agent_message_chunk or tool_call_update",
                    );
                    const statusAfter429 = await scoutConn.request(methods.agent.session.status, {
                        sessionId: "1#user",
                    });
                    assert.deepEqual(statusAfter429.state, { state: "idle" });

                    // 2. Named principal prompt completed via SEND + WAIT (parked at 202 while awaiting another obligation) settles principal on loop_status = 202.
                    scoutUpdates.length = 0;
                    const scoutSource2 = "acp://scoutproxy/sessions/1%23user/messages/msg-wait-2";
                    h.port.runLoop = async ({ messageAddress }) => {
                        const msg = {
                            path: "message://user/scoutproxy_01",
                            source: messageAddress ?? scoutSource2,
                            loopId: 2,
                            lifecycle: "running" as const,
                            body: "Prompt answered before WAIT",
                        };
                        h.port.inbox.push(msg);
                        h.port.openMessages.push(msg);
                        return {
                            status: 200,
                            action: "enqueued_new_loop" as const,
                            sessionId: 1,
                            loopId: 2,
                            resource: "message://user/scoutproxy_01",
                        };
                    };
                    await scoutConn.request(methods.agent.session.prompt, {
                        sessionId: "1#user",
                        prompt: [{ type: "text", text: "Prompt answered before WAIT" }],
                        _meta: { plurnk: { messageId: "msg-wait-2" } },
                    });
                    await waitFor(() =>
                        scoutUpdates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
                    );
                    h.port.inbox.length = 0;
                    h.port.emitEvent(1, "log/entry", {
                        entry: {
                            ...makeLogEntry({
                                id: 502,
                                session_id: 1,
                                loop_id: 2,
                                loop_seq: 2,
                                origin: "model",
                                op: "send",
                                pathname: "message://user/scoutproxy_01",
                                tx: JSON.stringify({ op: "send", target: "message://user/scoutproxy_01", body: "Answered before parking." }),
                                rx: { status: 200, repliedTo: ["message://user/scoutproxy_01"] },
                            }),
                            replied_to_sources: [scoutSource2],
                        },
                    });
                    // WAIT completes openMessages for scoutproxy and parks loop at 202
                    h.port.openMessages.length = 0;
                    h.port.emitEvent(1, "notice/event", {
                        sessionId: 1,
                        loopId: 2,
                        notice: {
                            level: "info",
                            source: "engine:lifecycle",
                            kind: "loop_status",
                            message: "",
                            status: 202,
                            loopSeq: 2,
                            waitUntil: null,
                            packetCount: 1,
                            claimedAt: "2026-01-01T00:00:00.000Z",
                        },
                    });
                    await waitFor(() =>
                        scoutUpdates.some(
                            (u) => u.sessionUpdate === "state_update" && u.state === "idle" && u.stopReason === "end_turn",
                        ),
                    );

                    // 3. Caller SEND tool_call_update transitions to status: "failed" on 'DOWN' fail (completion: 499) discharge.
                    operatorUpdates.length = 0;
                    h.port.emitEvent(1, "log/entry", {
                        entry: makeLogEntry({
                            id: 601,
                            session_id: 1,
                            loop_id: 3,
                            loop_seq: 3,
                            turn_id: 3,
                            turn_seq: 1,
                            sequence: 1,
                            origin: "model",
                            op: "send",
                            scheme: "session",
                            hostname: "worker",
                            pathname: "",
                            tx: JSON.stringify({ op: "send", target: "session://worker", body: "Need answer" }),
                            rx: { status: 200, resource: "message://worker/00" },
                        }),
                    });
                    h.port.emitEvent(1, "log/entry", {
                        entry: {
                            ...makeLogEntry({
                                id: 602,
                                session_id: 1,
                                loop_id: 3,
                                loop_seq: 3,
                                turn_id: 4,
                                turn_seq: 2,
                                sequence: 1,
                                origin: "_plurnk",
                                op: "fail",
                                source: "session://worker",
                                pathname: "session://user",
                                tx: JSON.stringify({
                                    op: "fail",
                                    target: "session://user",
                                    body: "Loop 1 ended with status 500; this message was not answered.",
                                }),
                                rx: {
                                    status: 200,
                                    repliedTo: ["message://worker/00"],
                                    completion: 499,
                                },
                                attrs: { kind: "reply", messageId: 901 },
                            }),
                            invocation: "log:///3/1/1/send",
                            answering: "log:///3/1/1/send",
                        },
                    });
                    await waitFor(() =>
                        operatorUpdates.some(
                            (u) =>
                                u.sessionUpdate === "tool_call_update" &&
                                u.toolCallId === "3/1/1" &&
                                u.status === "failed",
                        ),
                    );
                    const subagentIdx = operatorUpdates.findIndex(
                        (u) => u.sessionUpdate === "subagent_update" && u.sessionId === "1#worker",
                    );
                    const openingSendIdx = operatorUpdates.findIndex(
                        (u) =>
                            u.sessionUpdate === "tool_call_update" &&
                            u.toolCallId === "3/1/1" &&
                            Array.isArray(u.content) &&
                            u.content.some((c) => c.type === "session" && c.sessionId === "1#worker"),
                    );
                    assert.ok(subagentIdx >= 0, "session-targeting tool_call_update is preceded by subagent_update");
                    assert.ok(openingSendIdx > subagentIdx, "tool_call_update carries ACPv2 2.7.0 SessionReference after subagent_update");
                });
            });
        } finally {
            await h.close();
        }
    });
});
