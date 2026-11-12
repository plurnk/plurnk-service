import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    McpOverAcpProvider,
    methods,
    PlanUpdateContent,
    PROTOCOL_VERSION,
    SessionUpdate,
    type ContentBlock,
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
import SessionTranslator from "./SessionTranslator.ts";
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
                assert.ok(init.response.capabilities?.providers);
                assert.equal(init.response.capabilities?.session?.prompt?.audio, undefined);
            });

            const scoutStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer scoutproxy-token" },
            });
            const scoutUpdates: SessionUpdate[] = [];
            const scoutApp = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                scoutUpdates.push(params.update);
            });
            let capturedScoutRunLoop: Parameters<typeof h.port.runLoop>[0] | undefined;
            const origRunLoop = h.port.runLoop.bind(h.port);
            h.port.runLoop = async (args) => {
                capturedScoutRunLoop = args;
                return origRunLoop(args);
            };
            try {
                await scoutApp.connectWith(scoutStream, async (ctx) => {
                    await ctx.initialized;
                    const created = await ctx.request(methods.agent.session.new, {
                        cwd: "/workspace/family",
                        _meta: { plurnk: { name: "gookie" } },
                    });
                    const promptRes = await ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "What is on the schedule?" }],
                        _meta: { plurnk: { messageId: "msg-scout-1" } },
                    });
                    assert.equal(promptRes.messageId, "msg-scout-1");
                    const promptPlurnkMeta = (promptRes._meta as { plurnk?: { resource?: string } } | undefined)?.plurnk;
                    assert.equal(promptPlurnkMeta?.resource, "message://gookie/scoutproxy_00");
                    const expectedScoutSource = `acp://scoutproxy/sessions/${encodeURIComponent(created.sessionId)}/messages/msg-scout-1`;
                    assert.equal(capturedScoutRunLoop?.source, expectedScoutSource);
                    assert.equal(capturedScoutRunLoop?.messageAddress, expectedScoutSource);
                    await waitFor(() => scoutUpdates.some((u) => u.sessionUpdate === "agent_message_chunk"));
                    const replyChunk = scoutUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
                    const replyMeta = (replyChunk?._meta as {
                        plurnk?: {
                            voice?: string;
                            receipt?: {
                                repliedTo?: string[];
                                repliedToMessageIds?: string[];
                                repliedToSources?: string[];
                            };
                        };
                    } | undefined)?.plurnk;
                    assert.equal(replyMeta?.voice, "scoutproxy");
                    assert.deepEqual(replyMeta?.receipt?.repliedTo, ["message://gookie/scoutproxy_00"]);
                    assert.deepEqual(replyMeta?.receipt?.repliedToMessageIds, ["msg-scout-1"]);
                    assert.deepEqual(replyMeta?.receipt?.repliedToSources, [expectedScoutSource]);
                });
            } finally {
                h.port.runLoop = origRunLoop;
            }

            const wsStream = createWebSocketStream(h.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer valid-token" },
            });
            const wsClient = createAcpClient();
            const conn = wsClient.connect(wsStream);
            await conn.initialized;
            const logoutRes = await conn.agent.request(methods.agent.auth.logout, {});
            assert.deepEqual(logoutRes, {});
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
                assert.equal(providers.providers[0]?.current?.apiType, "mocktest");
                assert.equal(providers.providers[0]?.current?.baseUrl, "plurnk://mocktest/mock-v1");

                let mcpEnabled = true;
                let skillEnabled = true;
                const origListActions = h.port.listModuleActions.bind(h.port);
                const origInvokeAction = h.port.invokeModuleAction.bind(h.port);
                h.port.listModuleActions = () => [
                    ...origListActions(),
                    {
                        name: "workspace.mcp.enable",
                        scope: "workspace",
                        inputSchema: { type: "object", properties: { alias: { type: "string" } } },
                        outputSchema: { type: "object" },
                    },
                    {
                        name: "workspace.mcp.disable",
                        scope: "workspace",
                        inputSchema: { type: "object", properties: { alias: { type: "string" } } },
                        outputSchema: { type: "object" },
                    },
                    {
                        name: "workspace.skills.list",
                        scope: "workspace",
                        inputSchema: { type: "object" },
                        outputSchema: { type: "object" },
                    },
                    {
                        name: "workspace.skills.enable",
                        scope: "workspace",
                        inputSchema: { type: "object", properties: { alias: { type: "string" } } },
                        outputSchema: { type: "object" },
                    },
                    {
                        name: "workspace.skills.disable",
                        scope: "workspace",
                        inputSchema: { type: "object", properties: { alias: { type: "string" } } },
                        outputSchema: { type: "object" },
                    },
                ];
                h.port.invokeModuleAction = async (name, params, context) => {
                    if (name === "workspace.mcp.list") {
                        return {
                            definitions: [
                                {
                                    alias: "git-srv",
                                    state: mcpEnabled ? "active" : "disabled",
                                    detail: {
                                        promptDefinitions: [
                                            {
                                                name: "review",
                                                description: "Review git diff",
                                                arguments: [{ name: "branch", required: true }],
                                            },
                                        ],
                                    },
                                },
                            ],
                        };
                    }
                    if (name === "workspace.skills.list") {
                        return {
                            definitions: [
                                {
                                    alias: "triage",
                                    state: skillEnabled ? "active" : "disabled",
                                    detail: {
                                        description: "Triage repository issues",
                                    },
                                },
                            ],
                        };
                    }
                    if (name === "workspace.mcp.disable") {
                        mcpEnabled = false;
                        return {};
                    }
                    if (name === "workspace.mcp.enable") {
                        mcpEnabled = true;
                        return {};
                    }
                    if (name === "workspace.skills.disable") {
                        skillEnabled = false;
                        return {};
                    }
                    if (name === "workspace.skills.enable") {
                        skillEnabled = true;
                        return {};
                    }
                    return await origInvokeAction(name, params, context);
                };

                try {
                    const toggledMcp = await ctx.request(methods.agent.session.setConfigOption, {
                        sessionId: session.sessionId,
                        configId: "mcp:git-srv",
                        type: "boolean",
                        value: false,
                    });
                    const mcpOpt = toggledMcp.configOptions.find((c) => c.configId === "mcp:git-srv");
                    assert.equal(mcpOpt?.type, "boolean");
                    assert.equal(mcpOpt?.currentValue, false);

                    await ctx.request(methods.agent.session.setConfigOption, {
                        sessionId: session.sessionId,
                        configId: "mcp:git-srv",
                        type: "boolean",
                        value: true,
                    });
                    await waitFor(
                        () => updates.filter((u) => u.sessionUpdate === "available_commands_update").length >= 2,
                    );
                    const cmdUpdates = updates.filter(
                        (u): u is Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }> =>
                            u.sessionUpdate === "available_commands_update",
                    );
                    assert.ok(cmdUpdates.length >= 2);
                    const latestCmds = cmdUpdates.at(-1)?.availableCommands ?? [];
                    assert.ok(latestCmds.some((c) => c.name === "triage" && c.description === "Triage repository issues"));
                    assert.ok(
                        latestCmds.some(
                            (c) =>
                                c.name === "git-srv:review" &&
                                c.description === "Review git diff" &&
                                typeof c.input === "object" &&
                                c.input !== null &&
                                "hint" in c.input &&
                                c.input.hint === "branch=<value>",
                        ),
                    );
                } finally {
                    h.port.listModuleActions = origListActions;
                    h.port.invokeModuleAction = origInvokeAction;
                }

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

                // Zero-alias / unselected model still preserves `configId: "model"` across ACP v2 (.min(1) select options)
                const origListProviders = h.port.listProviders.bind(h.port);
                const origReadSessionModel = h.port.readSessionModel.bind(h.port);
                h.port.listProviders = () => ({ aliases: [] });
                h.port.readSessionModel = async () => ({ model: null, spawnModel: null });
                try {
                    const zeroAliasSession = await ctx.request(methods.agent.session.new, {
                        cwd: "/workspace/zero-alias",
                    });
                    const modelOpt = zeroAliasSession.configOptions?.find((c) => c.configId === "model");
                    assert.ok(modelOpt, "model configOption is preserved on zero-alias installs");
                    assert.equal(modelOpt.currentValue, "none");
                } finally {
                    h.port.listProviders = origListProviders;
                    h.port.readSessionModel = origReadSessionModel;
                }

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
                            ],
                        });
                        await session.readTextUntilIdle();
                        assert.deepEqual(capturedRunLoop?.openPaths, ["/workspace/alpha/README.md"]);
                        assert.equal(capturedRunLoop?.attachments?.length, 2);
                        assert.equal(capturedRunLoop?.attachments?.[0]?.name, "mem:///note.txt");
                        assert.equal(capturedRunLoop?.attachments?.[1]?.mediaType, "image/png");

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
                                    {
                                        type: "command",
                                        name: "triage",
                                        input: "Check bug #42",
                                    } as unknown as ContentBlock,
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
                            assert.equal(capturedRunLoop?.prompt, "Check bug #42");
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

                h.port.entryContents.set("sh://11#stdout", "hi\n");
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 11,
                        session_id: 1,
                        sequence: 3,
                        op: "sh",
                        status_rx: 202,
                        tx: { op: "sh", aside: "echo hi" },
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
                        op: "read",
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
                        attrs: { tag: "sh", body: "watch", stream: "sh://16" },
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
                        attrs: { tag: "sh", body: "check", stream: "sh://21" },
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
                        (u) => u.sessionUpdate === "agent_thought_chunk" && u.messageId === "outside-1/1/0",
                    ),
                );
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

    test("{§acp-proposal-resolve} {§acp-session-owner}: session/request_permission, elicitation/create, elicitation/complete, and multi-peer $/cancel_request", async () => {
        const h = await createHarness();
        try {
            const permissionRequests1: RequestPermissionRequest[] = [];
            const permissionRequests2: RequestPermissionRequest[] = [];
            const elicitations1: CreateElicitationRequest[] = [];
            const completedElicitations: string[] = [];
            const updates1: SessionUpdate[] = [];

            const stream1 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const stream2 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });

            const client1 = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates1.push(params.update);
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests1.push(params);
                    return {
                        outcome: { outcome: "selected", optionId: "allow_once" },
                        _meta: { plurnk: { body: "rm -rf build/tmp" } },
                    };
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
                    if (permissionRequests1[0]?.subject?.type === "command") {
                        assert.equal(permissionRequests1[0].subject.toolCallId, "1/1/1");
                        assert.equal(permissionRequests1[0].subject.terminalId, "term:501");
                    }
                    const pendingCall = updates1.find(
                        (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                            u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/1",
                    );
                    assert.ok(pendingCall !== undefined, "proposal emits pending tool_call_update with canonical coordinate toolCallId");
                    assert.equal(pendingCall.status, "pending");
                    assert.equal(
                        (pendingCall._meta as { plurnk?: { coordinate?: string; status?: number } } | undefined)?.plurnk?.coordinate,
                        "1/1/1",
                    );
                    assert.equal(
                        (pendingCall._meta as { plurnk?: { coordinate?: string; status?: number } } | undefined)?.plurnk?.status,
                        202,
                    );
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
                    assert.equal(
                        h.port.resolvedProposals[0]?.resolution.body,
                        "rm -rf build/tmp",
                        "edited proposal body forwarded to resolveProposal ({§acp-proposal-resolve})",
                    );
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

    test("{§acp-topology-scope} {§acp-proposal-resolve}: sibling sessions never leak subagent updates, session messages, or gates across actor boundaries, bodiless send omits session_message, and 409 gate settlements are idempotent", async () => {
        const h = await createHarness();
        try {
            h.port.sessions.push(
                {
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
                },
                {
                    id: 3,
                    workspaceId: 1,
                    name: "major",
                    created_at: "2026-10-25T00:00:00.000Z",
                    origin: "model",
                    owner: "acp://operator",
                    parentSessionId: null,
                    kind: "root",
                    lifecycle: "running",
                    archived_at: null,
                },
            );

            const updates: SessionUpdate[] = [];
            const permissionRequests: RequestPermissionRequest[] = [];
            let resolvePermissionGate: (() => void) | null = null;
            const permissionGateHeld = new Promise<void>((resolve) => {
                resolvePermissionGate = resolve;
            });

            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const clientApp = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates.push(params.update);
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests.push(params);
                    if (params._meta && typeof params._meta === "object" && "plurnk" in params._meta) {
                        const p = (params._meta as { plurnk?: { proposal?: { logEntryId?: number } } }).plurnk?.proposal;
                        if (p?.logEntryId === 702) {
                            await permissionGateHeld;
                        }
                    }
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                });

            await clientApp.connectWith(stream, async (ctx) => {
                // Pending proposal on sibling session 3 ("major") before session/resume on "1#user"
                const siblingProposal: ProposalProjection = {
                    logEntryId: 701,
                    sessionId: 3,
                    session: "major",
                    loopId: 3,
                    turnId: 1,
                    coordinate: "1/1/1",
                    op: "sh",
                    target: { scheme: "sh", authority: null, pathname: null },
                    body: "echo sibling",
                    disposition: { decision: "review" },
                    owner: "acp://operator",
                    attrs: { tag: "sh", body: "echo sibling", cwd: "/workspace/alpha" },
                    subject: { type: "command", command: "echo sibling", cwd: "/workspace/alpha" },
                };
                h.port.proposals.push(siblingProposal);

                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                // Live events on sibling session 3 ("major") must NOT leak to "1#user"
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 710,
                        session_id: 3,
                        session_name: "major",
                        loop_id: 3,
                        turn_id: 1,
                        op: "send",
                        attrs: { kind: "message", to: "acp://operator", body: "Sibling reply" },
                        rx: { status: 200, content: "Sibling reply", mimetype: "text/markdown" },
                        mimetype_rx: "text/markdown",
                    }),
                });
                h.port.emitEvent(1, "loop/proposal", siblingProposal);
                h.port.emitEvent(1, "loop/terminated", makeTerminatedEvent({ sessionId: 3, loopId: 3 }));

                // Bodiless done on descendant session 2 ("helper") emits subagent_update but NOT session_message("done")
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 711,
                        session_id: 2,
                        session_name: "helper",
                        loop_id: 2,
                        turn_id: 1,
                        op: "done",
                        attrs: {},
                        rx: { status: 204, completion: 200, content: "", mimetype: "text/plain" },
                    }),
                });

                await waitFor(() =>
                    updates.some(
                        (u) => u.sessionUpdate === "subagent_update" && u.sessionId === "1#helper",
                    ),
                );

                assert.equal(
                    updates.some(
                        (u) => u.sessionUpdate === "subagent_update" && u.sessionId === "1#major",
                    ),
                    false,
                    "sibling session never leaks subagent_update to 1#user",
                );
                assert.equal(
                    updates.some((u) => u.sessionUpdate === "session_message"),
                    false,
                    "neither sibling send nor bodiless descendant send emits session_message",
                );
                assert.equal(
                    permissionRequests.length,
                    0,
                    "sibling session proposals never dispatch to 1#user on resume or live loop/proposal",
                );

                // Descendant proposal on session 2 ("helper") DOES dispatch to "1#user",
                // and if already removed in Core (409 interrupt-not-pending), settles without error notice.
                const childProposal: ProposalProjection = {
                    logEntryId: 702,
                    sessionId: 2,
                    session: "helper",
                    loopId: 2,
                    turnId: 1,
                    coordinate: "1/1/2",
                    op: "sh",
                    target: { scheme: "sh", authority: null, pathname: null },
                    body: "echo child",
                    disposition: { decision: "review" },
                    owner: "acp://operator",
                    attrs: { tag: "sh", body: "echo child", cwd: "/workspace/alpha" },
                    subject: { type: "command", command: "echo child", cwd: "/workspace/alpha" },
                };
                h.port.proposals.push(childProposal);
                h.port.emitEvent(1, "loop/proposal", childProposal);

                await waitFor(() => permissionRequests.length === 1);
                // Simulate proposal already settled in Core before client response arrives
                h.port.proposals.length = 0;
                resolvePermissionGate?.();

                await new Promise((r) => setTimeout(r, 30));
                assert.equal(
                    updates.some(
                        (u) => u.sessionUpdate === "notice" && u.severity === "error",
                    ),
                    false,
                    "409 interrupt-not-pending settles idempotently without emitting an error notice",
                );
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
                // Omitted replayFrom does not replay historical turns
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

                // Standard ACPv2 replayFrom: { type: "start" } replays all retained conversation history
                replayed.length = 0;
                const fullResumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                });
                const fullHistoryMeta = (
                    fullResumed._meta as { plurnk?: { history?: { older?: string } } } | undefined
                )?.plurnk?.history;
                assert.equal(fullHistoryMeta?.older, undefined, "unwindowed start replay replays all loops");
                await waitFor(
                    () =>
                        replayed.filter((u) => u.sessionUpdate === "user_message_chunk").length === 2 &&
                        replayed.filter((u) => u.sessionUpdate === "agent_message_chunk").length === 2,
                );

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
                    params: { text: "await plurnk.note({ text: \"remember this\" });\n" },
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

                // Pre-loop refusal in seam.runLoop must broadcast a terminal state_update: idle (stopReason: refusal) after running
                updates.length = 0;
                const origRunLoop = h.port.runLoop.bind(h.port);
                h.port.runLoop = async () => ({
                    action: "enqueued_new_loop",
                    loopId: 0,
                    status: 409,
                    problem: {
                        type: "https://problems.plurnk.xyz/daemon/provider/model-not-configured",
                        title: "Model not configured",
                        status: 409,
                        detail: "No model is selected for this session.",
                    },
                });
                try {
                    await assert.rejects(
                        () =>
                            ctx.request(methods.agent.session.prompt, {
                                sessionId: "1#user",
                                prompt: [{ type: "text", text: "Fail pre-loop" }],
                            }),
                        /No model is selected for this session\./,
                    );
                    await waitFor(() =>
                        updates.some(
                            (u) =>
                                u.sessionUpdate === "state_update" &&
                                u.state === "idle" &&
                                u.stopReason === "refusal",
                        ),
                    );
                    const lastState = updates
                        .toReversed()
                        .find((u) => u.sessionUpdate === "state_update");
                    assert.equal(lastState?.sessionUpdate, "state_update");
                    assert.equal((lastState as Extract<SessionUpdate, { sessionUpdate: "state_update" }>).state, "idle");
                } finally {
                    h.port.runLoop = origRunLoop;
                }
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-body-reference} {§acp-plurnk-metadata} {§acp-proposal-resolve} {§acp-topology-scope}: DiffChange operations, 1-based ToolCallLocation.line, URL elicitation for MCP OAuth, and subagent_update ordering", async () => {
        const h = await createHarness();
        try {
            h.port.sessions.push({
                id: 2,
                workspaceId: 1,
                name: "worker",
                created_at: "2026-10-25T00:00:00.000Z",
                origin: "model",
                owner: "acp://operator",
                parentSessionId: 1,
                kind: "work",
                lifecycle: "running",
                archived_at: null,
            });
            const origListModuleActions = h.port.listModuleActions.bind(h.port);
            h.port.listModuleActions = () => [
                ...origListModuleActions(),
                {
                    name: "workspace.mcp.oauth.begin",
                    scope: "workspace",
                    inputSchema: {
                        type: "object",
                        properties: { alias: { type: "string" } },
                    },
                    outputSchema: { type: "object" },
                },
                {
                    name: "workspace.mcp.oauth.complete",
                    scope: "workspace",
                    inputSchema: {
                        type: "object",
                        properties: { alias: { type: "string" }, callbackUrl: { type: "string" } },
                    },
                    outputSchema: { type: "object" },
                },
            ];
            const origInvoke = h.port.invokeModuleAction.bind(h.port);
            h.port.invokeModuleAction = async (name, params, ctx) => {
                if (name === "workspace.mcp.oauth.begin") {
                    return {
                        status: 202,
                        alias: "github",
                        authorization: { url: "https://auth.example.com/authorize?state=xyz" },
                    };
                }
                if (name === "workspace.mcp.oauth.complete") {
                    return {
                        status: 202,
                        alias: "github",
                    };
                }
                return origInvoke(name, params, ctx);
            };

            const updates: SessionUpdate[] = [];
            const urlElicitations: CreateElicitationRequest[] = [];
            const completedElicitations: string[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const clientApp = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates.push(params.update);
                })
                .onRequest(methods.client.elicitation.create, async ({ params }) => {
                    urlElicitations.push(params);
                    return { action: "accept" };
                })
                .onNotification(methods.client.elicitation.complete, ({ params }) => {
                    completedElicitations.push(params.elicitationId);
                });

            await clientApp.connectWith(stream, async (ctx) => {
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });

                // 1. DiffChange: add (201), delete (kill), move (move), and 1-based line on read/edit
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 801,
                        session_id: 1,
                        sequence: 1,
                        op: "edit",
                        pathname: "/workspace/alpha/created.ts",
                        status_rx: 201,
                        tx: { op: "edit", lineMarker: { marks: [12] } },
                        attrs: { original: "", patched: "export const x = 1;\n" },
                        rx: { status: 201 },
                    }),
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 802,
                        session_id: 1,
                        sequence: 2,
                        op: "kill",
                        pathname: "/workspace/alpha/deleted.ts",
                        status_rx: 204,
                        attrs: { original: "old\n", patched: "" },
                        rx: { status: 204 },
                    }),
                });
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 803,
                        session_id: 1,
                        sequence: 3,
                        op: "move",
                        pathname: "/workspace/alpha/new-name.ts",
                        status_rx: 200,
                        attrs: { oldPath: "/workspace/alpha/old-name.ts", to: "/workspace/alpha/new-name.ts" },
                        rx: { status: 200 },
                    }),
                });

                await waitFor(() =>
                    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/3"),
                );

                const addCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/1",
                );
                assert.deepEqual(addCall?.locations, [{ path: "/workspace/alpha/created.ts", line: 12 }]);
                const addDiff = addCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    addDiff && "changes" in addDiff ? addDiff.changes : undefined,
                    [{ operation: "add", path: "/workspace/alpha/created.ts" }],
                );

                const delCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/2",
                );
                const delDiff = delCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    delDiff && "changes" in delDiff ? delDiff.changes : undefined,
                    [{ operation: "delete", path: "/workspace/alpha/deleted.ts" }],
                );

                const moveCall = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
                        u.sessionUpdate === "tool_call_update" && u.toolCallId === "1/1/3",
                );
                const moveDiff = moveCall?.content?.find((c) => c.type === "diff");
                assert.deepEqual(
                    moveDiff && "changes" in moveDiff ? moveDiff.changes : undefined,
                    [
                        {
                            operation: "move",
                            oldPath: "/workspace/alpha/old-name.ts",
                            path: "/workspace/alpha/new-name.ts",
                        },
                    ],
                );

                // 2. URL-mode elicitation for workspace.mcp.oauth.begin / complete (and /mcp oauth slash command)
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/mcp oauth github" }],
                });
                await waitFor(() => urlElicitations.length === 1);
                assert.equal(urlElicitations[0]?.mode, "url");
                if (urlElicitations[0]?.mode === "url") {
                    assert.equal(urlElicitations[0].url, "https://auth.example.com/authorize?state=xyz");
                    assert.equal(urlElicitations[0].elicitationId, "mcp-oauth:1:github");
                }

                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#user",
                    prompt: [{ type: "text", text: "/mcp oauth github http://127.0.0.1:9999/cb?code=1&state=xyz" }],
                });
                await waitFor(() => completedElicitations.includes("mcp-oauth:1:github"));

                // 3. Descendant log/entry followed immediately by loop/terminated preserves FIFO subagent_update order
                updates.length = 0;
                h.port.emitEvent(1, "log/entry", {
                    entry: makeLogEntry({
                        id: 804,
                        session_id: 2,
                        session_name: "worker",
                        loop_seq: 1,
                        turn_seq: 1,
                        sequence: 1,
                        origin: "model",
                        op: "done",
                        attrs: { body: "Done working" },
                        rx: { status: 200, completion: 200, content: "Done working" },
                    }),
                });
                h.port.emitEvent(1, "loop/terminated", {
                    sessionId: 2,
                    loopId: 2,
                    turnIds: [1],
                    hitMaxTurns: false,
                    result: { status: 200 },
                });

                await waitFor(
                    () =>
                        updates.filter((u) => u.sessionUpdate === "subagent_update").length >= 2 &&
                        updates.some((u) => u.sessionUpdate === "session_message"),
                );
                const subagentIdx0 = updates.findIndex(
                    (u) =>
                        SessionUpdate.isSubagentUpdate(u) &&
                        u.state !== null &&
                        typeof u.state === "object" &&
                        "state" in u.state &&
                        u.state.state === "running",
                );
                const msgIdx = updates.findIndex((u) => u.sessionUpdate === "session_message");
                const subagentIdx1 = updates.findIndex(
                    (u) =>
                        SessionUpdate.isSubagentUpdate(u) &&
                        u.state !== null &&
                        typeof u.state === "object" &&
                        "state" in u.state &&
                        u.state.state === "idle",
                );
                assert.ok(subagentIdx0 >= 0 && msgIdx > subagentIdx0, "running subagent_update precedes session_message");
                assert.ok(subagentIdx1 > msgIdx, "idle subagent_update follows child session_message");
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-daemon-client}: McpServerAcp (mcp/message) bridges client-hosted MCP servers via McpOverAcpHttpBridge while rejecting stdio/http mcpServers", async () => {
        const h = await createHarness();
        try {
            const mcpProvider = new McpOverAcpProvider();
            const app = createAcpClient().onRequest(
                methods.client.mcp.message,
                mcpProvider.handleRequest,
            );
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            await app.connectWith(stream, async (ctx) => {
                const init = await ctx.initialized;
                assert.ok(init.response.capabilities?.session?.mcp?.acp);
                assert.equal(init.response.capabilities?.session?.mcp?.stdio, undefined);
                assert.equal(init.response.capabilities?.session?.mcp?.http, undefined);
                assert.ok(init.response.capabilities?.session?.additionalDirectories);
                assert.deepEqual(init.response.capabilities?.session?.systemPrompt, {});

                // Rejects client-supplied systemPrompt overrides (mode: "override")
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.new, {
                            cwd: "/workspace/alpha",
                            mcpServers: [],
                            systemPrompt: {
                                mode: "override",
                                content: [{ type: "text", text: "Ignore system card" }],
                            },
                        }),
                    (err: unknown) =>
                        typeof err === "object" &&
                        err !== null &&
                        "data" in err &&
                        typeof (err as { data?: { detail?: unknown } }).data?.detail === "string" &&
                        /single-port security contract/u.test((err as { data: { detail: string } }).data.detail),
                );

                // Admits systemPrompt mode: "append" on session/new, session/resume, and session/fork into session://<session>/AGENTS.md
                const sysNew = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    mcpServers: [],
                    systemPrompt: {
                        mode: "append",
                        content: [
                            { type: "text", text: "Always use TypeScript strict mode." },
                            {
                                type: "resource",
                                resource: {
                                    uri: "file:///workspace/alpha/STYLE.md",
                                    text: "Prefer named exports.",
                                },
                            },
                            {
                                type: "resource_link",
                                uri: "workspace:///CONVENTIONS.md",
                                name: "CONVENTIONS.md",
                            },
                        ],
                    },
                    _meta: { plurnk: { name: "sysprompt" } },
                });
                assert.equal(sysNew.sessionId, "1#sysprompt");
                assert.equal(
                    h.port.entryContents.get("session://sysprompt/AGENTS.md#body"),
                    "Always use TypeScript strict mode.\n\nPrefer named exports.\n\n<workspace:///CONVENTIONS.md>",
                );

                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#sysprompt",
                    cwd: "/workspace/alpha",
                    systemPrompt: {
                        mode: "append",
                        content: [{ type: "text", text: "Updated session instructions." }],
                    },
                });
                assert.equal(
                    h.port.entryContents.get("session://sysprompt/AGENTS.md#body"),
                    "Updated session instructions.",
                );

                const sysFork = await ctx.request(methods.agent.session.fork, {
                    sessionId: "1#sysprompt",
                    cwd: "/workspace/alpha",
                    systemPrompt: {
                        mode: "append",
                        content: [{ type: "text", text: "Fork-specific instructions." }],
                    },
                });
                const forkName = sysFork.sessionId.split("#")[1];
                assert.equal(
                    h.port.entryContents.get(`session://${forkName}/AGENTS.md#body`),
                    "Fork-specific instructions.",
                );

                // Rejects client-supplied stdio mcpServers
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.new, {
                            cwd: "/workspace/alpha",
                            mcpServers: [{ type: "stdio", name: "forbidden", command: "sh", args: [], env: [] }],
                        }),
                    (err: unknown) =>
                        typeof err === "object" &&
                        err !== null &&
                        "data" in err &&
                        typeof (err as { data?: { detail?: unknown } }).data?.detail === "string" &&
                        /single-port security contract/u.test((err as { data: { detail: string } }).data.detail),
                );

                // Admits type: "acp" McpServerAcp and bridges MCP 2026-07-28 requests over mcp/message
                const reg = mcpProvider.registerServer(ctx, {
                    name: "ide-tools",
                    serverId: "srv-ide-1",
                    handler: async (op) => {
                        if (op.method === "tools/list") {
                            return {
                                result: {
                                    resultType: "tools/list",
                                    tools: [{ name: "open_buffer", inputSchema: { type: "object" } }],
                                },
                            };
                        }
                        return { result: { resultType: op.method } };
                    },
                });

                await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    mcpServers: [reg.declaration],
                    _meta: { plurnk: { name: "ide" } },
                });

                const mcpList = (await h.port.invokeModuleAction(
                    "workspace.mcp.list",
                    {},
                    { scope: "workspace", workspaceId: 1 },
                )) as {
                    items: Array<{
                        alias: string;
                        definition: { type: string; url: string; headers?: Record<string, string> };
                    }>;
                };
                const bridged = mcpList.items.find((item) => item.alias === "ide-tools");
                assert.ok(bridged, "ide-tools MCP server registered in workspace");
                assert.equal(bridged.definition.type, "streamable-http");

                const res = await fetch(bridged.definition.url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        accept: "application/json, text/event-stream",
                        "mcp-protocol-version": "2026-07-28",
                        "mcp-method": "tools/list",
                        ...bridged.definition.headers,
                    },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: "req-1",
                        method: "tools/list",
                        params: {
                            _meta: {
                                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                                "io.modelcontextprotocol/clientCapabilities": {},
                            },
                        },
                    }),
                });
                assert.equal(res.status, 200);
                const payload = (await res.json()) as {
                    jsonrpc: string;
                    id: string;
                    result: { tools: Array<{ name: string }> };
                };
                assert.equal(payload.id, "req-1");
                assert.equal(payload.result.tools[0]?.name, "open_buffer");
                await reg.dispose();
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

        // 2. Raced order: terminalConcluded (entries.id = 43, target = "sh://2") arrives BEFORE logEntry (log_entries.id = 501)
        const preConcluded = translator.terminalConcluded(43, 200, {
            sessionId: 1,
            target: "sh://2",
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
                attrs: JSON.stringify({ stream: "sh://2", aside: "Fast command" }),
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
                    attrs: JSON.stringify({ stream: "sh://9" }),
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
                        type: "https://problems.plurnk.xyz/grammar:parser/invalid-operation-syntax",
                        title: "Invalid Operation Syntax",
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
        }

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
            assert.equal(typeof wsArchived.archived_at, "string");

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
            assert.equal(wsUnarchived.archived_at, null);

            await sendRpc(10, "session/archive", { sessionId: "1#user" });
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

    test("{§acp-overview} {§acp-plurnk-metadata} {§acp-http-authorization}: scoped session/list overview metadata, immediate SSE open flush, and workspace/renamed updates (#1393 #1394 #1395)", async () => {
        const h = await createHarness({
            env: { PLURNK_ACP_HEARTBEAT_MS: "60000" },
        });
        try {
            // 1. Immediate SSE comment flush on GET /acp stream open before heartbeatMs elapses (#1395)
            const initRes = await fetch(h.baseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(initRes.status, 200);
            const connId = initRes.headers.get("acp-connection-id");
            assert.ok(connId);
            await initRes.text();

            const sseAbort = new AbortController();
            const sseRes = await fetch(h.baseUrl, {
                method: "GET",
                headers: {
                    accept: "text/event-stream",
                    "acp-connection-id": connId,
                },
                signal: sseAbort.signal,
            });
            assert.equal(sseRes.status, 200);
            assert.equal(sseRes.headers.get("x-accel-buffering"), "no");
            const reader = sseRes.body?.getReader();
            assert.ok(reader);
            const firstChunk = await reader.read();
            assert.equal(firstChunk.done, false);
            assert.match(new TextDecoder().decode(firstChunk.value), /: heartbeat/);
            sseAbort.abort();
            await reader.cancel().catch(() => undefined);

            // 2. Full session/list overview contract, workspace scoping, validation, and workspace/renamed (#1394 #1395)
            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    updates.push(params.update);
                });

            await app.connectWith(stream, async (ctx) => {
                // Create an empty second workspace to verify empty workspaces are included in overview _meta.plurnk.workspaces
                await ctx.request("_plurnk/action", {
                    kind: "workspace.create",
                    params: { name: "empty-ws", projectRoot: "/workspace/empty" },
                });

                // Invalid overview parameters return 400 overview-invalid
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.list, {
                            _meta: { plurnk: { workspaceId: 0 } },
                        }),
                    /overview-invalid/,
                );
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.list, {
                            _meta: { plurnk: { limit: -1 } },
                        }),
                    /overview-invalid/,
                );

                // Unknown workspaceId returns 404 workspace-not-found
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.list, {
                            _meta: { plurnk: { workspaceId: 999 } },
                        }),
                    /workspace-not-found/,
                );

                // Scoped session/list returns workspace sessions + top-level workspaces + cross-workspace recent feed
                const scopedList = await ctx.request(methods.agent.session.list, {
                    _meta: { plurnk: { workspaceId: 1 } },
                });
                assert.equal(scopedList.sessions.length, 1);
                const s0Meta = (scopedList.sessions[0]?._meta as { plurnk?: Record<string, unknown> } | undefined)
                    ?.plurnk;
                assert.equal(s0Meta?.workspaceId, 1);
                assert.equal(s0Meta?.workspaceName, "alpha");
                assert.equal(s0Meta?.id, 1);
                assert.equal(s0Meta?.sessionId, 1);
                assert.equal(s0Meta?.name, "user");
                assert.equal(s0Meta?.sessionName, "user");
                assert.equal(s0Meta?.parentSessionId, null);
                assert.equal(s0Meta?.kind, "root");
                assert.equal(s0Meta?.lifecycle, "idle");
                assert.equal(s0Meta?.gates, 0);
                assert.equal(s0Meta?.projectRoot, "/workspace/alpha");
                assert.equal(s0Meta?.projectLabel, "alpha");
                assert.equal(
                    ((s0Meta?.reply as { body?: { mimeType?: string } } | undefined)?.body)?.mimeType,
                    "text/plain",
                );

                const topMeta = (scopedList._meta as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;
                assert.deepEqual(topMeta?.scope, { workspaceId: 1 });
                assert.equal(topMeta?.omitted, 0);
                const topWorkspaces = topMeta?.workspaces as Array<{ id: number; name: string }> | undefined;
                assert.ok(topWorkspaces?.some((w) => w.name === "alpha"));
                assert.ok(topWorkspaces?.some((w) => w.name === "empty-ws"), "includes empty workspaces");
                assert.ok(Array.isArray(topMeta?.recent));

                // Resume 1#user so peer is bound to workspace 1, then rename workspace 1
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#user",
                    cwd: "/workspace/alpha",
                });
                updates.length = 0;

                await ctx.request("_plurnk/action", {
                    kind: "workspace.rename",
                    workspaceId: 1,
                    params: { name: "alpha-renamed" },
                });

                await waitFor(() => updates.some((u) => u.sessionUpdate === "session_info_update"));
                const infoUpdate = updates.find(
                    (u): u is Extract<SessionUpdate, { sessionUpdate: "session_info_update" }> =>
                        u.sessionUpdate === "session_info_update",
                );
                assert.equal(infoUpdate?.title, "alpha-renamed#user");

                const translator = new SessionTranslator({ acpSessionId: "1#user", workspaceId: 1, sessionId: 1 });
                const configNotice = {
                    source: "engine:configuration",
                    kind: "plugin_configuration",
                    level: "info" as const,
                    message: "plugin plurnk-web is shadowed",
                };
                assert.equal(translator.notice(configNotice).length, 1);
                assert.equal(translator.notice(configNotice).length, 0);
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

                        // Outside narration emitted during the turn projects as agent_thought_chunk (not agent_message_chunk)
                        h.port.emitEvent(1, "outside/event", {
                            sessionId: 1,
                            coordinate: "1/1/1",
                            text: "Internal model narration outside fences",
                            tokens: 7,
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

                        // Verify hazool17 has NOT received scoutproxy's reply, outside text, or idle state_update yet
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

                        // Verify operator received both user messages, outside text as agent_thought_chunk, and scoutproxy's reply,
                        // and zero tool_call_update for internal emission/entry_materialized/distilled rows
                        await waitFor(
                            () =>
                                operatorUpdates.filter((u) => u.sessionUpdate === "user_message_chunk").length === 2 &&
                                operatorUpdates.filter(
                                    (u) =>
                                        u.sessionUpdate === "agent_thought_chunk" &&
                                        u.messageId === "outside-1/1/1",
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
                                tx: "Early scoutproxy message before 110 tool calls",
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

    test("{§acp-daemon-client} {§acp-overview}: session/options is side-effect-free and session/new + session/resume apply initial configOptions (#1449)", async () => {
        const h = await createHarness();
        try {
            const updates: SessionUpdate[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            });
            await app.connectWith(stream, async (ctx) => {
                const init = await ctx.initialized;
                assert.deepEqual(init.response.capabilities?.session?.options, {});

                // 1. Non-absolute cwd / additionalDirectories fail -32602
                await assert.rejects(
                    () => ctx.request(methods.agent.session.options, { cwd: "relative/path" }),
                    (err: { code?: number }) => err.code === -32602,
                );
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.options, {
                            cwd: "/workspace/alpha",
                            additionalDirectories: ["relative/extra"],
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );

                // 2. session/options on an uncreated cwd neither creates a workspace/session nor emits notifications
                const workspacesBefore = (await h.port.listWorkspaces()).length;
                const previewUncreated = await ctx.request(methods.agent.session.options, {
                    cwd: "/workspace/never-created",
                });
                assert.equal((await h.port.listWorkspaces()).length, workspacesBefore);
                assert.equal(updates.length, 0);
                assert.ok(
                    previewUncreated.configOptions?.some(
                        (c) =>
                            c.configId === "thought_level" &&
                            Array.isArray((c as { options?: unknown }).options) &&
                            ((c as { options: unknown[] }).options.length === 3),
                    ),
                );
                assert.ok((previewUncreated.availableCommands?.length ?? 0) > 0);

                // 3. Duplicate or malformed initial configOptions fail -32602 before creating a session
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.new, {
                            cwd: "/workspace/alpha",
                            configOptions: [
                                { configId: "mode", type: "id", value: "allow" },
                                { configId: "mode", type: "id", value: "deny" },
                            ],
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );

                // 4. session/new applies valid initial configOptions in order, ignores unknown/mismatched/disallowed entries, and emits no config_option_update
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    configOptions: [
                        { configId: "unknown_opt", type: "id", value: "ignored" },
                        { configId: "spawn_model", type: "boolean", value: true },
                        { configId: "persona", type: "id", value: "not_a_persona" },
                        { configId: "thought_level", type: "id", value: "high" },
                        { configId: "mode", type: "id", value: "allow" },
                    ],
                });
                assert.equal(
                    created.configOptions?.find((c) => c.configId === "thought_level")?.currentValue,
                    "high",
                );
                assert.equal(created.configOptions?.find((c) => c.configId === "mode")?.currentValue, "allow");
                assert.ok(!updates.some((u) => u.sessionUpdate === "config_option_update"));

                await ctx.request(methods.agent.session.close, { sessionId: created.sessionId });
                const savedStatus = await ctx.request(methods.agent.session.status, {
                    sessionId: created.sessionId,
                });
                assert.equal(savedStatus.status, "saved");

                // 5. session/options with sessionId returns stored options without opening the saved session
                const existingOpts = await ctx.request(methods.agent.session.options, {
                    cwd: "/workspace/alpha",
                    sessionId: created.sessionId,
                });
                assert.equal(
                    existingOpts.configOptions?.find((c) => c.configId === "thought_level")?.currentValue,
                    "high",
                );
                assert.equal(existingOpts.configOptions?.find((c) => c.configId === "mode")?.currentValue, "allow");
                const stillSaved = await ctx.request(methods.agent.session.status, {
                    sessionId: created.sessionId,
                });
                assert.equal(stillSaved.status, "saved");

                // 6. session/resume applies initial configOptions without emitting config_option_update
                updates.length = 0;
                const resumed = await ctx.request(methods.agent.session.resume, {
                    sessionId: created.sessionId,
                    cwd: "/workspace/alpha",
                    configOptions: [{ configId: "mode", type: "id", value: "deny" }],
                });
                assert.equal(resumed.configOptions?.find((c) => c.configId === "mode")?.currentValue, "deny");
                assert.ok(!updates.some((u) => u.sessionUpdate === "config_option_update"));

                // 7. Unknown sessionId fails -32002
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.options, {
                            cwd: "/workspace/alpha",
                            sessionId: "1#no-such-session",
                        }),
                    (err: { code?: number }) => err.code === -32002,
                );
            });
        } finally {
            await h.close();
        }
    });
});
