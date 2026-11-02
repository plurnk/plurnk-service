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

// Compile-time & runtime exhaustiveness over `@agentclientprotocol/sdk/experimental/v2/unstable` ({§acp-first-party-client-conformance}, #1359, #1396).
const AGENT_METHOD_POSTURE = {
    initialize: "supported",
    auth_login: "oauth-out-of-band",
    auth_status: "supported",
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
    session_archive: "supported",
    session_unarchive: "supported",
    session_status: "supported",
    session_set_title: "supported",
    session_resume: "supported",
    session_close: "supported",
    tool_call_cancel: "supported",
    terminal_cancel: "supported",
    auth_logout: "supported",
} as const satisfies Record<keyof typeof AGENT_METHODS, "supported" | "config-option" | "oauth-out-of-band">;

const CLIENT_METHOD_POSTURE = {
    session_request_permission: "supported",
    session_update: "supported",
    mcp_message: "supported",
    elicitation_create: "supported",
    elicitation_complete: "supported",
    auth_status_update: "supported",
} as const satisfies Record<keyof typeof CLIENT_METHODS, "supported">;

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
            assert.ok(init.response.capabilities?.session?.archive);
            assert.ok(init.response.capabilities?.session?.delete);
            assert.ok(init.response.capabilities?.session?.status);
            assert.ok(init.response.capabilities?.session?.title);
            assert.ok(init.response.capabilities?.auth?.status);

            const authStatus = await ctx.request(methods.agent.auth.status, {});
            assert.equal(authStatus.state, "authenticated");
            assert.ok(Array.isArray(authStatus.accounts) && authStatus.accounts.length > 0);
            const loggedOut = await ctx.request(methods.agent.auth.logout, {});
            assert.deepEqual(loggedOut, {});

            const providers = await ctx.request(methods.agent.providers.list, {});
            assert.ok(providers.providers.length > 0);

            let builtSessionId = "";
            await ctx.buildSession("/workspace/alpha").withSession(async (session) => {
                builtSessionId = session.sessionId;
                await session.prompt("hello over ws");
                const text = await session.readTextUntilIdle();
                assert.match(text, /Echo: hello over ws/);

                const openStatus = await ctx.request(methods.agent.session.status, {
                    sessionId: session.sessionId,
                });
                assert.equal(openStatus.status, "open");
                assert.equal(openStatus.state?.state, "idle");
            });

            await ctx.request(methods.agent.session.close, {
                sessionId: builtSessionId,
            });
            const savedAfterCloseBuilt = await ctx.request(methods.agent.session.status, {
                sessionId: builtSessionId,
            });
            assert.equal(savedAfterCloseBuilt.status, "saved");

            const savedBeforeAttach = await ctx.request(methods.agent.session.status, {
                sessionId: "1#user",
            });
            assert.equal(savedBeforeAttach.status, "saved");

            const titled = await ctx.request(methods.agent.session.setTitle, {
                sessionId: "1#user",
                title: "  ACP v2 Session Title  ",
            });
            assert.equal(titled.title, "ACP v2 Session Title");

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
            const openAfterSetConfig = await ctx.request(methods.agent.session.status, {
                sessionId: "1#user",
            });
            assert.equal(openAfterSetConfig.status, "open");

            const retitledWhileOpen = await ctx.request(methods.agent.session.setTitle, {
                sessionId: "1#user",
                title: "ACP v2 Session Title",
            });
            assert.equal(retitledWhileOpen.title, "ACP v2 Session Title");

            // Exercise tool_call/cancel on a pending proposal and terminal/cancel on an open stream
            h.port.proposals.push({
                logEntryId: 400,
                sessionId: 1,
                session: "user",
                loopId: 1,
                turnId: 2,
                coordinate: "1/2/1",
                op: "EDIT",
                target: { scheme: "file", authority: null, pathname: "/workspace/alpha/notes.txt" },
                attrs: {},
                body: "updated content",
                disposition: {
                    decision: "review",
                },
                owner: "acp://operator",
            });
            await ctx.request(methods.agent.toolCall.cancel, {
                sessionId: "1#user",
                toolCallId: "1/2/1",
            });
            await assert.rejects(
                () =>
                    ctx.request(methods.agent.toolCall.cancel, {
                        sessionId: "1#user",
                        toolCallId: "1/2/1",
                    }),
                (err: { code?: number }) => err.code === -32602,
            );

            h.port.streams.push({
                entryId: 500,
                sessionId: 1,
                target: "exec:///1/2/2",
                lifetime: "turn",
                loop_seq: 1,
                turn_seq: 2,
                sequence: 2,
                channels: [{ channel: "body", state: "active", mimetype: "text/plain" }],
            });
            await ctx.request(methods.agent.terminal.cancel, {
                sessionId: "1#user",
                terminalId: "term:500",
            });
            await assert.rejects(
                () =>
                    ctx.request(methods.agent.terminal.cancel, {
                        sessionId: "1#user",
                        terminalId: "term:500",
                    }),
                (err: { code?: number }) => err.code === -32602,
            );

            const forked = await ctx.request(methods.agent.session.fork, {
                sessionId: "1#user",
                cwd: "/workspace/alpha",
            });
            assert.match(forked.sessionId, /^1#/);

            const listed = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(listed.sessions.some((s) => s.sessionId === forked.sessionId && s.archived === false));
            assert.equal(listed.sessions.find((s) => s.sessionId === "1#user")?.title, "ACP v2 Session Title");

            await ctx.request(methods.agent.session.archive, {
                sessionId: forked.sessionId,
            });
            const statusAfterArchive = await ctx.request(methods.agent.session.status, {
                sessionId: forked.sessionId,
            });
            assert.equal(statusAfterArchive.status, "saved");

            const listedDefaultAfterArchive = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
            });
            assert.ok(!listedDefaultAfterArchive.sessions.some((s) => s.sessionId === forked.sessionId));

            const listedOnlyArchived = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
                archived: "only",
            });
            assert.ok(listedOnlyArchived.sessions.some((s) => s.sessionId === forked.sessionId && s.archived === true));

            await ctx.request(methods.agent.session.unarchive, {
                sessionId: forked.sessionId,
            });
            const statusAfterUnarchive = await ctx.request(methods.agent.session.status, {
                sessionId: forked.sessionId,
            });
            assert.equal(statusAfterUnarchive.status, "saved");

            await ctx.notify(methods.agent.session.cancel, {
                sessionId: forked.sessionId,
            });
            await ctx.request(methods.agent.session.delete, {
                sessionId: forked.sessionId,
            });
            await assert.rejects(
                () =>
                    ctx.request(methods.agent.session.status, {
                        sessionId: forked.sessionId,
                    }),
                (err: { code?: number }) => err.code === -32002,
            );
            const listedIncludeAfterDelete = await ctx.request(methods.agent.session.list, {
                cwd: "/workspace/alpha",
                archived: "include",
            });
            assert.ok(!listedIncludeAfterDelete.sessions.some((s) => s.sessionId === forked.sessionId));

            await ctx.request(methods.agent.session.close, {
                sessionId: "1#user",
            });
            const statusAfterClose = await ctx.request(methods.agent.session.status, {
                sessionId: "1#user",
            });
            assert.equal(statusAfterClose.status, "saved");
        });

        assert.ok(wsUpdates.some((u) => SessionUpdate.isAgentMessageChunk(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isStateUpdate(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isUsageUpdate(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isConfigOptionUpdate(u)));
        assert.ok(wsUpdates.some((u) => SessionUpdate.isSessionInfoUpdate(u)));
        assert.ok(
            wsUpdates.some(
                (u) =>
                    SessionUpdate.isToolCallUpdate(u) &&
                    u.toolCallId === "1/2/1" &&
                    u.status === "cancelled" &&
                    u.capabilities?.cancel === null,
            ),
        );
        assert.ok(
            wsUpdates.some(
                (u) =>
                    SessionUpdate.isTerminalUpdate(u) &&
                    u.terminalId === "term:500" &&
                    u.exitStatus?.exitCode === 499 &&
                    u.capabilities?.cancel === null,
            ),
        );

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
