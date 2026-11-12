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
        const [{ default: Daemon }, { makeMockResponse }, { packetSection }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_packet.ts")),
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
                    makeMockResponse('await plurnk.work({ target: "session://spawned", prompt: "Say ready." });\nawait plurnk.wait({});'),
                    makeMockResponse('await plurnk.done({ text: "Ready." });'),
                    makeMockResponse('await plurnk.done({ text: "Spawned child." });'),
                    makeMockResponse(
                        'await plurnk.question({"message":"Proceed?","requestedSchema":{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}});',
                    ),
                    makeMockResponse('await plurnk.done({ text: "Child answered." });'),
                    makeMockResponse('await plurnk.sh({ command: "echo helper-ok" });'),
                    makeMockResponse('await plurnk.done({ text: "Helper done." });'),
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
                assert.equal(
                    parentLogs.some(
                        (e) =>
                            e.op === "read" &&
                            e.scheme === "session" &&
                            e.hostname === "parent" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    false,
                    "Turn 0 does not foist read (session://parent/AGENTS.md)",
                );
                const parentPacket: { packet: string } | undefined = await db.engine_session_latest_packet.get({
                    session_id: parentRow.id,
                });
                assert.ok(parentPacket);
                assert.match(
                    packetSection(JSON.parse(parentPacket.packet), "system-policy"),
                    /Parent session instructions\./u,
                    "session://parent/AGENTS.md materialized from ACP systemPrompt rides system-policy",
                );

                // Also create an unowned session `helper` directly so `session/resume` claims it for `acp://operator`
                await daemon.createSession({
                    workspaceId: workspace.id,
                    name: "helper",
                });

                // 2. Resume `${workspace.id}#spawned` with systemPrompt after Turn 0 and prompt it: it delivers session://spawned/AGENTS.md in system-policy and resolves `question` via elicitation/create
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
                assert.equal(
                    spawnedLogs.some(
                        (e) =>
                            e.op === "read" &&
                            e.scheme === "session" &&
                            e.hostname === "spawned" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    false,
                    "Post-Turn-0 session/resume with systemPrompt does not foist read (session://spawned/AGENTS.md)",
                );
                const spawnedPacket: { packet: string } | undefined = await db.engine_session_latest_packet.get({
                    session_id: spawnedRow.id,
                });
                assert.ok(spawnedPacket);
                assert.match(
                    packetSection(JSON.parse(spawnedPacket.packet), "system-policy"),
                    /Spawned child role on resume\./u,
                    "Post-Turn-0 session/resume with systemPrompt delivers session://spawned/AGENTS.md in system-policy",
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
        const [{ default: Daemon }, { makeMockResponse }, { packetSection }, { waitForDb }, { Mock }] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_packet.ts")),
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
                        'await plurnk.copy({ from: "persona://reviewer/PERSONA.md", to: "session://subreviewer/AGENTS.md" });\nawait plurnk.work({ target: "session://subreviewer", prompt: "Audit auth." });\nawait plurnk.wait({});',
                    ),
                    makeMockResponse('await plurnk.done({ text: "Audit complete." });'),
                    makeMockResponse('await plurnk.done({ text: "All reviewed." });'),
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
                const personaToggle = created.configOptions?.find((o) => o.configId === "personas:reviewer");
                assert.ok(personaToggle && personaToggle.type === "boolean");
                assert.equal(personaToggle.currentValue, true);

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
                    rootLogs.some((e) => e.op === "find" && e.scheme === "persona" && e.pathname === "/PERSONA.md"),
                    "Turn 0 surveys persona://*/PERSONA.md when personas exist",
                );
                assert.equal(
                    rootLogs.some(
                        (e) =>
                            e.op === "read" &&
                            e.scheme === "session" &&
                            e.hostname === rootSession.name &&
                            e.pathname === "/AGENTS.md",
                    ),
                    false,
                    "Turn 0 does not foist read (session://<root>/AGENTS.md)",
                );
                const rootPacket: { packet: string } | undefined = await db.engine_session_latest_packet.get({
                    session_id: rootSession.id,
                });
                assert.ok(rootPacket);
                assert.match(
                    packetSection(JSON.parse(rootPacket.packet), "system-policy"),
                    /Review every diff for security defects\./u,
                    "session://<root>/AGENTS.md written by configId persona rides system-policy",
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
                assert.equal(
                    childLogs.some(
                        (e) =>
                            e.op === "read" &&
                            e.scheme === "session" &&
                            e.hostname === "subreviewer" &&
                            e.pathname === "/AGENTS.md",
                    ),
                    false,
                    "Child session does not foist read (session://subreviewer/AGENTS.md)",
                );
                const childPacket: { packet: string } | undefined = await db.engine_session_latest_packet.get({
                    session_id: childSession.id,
                });
                assert.ok(childPacket);
                assert.match(
                    packetSection(JSON.parse(childPacket.packet), "system-policy"),
                    /Review every diff for security defects\./u,
                    "Child session receives session://subreviewer/AGENTS.md copied from persona://reviewer/PERSONA.md in system-policy",
                );

                // Exercise edit and kill on persona:// and workspace.personas.list
                const edited = await daemon.dispatchClientAction({
                    workspaceId: workspace.id,
                    actor: "operator",
                    contextSessionId: rootSession.id,
                    statements: [
                        {
                            op: "edit",
                            target: {
                                kind: "url",
                                raw: "persona://professor.md",
                                scheme: "persona",
                                username: null,
                                password: null,
                                hostname: "professor.md",
                                port: null,
                                pathname: "",
                                query: null,
                                fragment: null,
                            },
                            headers: null,
                            lineMarker: null,
                            matcher: null,
                            body: ["---", "description: Rigorous teacher", "effort: high", "---", "Teach from invariants."].join("\n"),
                        },
                    ],
                });
                assert.equal(edited[0]?.status, 200);
                const afterEdit: Array<{ name: string }> = await daemon.listPersonas({ workspaceId: workspace.id });
                assert.deepEqual(afterEdit.map((p) => p.name), ["professor", "reviewer"]);

                const killed = await daemon.dispatchClientAction({
                    workspaceId: workspace.id,
                    actor: "operator",
                    contextSessionId: rootSession.id,
                    statements: [
                        {
                            op: "kill",
                            target: {
                                kind: "url",
                                raw: "persona://professor.md",
                                scheme: "persona",
                                username: null,
                                password: null,
                                hostname: "professor.md",
                                port: null,
                                pathname: "",
                                query: null,
                                fragment: null,
                            },
                            headers: null,
                            remote: null,
                            lineMarker: null,
                            matcher: null,
                            body: null,
                        },
                    ],
                });
                assert.equal(killed[0]?.status, 200);
                const afterKill: Array<{ name: string }> = await daemon.listPersonas({ workspaceId: workspace.id });
                assert.deepEqual(afterKill.map((p) => p.name), ["reviewer"]);
            });
        } finally {
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);

