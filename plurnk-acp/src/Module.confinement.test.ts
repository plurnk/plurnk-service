import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    PROTOCOL_VERSION,
    RequestError,
    client as createRawAcpClient,
    methods,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Problems, type ApplicationDaemonPolicy } from "@plurnk/plurnk-contracts";
import { WsConstructor, createAcpClient, createHarness } from "../test/harness.ts";

describe("{§acp-daemon-client} {§operator-config-workspace-settings} plurnk-acp project-root confinement", { concurrency: true }, () => {
    for (const mode of ["unrestricted", "confined", "none"] as const) {
        test(`{§acp-daemon-client} {§operator-config-workspace-settings}: initialize advertises _meta.plurnk.policy (${mode}) and omits additionalDirectories under none`, async () => {
            const policy: ApplicationDaemonPolicy = {
                projectRoot: mode,
                families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                ...(mode === "confined" ? {
                    mcp: { workspaceTransports: ["streamable-http"], publicOnly: true },
                    skills: { workspaceSources: ["mcp", "local"], publicOnly: true },
                } : {}),
            };
            const h = await createHarness();
            h.port.daemonPolicy = () => policy;
            try {
                const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
                const app = createRawAcpClient();
                await app.connectWith(stream, async (ctx) => {
                    const init = await ctx.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "test-client", version: "1.0.0" },
                        capabilities: {},
                    });
                    const meta = (init._meta as { plurnk?: { policy?: ApplicationDaemonPolicy } } | undefined)?.plurnk;
                    assert.deepEqual(meta?.policy, policy);
                    if (mode === "none") {
                        assert.equal(init.capabilities?.session?.additionalDirectories, undefined);
                    } else {
                        assert.deepEqual(init.capabilities?.session?.additionalDirectories, {});
                    }
                });
            } finally {
                await h.close();
            }
        });
    }

    test("{§acp-daemon-client} {§operator-config-workspace-settings}: session/new refuses additionalDirectories under none and headless confined policies", async () => {
        const hNone = await createHarness();
        hNone.port.daemonPolicy = () => ({ projectRoot: "none" });
        try {
            const stream = createWebSocketStream(hNone.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/",
                        additionalDirectories: ["/etc"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type === "https://problems.plurnk.xyz/acp/project-root-forbidden";
                    },
                );
            });
        } finally {
            await hNone.close();
        }

        const hConfined = await createHarness();
        hConfined.port.daemonPolicy = () => ({ projectRoot: "confined" });
        const origInvoke = hConfined.port.invokeModuleAction.bind(hConfined.port);
        hConfined.port.invokeModuleAction = async (name, params, context) => {
            if (name === "workspace.members.add") {
                const problem = Problems.create("members:functionality", "members-confined", 403, "Confined to project root.");
                throw Object.assign(new Error(problem.detail), { problem });
            }
            return origInvoke(name, params, context);
        };
        try {
            const stream = createWebSocketStream(hConfined.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                // Headless session under confined mode refuses additionalDirectories before invoking members.add.
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/",
                        additionalDirectories: ["/srv/tenants/other"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type?.endsWith("/members-confined") === true;
                    },
                );

                // Rooted session under confined mode propagates 403 members-confined from workspace.members.add.
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/srv/tenants/alice",
                        additionalDirectories: ["/srv/tenants/bob"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type?.endsWith("/members-confined") === true;
                    },
                );
            });
        } finally {
            await hConfined.close();
        }
    });

    test("{§acp-http-authorization} {§acp-action-binding}: authenticated bridge with canDelegateActor attributes exterior speakers over WS and HTTP while preserving non-owner restrictions and pinning ordinary users", async () => {
        const h = await createHarness({ authMode: "oauth" });
        try {
            // 1. WebSocket connection with authorized bridge delegate token.
            const BridgeWs = class extends (WsConstructor as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket) {
                constructor(url: string | URL) {
                    super(url, ["acp", "bearer.bridge-delegate-token"]);
                }
            };
            const structuredUpdates: Array<{ sessionUpdate: string; _meta?: unknown }> = [];
            const wsStream = createWebSocketStream(h.wsUrl, {
                WebSocket: BridgeWs as unknown as typeof WsConstructor,
            });
            const bridgeApp = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                structuredUpdates.push(params.update);
            });
            await bridgeApp.connectWith(wsStream, async (ctx) => {
                const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace/alpha" });

                // Delegated exterior speaker prompt succeeds and attributes causal source to the exterior speaker.
                const delegated = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "/mcp list" }],
                    _meta: { plurnk: { messageId: "msg-tg-1", actor: "tg:12345" } },
                });
                assert.equal(delegated.messageId, "msg-tg-1");
                assert.equal((delegated._meta as { plurnk?: { actor?: string } } | undefined)?.plurnk?.actor, "tg:12345");
                const runCall = h.port.runLoopCalls.at(-1);
                assert.equal(runCall?.prompt, "/mcp list", "raw slash text from delegated exterior actor stays verbatim speech");
                assert.match(String(runCall?.messageAddress), /^acp:\/\/tg%3A12345\//u);

                // Delegated exterior speaker still cannot invoke operator Command blocks.
                await assert.rejects(
                    () => ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "command", name: "rollback", input: "1/1/1/edit" } as unknown as { type: "text"; text: string }],
                        _meta: { plurnk: { messageId: "msg-tg-cmd", actor: "tg:12345" } },
                    }),
                    (err: unknown) => err instanceof RequestError && err.code === -32000 && err.message.includes("actor-not-authorized"),
                );

                // Bridge delegate cannot spoof reserved default owner (`acp://operator`).
                await assert.rejects(
                    () => ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "Spoof operator" }],
                        _meta: { plurnk: { messageId: "msg-tg-op", actor: "acp://operator" } },
                    }),
                    (err: unknown) => err instanceof RequestError && err.code === -32000 && err.message.includes("actor-not-authorized"),
                );

                // Omitting _meta.plurnk.actor runs as the bridge's own verified subject.
                const selfPrompt = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Bridge self turn" }],
                    _meta: { plurnk: { messageId: "msg-bridge-self" } },
                });
                assert.equal(selfPrompt.messageId, "msg-bridge-self");
                assert.equal((selfPrompt._meta as { plurnk?: { actor?: string } } | undefined)?.plurnk?.actor, "plurnkbot");
                assert.match(String(h.port.runLoopCalls.at(-1)?.messageAddress), /^acp:\/\/plurnkbot\//u);

                // op.exec honors delegation for exterior speakers and still refuses spoofing `acp://operator`.
                const delegatedExec = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                    kind: "op.exec",
                    sessionId: created.sessionId,
                    params: { text: 'await plurnk.send({ target: "session://session1", text: "hi", actor: "tg:12345" });' },
                });
                assert.equal(delegatedExec.results[0]?.status, 200);

                const operatorExec = await ctx.request<{ results: Array<{ status: number; problem?: { type?: string } }> }>("_plurnk/action", {
                    kind: "op.exec",
                    sessionId: created.sessionId,
                    params: { text: 'await plurnk.send({ target: "session://session1", text: "hi", actor: "acp://operator" });' },
                });
                assert.equal(operatorExec.results[0]?.status, 403);
                assert.equal(operatorExec.results[0]?.problem?.type, "https://problems.plurnk.xyz/acp/actor-not-authorized");
                // Structured { id, handle, name } delegated speaker keeps durable id on messageAddress and readable handle on resource/actor.
                structuredUpdates.length = 0;
                const structured = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Hello from Slack" }],
                    _meta: {
                        plurnk: {
                            messageId: "msg-slack-1",
                            actor: { id: "U12345", handle: "alice", name: "Alice Smith" },
                        },
                    },
                });
                const structuredMeta = (structured._meta as {
                    plurnk?: { resource?: string; actor?: string; actorProfile?: unknown };
                } | undefined)?.plurnk;
                assert.equal(structuredMeta?.resource, "message://session-2/alice_00");
                assert.equal(structuredMeta?.actor, "alice");
                assert.deepEqual(structuredMeta?.actorProfile, {
                    id: "U12345",
                    handle: "alice",
                    name: "Alice Smith",
                });
                const structuredRun = h.port.runLoopCalls.at(-1);
                assert.match(String(structuredRun?.messageAddress), /^acp:\/\/U12345\//u);
                assert.deepEqual(structuredRun?.actor, {
                    id: "U12345",
                    handle: "alice",
                    name: "Alice Smith",
                });
                await new Promise((r) => setTimeout(r, 30));
                const agentReply = structuredUpdates.find((u) => u.sessionUpdate === "agent_message_chunk");
                const agentReplyMeta = (agentReply?._meta as { plurnk?: { actor?: string; actors?: string[] } } | undefined)?.plurnk;
                assert.equal(agentReplyMeta?.actor, "alice");
                assert.deepEqual(agentReplyMeta?.actors, ["alice"]);
            });

            // 2. Streamable HTTP also carries canDelegateActor per request.
            const httpStream = createHttpStream(h.baseUrl, {
                headers: { authorization: "Bearer bridge-delegate-token" },
            });
            await createAcpClient().connectWith(httpStream, async (ctx) => {
                const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace/alpha" });
                const delegated = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "HTTP bridged speaker" }],
                    _meta: { plurnk: { messageId: "msg-http-tg", actor: "tg:98765" } },
                });
                assert.equal(delegated.messageId, "msg-http-tg");
                assert.equal((delegated._meta as { plurnk?: { actor?: string } } | undefined)?.plurnk?.actor, "tg:98765");
                assert.match(String(h.port.runLoopCalls.at(-1)?.messageAddress), /^acp:\/\/tg%3A98765\//u);
            });

            // 3. Ordinary authenticated user (no canDelegateActor) stays strictly pinned to its own sub.
            const UserWs = class extends (WsConstructor as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket) {
                constructor(url: string | URL) {
                    super(url, ["acp", "bearer.scoutproxy-token"]);
                }
            };
            const userStream = createWebSocketStream(h.wsUrl, {
                WebSocket: UserWs as unknown as typeof WsConstructor,
            });
            await createAcpClient().connectWith(userStream, async (ctx) => {
                const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace/alpha" });
                await assert.rejects(
                    () => ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "User trying to spoof" }],
                        _meta: { plurnk: { messageId: "msg-user-spoof", actor: "tg:12345" } },
                    }),
                    (err: unknown) => err instanceof RequestError && err.code === -32000 && err.message.includes("actor-not-authorized"),
                );
            });

            // 4. Direct OIDC user with opaque `sub` (`auth0|507f1f77`) and profile claims (`alice` / `Alice Smith`) gets readable handle on resource and actor while keeping `sub` as durable authority.
            const OidcAliceWs = class extends (WsConstructor as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket) {
                constructor(url: string | URL) {
                    super(url, ["acp", "bearer.oidc-alice-token"]);
                }
            };
            const aliceStream = createWebSocketStream(h.wsUrl, {
                WebSocket: OidcAliceWs as unknown as typeof WsConstructor,
            });
            await createAcpClient().connectWith(aliceStream, async (ctx) => {
                const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace/alpha" });
                const prompted = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Hi from OIDC Alice" }],
                    _meta: { plurnk: { messageId: "msg-oidc-alice-1" } },
                });
                const meta = (prompted._meta as {
                    plurnk?: { resource?: string; actor?: string; actorProfile?: unknown };
                } | undefined)?.plurnk;
                assert.equal(meta?.resource, "message://session-5/alice_00");
                assert.equal(meta?.actor, "alice");
                assert.deepEqual(meta?.actorProfile, {
                    id: "auth0|507f1f77",
                    handle: "alice",
                    name: "Alice Smith",
                });
                assert.match(String(h.port.runLoopCalls.at(-1)?.messageAddress), /^acp:\/\/auth0%7C507f1f77\//u);

                const aliceExec = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                    kind: "op.exec",
                    sessionId: created.sessionId,
                    params: { text: 'await plurnk.send({ target: "session://session1", text: "Hi via op.exec" });' },
                });
                assert.equal(aliceExec.results[0]?.status, 200);
                const lastDispatched = h.port.dispatchClientActionCalls.at(-1);
                assert.equal(lastDispatched?.actor, "acp://auth0%7C507f1f77");
                const sentStmt = lastDispatched?.statements[0];
                assert.equal(sentStmt?.op, "send");
                if (sentStmt?.op === "send") {
                    assert.deepEqual(sentStmt.actor, {
                        id: "auth0|507f1f77",
                        handle: "alice",
                        name: "Alice Smith",
                    });
                }
            });
        } finally {
            await h.close();
        }
    });
});
