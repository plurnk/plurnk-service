import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WsConstructor } from "../harness.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test(
    "{§acp-session-owner} {§acp-proposal-resolve}: concurrent peers on the same session receive permission requests and converge when one answers or when the loop is cancelled, and reattaching via session/resume re-presents a held gate",
    { timeout: 30_000 },
    async () => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            http,
            nodeModulesPath: join(SERVICE, "node_modules"),
            provider: new Mock({
                contextWindow: 32768,
                responses: [
                    makeMockResponse("````sh\necho held-once\n````"),
                    makeMockResponse("````SEND [200]\nDone.\n````"),
                    makeMockResponse("````sh\necho cancelled-gate\n````"),
                ],
            }),
        });

        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;

            // 1. Peer 1 starts a prompt that pauses on a `sh` proposal, then disconnects without answering
            const firstGateSeen = Promise.withResolvers<RequestPermissionRequest>();
            const releasePeer1 = Promise.withResolvers<void>();
            const peer1App = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "peer-1", version: "1.0.0" },
                    });
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    firstGateSeen.resolve(params);
                    await releasePeer1.promise;
                    return { outcome: { outcome: "cancelled" } };
                });

            let sessionId = "";
            await peer1App.connectWith(createWebSocketStream(wsUrl, { WebSocket: WsConstructor }), async (ctx) => {
                await ctx.initialized;
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: "/tmp/held-ws",
                    _meta: { plurnk: { workspace: "held", sessionName: "operator" } },
                });
                sessionId = created.sessionId;
                await ctx.request(methods.agent.session.prompt, {
                    sessionId,
                    prompt: [{ type: "text", text: "Run the shell command." }],
                });
                await firstGateSeen.promise;
                // Disconnect peer 1 while the proposal is still pending in Core
            });
            releasePeer1.resolve();

            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace);
            assert.equal((await daemon.pendingProposals(workspace.id)).length, 1, "proposal remains pending after peer 1 disconnects");

            // 2. Peer 2 and Peer 3 both attach via `session/resume`; both receive the re-presented permission request.
            // Peer 2 holds its request until Peer 3 answers `allow_once`, which aborts Peer 2's request via $/cancel_request.
            const peer2GateSeen = Promise.withResolvers<void>();
            const peer2Aborted = Promise.withResolvers<boolean>();
            const peer3Decision = Promise.withResolvers<RequestPermissionResponse>();

            const peer2App = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "peer-2", version: "1.0.0" },
                    });
                })
                .onRequest(methods.client.session.requestPermission, async (ctx) => {
                    peer2GateSeen.resolve();
                    return await new Promise<RequestPermissionResponse>((_resolve, reject) => {
                        ctx.signal.addEventListener(
                            "abort",
                            () => {
                                peer2Aborted.resolve(true);
                                reject(new Error("aborted"));
                            },
                            { once: true },
                        );
                    });
                });

            const peer3GateSeen = Promise.withResolvers<void>();
            const peer3App = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "peer-3", version: "1.0.0" },
                    });
                })
                .onRequest(methods.client.session.requestPermission, async () => {
                    peer3GateSeen.resolve();
                    return await peer3Decision.promise;
                });

            await peer2App.connectWith(createWebSocketStream(wsUrl, { WebSocket: WsConstructor }), async (ctx2) => {
                await ctx2.initialized;
                await ctx2.request(methods.agent.session.resume, { sessionId, cwd: "/tmp/held-ws" });
                await peer2GateSeen.promise;

                await peer3App.connectWith(createWebSocketStream(wsUrl, { WebSocket: WsConstructor }), async (ctx3) => {
                    await ctx3.initialized;
                    await ctx3.request(methods.agent.session.resume, { sessionId, cwd: "/tmp/held-ws" });
                    await peer3GateSeen.promise;

                    // Peer 3 approves the proposal
                    peer3Decision.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
                    assert.equal(await peer2Aborted.promise, true, "Peer 2 receives $/cancel_request when Peer 3 settles the gate");

                    const operatorSession = await daemon.readSession({
                        workspaceId: workspace.id,
                        identity: { name: "operator" },
                    });
                    assert.ok(operatorSession);
                    await waitForDb(
                        () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: operatorSession.id }),
                        (loops: Array<{ terminalResult: { status: number } | null }>) =>
                            loops.some(({ terminalResult }) => terminalResult?.status === 200),
                    );
                    assert.deepEqual(await daemon.pendingProposals(workspace.id), []);
                });

                // 3. Start a second loop that pauses on a `sh` proposal, then cancel the session:
                // verify `cancelSessionGates` aborts the in-flight permission request on `loop/terminated`.
                const cancelGateSeen = Promise.withResolvers<void>();
                const cancelGateAborted = Promise.withResolvers<boolean>();
                const peer4App = createRawAcpClient()
                    .onConnect((conn) => {
                        void conn.agent.request(methods.agent.initialize, {
                            protocolVersion: PROTOCOL_VERSION,
                            info: { name: "peer-4", version: "1.0.0" },
                        });
                    })
                    .onRequest(methods.client.session.requestPermission, async (ctx) => {
                        cancelGateSeen.resolve();
                        return await new Promise<RequestPermissionResponse>((_resolve, reject) => {
                            ctx.signal.addEventListener(
                                "abort",
                                () => {
                                    cancelGateAborted.resolve(true);
                                    reject(new Error("aborted"));
                                },
                                { once: true },
                            );
                        });
                    });

                await peer4App.connectWith(createWebSocketStream(wsUrl, { WebSocket: WsConstructor }), async (ctx4) => {
                    await ctx4.initialized;
                    await ctx4.request(methods.agent.session.resume, { sessionId, cwd: "/tmp/held-ws" });
                    await ctx4.request(methods.agent.session.prompt, {
                        sessionId,
                        prompt: [{ type: "text", text: "Run second shell command." }],
                    });
                    await cancelGateSeen.promise;
                    await ctx4.notify(methods.agent.session.cancel, { sessionId });
                    assert.equal(
                        await cancelGateAborted.promise,
                        true,
                        "cancelling the session aborts the in-flight permission request on loop/terminated",
                    );
                });
            });
        } finally {
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);