test(
    "{§acp-action-binding} {§session-model-selection}: session/set_config_option re-pins model, spawn_model, and thought_level on a crash-parked (202) loop and resumes in place without cancellation",
    { timeout: 30_000 },
    async () => {
        await import(join(SERVICE, "test/setup.ts"));
        const [
            { default: Daemon },
            { default: ProviderInstantiate },
            { makeMockResponse },
            { waitForDb },
            { Mock, ProviderError },
        ] = await Promise.all([
            import(join(SERVICE, "src/server/Daemon.ts")),
            import(join(SERVICE, "src/core/ProviderInstantiate.ts")),
            import(join(SERVICE, "test/intg/_mock.ts")),
            import(join(SERVICE, "test/intg/_rpc.ts")),
            import("@plurnk/plurnk-providers"),
        ]);

        const crashedAlias = `acp-crashed-${crypto.randomUUID().slice(0, 8)}`;
        const healthyAlias = `acp-healthy-${crypto.randomUUID().slice(0, 8)}`;
        const childAlias = `acp-child-${crypto.randomUUID().slice(0, 8)}`;
        const envKeys = [
            [`PLURNK_MODEL_${crashedAlias}`, "openai/acp-crashed-model"],
            [`PLURNK_MODEL_${healthyAlias}`, "openai/acp-healthy-model"],
            [`PLURNK_MODEL_${childAlias}`, "openai/acp-child-model"],
        ] as const;
        for (const [k, v] of envKeys) process.env[k] = v;

        const crashedSpec = { alias: crashedAlias, provider: "openai", model: "acp-crashed-model" };
        const healthySpec = { alias: healthyAlias, provider: "openai", model: "acp-healthy-model" };
        const childSpec = { alias: childAlias, provider: "openai", model: "acp-child-model" };

        const crashedMock = new Mock({ contextWindow: 32_768, responses: [] });
        crashedMock.generate = async () => {
            throw new ProviderError("plurnk", "network_failure", "upstream dropped");
        };
        const healthyMock = new Mock({
            contextWindow: 32_768,
            responses: [
                makeMockResponse('await plurnk.bare({ prompt: "ask new spawn model" });'),
                makeMockResponse(
                    'await plurnk.done({ target: "message://main/00", text: "first" });\n\nawait plurnk.done({ target: "message://main/01", text: "resumed in place" });',
                ),
            ],
        });
        const childMock = new Mock({
            contextWindow: 16_384,
            responses: [{ assistant: { content: "child ok", reasoning: null } }],
        });

        for (const effort of [undefined, "adaptive", "high"] as const) {
            ProviderInstantiate.registerInstance(crashedMock, crashedSpec, process.env, effort);
            ProviderInstantiate.registerInstance(healthyMock, healthySpec, process.env, effort);
            ProviderInstantiate.registerInstance(childMock, childSpec, process.env, effort);
        }

        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({
            db,
            http,
            nodeModulesPath: join(SERVICE, "node_modules"),
            provider: null,
        });

        try {
            await daemon.start();
            const wsUrl = `ws://127.0.0.1:${http.httpAddress().port}/acp`;
            const configUpdates: Array<{ configOptions?: ReadonlyArray<{ configId: string; currentValue?: unknown }> }> = [];

            const clientApp = createRawAcpClient()
                .onConnect((conn) => {
                    void conn.agent.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "repin-test", version: "1.0.0" },
                    });
                })
                .onNotification(methods.client.session.update, ({ params }) => {
                    if (params.update.sessionUpdate === "config_option_update") {
                        configUpdates.push(params.update as { configOptions?: ReadonlyArray<{ configId: string; currentValue?: unknown }> });
                    }
                })
                .onRequest(methods.client.session.requestPermission, async () => ({
                    outcome: { outcome: "selected", optionId: "allow_once" },
                }));

            const stream = createWebSocketStream(wsUrl, { WebSocket: WsConstructor });
            await clientApp.connectWith(stream, async (ctx) => {
                await ctx.initialized;
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: "/tmp/acp-repin",
                    _meta: { plurnk: { workspace: "repin", sessionName: "main" } },
                });

                await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "model",
                    type: "id",
                    value: crashedAlias,
                });

                const firstPrompt = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Start work before upstream failure." }],
                });
                const firstLoopId = (firstPrompt._meta as { plurnk?: { loopId?: number } } | undefined)?.plurnk?.loopId;
                assert.ok(typeof firstLoopId === "number");

                const [workspace] = await daemon.listWorkspaces();
                assert.ok(workspace);
                const mainRow = await daemon.readSession({
                    workspaceId: workspace.id,
                    identity: { name: "main" },
                });
                assert.ok(mainRow);

                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: mainRow.id }),
                    (loops: Array<{ id: number; status: number }>) =>
                        loops.some((l) => l.id === firstLoopId && l.status === 202),
                );

                // Re-pin model, spawn_model, and thought_level directly on the 202 parked loop — no session/cancel!
                const repinnedModel = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "model",
                    type: "id",
                    value: healthyAlias,
                });
                assert.equal(
                    repinnedModel.configOptions.find((o) => o.configId === "model")?.currentValue,
                    healthyAlias,
                );
                await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "spawn_model",
                    type: "id",
                    value: childAlias,
                });
                const repinnedEffort = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: created.sessionId,
                    configId: "thought_level",
                    type: "id",
                    value: "high",
                });
                assert.equal(
                    repinnedEffort.configOptions.find((o) => o.configId === "thought_level")?.currentValue,
                    "high",
                );

                const resumedPrompt = await ctx.request(methods.agent.session.prompt, {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "Continue on healthy route." }],
                });
                const resumedLoopId = (resumedPrompt._meta as { plurnk?: { loopId?: number } } | undefined)?.plurnk?.loopId;
                assert.equal(resumedLoopId, firstLoopId, "resumed the exact crash-parked loop in place without cancel");

                await waitForDb(
                    () => daemon.listSessionLoops({ workspaceId: workspace.id, sessionId: mainRow.id }),
                    (loops: Array<{ id: number; terminalResult: { status: number } | null }>) =>
                        loops.some((l) => l.id === firstLoopId && l.terminalResult?.status === 200),
                );
                assert.equal(childMock.remaining, 0, "spawn_model switch took effect on next turn");
                assert.equal(healthyMock.remaining, 0, "model and thought_level switch took effect on next turn");
                assert.ok(configUpdates.length >= 4, "config_option_update emitted for live re-pinning");
            });
        } finally {
            for (const [k] of envKeys) delete process.env[k];
            await daemon.stop();
            await http.close();
            await db.close();
        }
    },
);
