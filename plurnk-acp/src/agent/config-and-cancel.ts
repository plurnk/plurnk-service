// {§acp-daemon-client} {§acp-action-binding} {§acp-overview} {§acp-proposal-resolve}
// Protocol initialization, auth, providers, `_plurnk/action`, config options, status/title, and cancellation handlers.

import {
    PROTOCOL_VERSION,
    RequestError,
    methods,
    type AgentApp,
    type AuthStatusResponse,
    type CancelTerminalResponse,
    type CancelToolCallResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type LogoutAuthResponse,
    type SessionOptionsResponse,
    type SessionStatusResponse,
    type SetSessionConfigOptionResponse,
    type SetSessionTitleResponse,
    type StateUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { Problems, isRecord, lifecycleOfLoopStatus, selectSessionLoop } from "@plurnk/plurnk-contracts";
import { handlePlurnkAction } from "../actions.ts";
import { broadcastConfigOptionsUpdate } from "../events.ts";
import { attrRecord, readAllLogEntries } from "../log-entry-projection.ts";
import {
    applyConfigOption,
    isCommandAffectingConfigId,
    isWorkspaceScopedConfigId,
    resolveSessionOptions,
} from "../session-options.ts";
import {
    OWNER_ADDRESS,
    buildAuthStatus,
    extractPlurnkMeta,
    isDescendantSession,
    lookupSessionTarget,
    resolveSessionBinding,
    toRequestError,
    tryListProviders,
} from "../sessions.ts";
import type { AgentPeerRuntime } from "./context.ts";

export const registerConfigAndCancelHandlers = (app: AgentApp, rt: AgentPeerRuntime): void => {
    const { peer, serviceVersion, actionCallbacks, notifyWorkspaceCommandsChanged } = rt;
    const { seam, opts, peers, gates, optionSync, httpOrigin, requestSubject, requestCanDelegateActor, notifyPeerSession, broadcastSessionUpdate } =
        rt.host;

    app.onRequest(methods.agent.initialize, async (ctx): Promise<InitializeResponse> => {
        peer.client = ctx.client;
        peer.supportsSkillCommands =
            isRecord(ctx.params.capabilities) &&
            isRecord(ctx.params.capabilities.session) &&
            isRecord(ctx.params.capabilities.session.commands) &&
            isRecord(ctx.params.capabilities.session.commands.skill);
        peers.add(peer);
        const policy = seam.daemonPolicy?.();
        return {
            protocolVersion: PROTOCOL_VERSION,
            info: {
                name: "@plurnk/plurnk-service",
                title: "PLURNK Service",
                version: serviceVersion,
            },
            capabilities: {
                session: {
                    prompt: {
                        image: {},
                        audio: {},
                        embeddedContext: {},
                        skill: { inline: {} },
                    },
                    mcp: { acp: {} },
                    archive: {},
                    delete: {},
                    fork: {},
                    options: {},
                    status: {},
                    title: {},
                    ...(policy?.projectRoot === "none" ? {} : { additionalDirectories: {} }),
                    systemPrompt: {},
                },
                auth: { status: {} },
                providers: {},
            },
            ...(policy !== undefined ? { _meta: { plurnk: { policy } } } : {}),
        };
    });

    app.onRequest(methods.agent.auth.status, async (ctx): Promise<AuthStatusResponse> => {
        peer.client = ctx.client;
        const status = buildAuthStatus(seam);
        peer.lastAuthStatusJson = JSON.stringify(status);
        return status;
    });

    app.onRequest(methods.agent.auth.logout, async (ctx): Promise<LogoutAuthResponse> => {
        peer.client = ctx.client;
        if (peer.subject !== null && peer.subject !== undefined && peer.closeTransport !== undefined) {
            const close = peer.closeTransport;
            setImmediate(() => close());
        }
        return {};
    });

    app.onRequest(methods.agent.providers.list, async (ctx): Promise<ListProvidersResponse> => {
        peer.client = ctx.client;
        const providers = seam.listProviders();
        return {
            providers: providers.aliases.map((a) => ({
                providerId: a.alias,
                supported: [a.provider],
                required: false,
                ...(a.active
                    ? {
                          current: {
                              apiType: a.provider,
                              baseUrl: `plurnk://${a.provider}/${a.model}`,
                          },
                      }
                    : {}),
                _meta: { plurnk: { ...a } },
            })),
        };
    });

    app.onRequest(
        "_plurnk/action",
        (raw) => raw,
        async (ctx) => {
            peer.client = ctx.client;
            try {
                return await handlePlurnkAction(
                    seam,
                    httpOrigin(),
                    ctx.params,
                    peer,
                    notifyPeerSession,
                    actionCallbacks,
                    requestSubject?.() ?? peer.subject ?? null,
                    requestCanDelegateActor?.() ?? peer.canDelegateActor ?? false,
                );
            } catch (err) {
                throw toRequestError(err);
            }
        },
    );

    app.onRequest(methods.agent.session.options, async (ctx): Promise<SessionOptionsResponse> => {
        peer.client = ctx.client;
        try {
            return await resolveSessionOptions(seam, ctx.params, {
                includeSkills: peer.supportsSkillCommands === true,
            });
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.status, async (ctx): Promise<SessionStatusResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            let isOpen = false;
            for (const p of peers) {
                for (const bound of p.sessions.values()) {
                    if (bound.workspaceId === target.workspaceId && bound.sessionId === target.session.id) {
                        isOpen = true;
                        break;
                    }
                }
                if (isOpen) break;
            }
            if (!isOpen) {
                return { status: "saved" };
            }
            const [loops, proposals, interactions, workspaceSessions] = await Promise.all([
                seam.listSessionLoops({ workspaceId: target.workspaceId, sessionId: target.session.id }),
                seam.pendingProposals(target.workspaceId),
                seam.pendingClientInteractions(target.workspaceId),
                seam.listSessions(target.workspaceId),
            ]);
            const hasPendingProposal = proposals.some(
                (p) =>
                    p.disposition.decision === "review" &&
                    (p.sessionId === target.session.id ||
                        isDescendantSession(workspaceSessions, p.sessionId, target.session.id)),
            );
            const hasPendingInteraction = interactions.some(
                (i) =>
                    i.sessionId === target.session.id ||
                    isDescendantSession(workspaceSessions, i.sessionId, target.session.id),
            );
            const activeLoop = selectSessionLoop(loops);
            const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
            const state: StateUpdate =
                hasPendingProposal || hasPendingInteraction
                    ? { state: "requires_action" }
                    : lifecycle === "running" || lifecycle === "queued"
                      ? { state: "running" }
                      : { state: "idle" };
            return { status: "open", state };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.setTitle, async (ctx): Promise<SetSessionTitleResponse> => {
        peer.client = ctx.client;
        try {
            const rawTitle: unknown = ctx.params.title;
            if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
                const problem = Problems.create(
                    "acp",
                    "session-title-invalid",
                    400,
                    "Session title must be a non-empty string.",
                );
                throw new RequestError(-32602, `${problem.detail} (session-title-invalid)`, { ...problem, problem });
            }
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            const updated = await seam.setSessionTitle({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
                title: rawTitle.trim(),
            });
            return { title: updated.title };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(
        methods.agent.session.setConfigOption,
        async (ctx): Promise<SetSessionConfigOptionResponse> => {
            peer.client = ctx.client;
            try {
                const hasMetaWorkspace =
                    isRecord(ctx.params._meta) &&
                    isRecord(ctx.params._meta.plurnk) &&
                    (ctx.params._meta.plurnk.workspace !== undefined ||
                        ctx.params._meta.plurnk.workspaceName !== undefined ||
                        ctx.params._meta.plurnk.workspaceId !== undefined ||
                        ctx.params._meta.plurnk.projectRoot !== undefined);
                const bound = (!hasMetaWorkspace ? peer.sessions.get(ctx.params.sessionId) : undefined)
                    ?? (await resolveSessionBinding(
                        seam,
                        httpOrigin(),
                        peer,
                        ctx.params.sessionId,
                        undefined,
                        hasMetaWorkspace,
                        ctx.params._meta,
                        opts.historyPageChars,
                    ));
                const prevConfigGen = optionSync.configGeneration(bound.workspaceId);
                const prevCommandsGen = optionSync.commandsGeneration(bound.workspaceId);
                const configOptions = await applyConfigOption(
                    seam,
                    bound,
                    ctx.params.configId,
                    ctx.params.value,
                );
                const workspaceScoped = isWorkspaceScopedConfigId(ctx.params.configId);
                const commandsChanged = isCommandAffectingConfigId(ctx.params.configId);
                const providerCatalog = tryListProviders(seam);
                const modelInfo = await seam.readSessionModel({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                });
                const statusMeta = {
                    plurnk: {
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                            projectRoot: bound.projectRoot,
                            projectLabel: bound.projectLabel,
                        },
                        status: {
                            model: modelInfo.model,
                            childModel: modelInfo.childModel,
                        },
                        ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                    },
                };
                if (optionSync.configGeneration(bound.workspaceId) > prevConfigGen) {
                    await optionSync.flush(bound.workspaceId);
                } else {
                    await broadcastConfigOptionsUpdate(
                        seam,
                        peers,
                        notifyPeerSession,
                        bound.workspaceId,
                        workspaceScoped ? null : bound.sessionId,
                        {
                            prebuilt: {
                                sessionId: bound.sessionId,
                                configOptions,
                                modelInfo,
                            },
                        },
                    );
                }
                if (commandsChanged) {
                    if (optionSync.commandsGeneration(bound.workspaceId) > prevCommandsGen) {
                        await optionSync.flush(bound.workspaceId);
                    } else {
                        await notifyWorkspaceCommandsChanged(bound.workspaceId);
                    }
                }
                return { configOptions, _meta: statusMeta };
            } catch (err) {
                throw toRequestError(err);
            }
        },
    );

    app.onRequest(methods.agent.terminal.cancel, async (ctx): Promise<CancelTerminalResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            const rawTerminalId = typeof ctx.params.terminalId === "string" ? ctx.params.terminalId : "";
            const match = /^term:([1-9]\d*)$/u.exec(rawTerminalId);
            if (match === null) {
                throw RequestError.invalidParams({
                    detail: `Terminal '${rawTerminalId}' is unknown, has already exited, or is not cancellable.`,
                });
            }
            const entryId = Number(match[1]);
            const cancelled = await seam.cancelStream({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
                entryId,
            });
            if (!cancelled) {
                throw RequestError.invalidParams({
                    detail: `Terminal '${rawTerminalId}' is unknown, has already exited, or is not cancellable.`,
                });
            }
            return {};
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.toolCall.cancel, async (ctx): Promise<CancelToolCallResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            const toolCallId = typeof ctx.params.toolCallId === "string" ? ctx.params.toolCallId : "";
            if (toolCallId.length === 0) {
                throw RequestError.invalidParams({ detail: "toolCallId must be a non-empty string." });
            }

            const interactionMatch = /^(?:int|interaction):([1-9]\d*)$/u.exec(toolCallId);
            if (interactionMatch !== null) {
                const interactionId = Number(interactionMatch[1]);
                const pendingInteractions = await seam.pendingClientInteractions(target.workspaceId);
                const matchedInteraction = pendingInteractions.find(
                    (i) => i.interactionId === interactionId && i.sessionId === target.session.id,
                );
                if (matchedInteraction === undefined) {
                    throw RequestError.invalidParams({
                        detail: `Tool call '${toolCallId}' is unknown, already final, or not cancellable.`,
                    });
                }
                gates.cancelSessionGates(target.workspaceId, target.session.id);
                await seam.resolveClientInteraction(
                    interactionId,
                    { action: "cancel" },
                    { workspaceId: target.workspaceId, address: OWNER_ADDRESS },
                );
                broadcastSessionUpdate(target.workspaceId, target.session.id, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId,
                            status: "cancelled",
                            capabilities: { cancel: null },
                        },
                    },
                ]);
                return {};
            }

            const pendingProposals = await seam.pendingProposals(target.workspaceId);
            const matchedProposal = pendingProposals.find(
                (p) =>
                    p.sessionId === target.session.id &&
                    p.coordinate === toolCallId &&
                    p.disposition.decision === "review",
            );
            if (matchedProposal !== undefined) {
                await seam.resolveProposal(
                    matchedProposal.logEntryId,
                    { decision: "cancel" },
                    { workspaceId: target.workspaceId, address: OWNER_ADDRESS },
                );
                gates.cancelProposalIfSettled(target.workspaceId, matchedProposal.logEntryId, "cancelled");
                broadcastSessionUpdate(target.workspaceId, target.session.id, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId,
                            status: "cancelled",
                            capabilities: { cancel: null },
                        },
                    },
                ]);
                return {};
            }

            const streamCancelled = await seam.cancelStream({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
                coordinate: toolCallId,
            });
            if (streamCancelled) {
                broadcastSessionUpdate(target.workspaceId, target.session.id, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId,
                            status: "cancelled",
                            capabilities: { cancel: null },
                        },
                    },
                ]);
                return {};
            }

            const logRows = await readAllLogEntries(seam, {
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
            });
            const matchedRow = logRows.find(
                (r) =>
                    `${r.loopSeq}/${r.turnSeq}/${r.sequence}` === toolCallId &&
                    (r.op === "work" || r.op === "fork"),
            );
            if (matchedRow !== undefined) {
                const attrs = attrRecord(matchedRow.attrs);
                const childSessionName = typeof attrs?.session === "string" ? attrs.session : null;
                if (childSessionName !== null) {
                    const workspaceSessions = await seam.listSessions(target.workspaceId);
                    const childSession = workspaceSessions.find((s) => s.name === childSessionName);
                    if (
                        childSession !== undefined &&
                        (childSession.lifecycle === "running" ||
                            childSession.lifecycle === "queued" ||
                            childSession.lifecycle === "parked")
                    ) {
                        await seam.cancelSession({
                            workspaceId: target.workspaceId,
                            sessionId: childSession.id,
                            reason: `Cancelled tool call '${toolCallId}' by ACP client`,
                        });
                        broadcastSessionUpdate(target.workspaceId, target.session.id, (s) => [
                            {
                                sessionId: s.acpSessionId,
                                update: {
                                    sessionUpdate: "tool_call_update",
                                    toolCallId,
                                    status: "cancelled",
                                    capabilities: { cancel: null },
                                },
                            },
                        ]);
                        return {};
                    }
                }
            }

            throw RequestError.invalidParams({
                detail: `Tool call '${toolCallId}' is unknown, already final, or not cancellable.`,
            });
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onNotification(methods.agent.session.cancel, async (ctx) => {
        const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
        const bound = peer.sessions.get(ctx.params.sessionId)
            ?? (await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                ctx.params.sessionId,
                undefined,
                false,
                undefined,
                opts.historyPageChars,
            ).catch(() => undefined));
        if (bound === undefined) return;
        await seam.cancelSession({
            workspaceId: bound.workspaceId,
            sessionId: bound.sessionId,
            reason: plurnkMeta.reason ?? "Cancelled by ACP client",
        });
    });
};
