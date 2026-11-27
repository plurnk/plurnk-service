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
                h.port.readSessionModel = async () => ({ model: null, childModel: null });
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

                const boundSessionRow = h.port.sessions.find((s) => `1#${s.name}` === session.sessionId)!;
                const updatedAcceptMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "accept",
                });
                const acceptModeOption = updatedAcceptMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(acceptModeOption?.currentValue, "accept");
                assert.deepEqual(
                    await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: boundSessionRow.id }),
                    {
                        policy: "accept",
                        effective: "accept",
                    },
                );
                assert.deepEqual(await h.port.readWorkspaceProposalPolicy({ workspaceId: 1 }), {
                    policy: null,
                    effective: "review",
                });

                const updatedRejectMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "reject",
                });
                const rejectModeOption = updatedRejectMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(rejectModeOption?.currentValue, "reject");
                assert.deepEqual(
                    await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: boundSessionRow.id }),
                    {
                        policy: "reject",
                        effective: "reject",
                    },
                );

                const updatedReviewMode = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "mode",
                    type: "id",
                    value: "review",
                });
                const reviewModeOption = updatedReviewMode.configOptions.find((c) => c.configId === "mode");
                assert.equal(reviewModeOption?.currentValue, "review");
                assert.deepEqual(
                    await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: boundSessionRow.id }),
                    {
                        policy: "review",
                        effective: "review",
                    },
                );

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.setConfigOption, {
                            sessionId: session.sessionId,
                            configId: "mode",
                            type: "id",
                            value: "allow",
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );

                const updatedChildModel = await ctx.request(methods.agent.session.setConfigOption, {
                    sessionId: session.sessionId,
                    configId: "child",
                    type: "id",
                    value: "fast",
                });
                const childModelOption = updatedChildModel.configOptions.find((c) => c.configId === "child");
                assert.equal(childModelOption?.currentValue, "mocktest/fast");
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-overview} {§acp-action-binding} {§contract-representations} {§acp-http-authorization}: session/list directory, slash commands, _plurnk/action, op.exec, session.rollback, and discovery contract", async () => {
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
                assert.equal(discovered.actions["workspace.rollback"], undefined);
                assert.equal(discovered.actions["op.parse"], undefined);
                assert.equal(discovered.actions["session.rollback"]?.scope, "session");
                assert.equal(
                    discovered.actions["session.rollback"]?.outputSchema.$ref,
                    "https://schemas.plurnk.xyz/v0/RollbackReport.json",
                );
                Validator.assertAcpDiscovery(discovered);

                const loops = await ctx.request<{
                    items: Array<Record<string, unknown>>;
                    updates?: unknown[];
                }>("_plurnk/action", {
                    kind: "session.loops",
                    workspace: "alpha",
                    params: { loopSeq: 1 },
                });
                assert.ok(Array.isArray(loops.items));
                assert.deepEqual(loops.items[0], {
                    id: 1,
                    sequence: 1,
                    status: 200,
                    lifecycle: "completed",
                    source: "acp://operator/sessions/1%23session1/messages/msg-1",
                    opening: "Hello world",
                    continued: false,
                    claimedAt: "2026-10-25T00:00:00.000Z",
                    terminatedAt: "2026-10-25T00:00:01.000Z",
                });
                assert.ok(Array.isArray(loops.updates));

                const parsedOk = await ctx.request<{ results: Array<{ status: number }> }>("_plurnk/action", {
                    kind: "op.exec",
                    workspace: "alpha",
                    params: { text: "await plurnk.note({ text: \"remember this\" });\n" },
                });
                assert.ok(Array.isArray(parsedOk.results));
                assert.equal(parsedOk.results[0]?.status, 200);

                const parsedBad = await ctx.request<{
                    results: Array<{ status: number; problem?: { type?: string; title?: string; status?: number } }>;
                }>("_plurnk/action", {
                    kind: "op.exec",
                    workspace: "alpha",
                    params: { text: "INVALID_VERB ???\n" },
                });
                assert.ok(Array.isArray(parsedBad.results));
                assert.equal(parsedBad.results[0]?.status, 400);
                assert.equal(parsedBad.results[0]?.problem?.type, "https://problems.plurnk.xyz/acp/parse-failed");
                assert.equal(parsedBad.results[0]?.problem?.title, "Statement parse failed");
                assert.equal(parsedBad.results[0]?.problem?.status, 400);

                const rolledBack = await ctx.request<{ to: string }>("_plurnk/action", {
                    kind: "session.rollback",
                    workspace: "alpha",
                    params: { to: "log:///1/1/1/note" },
                });
                assert.equal(rolledBack.to, "log:///1/1/1/note");

                const mcpList = await ctx.request<Record<string, unknown>>("_plurnk/action", {
                    kind: "workspace.mcp.list",
                    workspace: "alpha",
                    params: {},
                });
                assert.deepEqual(mcpList, { family: "mcp", definitions: [] });

                const windowedLogs = await ctx.request<{ entries: unknown[] }>("_plurnk/action", {
                    kind: "log.read",
                    workspace: "alpha",
                    params: { beforeLoopSeq: 3, afterLoopSeq: 1, lastLoops: 2 },
                });
                assert.ok(Array.isArray(windowedLogs.entries));

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
                assert.deepEqual(discovered.actions["op.exec"]?.inputSchema.required, ["text"]);

                const updateAction = await ctx.request<{ catalog: { status: string }; service: { artifact: string } }>(
                    "_plurnk/action",
                    { kind: "service.update", params: {} },
                );
                assert.equal(updateAction.catalog.status, "updated");
                assert.equal(updateAction.service.artifact, "source");

                await ctx.request(methods.agent.session.resume, {
                    sessionId: "1#session1",
                    cwd: "/workspace/alpha",
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#session1",
                    prompt: [{ type: "text", text: "/mcp list" }],
                });
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: "1#session1",
                            prompt: [{ type: "text", text: "/env list" }],
                        }),
                    /Action 'session\.env\.list' is not registered\./,
                );
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: "1#session1",
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
                                sessionId: "1#session1",
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
                                { configId: "mode", type: "id", value: "accept" },
                                { configId: "mode", type: "id", value: "reject" },
                            ],
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );

                // 4. session/new applies valid initial configOptions in order, ignores unknown/mismatched/disallowed entries, and emits no config_option_update
                const created = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    configOptions: [
                        { configId: "unknown_opt", type: "id", value: "ignored" },
                        { configId: "child", type: "boolean", value: true },
                        { configId: "persona", type: "id", value: "not_a_persona" },
                        { configId: "thought_level", type: "id", value: "high" },
                        { configId: "mode", type: "id", value: "accept" },
                    ],
                });
                assert.equal(
                    created.configOptions?.find((c) => c.configId === "thought_level")?.currentValue,
                    "high",
                );
                const createdRow = h.port.sessions.find((s) => `1#${s.name}` === created.sessionId)!;
                assert.equal(created.configOptions?.find((c) => c.configId === "mode")?.currentValue, "accept");
                assert.deepEqual(
                    await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: createdRow.id }),
                    {
                        policy: "accept",
                        effective: "accept",
                    },
                );
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
                assert.equal(existingOpts.configOptions?.find((c) => c.configId === "mode")?.currentValue, "accept");
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
                        configOptions: [{ configId: "mode", type: "id", value: "reject" }],
                    });
                    assert.equal(resumed.configOptions?.find((c) => c.configId === "mode")?.currentValue, "reject");
                    assert.deepEqual(
                        await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: createdRow.id }),
                        {
                            policy: "reject",
                            effective: "reject",
                        },
                    );
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
                        "reject",
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
                        { configId: "mode", type: "id", value: "accept" },
                    ],
                });
                assert.equal(
                    forkedWithOpts.configOptions?.find((c) => c.configId === "thought_level")?.currentValue,
                    "low",
                );
                const forkedRow = h.port.sessions.find((s) => `1#${s.name}` === forkedWithOpts.sessionId)!;
                assert.equal(
                    forkedWithOpts.configOptions?.find((c) => c.configId === "mode")?.currentValue,
                    "accept",
                );
                assert.deepEqual(
                    await h.port.readSessionProposalPolicy({ workspaceId: 1, sessionId: forkedRow.id }),
                    {
                        policy: "accept",
                        effective: "accept",
                    },
                );
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
                        _meta: { plurnk: { name: "session1" } },
                    });
                    const helperSession = await ctx1.request(methods.agent.session.new, {
                        cwd: "/workspace/alpha",
                        _meta: { plurnk: { name: "helper" } },
                    });
                    assert.equal(userSession.sessionId, "1#session1");
                    assert.equal(helperSession.sessionId, "1#helper");
                    await ctx2.request(methods.agent.session.resume, {
                        sessionId: "1#session1",
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
                                    e.sessionId === "1#session1" &&
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
                            (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ),
                    );
                    assert.equal(
                        peer1Updates.some(
                            (e) => e.sessionId === "1#helper" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ),
                        false,
                        "session-scoped functionality/changed does not broadcast to sibling sessions",
                    );

                    // Session-scoped session/set_config_option (mode) updates only the targeted session
                    peer1Updates.length = 0;
                    peer2Updates.length = 0;
                    await ctx1.request(methods.agent.session.setConfigOption, {
                        sessionId: "1#session1",
                        configId: "mode",
                        type: "id",
                        value: "accept",
                    });
                    await waitFor(
                        () =>
                            peer1Updates.some(
                                (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ) &&
                            peer2Updates.some(
                                (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ),
                    );
                    assert.equal(
                        peer1Updates.filter(
                            (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ).length,
                        1,
                    );
                    assert.equal(
                        peer1Updates.some(
                            (e) => e.sessionId === "1#helper" && SessionUpdate.isConfigOptionUpdate(e.update),
                        ),
                        false,
                        "session-scoped mode setConfigOption does not broadcast to sibling sessions",
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
                        childModel: {
                            provider: "mocktest",
                            model: "mock-child",
                            effortSource: "default",
                        },
                        persona: "reviewer",
                    });
                    await waitFor(
                        () =>
                            peer1Updates.some(
                                (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ) &&
                            peer2Updates.some(
                                (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                            ),
                    );
                    const policyEntry = peer1Updates.find(
                        (e) => e.sessionId === "1#session1" && SessionUpdate.isConfigOptionUpdate(e.update),
                    );
                    assert.ok(policyEntry && SessionUpdate.isConfigOptionUpdate(policyEntry.update));
                    const policyUpdate = policyEntry.update;
                    assert.equal(policyUpdate.configOptions.find((o) => o.configId === "model")?.currentValue, "smart");
                    assert.equal(
                        policyUpdate.configOptions.find((o) => o.configId === "thought_level")?.currentValue,
                        "high",
                    );
                    assert.equal(
                        policyUpdate.configOptions.find((o) => o.configId === "child")?.currentValue,
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
                            (e) => e.sessionId === "1#session1" && e.update.sessionUpdate === "_plurnk_telemetry",
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
                                    e.sessionId === "1#session1" &&
                                    e.update.sessionUpdate === "tool_call_update" &&
                                    e.update.toolCallId === "int:777" &&
                                    e.update.status === "completed",
                            ),
                    );
                    assert.equal(completedElicitations.filter((id) => id === "777").length, 1);
                    assert.ok(
                        peer1Updates.some(
                            (e) =>
                                e.sessionId === "1#session1" &&
                                e.update.sessionUpdate === "state_update" &&
                                e.update.state === "running",
                        ),
                    );

                    // Also verify external proposal settlement via loop/gate-settled cancels open requestPermission
                    const proposal: ProposalProjection = {
                        logEntryId: 888,
                        sessionId: 1,
                        session: "session1",
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

    test("{§acp-action-binding} {§acp-daemon-client}: models.list enforces limit <= 100 and session/prompt forwards _meta.plurnk.proposalPolicy per loop", async () => {
        const h = await createHarness();
        try {
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            await createAcpClient().connectWith(stream, async (ctx) => {
                const discovery = await ctx.request<AcpDiscovery>("_plurnk/action", {
                    kind: "discover",
                    params: {},
                });
                assert.ok(discovery.actions["models.list"]);

                const seenQueries: unknown[] = [];
                const origListModels = h.port.listModels.bind(h.port);
                h.port.listModels = (query) => {
                    seenQueries.push(query);
                    return origListModels(query);
                };
                await ctx.request("_plurnk/action", {
                    kind: "models.list",
                    params: { minInputPer1M: 1, maxInputPer1M: 5, sort: "cost-desc", limit: 10 },
                });
                assert.deepEqual(seenQueries.at(-1), {
                    minInputPer1M: 1,
                    maxInputPer1M: 5,
                    sort: "cost-desc",
                    limit: 10,
                });

                await assert.rejects(
                    () =>
                        ctx.request("_plurnk/action", {
                            kind: "models.list",
                            params: { limit: 200 },
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );

                const session = await ctx.request(methods.agent.session.new, {
                    cwd: "/workspace/alpha",
                    configOptions: [{ configId: "mode", type: "id", value: "accept" }],
                });
                await ctx.request(methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "careful run" }],
                    _meta: { plurnk: { proposalPolicy: "review" } },
                });
                assert.equal(h.port.runLoopCalls.at(-1)?.proposalPolicy, "review");

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: "invalid override" }],
                            _meta: { plurnk: { proposalPolicy: "yolo" } },
                        }),
                    (err: { code?: number }) => err.code === -32602,
                );
            });
        } finally {
            await h.close();
        }
    });

    test("{§acp-action-binding} {§acp-daemon-client}: /schedule slash commands preserve quoted args, support show/inspect, format receipts, and reject invalid usage with -32602", async () => {
        const h = await createHarness();
        try {
            const schedules = new Map<string, { alias: string; state: string; detail?: Record<string, unknown>; definition: Record<string, unknown> }>();
            const origListActions = h.port.listModuleActions.bind(h.port);
            const origInvokeAction = h.port.invokeModuleAction.bind(h.port);
            h.port.listModuleActions = () => [
                ...origListActions(),
                {
                    name: "workspace.schedule.list",
                    scope: "workspace",
                    inputSchema: { type: "object", additionalProperties: false, properties: {} },
                    outputSchema: { type: "object" },
                },
                {
                    name: "workspace.schedule.add",
                    scope: "workspace",
                    inputSchema: { type: "object" },
                    outputSchema: { type: "object" },
                },
                {
                    name: "workspace.schedule.run",
                    scope: "workspace",
                    inputSchema: { type: "object", properties: { alias: { type: "string" } } },
                    outputSchema: { type: "object" },
                },
                {
                    name: "workspace.schedule.status",
                    scope: "workspace",
                    inputSchema: { type: "object", properties: { alias: { type: "string" }, status: { type: "string" } } },
                    outputSchema: { type: "object" },
                },
            ];
            h.port.invokeModuleAction = async (name, params, context) => {
                const p = params as Record<string, unknown>;
                if (name === "workspace.schedule.add") {
                    const alias = typeof p.alias === "string" ? p.alias : "";
                    const rule = typeof p.rule === "string" ? p.rule : "manual";
                    const entry = {
                        alias,
                        state: "active",
                        detail: { kind: Array.isArray(p.run) ? "run" : "prompt", status: "open", rule },
                        definition: {
                            rule,
                            ...(p.run !== undefined ? { run: p.run } : {}),
                            ...(p.target !== undefined ? { target: p.target } : {}),
                            ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
                        },
                    };
                    schedules.set(alias, entry);
                    return { definition: entry };
                }
                if (name === "workspace.schedule.list") {
                    return { definitions: [...schedules.values()] };
                }
                if (name === "workspace.schedule.run") {
                    const alias = typeof p.alias === "string" ? p.alias : "";
                    return {
                        alias,
                        status: "open",
                        loopId: 12,
                        lastFiredAt: "2026-11-23T17:30:00Z",
                        results: [
                            { index: 0, server: "plurnk", tool: "sh", status: 200, uri: "exec:///sh/1", preview: "echo hi" },
                            { index: 1, server: "gitea", tool: "issue_read", status: 200, uri: "log:///12/1/2/gitea" },
                        ],
                    };
                }
                if (name === "workspace.schedule.status") {
                    const alias = typeof p.alias === "string" ? p.alias : "";
                    const status = typeof p.status === "string" ? p.status : "open";
                    const existing = schedules.get(alias);
                    if (existing?.detail) existing.detail.status = status;
                    return {
                        alias,
                        status,
                        doneAt: status === "done" ? "2026-11-23T17:31:00Z" : null,
                    };
                }
                return origInvokeAction(name, params, context);
            };

            const chunks: string[] = [];
            const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient().onNotification(methods.client.session.update, ({ params }) => {
                if (
                    SessionUpdate.isAgentMessageChunk(params.update) &&
                    params.update.content.type === "text" &&
                    typeof params.update.content.text === "string"
                ) {
                    chunks.push(params.update.content.text);
                }
            });
            await app.connectWith(stream, async (ctx) => {
                const session = await ctx.request(methods.agent.session.new, { cwd: "/workspace/alpha" });
                const runSlash = async (command: string): Promise<string> => {
                    chunks.length = 0;
                    await ctx.request(methods.agent.session.prompt, {
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text: command }],
                    });
                    await waitFor(() => chunks.length > 0);
                    return chunks.join("");
                };

                const added = await runSlash(
                    `/schedule add deploy --manual --step plurnk.sh '{"text":"echo hi"}' --aside "Run check" --step gitea.issue_read '{"owner":"plurnk"}'`,
                );
                assert.match(added, /deploy {2}active {2}macro {2}status=open {2}manual {2}2 steps: plurnk\.sh → gitea\.issue_read/u);
                assert.deepEqual(schedules.get("deploy")?.definition.run, [
                    { server: "plurnk", tool: "sh", arguments: { text: "echo hi" }, aside: "Run check" },
                    { server: "gitea", tool: "issue_read", arguments: { owner: "plurnk" } },
                ]);

                const shown = await runSlash("/schedule show deploy");
                assert.match(shown, /alias:\s+deploy/u);
                assert.match(shown, /kind:\s+macro \(run\)/u);
                assert.match(shown, /#0 {2}plurnk\.sh {2}\{"text":"echo hi"\} {2}\(Run check\)/u);

                const inspected = await runSlash("/schedule inspect deploy");
                assert.equal(inspected, shown);

                const runOut = await runSlash("/schedule run deploy");
                assert.match(runOut, /deploy {2}open {2}\(2 steps · loop 12 · fired 2026-11-23T17:30:00Z\)/u);
                assert.match(runOut, /#0 {2}plurnk\.sh {2}200 {2}exec:\/\/\/sh\/1 {2}— echo hi/u);
                assert.match(runOut, /#1 {2}gitea\.issue_read {2}200 {2}log:\/\/\/12\/1\/2\/gitea/u);

                assert.equal(await runSlash("/schedule done deploy"), "deploy  done  (done 2026-11-23T17:31:00Z)");
                assert.equal(await runSlash("/schedule reopen deploy"), "deploy  open");
                assert.match(await runSlash("/schedule help"), /--step <server>\.<tool>/u);

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: "/schedule show missing" }],
                        }),
                    (err: { code?: number; data?: { status?: number } }) =>
                        err.code === -32000 && err.data?.status === 404,
                );
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: `/schedule add bad --run 'await plurnk.sh()'` }],
                        }),
                    (err: { code?: number; data?: { status?: number; type?: string } }) =>
                        err.code === -32602 &&
                        err.data?.status === 400 &&
                        err.data?.type === "https://problems.plurnk.xyz/client/usage",
                );
                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [{ type: "text", text: `/schedule add bad --rule "0 9 *` }],
                        }),
                    (err: { code?: number; data?: { status?: number } }) =>
                        err.code === -32602 && err.data?.status === 400,
                );

                // #1553: Delegated non-operator _meta.plurnk.actor treats leading '/' text as speech and refuses operator Command blocks with 403
                h.port.runLoopCalls.length = 0;
                const delegatedSlashSpeech = await ctx.request(methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "/rollback 1/1/1/edit" }],
                    _meta: { plurnk: { actor: "alice", messageId: "msg-alice-slash" } },
                });
                assert.equal(delegatedSlashSpeech.messageId, "msg-alice-slash");
                assert.equal(h.port.runLoopCalls.length, 1);
                assert.equal(h.port.runLoopCalls[0]?.prompt, "/rollback 1/1/1/edit");
                assert.equal(
                    (delegatedSlashSpeech._meta as { plurnk?: { resource?: string; actor?: string } } | undefined)
                        ?.plurnk?.actor,
                    "alice",
                );

                await assert.rejects(
                    () =>
                        ctx.request(methods.agent.session.prompt, {
                            sessionId: session.sessionId,
                            prompt: [
                                {
                                    type: "command",
                                    name: "rollback",
                                    input: "1/1/1/edit",
                                } as unknown as { type: "text"; text: string },
                            ],
                            _meta: { plurnk: { actor: "alice", messageId: "msg-alice-cmd" } },
                        }),
                    (err: { code?: number; data?: { status?: number; type?: string } }) =>
                        err.code === -32000 &&
                        err.data?.status === 403 &&
                        err.data?.type === "https://problems.plurnk.xyz/acp/actor-not-authorized",
                );
            });
        } finally {
            await h.close();
        }
    });
});
