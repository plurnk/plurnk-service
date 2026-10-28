import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    methods,
    PROTOCOL_VERSION,
    type SessionUpdate,
    type RequestPermissionRequest,
    type CreateElicitationRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import {
    Validator,
    type AcpDiscovery,
    type ClientInteractionProjection,
    type Notice,
    type ProposalProjection,
    type ReasoningEventNotification,
} from "@plurnk/plurnk-contracts";
import Module from "./Module.ts";
import type { AcpPlusState, ActionOutcome } from "./client.ts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    makeLogEntry,
    makeTerminatedEvent,
} from "../test/harness.ts";

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 10));
    }
};

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

    test("{§acp-http-authorization} {§acp-daemon-client}: Streamable HTTP, WebSocket, CORS, OAuth perimeter, and revocation", async () => {
        const h = await createHarness({
            authMode: "oauth",
            env: { PLURNK_ACP_HEARTBEAT_MS: "20" },
        });
        try {
            const preflight = await fetch(h.baseUrl, { method: "OPTIONS" });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

            const unauth = await fetch(h.baseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(unauth.status, 401);
            assert.ok(unauth.headers.get("www-authenticate")?.includes("Bearer"));
            const unauthProblem = (await unauth.json()) as Record<string, unknown>;
            assert.match(String(unauthProblem.code), /bearer-token-required/);

            const badScope = await fetch(h.baseUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer no-scope-token",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(badScope.status, 403);

            const initPost = await fetch(h.baseUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer valid-token",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(initPost.status, 200);
            const connId = initPost.headers.get("acp-connection-id");
            assert.ok(connId, "initialize returns Acp-Connection-Id");
            await initPost.text();

            const sseAbort = new AbortController();
            const sseRes = await fetch(h.baseUrl, {
                method: "GET",
                headers: {
                    accept: "text/event-stream",
                    authorization: "Bearer valid-token",
                    "acp-connection-id": connId,
                },
                signal: sseAbort.signal,
            });
            assert.equal(sseRes.status, 200);
            assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/i);
            const reader = sseRes.body?.getReader();
            assert.ok(reader, "SSE response has readable body");
            const decoder = new TextDecoder();
            let sseText = "";
            while (!sseText.includes(": heartbeat")) {
                const { done, value } = await reader.read();
                if (done) break;
                sseText += decoder.decode(value, { stream: true });
            }
            assert.match(sseText, /: heartbeat/, "SSE stream emits heartbeat comments at PLURNK_ACP_HEARTBEAT_MS");
            sseAbort.abort();
            await reader.cancel().catch(() => undefined);

            const httpStream = createHttpStream(h.baseUrl, {
                headers: { authorization: "Bearer valid-token" },
            });
            const app = createAcpClient();
            await app.connectWith(httpStream, async (ctx) => {
                const init = await ctx.initialized;
                assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
                assert.ok(init.response.capabilities?.session);
                assert.ok(init.response.capabilities?.session?.fork);
            });

            const wsStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer valid-token" },
            });
            const wsClient = createAcpClient();
            const conn = wsClient.connect(wsStream);
            await conn.initialized;
            h.port.revokeFamily("fam-1");
            await conn.closed;
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
                    _meta: { plurnk: { name: "alice" } },
                });
                assert.equal(created.sessionId, "1#alice");
                assert.ok(Array.isArray(created.configOptions));
                assert.ok(created.configOptions?.some((opt) => opt.configId === "model"));
                assert.ok(created.configOptions?.some((opt) => opt.configId === "thought_level"));
                assert.ok(Array.isArray(created.availableCommands));
                assert.ok(created.availableCommands?.some((cmd) => cmd.name === "mcp"));

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

                const listedBefore = await ctx.request(methods.agent.session.list, {
                    cwd: "/workspace/alpha",
                });
                assert.ok(listedBefore.sessions.some((s) => s.sessionId === forked.sessionId));

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

    test("{§acp-action-binding} {§acp-status-descendants}: session/set_config_option, config_option_update, and providers/list", async () => {
        const h = await createHarness();
        try {
            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                const session = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                });
                const plurnkMeta = (
                    session._meta as
                        | { plurnk?: { workspace?: { name?: string }; providers?: Array<{ alias?: string }> } }
                        | undefined
                )?.plurnk;
                assert.equal(plurnkMeta?.workspace?.name, "alpha");
                assert.equal(plurnkMeta?.providers?.[0]?.alias, "fast");

                const providers = await ctx.request(methods.agent.providers.list, {});
                assert.ok(providers.providers.length > 0);

                const updatedModel = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "model",
                    type: "id",
                    value: "mocktest/mock-v1",
                });
                assert.ok(updatedModel.configOptions.some((c) => c.configId === "model"));

                const updatedEffort = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "thought_level",
                    type: "id",
                    value: "high",
                });
                assert.ok(updatedEffort.configOptions.some((c) => c.configId === "thought_level"));
                assert.ok(updates.some((u) => u.sessionUpdate === "config_option_update"));

                const updatedAllowMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "allow",
                });
                const allowModeOption = updatedAllowMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(allowModeOption?.currentValue, "allow");

                const updatedDenyMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "deny",
                });
                const denyModeOption = updatedDenyMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(denyModeOption?.currentValue, "deny");

                const updatedProposeMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "propose",
                });
                const proposeModeOption = updatedProposeMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(proposeModeOption?.currentValue, "propose");

                const updatedSpawnModel = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "spawn_model",
                    type: "id",
                    value: "fast",
                });
                const spawnModelOption = updatedSpawnModel.configOptions.find((c) => c.configId === "spawn_model");
                assert.equal(spawnModelOption?.currentValue, "mocktest/fast");
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
                });
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-plurnk-metadata} {§acp-body-reference} {§acp-status-descendants} {§acp-action-binding} {§acp-topology-scope}: event projection for thoughts, tool calls, diffs, terminals, subagents, outside text, notices, and entry route", async () => {
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

                h.port.emitEvent(1, "outside/event", {
                    sessionId: 1,
                    loopId: 1,
                    turnId: 1,
                    coordinate: "1/1/0",
                    text: "Outside commentary",
                    tokens: 3,
                });

                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 10,
                        session_id: 1,
                        sequence: 2,
                        op: "EDIT",
                        tx: { op: "EDIT", aside: "update x" },
                        attrs: {
                            path: "/workspace/alpha/file.ts",
                            original: "const x = 1;\n",
                            patched: "const x = 2;\n",
                        },
                        rx: { status: 200, content: "const x = 2;\n", mimetype: "text/plain" },
                    }),
                });

                h.port.entryContents.set("sh://11#stdout", "hi\n");
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 11,
                        session_id: 1,
                        sequence: 3,
                        op: "sh",
                        status_rx: 202,
                        attrs: { tag: "sh", body: "echo hi", stream: "sh://11" },
                        rx: { status: 202, content: "", mimetype: "text/plain" },
                    }),
                });
                h.port.emitEvent(1, "stream/event", {
                    sessionId: 1,
                    entryId: 11,
                    target: "sh://11",
                    channel: "stdout",
                    state: "active",
                    contentLength: 3,
                });
                h.port.emitEvent(1, "stream/concluded", {
                    sessionId: 1,
                    entryId: 11,
                    target: "sh://11",
                    result: { status: 200 },
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 12,
                        session_id: 1,
                        turn_seq: 2,
                        sequence: 1,
                        origin: "system",
                        op: "READ",
                        source: "sh://11",
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
                        attrs: { attempt: { verb: "READ", text: "READ bad" } },
                        rx: { status: 400, content: "Refused READ", mimetype: "text/plain" },
                    }),
                });

                const notice: Notice = {
                    source: "acp",
                    kind: "test-notice",
                    level: "warn",
                    message: "Watch out",
                };
                h.port.emitEvent(1, "notice/event", { notice });

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
                    hidden_at: null,
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 14,
                        session_id: 2,
                        session_name: "helper",
                        loop_id: 2,
                        turn_id: 2,
                        op: "SEND",
                        attrs: { kind: "message", to: "session://user", body: "Child progress" },
                        rx: { status: 200, content: "Child progress", mimetype: "text/markdown" },
                        mimetype_rx: "text/markdown",
                    }),
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
                                u.sessionUpdate === "subagent_update" &&
                                u.sessionId === "1#helper" &&
                                (u.state as { state?: string } | undefined)?.state === "idle",
                        ),
                );

                assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
                assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
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
                assert.ok(updates.some((u) => u.sessionUpdate === "notice"));
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
                            (u.state as { state?: string } | undefined)?.state === "idle",
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
                        const plurnk = (u._meta as { plurnk?: { budget?: Record<string, unknown> } } | undefined)?.plurnk;
                        return (
                            plurnk?.budget?.curationWeight === 420 &&
                            plurnk?.budget?.curationBudget === 4000 &&
                            plurnk?.budget?.contextTokens === 840 &&
                            plurnk?.budget?.contextCapacity === 8000
                        );
                    }),
                );

                const entryUrl = `${h.baseUrl}/1/1/entry?target=${encodeURIComponent("log:///1/1/2/EDIT")}`;
                const entryRes = await fetch(entryUrl);
                assert.equal(entryRes.status, 200);
                assert.equal(await entryRes.text(), "Body for log:///1/1/2/EDIT");

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

    test("{§acp-proposal-resolve} {§acp-session-owner}: session/request_permission, elicitation/create, elicitation/complete, and multi-peer $/cancel_request", async () => {
        const h = await createHarness();
        try {
            const permissionRequests1: RequestPermissionRequest[] = [];
            const permissionRequests2: RequestPermissionRequest[] = [];
            const elicitations1: CreateElicitationRequest[] = [];
            const completedElicitations: string[] = [];

            const stream1 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const stream2 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });

            const client1 = createAcpClient()
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests1.push(params);
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                })
                .onRequest(methods.client.elicitation.create, async ({ params }) => {
                    elicitations1.push(params);
                    return { action: "accept", content: { answer: "42" } };
                })
                .onNotification(methods.client.elicitation.complete, ({ params }) => {
                    completedElicitations.push(params.elicitationId);
                });

            let peer2Cancelled = false;
            const client2 = createAcpClient().onRequest(
                methods.client.session.requestPermission,
                async ({ params, signal }) => {
                    permissionRequests2.push(params);
                    await new Promise<void>((resolve) => {
                        signal.addEventListener("abort", () => {
                            peer2Cancelled = true;
                            resolve();
                        });
                    });
                    return { outcome: { outcome: "cancelled" } };
                },
            );

            await client1.connectWith(stream1, async (ctx1) => {
                await client2.connectWith(stream2, async (ctx2) => {
                    await ctx1.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });
                    await ctx2.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });

                    const proposal: ProposalProjection = {
                        logEntryId: 501,
                        sessionId: 1,
                        session: "user",
                        loopId: 1,
                        turnId: 1,
                        coordinate: "1/1/1",
                        op: "sh",
                        target: { scheme: "sh", authority: null, pathname: null },
                        body: "rm -rf build",
                        disposition: { decision: "review" },
                        owner: "acp://operator",
                        attrs: { tag: "sh", body: "rm -rf build", cwd: "/workspace/alpha" },
                        subject: { type: "command", command: "rm -rf build", cwd: "/workspace/alpha" },
                    };
                    h.port.proposals.push(proposal);
                    h.port.emitEvent(1, "loop/proposal", proposal);

                    const interaction: ClientInteractionProjection = {
                        interactionId: 601,
                        sessionId: 1,
                        loopId: 1,
                        turnId: 1,
                        recipient: "acp://operator",
                        request: {
                            toolName: "question",
                            mode: "form",
                            message: "What is the answer?",
                            requestedSchema: {
                                type: "object",
                                properties: { answer: { type: "string", title: "Answer" } },
                                required: ["answer"],
                            },
                        },
                    };
                    h.port.interactions.push(interaction);
                    h.port.emitEvent(1, "loop/interaction", interaction);

                    await waitFor(
                        () =>
                            h.port.proposals.length === 0 &&
                            peer2Cancelled &&
                            h.port.interactions.length === 0 &&
                            completedElicitations.length > 0,
                    );

                    assert.equal(permissionRequests1.length, 1);
                    assert.equal(permissionRequests1[0]?.subject?.type, "command");
                    assert.deepEqual(
                        permissionRequests1[0]?.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
                        [
                            { optionId: "allow_once", kind: "allow_once" },
                            { optionId: "allow_always", kind: "allow_always" },
                            { optionId: "reject_once", kind: "reject_once" },
                            { optionId: "reject_always", kind: "reject_always" },
                        ],
                    );
                    assert.equal(h.port.proposals.length, 0, "proposal resolved in port");
                    assert.equal(peer2Cancelled, true, "second peer received $/cancel_request ({§acp-proposal-resolve})");

                    assert.equal(elicitations1.length, 1);
                    assert.equal(elicitations1[0]?.mode, "form");
                    assert.equal(h.port.interactions.length, 0, "interaction resolved in port");
                    assert.ok(completedElicitations.length > 0, "elicitation/complete emitted");
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
                    op: "SEND",
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
                    op: "SEND",
                    attrs: { kind: "message", to: "acp://operator", body: "Loop 1 answer" },
                    rx: { status: 200, content: "Loop 1 answer", mimetype: "text/markdown" },
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
                    op: "SEND",
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
                    op: "SEND",
                    attrs: { kind: "message", to: "acp://operator", body: "X".repeat(600) },
                    rx: { status: 200, content: "X".repeat(600), mimetype: "text/markdown" },
                    mimetype_rx: "text/markdown",
                }),
            );

            const replayed: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                replayed.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                const resumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                });
                const historyMeta = (
                    resumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
                )?.plurnk?.history;
                assert.ok(historyMeta?.older, "older history link is present");
                await waitFor(
                    () =>
                        replayed.some((u) => u.sessionUpdate === "user_message_chunk") &&
                        replayed.some((u) => u.sessionUpdate === "agent_message_chunk"),
                );
                assert.ok(replayed.some((u) => u.sessionUpdate === "user_message_chunk"));
                assert.ok(replayed.some((u) => u.sessionUpdate === "agent_message_chunk"));

                const pageRes = await fetch(historyMeta.older);
                assert.equal(pageRes.status, 200);
                const page = (await pageRes.json()) as Record<string, unknown>;
                assert.ok(Array.isArray(page.updates));

                const loopRes = await fetch(`${h.baseUrl}/1/1/messages?session=${encodeURIComponent("1#user")}&loop=1`);
                assert.equal(loopRes.status, 200);
                const loopPage = (await loopRes.json()) as Record<string, unknown>;
                assert.ok(Array.isArray(loopPage.updates));
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-overview} {§acp-action-binding} {§contract-representations} {§acp-http-authorization}: session/list directory, slash commands, _plurnk/action, op.parse, and discovery contract", async () => {
        const h = await createHarness();
        try {
            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                const listed = await ctx.request(methods.agent.session.list, {});
                assert.ok(listed.sessions.length >= 1);
                const firstMeta = listed.sessions[0]?._meta as
                    | { plurnk?: { reply?: { body?: { url?: string } } } }
                    | undefined;
                assert.ok(firstMeta?.plurnk?.reply?.body?.url);

                const discovered = await ctx.request<AcpDiscovery>("_plurnk/action", {
                    kind: "discover",
                    params: {},
                });
                assert.equal(discovered.schemaVersion, 1);
                assert.ok(discovered.actions["workspace.mcp.list"]);
                Validator.assertAcpDiscovery(discovered);

                const loops = await ctx.request<{ items?: unknown[]; updates?: unknown[] } | unknown[]>("_plurnk/action", {
                    kind: "session.loops",
                    workspace: "alpha",
                    params: { loopSeq: 1 },
                });
                assert.ok(Array.isArray(Array.isArray(loops) ? loops : loops.items));
                assert.ok(!Array.isArray(loops) && Array.isArray(loops.updates));

                const parsedOk = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                    kind: "op.parse",
                    workspace: "alpha",
                    params: { text: "```NOTE\nremember this\n```\n" },
                });
                assert.ok(Array.isArray(parsedOk.results));
                assert.equal(parsedOk.results[0]?.status, 200);

                const parsedBad = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                    kind: "op.parse",
                    workspace: "alpha",
                    params: { text: "INVALID_VERB ???\n" },
                });
                assert.ok(Array.isArray(parsedBad.results));
                assert.equal(parsedBad.results[0]?.status, 400);

                const mcpList = await ctx.request<Record<string, unknown>>("_plurnk/action", {
                    kind: "workspace.mcp.list",
                    workspace: "alpha",
                    params: {},
                });
                assert.deepEqual(mcpList, { items: [] });

                await assert.rejects(
                    () => ctx.request("_plurnk/action", { kind: "no.such.action", params: {} }),
                    /Action 'no\.such\.action' is not registered\. Recovery: Use an action advertised by discover\./,
                );
                await assert.rejects(
                    () =>
                        ctx.request("_plurnk/action", {
                            kind: "workspace.mcp.list",
                            workspace: "alpha",
                            params: { unexpectedField: 123 },
                        }),
                    /Action 'workspace\.mcp\.list' rejected parameters\./,
                );
                await assert.rejects(
                    () =>
                        ctx.request("_plurnk/action", {
                            kind: "ping",
                            params: { unexpectedField: 123 },
                        }),
                    /Action 'ping' rejected parameters\./,
                );
                assert.equal(discovered.actions.ping?.inputSchema.additionalProperties, false);
                assert.deepEqual(discovered.actions["op.parse"]?.inputSchema.required, ["text"]);

                const updateAction = await ctx.request<{ catalog: { status: string }; service: { artifact: string } }>(
                    "_plurnk/action",
                    { kind: "service.update", params: {} },
                );
                assert.equal(updateAction.catalog.status, "updated");
                assert.equal(updateAction.service.artifact, "source");

                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/mcp list" }],
                });
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: "1#user",
                            prompt: [{ type: "text", text: "/env list" }],
                        }),
                    /Action 'session\.env\.list' is not registered\./,
                );
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/update" }],
                });
                await waitFor(() => updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
                assert.ok(updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
            });
        } finally {
            await h.close();
        }
    });
});
