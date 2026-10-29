import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type CreateElicitationRequest,
    type RequestPermissionRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WsConstructor } from "../harness.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test(
    "{§acp-session-owner} {§acp-proposal-resolve}: switching to a spawned child session or a client-created session claims it for acp://operator and resolves its proposals and interactions",
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
                    makeMockResponse("````WORK (session://spawned)\nSay ready.\n````\n````WAIT\n````"),
                    makeMockResponse("````SEND [200]\nReady.\n````"),
                    makeMockResponse("````SEND [200]\nSpawned child.\n````"),
                    makeMockResponse(
                        '````plurnk (question)\n{"message":"Proceed?","requestedSchema":{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}}\n````',
                    ),
                    makeMockResponse("````SEND [200]\nChild answered.\n````"),
                    makeMockResponse("````sh\necho helper-ok\n````"),
                    makeMockResponse("````SEND [200]\nHelper done.\n````"),
                ],
            }),
        });

        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;

            const elicitationRequests: CreateElicitationRequest[] = [];
            const permissionRequests: RequestPermissionRequest[] = [];

            const clientApp = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "owner-test", version: "1.0.0" },
                    });
                })
                .onRequest(methods.client.elicitation.create, async ({ params }) => {
                    elicitationRequests.push(params);
                    return { action: "accept", content: { proceed: true } };
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests.push(params);
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                });

            const stream = createWebSocketStream(wsUrl, { WebSocket: WsConstructor });
            await clientApp.connectWith(stream, async (ctx) => {
                await ctx.initialized;

                // 1. Create parent session with systemPrompt (mode: "append") and prompt it to spawn `spawned`
                const parentSession = await ctx.request(methods.agent.session.new, {
                    cwd: "/tmp/owner-tabs",
                    systemPrompt: {
                        mode: "append",
                        content: [{ type: "text", text: "Parent session instructions." }],
                    },
                    _meta: { plurnk: { workspace: "tabs", sessionName: "parent" } },
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: parentSession.sessionId,
                    prompt: [{ type: "text", text: "Spawn a child." }],
                });

                const [workspace] = await daemon.listWorkspaces();
                assert.ok(workspace);
                const parentRow = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "parent" },
                });
                assert.ok(parentRow);
                const sessionAgentsMd = await daemon.readEntry({
                    workspaceId: workspace.id,
                    sessionId: parentRow.id,
                    target: "session://parent/AGENTS.md",
                });
                assert.equal(sessionAgentsMd.status, 200);
                assert.match(sessionAgentsMd.entry?.channels.body?.content ?? "", /Parent session instructions\./u);
                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: parentRow.id }),
                    (loops: Array<{ terminalResult: { status: number } | null }>) =>
                        loops.some(({ terminalResult }) => terminalResult?.status === 200),
                );
                const parentLogs: Array<{
                    op: string;
                    scheme: string | null;
                    hostname: string | null;
                    pathname: string | null;
                }> = await daemon.readLog({
                    workspaceId: workspace.id,
                    sessionId: parentRow.id,
                });
                assert.ok(
                    parentLogs.some(
                        (e) =>
                            e.op === "READ" &&
                            e.scheme === "session" &&
                            e.hostname === "parent" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    "Turn 0 foists READ (session://parent/AGENTS.md) materialized from ACP systemPrompt",
                );

                // Also create an unowned session `helper` directly so `session/resume` claims it for `acp://operator`
                await daemon.createSession({
                    workspaceId: workspace.id,
                    name: "helper",
                });

                // 2. Resume `${workspace.id}#spawned` and prompt it: it invokes `question` and resolves via elicitation/create
                const childSessionId = `${workspace.id}#spawned`;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: childSessionId,
                    cwd: "/tmp/owner-tabs",
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: childSessionId,
                    prompt: [{ type: "text", text: "Ask me." }],
                });
                const spawnedRow = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "spawned" },
                });
                assert.ok(spawnedRow);
                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: spawnedRow.id }),
                    (loops: Array<{ terminalResult: { status: number } | null }>) =>
                        loops.length >= 2 && loops.every(({ terminalResult }) => terminalResult?.status === 200),
                );
                assert.equal(elicitationRequests.length, 1);

                // 3. Resume `${workspace.id}#helper`: claims ownership for `acp://operator` and resolves its `sh` proposal
                const helperSessionId = `${workspace.id}#helper`;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: helperSessionId,
                    cwd: "/tmp/owner-tabs",
                });
                const helperRow = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "helper" },
                });
                assert.ok(helperRow);
                assert.equal(helperRow.owner, "acp://operator");

                await ctx.request(methods.agent.session.prompt, {
                    sessionId: helperSessionId,
                    prompt: [{ type: "text", text: "Run sh." }],
                });
                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: helperRow.id }),
                    (loops: Array<{ terminalResult: { status: number } | null }>) =>
                        loops.some(({ terminalResult }) => terminalResult?.status === 200),
                );
                assert.equal(permissionRequests.length, 1);
            });
        } finally {
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);
