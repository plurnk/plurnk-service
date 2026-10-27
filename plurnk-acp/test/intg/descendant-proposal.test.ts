import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { isRecord } from "@plurnk/plurnk-contracts";
import { WsConstructor } from "../harness.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test(
    "{§acp-proposal-resolve} {§acp-topology-scope}: a child session proposal traverses to its owning parent session with subagent_update and proposal metadata, and approving it applies the child's edit",
    { timeout: 30_000 },
    async () => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);
        const provider = new Mock({
            contextWindow: 32768,
            responses: [
                makeMockResponse(
                    "````WORK (session://guesser1)\nCreate child.txt and conclude.\n````\n" +
                        "````WAIT\nWaiting for guesser1.\n````",
                    10,
                ),
                makeMockResponse(
                    "````EDIT (child.txt)\ncreated by child\n````\n" +
                        "````NOTE\nConfirming the write.\n````",
                    10,
                ),
                makeMockResponse("````SEND [200]\nChild work complete.\n````", 10),
                makeMockResponse("````SEND [200]\nDelegated work confirmed.\n````", 10),
            ],
        });
        const db = await openTestDatabase();
        const root = await mkdtemp(join(tmpdir(), "plurnk-descendant-proposal-"));
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            provider,
            nodeModulesPath: join(SERVICE, "node_modules"),
            http,
        });

        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;

            const permissionRequests: RequestPermissionRequest[] = [];
            const updates: SessionUpdate[] = [];

            const clientApp = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "descendant-proposal-client", version: "1.0.0" },
                    });
                })
                .onNotification(methods.client.session.update, async ({ params }) => {
                    updates.push(params.update);
                })
                .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                    permissionRequests.push(params);
                    return { outcome: { outcome: "selected", optionId: "allow_once" } };
                });

            await clientApp.connectWith(createWebSocketStream(wsUrl, { WebSocket: WsConstructor }), async (ctx) => {
                await ctx.initialized;
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: root,
                    _meta: {
                        plurnk: {
                            workspace: "delegated-proposal",
                            projectRoot: root,
                            sessionName: "delegated-proposal",
                        },
                    },
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Delegate this task." }],
                    _meta: { plurnk: { maxTurns: 6 } },
                });

                const [workspace] = await daemon.listWorkspaces();
                assert.ok(workspace);
                const parentSession = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "delegated-proposal" },
                });
                assert.ok(parentSession);
                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: parentSession.id }),
                    (loops: Array<{ terminalResult: { status: number } | null }>) =>
                        loops.some(({ terminalResult }) => terminalResult?.status === 200),
                );
            });

            assert.equal(permissionRequests.length, 1, "child EDIT proposal delivered to parent session");
            const reqMeta = permissionRequests[0]?._meta;
            assert.ok(isRecord(reqMeta) && isRecord(reqMeta.plurnk) && isRecord(reqMeta.plurnk.proposal));
            assert.equal(reqMeta.plurnk.proposal.op, "EDIT");
            assert.equal(reqMeta.plurnk.proposal.session, "guesser1");
            assert.ok(
                updates.some((u) => u.sessionUpdate === "subagent_update"),
                "subagent_update emitted to parent session",
            );
            assert.equal(provider.remaining, 0, "parent, child, and resumed parent each generated once");
            assert.equal(
                await readFile(join(root, "child.txt"), "utf8"),
                "created by child",
                "resolving the parent-delivered gate applies the child's proposed EDIT",
            );
        } finally {
            await daemon.stop();
            await http.close();
            await db.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
