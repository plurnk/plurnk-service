import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import {
    McpOverAcpProvider,
    methods,
    PROTOCOL_VERSION,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import SessionTranslator from "./SessionTranslator.ts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    makeLogEntry,
    waitFor,
} from "../test/harness.ts";

describe("{§acp-http-authorization} plurnk-acp HTTP & auth", { concurrency: true }, () => {
    test("{§acp-http-authorization} {§acp-daemon-client}: Streamable HTTP, WebSocket, CORS, OAuth perimeter, and revocation", async () => {
        const h = await createHarness({
            authMode: "oauth",
            env: { PLURNK_ACP_HEARTBEAT_MS: "20" },
        });
        try {
            const preflight = await fetch(h.baseUrl, { method: "OPTIONS" });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers.get("access-control-allow-origin"), null, "same-origin default omits CORS");

            const corsHarness = await createHarness({
                authMode: "oauth",
                env: { PLURNK_ACP_ALLOW_ORIGIN: "https://portal.example" },
            });
            try {
                const corsPreflight = await fetch(corsHarness.baseUrl, { method: "OPTIONS" });
                assert.equal(corsPreflight.status, 204);
                assert.equal(corsPreflight.headers.get("access-control-allow-origin"), "https://portal.example");
                const corsUnauth = await fetch(corsHarness.baseUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
                });
                assert.equal(corsUnauth.status, 401);
                assert.equal(corsUnauth.headers.get("access-control-allow-origin"), "https://portal.example");
            } finally {
                await corsHarness.close();
            }

            const unauth = await fetch(h.baseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(unauth.status, 401);
            assert.ok(unauth.headers.get("www-authenticate")?.includes("Bearer"));
            const unauthProblem = (await unauth.json()) as Record<string, unknown>;
            assert.match(String(unauthProblem.code), /bearer-token-required/);

            const badToken = await fetch(h.baseUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer invalid-token",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(badToken.status, 401);
            assert.match(badToken.headers.get("www-authenticate") ?? "", /error="invalid_token"/u);

            const crossOriginBrowser = await fetch(h.baseUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: "https://evil.example",
                    "sec-fetch-site": "cross-site",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } }),
            });
            assert.equal(crossOriginBrowser.status, 403);
            const crossOriginProblem = (await crossOriginBrowser.json()) as Record<string, unknown>;
            assert.match(String(crossOriginProblem.code), /cross-origin-forbidden/);

            // WebSocket subprotocol bearer (`new WebSocket(url, ["acp", "bearer.<jwt>"])`) echoes `acp` without leaking the token
            const SubprotoWs = class extends (WsConstructor as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket) {
                constructor(url: string | URL) {
                    super(url, ["acp", "bearer.valid-token"]);
                }
            } as unknown as typeof WsConstructor;
            const subprotoStream = createWebSocketStream(h.wsUrl, { WebSocket: SubprotoWs });
            await createAcpClient().connectWith(subprotoStream, async (ctx) => {
                const init = await ctx.initialized;
                assert.equal(init.response.protocolVersion, PROTOCOL_VERSION);
            });

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
                assert.ok(init.response.capabilities?.session?.prompt?.skill?.inline);
                assert.ok(init.response.capabilities?.providers);
                assert.deepEqual(init.response.capabilities?.session?.prompt?.audio, {});
                const acpPkg = createRequire(import.meta.url)("../package.json") as { version: string };
                assert.equal(init.response.info.version, acpPkg.version);
            });

            Object.assign(h.port, { serviceVersion: "8.99.0" });
            const versionStream = createHttpStream(h.baseUrl, {
                headers: { authorization: "Bearer valid-token" },
            });
            await createAcpClient().connectWith(versionStream, async (ctx) => {
                const init = await ctx.initialized;
                assert.equal(init.response.info.version, "8.99.0");
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
                    const promptPlurnkMeta = (
                        promptRes._meta as { plurnk?: { resource?: string; actor?: string } } | undefined
                    )?.plurnk;
                    assert.equal(promptPlurnkMeta?.resource, "message://gookie/scoutproxy_00");
                    assert.equal(promptPlurnkMeta?.actor, "scoutproxy");
                    const expectedScoutSource = `acp://scoutproxy/sessions/${encodeURIComponent(created.sessionId)}/messages/msg-scout-1`;
                    assert.equal(capturedScoutRunLoop?.source, expectedScoutSource);
                    assert.equal(capturedScoutRunLoop?.messageAddress, expectedScoutSource);
                    await waitFor(() => scoutUpdates.some((u) => u.sessionUpdate === "agent_message_chunk"));
                    const replyChunk = scoutUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
                    const replyMeta = (replyChunk?._meta as {
                        plurnk?: {
                            actor?: string;
                            actors?: string[];
                            receipt?: {
                                repliedTo?: string[];
                                repliedToMessageIds?: string[];
                                repliedToSources?: string[];
                            };
                        };
                    } | undefined)?.plurnk;
                    assert.equal(replyMeta?.actor, "scoutproxy");
                    assert.deepEqual(replyMeta?.actors, ["scoutproxy"]);
                    assert.deepEqual(replyMeta?.receipt?.repliedTo, ["message://gookie/scoutproxy_00"]);
                    assert.deepEqual(replyMeta?.receipt?.repliedToMessageIds, ["msg-scout-1"]);
                    assert.deepEqual(replyMeta?.receipt?.repliedToSources, [expectedScoutSource]);

                    // Under OIDC, explicit matching _meta.plurnk.actor is admitted, mismatch is 403 actor-not-authorized, invalid is 400 actor-invalid
                    const matchingPrompt = await ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "Matching actor prompt" }],
                        _meta: { plurnk: { messageId: "msg-scout-2", actor: "acp://scoutproxy" } },
                    });
                    assert.equal(matchingPrompt.messageId, "msg-scout-2");
                    await assert.rejects(
                        () =>
                            ctx.request(methods.agent.session.prompt, {
                                sessionId: created.sessionId,
                                prompt: [{ type: "text", text: "Spoofed actor" }],
                                _meta: { plurnk: { messageId: "msg-scout-spoof", actor: "hazool17" } },
                            }),
                        /actor-not-authorized/u,
                    );
                    await assert.rejects(
                        () =>
                            ctx.request(methods.agent.session.prompt, {
                                sessionId: created.sessionId,
                                prompt: [{ type: "text", text: "Invalid actor" }],
                                _meta: { plurnk: { messageId: "msg-scout-bad", actor: "session://worker" } },
                            }),
                        /actor-invalid/u,
                    );

                    // op.exec enforces OIDC subject authority on plurnk.send({ actor }) and attributes calls to acp://<subject>
                    const spoofExec = await ctx.request<{ results: Array<{ status: number; problem?: { type?: string } }> }>(
                        "_plurnk/action",
                        {
                            kind: "op.exec",
                            sessionId: created.sessionId,
                            params: {
                                text: 'await plurnk.send({"target":"session://gookie","actor":"hazool17","text":"spoof"});',
                            },
                        },
                    );
                    assert.equal(spoofExec.results[0]?.status, 403);
                    assert.match(String(spoofExec.results[0]?.problem?.type), /actor-not-authorized/u);

                    h.port.dispatchClientActionCalls.length = 0;
                    const selfExec = await ctx.request<{ results: Array<{ status: number }> }>(
                        "_plurnk/action",
                        {
                            kind: "op.exec",
                            sessionId: created.sessionId,
                            params: {
                                text: 'await plurnk.send({"target":"session://gookie","actor":"scoutproxy","text":"self"});',
                            },
                        },
                    );
                    assert.equal(selfExec.results[0]?.status, 200);
                    assert.equal(h.port.dispatchClientActionCalls.at(-1)?.actor, "acp://scoutproxy");
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
                    definitions: Array<{
                        alias: string;
                        definition: { type: string; url: string; headers?: Record<string, string> };
                    }>;
                };
                const bridged = mcpList.definitions.find((item) => item.alias === "ide-tools");
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
                assert.equal(s0Meta?.name, "session1");
                assert.equal(s0Meta?.sessionName, "session1");
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

                // Resume 1#session1 so peer is bound to workspace 1, then rename workspace 1
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#session1",
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
                assert.equal(infoUpdate?.title, "alpha-renamed#session1");

                const translator = new SessionTranslator({ acpSessionId: "1#session1", workspaceId: 1, sessionId: 1 });
                const configNotice = {
                    source: "engine:configuration",
                    kind: "configuration_unavailable",
                    level: "info" as const,
                    message: "PLURNK_MCP_broken must be an MCP server definition.",
                };
                assert.equal(translator.notice(configNotice).length, 1);
                assert.equal(translator.notice(configNotice).length, 0);
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-http-authorization} {§acp-body-reference} {§acp-history-window}: HTTPS reverse-proxy origin resolution via PLURNK_AUTH_ISSUER and loopback X-Forwarded-Proto", async () => {
        // 1. Configured PLURNK_AUTH_ISSUER (e.g. behind plurnk.nginx.conf without X-Forwarded-Proto)
        const hIssuer = await createHarness({
            authMode: "oauth",
            issuer: "https://plurnk.example.com",
            env: { PLURNK_ACP_HISTORY_LOOPS: "1" },
        });
        try {
            hIssuer.port.logs.push(
                makeLogEntry({
                    id: 1,
                    session_id: 1,
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 1,
                    op: "done",
                    attrs: { kind: "message", to: "acp://operator", body: "Loop 1 reply" },
                    rx: { status: 200, completion: 200, content: "Loop 1 reply", mimetype: "text/markdown" },
                }),
                makeLogEntry({
                    id: 2,
                    session_id: 1,
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    op: "done",
                    attrs: { kind: "message", to: "acp://operator", body: "Loop 2 reply" },
                    rx: { status: 200, completion: 200, content: "Loop 2 reply", mimetype: "text/markdown" },
                }),
            );

            const messagesRes = await fetch(`${hIssuer.baseUrl}/1/1/messages?session=1%23session1`, {
                headers: {
                    authorization: "Bearer valid-token",
                    host: "plurnk.example.com",
                },
            });
            assert.equal(messagesRes.status, 200);
            const page = (await messagesRes.json()) as {
                updates: Array<{ _meta?: { plurnk?: { body?: { url?: string } } } }>;
                history?: { older?: string };
            };
            assert.match(page.history?.older ?? "", /^https:\/\/plurnk\.example\.com\/acp\/1\/1\/messages\?/u);
            assert.match(
                page.updates[0]?._meta?.plurnk?.body?.url ?? "",
                /^https:\/\/plurnk\.example\.com\/acp\/1\/1\/entry\?/u,
            );

            const wsUpdates: SessionUpdate[] = [];
            const wsStream = createWebSocketStream(hIssuer.wsUrl, {
                WebSocket: WsConstructor,
                headers: { authorization: "Bearer valid-token" },
            });
            const wsApp = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                wsUpdates.push(params.update);
            });
            await wsApp.connectWith(wsStream, async (ctx) => {
                await ctx.initialized;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#session1",
                    cwd: "/workspace/alpha",
                    replayFrom: { type: "start" },
                });
                await waitFor(() => wsUpdates.some((u) => u.sessionUpdate === "replay_complete"));
                const msgUpdate = wsUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
                const bodyUrl = (msgUpdate?._meta as { plurnk?: { body?: { url?: string } } } | undefined)?.plurnk
                    ?.body?.url;
                assert.match(bodyUrl ?? "", /^https:\/\/plurnk\.example\.com\/acp\/1\/1\/entry\?/u);

                const listed = await ctx.request(methods.agent.session.list, { cwd: "/workspace/alpha" });
                const replyUrl = (
                    listed.sessions[0]?._meta as
                        | { plurnk?: { reply?: { body?: { url?: string } } } }
                        | undefined
                )?.plurnk?.reply?.body?.url;
                assert.match(replyUrl ?? "", /^https:\/\/plurnk\.example\.com\/acp\/1\/1\/entry\?/u);
            });
        } finally {
            await hIssuer.close();
        }

        // 2. X-Forwarded-Proto: https on loopback listener vs non-loopback listener & direct HTTP preservation
        const hProxy = await createHarness({
            authMode: "oauth",
            env: { PLURNK_ACP_HISTORY_LOOPS: "1" },
        });
        try {
            hProxy.port.logs.push(
                makeLogEntry({
                    id: 1,
                    session_id: 1,
                    loop_id: 1,
                    loop_seq: 1,
                    turn_id: 1,
                    turn_seq: 1,
                    sequence: 1,
                    op: "done",
                    attrs: { kind: "message", to: "acp://operator", body: "First" },
                    rx: { status: 200, completion: 200, content: "First", mimetype: "text/markdown" },
                }),
                makeLogEntry({
                    id: 2,
                    session_id: 1,
                    loop_id: 2,
                    loop_seq: 2,
                    turn_id: 2,
                    turn_seq: 1,
                    sequence: 1,
                    op: "done",
                    attrs: { kind: "message", to: "acp://operator", body: "Second" },
                    rx: { status: 200, completion: 200, content: "Second", mimetype: "text/markdown" },
                }),
            );

            const rawHttpGetJson = (
                urlStr: string,
                headers: Record<string, string>,
            ): Promise<{ status: number; body: unknown }> =>
                new Promise((resolve, reject) => {
                    const u = new URL(urlStr);
                    const req = http.request(
                        {
                            hostname: u.hostname,
                            port: u.port,
                            path: `${u.pathname}${u.search}`,
                            method: "GET",
                            headers,
                        },
                        (res) => {
                            let raw = "";
                            res.setEncoding("utf8");
                            res.on("data", (chunk) => {
                                raw += chunk;
                            });
                            res.on("end", () => {
                                resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
                            });
                        },
                    );
                    req.on("error", reject);
                    req.end();
                });

            // Loopback listener honors X-Forwarded-Proto: https with nginx `Host: $host` without appending internal port
            const forwardedRes = await rawHttpGetJson(`${hProxy.baseUrl}/1/1/messages?session=1%23session1`, {
                authorization: "Bearer valid-token",
                host: "proxy.example.com",
                "x-forwarded-proto": "https",
            });
            assert.equal(forwardedRes.status, 200);
            const forwardedPage = forwardedRes.body as {
                updates: Array<{ _meta?: { plurnk?: { body?: { url?: string } } } }>;
                history?: { older?: string };
            };
            assert.match(forwardedPage.history?.older ?? "", /^https:\/\/proxy\.example\.com\/acp\/1\/1\/messages\?/u);
            assert.match(
                forwardedPage.updates[0]?._meta?.plurnk?.body?.url ?? "",
                /^https:\/\/proxy\.example\.com\/acp\/1\/1\/entry\?/u,
            );

            // Direct HTTP without X-Forwarded-Proto preserves http://<host>:<listenerPort>
            const listenerPort = hProxy.port.httpAddress().port;
            const directRes = await rawHttpGetJson(`${hProxy.baseUrl}/1/1/messages?session=1%23session1`, {
                authorization: "Bearer valid-token",
                host: "localhost",
            });
            assert.equal(directRes.status, 200);
            const directPage = directRes.body as { history?: { older?: string } };
            assert.match(
                directPage.history?.older ?? "",
                new RegExp(`^http://localhost:${listenerPort}/acp/1/1/messages\\?`, "u"),
            );

            // Non-loopback listener ignores spoofed X-Forwarded-Proto: https
            const origHttpAddress = hProxy.port.httpAddress.bind(hProxy.port);
            hProxy.port.httpAddress = () => ({ host: "192.0.2.10", port: listenerPort });
            try {
                const untrustedRes = await rawHttpGetJson(`${hProxy.baseUrl}/1/1/messages?session=1%23session1`, {
                    authorization: "Bearer valid-token",
                    host: "spoofed.example.com:8080",
                    "x-forwarded-proto": "https",
                });
                assert.equal(untrustedRes.status, 200);
                const untrustedPage = untrustedRes.body as { history?: { older?: string } };
                assert.match(
                    untrustedPage.history?.older ?? "",
                    /^http:\/\/spoofed\.example\.com:8080\/acp\/1\/1\/messages\?/u,
                );
            } finally {
                hProxy.port.httpAddress = origHttpAddress;
            }
        } finally {
            await hProxy.close();
        }
    });

    test("{§acp-body-reference} {§acp-http-authorization}: /entry admits ?access_token= on GET/HEAD and streams decoded binary Buffer bytes without charset=utf-8", async () => {
        const h = await createHarness({ authMode: "oauth" });
        try {
            // Raw PNG header + non-UTF-8 bytes stored as base64 in channel content (matching ClientReads / EntryCrud)
            const rawPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
            const pngTarget = "session://session1/attachments/a1b2c3d4/diagram.png";
            h.port.entryContents.set(`${pngTarget}#body`, rawPngBytes.toString("base64"));
            h.port.entryMimetypes.set(`${pngTarget}#body`, "image/png");

            const mdTarget = "workspace:///notes.md";
            const mdText = "# Hello UTF-8 — café\n";
            h.port.entryContents.set(`${mdTarget}#body`, mdText);
            h.port.entryMimetypes.set(`${mdTarget}#body`, "text/markdown");

            // Missing token -> 401
            const unauthRes = await fetch(`${h.baseUrl}/1/1/entry?target=${encodeURIComponent(pngTarget)}`);
            assert.equal(unauthRes.status, 401);
            assert.equal(unauthRes.headers.get("cache-control"), "no-store");

            // Invalid query token -> 401
            const badTokenRes = await fetch(
                `${h.baseUrl}/1/1/entry?target=${encodeURIComponent(pngTarget)}&access_token=invalid-token`,
            );
            assert.equal(badTokenRes.status, 401);

            // Non-/entry HTTP routes still reject ?access_token= without Authorization header
            const messagesQueryToken = await fetch(`${h.baseUrl}/1/1/messages?access_token=valid-token`);
            assert.equal(messagesQueryToken.status, 401);
            assert.equal(messagesQueryToken.headers.get("cache-control"), "no-store");

            // Authenticated GET /messages and Streamable HTTP /acp (POST, GET SSE, DELETE) carry cache-control: no-store
            const messagesRes = await fetch(`${h.baseUrl}/1/1/messages`, {
                headers: { authorization: "Bearer valid-token" },
            });
            assert.equal(messagesRes.status, 200);
            assert.equal(messagesRes.headers.get("cache-control"), "no-store");

            const initRes = await fetch(h.baseUrl, {
                method: "POST",
                headers: {
                    authorization: "Bearer valid-token",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" } },
                }),
            });
            assert.equal(initRes.status, 200);
            assert.equal(initRes.headers.get("cache-control"), "no-store");
            const connId = initRes.headers.get("acp-connection-id");
            assert.ok(connId);

            const sseAbort = new AbortController();
            const sseRes = await fetch(h.baseUrl, {
                headers: {
                    authorization: "Bearer valid-token",
                    accept: "text/event-stream",
                    "acp-connection-id": connId,
                },
                signal: sseAbort.signal,
            });
            assert.equal(sseRes.status, 200);
            assert.equal(sseRes.headers.get("cache-control"), "no-store");
            sseAbort.abort();

            const delRes = await fetch(h.baseUrl, {
                method: "DELETE",
                headers: {
                    authorization: "Bearer valid-token",
                    "acp-connection-id": connId,
                },
            });
            assert.equal(delRes.status, 202);
            assert.equal(delRes.headers.get("cache-control"), "no-store");

            // GET /entry with ?access_token= on binary image/png returns decoded bytes and exact content-type without charset
            const pngGet = await fetch(
                `${h.baseUrl}/1/1/entry?target=${encodeURIComponent(pngTarget)}&access_token=valid-token`,
            );
            assert.equal(pngGet.status, 200);
            assert.equal(pngGet.headers.get("content-type"), "image/png");
            assert.equal(pngGet.headers.get("content-length"), String(rawPngBytes.byteLength));
            assert.equal(pngGet.headers.get("cache-control"), "no-store");
            const fetchedBytes = Buffer.from(await pngGet.arrayBuffer());
            assert.deepEqual(fetchedBytes, rawPngBytes);

            // HEAD /entry with ?access_token= returns exact headers and empty body
            const pngHead = await fetch(
                `${h.baseUrl}/1/1/entry?target=${encodeURIComponent(pngTarget)}&access_token=valid-token`,
                { method: "HEAD" },
            );
            assert.equal(pngHead.status, 200);
            assert.equal(pngHead.headers.get("content-type"), "image/png");
            assert.equal(pngHead.headers.get("content-length"), String(rawPngBytes.byteLength));
            assert.equal((await pngHead.arrayBuffer()).byteLength, 0);

            // GET /entry with ?access_token= on textual channel retains `; charset=utf-8`
            const mdGet = await fetch(
                `${h.baseUrl}/1/1/entry?target=${encodeURIComponent(mdTarget)}&access_token=valid-token`,
            );
            assert.equal(mdGet.status, 200);
            assert.equal(mdGet.headers.get("content-type"), "text/markdown; charset=utf-8");
            assert.equal(await mdGet.text(), mdText);
        } finally {
            await h.close();
        }
    });
});
