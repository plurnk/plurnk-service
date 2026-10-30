import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
                        '````plurnk_question (ask)\n{"message":"Proceed?","requestedSchema":{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}}\n````',
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

                // 2. Resume `${workspace.id}#spawned` with systemPrompt after Turn 0 and prompt it: it foists READ (session://spawned/AGENTS.md) and resolves `question` via elicitation/create
                const childSessionId = `${workspace.id}#spawned`;
                await ctx.request(methods.agent.session.resume, {
                    sessionId: childSessionId,
                    cwd: "/tmp/owner-tabs",
                    systemPrompt: {
                        mode: "append",
                        content: [{ type: "text", text: "Spawned child role on resume." }],
                    },
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
                const spawnedLogs: Array<{
                    op: string;
                    scheme: string | null;
                    hostname: string | null;
                    pathname: string | null;
                }> = await daemon.readLog({
                    workspaceId: workspace.id,
                    sessionId: spawnedRow.id,
                });
                assert.ok(
                    spawnedLogs.some(
                        (e) =>
                            e.op === "READ" &&
                            e.scheme === "session" &&
                            e.hostname === "spawned" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    "Post-Turn-0 session/resume with systemPrompt foists READ (session://spawned/AGENTS.md) (#1347)",
                );

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

test(
    "{§persona-discovery} {§acp-action-binding} {§session-initialization-entry}: discovers workspace personas, projects configId persona, and surveys persona://*/PERSONA.md on Turn 0",
    { timeout: 30_000 },
    async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const [{ default: Daemon }, { makeMockResponse }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);
        const projectDir = await mkdtemp(join(tmpdir(), "plurnk-acp-personas-"));
        t.after(() => rm(projectDir, { recursive: true, force: true }));
        await mkdir(join(projectDir, ".agents", "personas"), { recursive: true });
        await writeFile(
            join(projectDir, ".agents", "personas", "reviewer.md"),
            [
                "---",
                "name: reviewer",
                "description: Security code reviewer",
                "effort: adaptive",
                "---",
                "Review every diff for security defects.",
            ].join("\n"),
        );

        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            http,
            nodeModulesPath: join(SERVICE, "node_modules"),
            provider: new Mock({
                contextWindow: 32768,
                responses: [
                    makeMockResponse(
                        "````COPY (persona://reviewer/PERSONA.md) (session://subreviewer/AGENTS.md)\n````\n````WORK (session://subreviewer)\nAudit auth.\n````\n````WAIT\n````",
                    ),
                    makeMockResponse("````SEND [200]\nAudit complete.\n````"),
                    makeMockResponse("````SEND [200]\nAll reviewed.\n````"),
                ],
            }),
        });

        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;

            const clientApp = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "persona-test", version: "1.0.0" },
                    });
                });

            const stream = createWebSocketStream(wsUrl, { WebSocket: WsConstructor });
            await clientApp.connectWith(stream, async (ctx) => {
                await ctx.initialized;
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: projectDir,
                });
                const personaOpt = created.configOptions?.find((o) => o.configId === "persona");
                assert.ok(personaOpt && personaOpt.type === "select" && Array.isArray(personaOpt.options));
                assert.equal(personaOpt.currentValue, "none");
                assert.deepEqual(
                    (personaOpt.options as ReadonlyArray<{ readonly value?: string }>).map((o) => o.value ?? ""),
                    ["none", "reviewer"],
                );

                // Select persona "reviewer" via session/set_config_option
                const updated = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "persona",
                    type: "id",
                    value: "reviewer",
                });
                const updatedPersona = updated.configOptions.find((o) => o.configId === "persona");
                assert.ok(updatedPersona && updatedPersona.type === "select");
                assert.equal(updatedPersona.currentValue, "reviewer");
                const updatedEffort = updated.configOptions.find((o) => o.configId === "thought_level");
                assert.ok(updatedEffort && updatedEffort.type === "select");
                assert.equal(updatedEffort.currentValue, "adaptive");

                // Clear persona back to "none", then re-select "reviewer"
                const cleared = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "persona",
                    type: "id",
                    value: "none",
                });
                assert.equal(
                    cleared.configOptions.find((o) => o.configId === "persona")?.currentValue,
                    "none",
                );
                await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "persona",
                    type: "id",
                    value: "reviewer",
                });

                await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Run the review." }],
                });

                const [workspace] = await daemon.listWorkspaces();
                assert.ok(workspace);
                const rootSession = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: created.sessionId.split("#")[1] },
                });
                assert.ok(rootSession);
                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: rootSession.id }),
                    (loops: Array<{ terminalResult: { status: number } | null }>) =>
                        loops.some(({ terminalResult }) => terminalResult?.status === 200),
                );

                const rootLogs: Array<{
                    op: string;
                    scheme: string | null;
                    hostname: string | null;
                    pathname: string | null;
                }> = await daemon.readLog({
                    workspaceId: workspace.id,
                    sessionId: rootSession.id,
                });
                assert.ok(
                    rootLogs.some((e) => e.op === "FIND" && e.scheme === "persona" && e.pathname === "/PERSONA.md"),
                    "Turn 0 surveys persona://*/PERSONA.md when personas exist",
                );
                assert.ok(
                    rootLogs.some(
                        (e) =>
                            e.op === "READ" &&
                            e.scheme === "session" &&
                            e.hostname === rootSession.name &&
                            e.pathname === "/AGENTS.md",
                    ),
                    "Turn 0 reads session://<root>/AGENTS.md written by configId persona",
                );

                const childSession = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "subreviewer" },
                });
                assert.ok(childSession);
                const childLogs: Array<{
                    op: string;
                    scheme: string | null;
                    hostname: string | null;
                    pathname: string | null;
                }> = await daemon.readLog({
                    workspaceId: workspace.id,
                    sessionId: childSession.id,
                });
                assert.ok(
                    childLogs.some(
                        (e) =>
                            e.op === "READ" &&
                            e.scheme === "session" &&
                            e.hostname === "subreviewer" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    "Child session reads session://subreviewer/AGENTS.md copied from persona://reviewer/PERSONA.md",
                );
            });
        } finally {
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);
