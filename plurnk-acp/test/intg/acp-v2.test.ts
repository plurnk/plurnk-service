import test from "node:test";
import assert from "node:assert/strict";
import {
    AGENT_METHODS,
    CLIENT_METHODS,
    methods,
    PROTOCOL_VERSION,
    SessionUpdate,
    type SessionUpdate as SessionUpdateType,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { WsConstructor, createAcpClient, createHarness } from "../harness.ts";

// Compile-time & runtime exhaustiveness over `@agentclientprotocol/sdk/experimental/v2/unstable` ({§acp-first-party-client-conformance}, #1359).
const AGENT_METHOD_POSTURE = {
    initialize: "supported",
    auth_login: "oauth-out-of-band",
    auth_status: "oauth-out-of-band",
    providers_list: "supported",
    providers_set: "config-option",
    providers_disable: "config-option",
    session_new: "supported",
    session_set_config_option: "supported",
    session_prompt: "supported",
    session_cancel: "supported",
    mcp_message: "supported",
    session_list: "supported",
    session_delete: "supported",
    session_fork: "supported",
    session_archive: "tracked-#1396",
    session_unarchive: "tracked-#1396",
    session_status: "tracked-#1396",
    session_set_title: "tracked-#1396",
    session_resume: "supported",
    session_close: "supported",
    tool_call_cancel: "tracked-#1396",
    terminal_cancel: "tracked-#1396",
    auth_logout: "oauth-out-of-band",
} as const satisfies Record<keyof typeof AGENT_METHODS, string>;

const CLIENT_METHOD_POSTURE = {
    session_request_permission: "supported",
    session_update: "supported",
    mcp_message: "supported",
    elicitation_create: "supported",
    elicitation_complete: "supported",
    auth_status_update: "oauth-out-of-band",
} as const satisfies Record<keyof typeof CLIENT_METHODS, string>;

const SESSION_UPDATE_POSTURE = {
    isUserMessageChunk: "emitted",
    isUserMessage: "chunk-streamed",
    isAgentMessageChunk: "emitted",
    isAgentMessage: "chunk-streamed",
    isAgentThoughtChunk: "emitted",
    isAgentThought: "chunk-streamed",
    isStateUpdate: "emitted",
    isToolCallContentChunk: "update-carried",
    isToolCallUpdate: "emitted",
    isTerminalUpdate: "emitted",
    isTerminalOutputChunk: "emitted",
    isPlanUpdate: "emitted",
    isPlanRemoved: "emitted",
    isAvailableCommandsUpdate: "emitted",
    isConfigOptionUpdate: "emitted",
    isSessionInfoUpdate: "emitted",
    isUsageUpdate: "emitted",
    isNotice: "emitted",
    isCompactionUpdate: "model-curated",
    isCompactionSummaryChunk: "model-curated",
    isSubagentUpdate: "emitted",
    isSessionMessage: "emitted",
    isSessionMessageChunk: "message-upserted",
    isCustom: "unused",
} as const satisfies Record<keyof typeof SessionUpdate, string>;

test("{§acp-first-party-client-conformance}: stock @agentclientprotocol/sdk v2 surface is exhaustively classified and exercised over WebSocket and Streamable HTTP (#1359)", async () => {
    assert.deepEqual(Object.keys(AGENT_METHOD_POSTURE).toSorted(), Object.keys(AGENT_METHODS).toSorted());
    assert.deepEqual(Object.keys(CLIENT_METHOD_POSTURE).toSorted(), Object.keys(CLIENT_METHODS).toSorted());
    assert.deepEqual(Object.keys(SESSION_UPDATE_POSTURE).toSorted(), Object.keys(SessionUpdate).toSorted());

    const h = await createHarness();
    try {
        const wsUpdates: SessionUpdateType[] = [];
        const wsStream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
        const wsApp = createAcpClient()
            .onNotification(methods.client.session.update, ({ params }) => {
                wsUpdates.push(params.update);
            })
            .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                const allow = params.options.find((o) => o.kind === "allow_once");
                return { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow_once" } };
            })
            .onRequest(methods.client.elicitation.create, async () => ({
                action: "accept",
                content: { answer: "approved" },
            }));

        await wsApp.connectWith(wsStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);

            const providers = await ctx.request(methods.agent.providers.list, {});
            assert.ok(providers.providers.length > 0);

            await ctx.buildSession("/workspace/alpha").withSession(async (session) => {
                await session.prompt("hello over ws");
                const text = await session.readTextUntilIdle();
                assert.match(text, /Echo: hello over ws/);
            });

            const updatedCfg = await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: "1#user",
                configId: "thought_level",
                type: "id",
                value: "high",
            });
            assert.ok(
                updatedCfg.configOptions.some(
                    (c) => c.configId === "thought_level" && "currentValue" in c && c.currentValue === "high",
                ),
            );

            const forked = await ctx.request(methods.agent.session.fork, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            assert.match(forked.sessionId, /^1#/);

            const listed = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(listed.sessions.some((s) => s.sessionId === forked.sessionId));

            await ctx.notify(methods.agent.session.cancel, {
                sessionId: forked.sessionId,
            });
            await ctx.request(methods.agent.session.delete, {
                sessionId: forked.sessionId,
            });
            await ctx.request(methods.agent.session.close, {
                sessionId: "1#user",
            });
        });

        assert.ok(wsUpdates.some((u) => SessionUpdate.isAgentMessageChunk(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isStateUpdate(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isUsageUpdate(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isConfigOptionUpdate(u)));

        const httpStream = createHttpStream(h.baseUrl);
        const httpApp = createAcpClient();
        await httpApp.connectWith(httpStream, async (ctx) => {
            const init = await ctx.initialized;
            assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            const resumed = await ctx.request(methods.agent.session.resume, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            assert.ok(resumed.configOptions);
        });
    } finally {
        await h.close();
    }
});
