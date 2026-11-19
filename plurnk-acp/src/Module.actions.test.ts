import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    methods,
    SessionConfigOption,
    SessionUpdate,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
    Validator,
    type AcpDiscovery,
    type ClientInteractionProjection,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
import {
    WsConstructor,
    createAcpClient,
    createHarness,
    waitFor,
} from "../test/harness.ts";

describe("{§acp-action-binding} plurnk-acp actions & options", { concurrency: true }, () => {
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
                                    provenance: {
                                        kind: "file",
                                        source: "/workspace/alpha/skills/triage/SKILL.md",
                                    },
                                    detail: {
                                        description: "Triage repository issues",
                                    },
                                },
                                {
                                    alias: "mcp",
                                    state: skillEnabled ? "active" : "disabled",
                                    provenance: {
                                        kind: "provided",
                                        source: "@plurnk/plurnk-meta",
                                    },
                                    detail: {
                                        description: "Colliding built-in skill",
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
                    assert.ok(
                        latestCmds.some(
                            (c) =>
                                c.type === "skill" &&
                                c.name === "triage" &&
                                c.description === "Triage repository issues" &&
                                c.path === "/workspace/alpha/skills/triage/SKILL.md",
                        ),
                    );
                    assert.ok(
                        latestCmds.some(
                            (c) =>
                                c.type === "skill" &&
                                c.name === "skill:mcp" &&
                                c.description === "Colliding built-in skill" &&
                                c.path === undefined,
                        ),
                    );
                    assert.ok(
                        latestCmds.some(
                            (c) =>
                                c.type === "command" &&
                                c.name === "git-srv:review" &&
                                c.description === "Review git diff" &&
                                typeof c.input === "object" &&
                                c.input !== null &&
                                "hint" in c.input &&
                                c.input.hint === "branch=<value>",
                        ),
                    );

                    // Clients that omit session.commands.skill receive commands only, never skill entries
                    const legacyUpdates: SessionUpdate[] = [];
                    const legacyStream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
                    const legacyApp = createAcpClient({}).onNotification(
                        methods.client.session.update,
                        ({ params }) => {
                            legacyUpdates.push(params.update);
                        },
                    );
                    await legacyApp.connectWith(legacyStream, async (legacyCtx) => {
                        const legacyOpts = await legacyCtx.request(methods.agent.session.options, {
                            cwd: "/workspace/alpha",
                            sessionId: session.sessionId,
                        });
                        assert.ok(legacyOpts.availableCommands?.every((c) => c.type !== "skill"));
                        const legacyResumed = await legacyCtx.request(methods.agent.session.resume, {
                            sessionId: session.sessionId,
                            cwd: "/workspace/alpha",
                        });
                        assert.ok(legacyResumed.availableCommands?.every((c) => c.type !== "skill"));
                        await ctx.request(methods.agent.session.setConfigOption, {
                            sessionId: session.sessionId,
                            configId: "skills:triage",
                            type: "boolean",
                            value: true,
                        });
                        await waitFor(() =>
                            legacyUpdates.some((u) => u.sessionUpdate === "available_commands_update"),
                        );
                        const legacyCmdUpdate = legacyUpdates.find(
                            (u): u is Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }> =>
                                u.sessionUpdate === "available_commands_update",
                        );
                        assert.ok(legacyCmdUpdate?.availableCommands.every((c) => c.type !== "skill"));
                    });
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
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: "accept",
                    effective: "accept",
                });

                const updatedDenyMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "deny",
                });
                const denyModeOption = updatedDenyMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(denyModeOption?.currentValue, "deny");
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: "reject",
                    effective: "reject",
                });

                const updatedProposeMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "propose",
                });
                const proposeModeOption = updatedProposeMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(proposeModeOption?.currentValue, "propose");
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: "review",
                    effective: "review",
                });

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
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: "accept",
                    effective: "accept",
                });
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

                // 6. session/resume applies initial configOptions without emitting config_option_update on the requester, while notifying other active peers
                const peerObserverUpdates: SessionUpdate[] = [];
                const peerObserverStream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
                const peerObserverApp = createAcpClient().onNotification(
                    methods.client.session.update,
                    ({ params }) => {
                        peerObserverUpdates.push(params.update);
                    },
                );
                await peerObserverApp.connectWith(peerObserverStream, async (observerCtx) => {
                    await observerCtx.request(methods.agent.session.resume, {
                        sessionId: created.sessionId,
                        cwd: "/workspace/alpha",
                    });
                    peerObserverUpdates.length = 0;
                    updates.length = 0;
                    const resumed = await ctx.request(methods.agent.session.resume, {
                        sessionId: created.sessionId,
                        cwd: "/workspace/alpha",
                        configOptions: [{ configId: "mode", type: "id", value: "deny" }],
                    });
                    assert.equal(resumed.configOptions?.find((c) => c.configId === "mode")?.currentValue, "deny");
                    assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                        policy: "reject",
                        effective: "reject",
                    });
                    assert.ok(!updates.some((u) => u.sessionUpdate === "config_option_update"));
                    await waitFor(() =>
                        peerObserverUpdates.some((u) => u.sessionUpdate === "config_option_update"),
                    );
                    const crossPeerUpdate = peerObserverUpdates.find(
                        (u): u is Extract<SessionUpdate, { sessionUpdate: "config_option_update" }> =>
                            u.sessionUpdate === "config_option_update",
                    );
                    assert.equal(
                        crossPeerUpdate?.configOptions.find((c) => c.configId === "mode")?.currentValue,
                        "deny",
                    );
                });

                // 6b. session/fork applies initial configOptions without emitting config_option_update and rejects duplicate configId with -32602
                updates.length = 0;
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.fork, {
                            sessionId: created.sessionId,
                            cwd: "/workspace/alpha",
                            configOptions: [
                                { configId: "thought_level", type: "id", value: "low" },
                                { configId: "thought_level", type: "id", value: "high" },
                            ],
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );
                const forkedWithOpts = await ctx.request(methods.agent.session.fork, {
                    sessionId: created.sessionId,
                    cwd: "/workspace/alpha",
                    configOptions: [
                        { configId: "thought_level", type: "id", value: "low" },
                        { configId: "mode", type: "id", value: "allow" },
                    ],
                });
                assert.equal(
                    forkedWithOpts.configOptions?.find((c) => c.configId === "thought_level")?.currentValue,
                    "low",
                );
                assert.equal(
                    forkedWithOpts.configOptions?.find((c) => c.configId === "mode")?.currentValue,
                    "allow",
                );
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: "accept",
                    effective: "accept",
                });
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

    test("{§acp-event-translation} {§acp-proposal-resolve} {§acp-action-binding}: functionality/changed, session/policy (with persona), runtime/telemetry, and external loop/gate-settled push live updates across peers", async () => {
        const h = await createHarness();
        try {
            let discoveredSkills = [{ alias: "audit", state: "active", detail: { description: "Audit code" } }];
            let discoveredPersonas = [
                {
                    name: "reviewer",
                    description: "Security reviewer",
                    body: "Review code.",
                    source: "/workspace/alpha/.agents/personas/reviewer.md",
                },
            ];
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
                {
                    name: "workspace.personas.list",
                    scope: "workspace",
                    inputSchema: { type: "object" },
                    outputSchema: { type: "object" },
                },
            ];
            h.port.invokeModuleAction = async (name, params, context) => {
                if (name === "workspace.skills.list") {
                    return { definitions: discoveredSkills };
                }
                if (name === "workspace.personas.list") {
                    return {
                        definitions: discoveredPersonas.map((p) => ({
                            alias: p.name,
                            state: "active",
                            enabled: true,
                        })),
                    };
                }
                return await origInvokeAction(name, params, context);
            };
            h.port.listPersonas = async () => discoveredPersonas;

            const peer1Updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
            const peer2Updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
            const completedElicitations: string[] = [];
            const elicitationSeen: PromiseWithResolvers<CreateElicitationRequest> = Promise.withResolvers();
            const elicitationAborted: PromiseWithResolvers<boolean> = Promise.withResolvers();
            const permissionSeen: PromiseWithResolvers<RequestPermissionRequest> = Promise.withResolvers();
            const permissionAborted: PromiseWithResolvers<boolean> = Promise.withResolvers();

            const peer1App = createAcpClient()
                .onNotification(methods.client.session.update, ({ params }) => {
                    peer1Updates.push(params);
                })
                .onNotification(methods.client.elicitation.complete, ({ params }) => {
                    completedElicitations.push(params.elicitationId);
                })
                .onRequest(methods.client.elicitation.create, async (ctx) => {
                    elicitationSeen.resolve(ctx.params);
                    return await new Promise<CreateElicitationResponse>((_resolve, reject) => {
                        ctx.signal.addEventListener(
                            "abort",
                            () => {
                                elicitationAborted.resolve(true);
                                reject(new Error("elicitation cancelled"));
                            },
                            { once: true },
                        );
                    });
                })
                .onRequest(methods.client.session.requestPermission, async (ctx) => {
                    permissionSeen.resolve(ctx.params);
                    return await new Promise<RequestPermissionResponse>((_resolve, reject) => {
                        ctx.signal.addEventListener(
                            "abort",
                            () => {
                                permissionAborted.resolve(true);
                                reject(new Error("permission cancelled"));
                            },
                            { once: true },
                        );
                    });
                });

            // Peer 2 omits session.commands.skill to verify capability-filtered available_commands_update
            const peer2App = createAcpClient({}).onNotification(methods.client.session.update, ({ params }) => {
                peer2Updates.push(params);
            });

            const stream1 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const stream2 = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            await peer1App.connectWith(stream1, async (ctx1) => {
                await peer2App.connectWith(stream2, async (ctx2) => {
                    const userSession = await ctx1.request(methods.agent.session.new, {
                        cwd: "/workspace/alpha",
                        _meta: { plurnk: { name: "user" } },
                    });
                    const helperSession = await ctx1.request(methods.agent.session.new, {
                        cwd: "/workspace/alpha",
                        _meta: { plurnk: { name: "helper" } },
                    });
                    assert.equal(userSession.sessionId, "1#user");
                    assert.equal(helperSession.sessionId, "1#helper");
                    await ctx2.request(methods.agent.session.resume, {
                        sessionId: "1#user",
                        cwd: "/workspace/alpha",
                    });

                    peer1Updates.length = 0;
                    peer2Updates.length = 0;

                    // 1. Workspace-scoped functionality/changed pushes available_commands_update and config_option_update
                    discoveredSkills = [
                        ...discoveredSkills,
                        { alias: "deploy", state: "active", detail: { description: "Deploy release" } },
                    ];
                    discoveredPersonas = [
                        ...discoveredPersonas,
                        {
                            name: "architect",
                            description: "System architect",
                            body: "Design systems.",
                            source: "/workspace/alpha/.agents/personas/architect.md",
                        },
                    ];
                    h.port.emitEvent(1, "functionality/changed", {
                        workspaceId: 1,
                        sessionId: null,
                        family: "skills",
                    });

                    await waitFor(
                        () =>
                            peer1Updates.some(
                                (e) =>
                                    e.sessionId === "1#user" &&
                                    SessionUpdate.isAvailableCommandsUpdate(e.update) &&
                                    e.update.availableCommands.some((c) => c.type === "skill" && c.name === "deploy"),
                            ) &&
                            peer1Updates.some(
                                (e) =>
                                    e.sessionId === "1#helper" &&
                                    SessionUpdate.isConfigOptionUpdate(e.update) &&
                                    e.update.configOptions.some((o) => o.configId === "skills:deploy"),
                            ) &&
                            peer2Updates.some((e) => SessionUpdate.isAvailableCommandsUpdate(e.update)) &&
                            peer2Updates.some((e) => SessionUpdate.isConfigOptionUpdate(e.update)),
                    );
                    const peer2CmdUpdate = peer2Updates.find((e) => SessionUpdate.isAvailableCommandsUpdate(e.update));
                    assert.ok(peer2CmdUpdate && SessionUpdate.isAvailableCommandsUpdate(peer2CmdUpdate.update));
                    assert.ok(peer2CmdUpdate.update.availableCommands.every((c) => c.type !== "skill"));
                    const helperCfgUpdate = peer1Updates.find(
                        (e) => e.sessionId === "1#helper" && SessionUpdate.isConfigOptionUpdate(e.update),
                    );
                    assert.ok(helperCfgUpdate && SessionUpdate.isConfigOptionUpdate(helperCfgUpdate.update));
                    const personaSelect = helperCfgUpdate.update.configOptions.find((o) => o.configId === "persona");
                    assert.ok(personaSelect && SessionConfigOption.isSelect(personaSelect));
                    assert.ok(
                        personaSelect.options.some((o) => "value" in o && o.value === "architect"),
                        "persona options include newly added persona",
                    );

                    // Session-scoped functionality/changed updates only the targeted session
                    peer1Updates.length = 0;
                    h.port.emitEvent(1, "functionality/changed", {
                        workspaceId: 1,
                        sessionId: 1,
                        family: "env",
                    });
                    await waitFor(() =>
                        peer1Updates.some(
                            (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ),
                    );
                    assert.equal(
                        peer1Updates.some(
                            (e) => e.sessionId === "1#helper" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ),
                        false,
                        "session-scoped functionality/changed does not broadcast to sibling sessions",
                    );

                    // Workspace-scoped session/set_config_option (mode) refreshes sibling bound sessions once
                    peer1Updates.length = 0;
                    await ctx1.request(methods.agent.session.setConfigOption, {
                        sessionId: "1#user",
                        configId: "mode",
                        type: "id",
                        value: "allow",
                    });
                    await waitFor(
                        () =>
                            peer1Updates.some(
                                (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ) &&
                            peer1Updates.some(
                                (e) => e.sessionId === "1#helper" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ),
                    );
                    assert.equal(
                        peer1Updates.filter(
                            (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ).length,
                        1,
                    );
                    assert.equal(
                        peer1Updates.filter(
                            (e) =>
                                e.sessionId === "1#helper" &&
                                SessionUpdate.isConfigOptionUpdate(e.update) &&
                                e.update.configOptions.find((o) => o.configId === "mode")?.currentValue === "allow",
                        ).length,
                        1,
                        "workspace-scoped setConfigOption pushes config_option_update to sibling bound sessions",
                    );

                    // 2. session/policy (including persona) pushes config_option_update to matching bound sessions
                    peer1Updates.length = 0;
                    peer2Updates.length = 0;
                    h.port.emitEvent(1, "session/policy", {
                        sessionId: 1,
                        model: {
                            alias: "smart",
                            provider: "mocktest",
                            model: "mock-v2",
                            effort: "high",
                            effortSource: "explicit",
                        },
                        spawnModel: {
                            provider: "mocktest",
                            model: "mock-child",
                            effortSource: "default",
                        },
                        persona: "reviewer",
                    });
                    await waitFor(
                        () =>
                            peer1Updates.some(
                                (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ) &&
                            peer2Updates.some(
                                (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ),
                    );
                    const policyEntry = peer1Updates.find(
                        (e) => e.sessionId === "1#user" && SessionUpdate.isConfigOptionUpdate(e.update),
                    );
                    assert.ok(policyEntry && SessionUpdate.isConfigOptionUpdate(policyEntry.update));
                    const policyUpdate = policyEntry.update;
                    assert.equal(policyUpdate.configOptions.find((o) => o.configId === "model")?.currentValue, "smart");
                    assert.equal(
                        policyUpdate.configOptions.find((o) => o.configId === "thought_level")?.currentValue,
                        "high",
                    );
                    assert.equal(
                        policyUpdate.configOptions.find((o) => o.configId === "spawn_model")?.currentValue,
                        "mocktest/mock-child",
                    );
                    assert.equal(
                        policyUpdate.configOptions.find((o) => o.configId === "persona")?.currentValue,
                        "reviewer",
                    );
                    assert.equal(
                        peer1Updates.some(
                            (e) => e.sessionId === "1#helper" && e.update.sessionUpdate === "config_option_update",
                        ),
                        false,
                        "session/policy scopes config_option_update to matching sessionId",
                    );

                    // 3. Direct runtime/telemetry on subscribeToRuntimeStream emits _plurnk_telemetry
                    peer1Updates.length = 0;
                    h.port.emitEvent(1, "runtime/telemetry", {
                        sessionId: 1,
                        loopId: 1,
                        notice: {
                            source: "engine:turn",
                            kind: "results_pending",
                            level: "info",
                            message: "",
                        },
                    });
                    await waitFor(() =>
                        peer1Updates.some(
                            (e) => e.sessionId === "1#user" && e.update.sessionUpdate === "_plurnk_telemetry",
                        ),
                    );

                    // 4. External loop/gate-settled (kind: "interaction" and kind: "proposal") cancels open gates cleanly
                    peer1Updates.length = 0;
                    completedElicitations.length = 0;
                    const interaction: ClientInteractionProjection = {
                        interactionId: 777,
                        sessionId: 1,
                        loopId: 1,
                        turnId: 1,
                        recipient: "acp://operator",
                        request: {
                            toolName: "question",
                            mode: "form",
                            message: "Approve external settlement?",
                            requestedSchema: {
                                type: "object",
                                properties: { ok: { type: "boolean" } },
                                required: ["ok"],
                            },
                        },
                    };
                    h.port.interactions.push(interaction);
                    h.port.emitEvent(1, "loop/interaction", interaction);
                    const createdReq = await elicitationSeen.promise;
                    assert.ok("toolCallId" in createdReq);
                    assert.equal(createdReq.toolCallId, "int:777");

                    // Resolve externally via ApplicationPort (emits loop/gate-settled kind: "interaction")
                    await h.port.resolveClientInteraction(
                        777,
                        { action: "accept", content: { ok: true } },
                        { workspaceId: 1, address: "acp://operator" },
                    );
                    assert.equal(await elicitationAborted.promise, true, "external interaction settlement sends $/cancel_request");
                    await waitFor(
                        () =>
                            completedElicitations.includes("777") &&
                            peer1Updates.some(
                                (e) =>
                                    e.sessionId === "1#user" &&
                                    e.update.sessionUpdate === "tool_call_update" &&
                                    e.update.toolCallId === "int:777" &&
                                    e.update.status === "completed",
                            ),
                    );
                    assert.equal(completedElicitations.filter((id) => id === "777").length, 1);
                    assert.ok(
                        peer1Updates.some(
                            (e) =>
                                e.sessionId === "1#user" &&
                                e.update.sessionUpdate === "state_update" &&
                                e.update.state === "running",
                        ),
                    );

                    // Also verify external proposal settlement via loop/gate-settled cancels open requestPermission
                    const proposal: ProposalProjection = {
                        logEntryId: 888,
                        sessionId: 1,
                        session: "user",
                        loopId: 1,
                        turnId: 1,
                        coordinate: "1/1/8",
                        op: "sh",
                        target: { scheme: "sh", authority: null, pathname: null },
                        body: "echo external",
                        disposition: { decision: "review" },
                        owner: "acp://operator",
                        attrs: { tag: "sh", body: "echo external", cwd: "/workspace/alpha" },
                        subject: { type: "command", command: "echo external", cwd: "/workspace/alpha" },
                    };
                    h.port.proposals.push(proposal);
                    h.port.emitEvent(1, "loop/proposal", proposal);
                    await permissionSeen.promise;
                    await h.port.resolveProposal(
                        888,
                        { decision: "reject", scope: "once" },
                        { workspaceId: 1, address: "acp://operator" },
                    );
                    assert.equal(await permissionAborted.promise, true, "external proposal settlement sends $/cancel_request");
                });
            });
        } finally {
            await h.close();
        }
    });
});
