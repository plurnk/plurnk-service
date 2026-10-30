import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    createWebSocketStream,
    type WebSocketConstructor,
} from "@agentclientprotocol/sdk/experimental/ws-client";
import type { ApplicationLoopProjection, OperationResult } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test(
    "{§acp-session-owner} {§connection-lifecycle}: disconnecting an ACP client after resolving a proposal leaves the executor and loop running to completion",
    { timeout: 30_000 },
    async () => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);
        const command = "printf ready; sleep 0.3; printf done";
        const provider = new Mock({
            contextWindow: 32768,
            responses: [
                makeMockResponse(`\`\`\`sh\n${command}\n\`\`\``),
                makeMockResponse("````SEND [200]\nCompleted.\n````"),
            ],
        });
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            http,
            provider,
            nodeModulesPath: join(SERVICE, "node_modules"),
        });
        const application: ApplicationPort = daemon;
        const streamWriting = Promise.withResolvers<void>();
        const streamConcluded = Promise.withResolvers<{ sessionId: number; result: OperationResult }>();
        const off = application.subscribeToEvents((_workspace, method, params) => {
            const target = (params as { target?: unknown }).target;
            if (typeof target !== "string" || !target.startsWith("sh://")) return;
            if (method === "stream/event" && (params as { contentLength: number }).contentLength > 0) {
                streamWriting.resolve();
            }
            if (method === "stream/concluded") {
                streamConcluded.resolve(params as { sessionId: number; result: OperationResult });
            }
        });

        const activeSockets: WebSocket[] = [];
        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;

            const TrackingWs = class extends WebSocket {
                constructor(address: string | URL, protocols?: string | string[]) {
                    super(address, protocols);
                    activeSockets.push(this);
                }
            } as unknown as WebSocketConstructor;

            const permissionReceived = Promise.withResolvers<RequestPermissionRequest>();
            const approveSignal = Promise.withResolvers<void>();
            const holdConn = Promise.withResolvers<void>();

            const clientApp = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "disconnect-test", version: "1.0.0" },
                    });
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionReceived.resolve(params);
                    await approveSignal.promise;
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                });

            const stream = createWebSocketStream(wsUrl, { WebSocket: TrackingWs });
            const connPromise = clientApp
                .connectWith(stream, async (ctx) => {
                    await ctx.initialized;
                    const created = await ctx.request(methods.agent.session.new, {
                        cwd: "/tmp",
                        _meta: { plurnk: { workspace: "disconnect", projectRoot: null } },
                    });
                    await ctx.request(methods.agent.session.prompt, {
                        sessionId: created.sessionId,
                        prompt: [{ type: "text", text: "Run the command and conclude." }],
                    });
                    await holdConn.promise;
                })
                .catch(() => undefined);

            await permissionReceived.promise;
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace);
            const [proposal] = await daemon.pendingProposals(workspace.id);
            assert.ok(proposal, "proposal is pending before approval");

            approveSignal.resolve();
            await streamWriting.promise;

            // Force-close the client WebSocket while the shell command is still running
            for (const ws of activeSockets) ws.terminate();
            holdConn.resolve();
            await connPromise;

            const concluded = await streamConcluded.promise;
            assert.equal(concluded.sessionId, proposal.sessionId, "the accepted operation's session finishes it");
            assert.equal(concluded.result.status, 200, "the executor runs to its own end rather than being reaped");
            assert.deepEqual(await daemon.pendingProposals(workspace.id), [], "the accepted decision stands");

            const loops: ApplicationLoopProjection[] = await waitForDb(
                () => application.listSessionLoops({ workspaceId: workspace.id, sessionId: proposal.sessionId }),
                (rows: ApplicationLoopProjection[]) =>
                    rows.some((row) => row.id === proposal.loopId && row.terminalResult !== null),
            );
            const result = loops.find((loop) => loop.id === proposal.loopId)?.terminalResult;
            assert.equal(result?.status, 200, "the loop concludes cleanly at 200 after client disconnect");
        } finally {
            for (const ws of activeSockets) ws.terminate();
            off();
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);

test(
    "{§acp-session-owner} {§connection-lifecycle}: disconnecting a client during an op.parse script leaves the command running to completion",
    { timeout: 30_000 },
    async () => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            http,
            provider: new Mock({ contextWindow: 32768, responses: [] }),
            nodeModulesPath: join(SERVICE, "node_modules"),
        });
        const application: ApplicationPort = daemon;
        const writing = Promise.withResolvers<string>();
        const concluded = new Map<string, OperationResult>();
        const off = application.subscribeToEvents((_workspace, method, params) => {
            if (method === "stream/event" && (params as { contentLength: number }).contentLength > 0) {
                writing.resolve((params as { target: string }).target);
            }
            if (method === "stream/concluded") {
                concluded.set(
                    (params as { target: string }).target,
                    (params as { result: OperationResult }).result,
                );
            }
        });

        const activeSockets: WebSocket[] = [];
        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;
            const TrackingWs = class extends WebSocket {
                constructor(address: string | URL, protocols?: string | string[]) {
                    super(address, protocols);
                    activeSockets.push(this);
                }
            } as unknown as WebSocketConstructor;

            const clientApp = createRawAcpClient().onConnect((conn) => {
                void conn.agent.request(methods.agent.initialize, {
                    protocolVersion: PROTOCOL_VERSION,
                    info: { name: "script-disconnect-test", version: "1.0.0" },
                });
            });

            const stream = createWebSocketStream(wsUrl, { WebSocket: TrackingWs });
            const connPromise = clientApp
                .connectWith(stream, async (ctx) => {
                    await ctx.initialized;
                    await ctx.request("_plurnk/action", {
                        kind: "workspace.create",
                        params: { name: "script-disconnect" },
                    });
                    void ctx
                        .request("_plurnk/action", {
                            kind: "op.parse",
                            workspace: "script-disconnect",
                            params: {
                                text: "````sh\nprintf ready; sleep 0.3; printf done\n````",
                            },
                        })
                        .catch(() => undefined);
                    await writing.promise;
                })
                .catch(() => undefined);

            const target = await writing.promise;
            for (const ws of activeSockets) ws.terminate();
            await connPromise;

            const finished: OperationResult = await waitForDb(
                async () => concluded.get(target),
                (res: OperationResult | undefined) => res !== undefined,
            );
            assert.equal(finished.status, 200, "op.parse command ran to completion after client disconnected");
        } finally {
            for (const ws of activeSockets) ws.terminate();
            off();
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);
