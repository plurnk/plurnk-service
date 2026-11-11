// {§acp-session-owner} {§acp-proposal-resolve} {§acp-topology-scope}
// Per-connection ACP v2 AgentApp factory and JSON-RPC request/notification handlers.

import { fileURLToPath } from "node:url";
import { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import {
    McpOverAcpCaller,
    PROTOCOL_VERSION,
    RequestError,
    agent,
    methods,
    type AgentApp,
    type ArchiveSessionResponse,
    type AuthStatusResponse,
    type CancelTerminalResponse,
    type CancelToolCallResponse,
    type CloseSessionResponse,
    type ContentBlock,
    type DeleteSessionResponse,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type LogoutAuthResponse,
    type NewSessionResponse,
    type PromptResponse,
    type ResumeSessionResponse,
    type SessionOptionsResponse,
    type SessionStatusResponse,
    type SessionUpdate,
    type SetSessionConfigOptionResponse,
    type SetSessionTitleResponse,
    type StateUpdate,
    type UnarchiveSessionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    isRecord,
    lifecycleOfLoopStatus,
    selectSessionLoop,
    type MessageResource,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { executeSlashCommand, handlePlurnkAction } from "./actions.ts";
import type { ResolvedModuleOptions } from "./config.ts";
import { applyWorkspaceRenamed } from "./events.ts";
import type { GateTracker } from "./gates.ts";
import {
    attrRecord,
    extractMessageId,
    principalHasOpenWork,
    readAllLogEntries,
} from "./log-entry-projection.ts";
import SessionTranslator from "./SessionTranslator.ts";
import {
    buildAvailableCommands,
    resolvePromptCommand,
    type ResolvedPromptCommand,
} from "./session-commands.ts";
import {
    applyAdditionalDirectories,
    applyConfigOption,
    applyInitialConfigOptions,
    buildConfigOptions,
    resolveSessionOptions,
} from "./session-options.ts";
import { listSessionsOverview, parseOverviewRequest } from "./session-overview.ts";
import {
    OWNER_ADDRESS,
    applyAcpMcpServers,
    applySystemPrompt,
    assertSinglePortSecurity,
    buildAuthStatus,
    buildSessionDescendants,
    extractPlurnkMeta,
    formatSessionId,
    isDescendantSession,
    lookupSessionTarget,
    registerAcpSessionOwner,
    resolveSessionBinding,
    selectBoundSessionForTarget,
    toRequestError,
    tryListProviders,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

const toEpochMs = (ts: string | number | null | undefined): number | null => {
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

export interface ConnectionAgentContext {
    readonly seam: ApplicationPort;
    readonly opts: ResolvedModuleOptions;
    readonly peers: Set<AcpPeer>;
    readonly gates: GateTracker;
    readonly httpOrigin: () => string;
    readonly requestSubject?: () => string | null;
    readonly notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void;
    readonly broadcastSessionUpdate: (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ) => void;
}

export const createConnectionAgent = (
    host: ConnectionAgentContext,
    connInfo: { readonly family: string | null; readonly subject?: string | null; readonly closeTransport?: () => void },
): AgentApp => {
    const {
        seam,
        opts,
        peers,
        gates,
        httpOrigin,
        requestSubject,
        notifyPeerSession,
        broadcastSessionUpdate,
    } = host;
    const notifyAuthStatusChanged = (): void => {
        const status = buildAuthStatus(seam);
        const json = JSON.stringify(status);
        for (const p of peers) {
            if (p.client === null || p.lastAuthStatusJson === json) continue;
            p.lastAuthStatusJson = json;
            void p.client.notify(methods.client.auth.statusUpdate, status).catch(() => undefined);
        }
    };

    const actionCallbacks = {
        onWorkspaceRenamed: (workspaceId: number, name: string) =>
            applyWorkspaceRenamed(peers, notifyPeerSession, workspaceId, name),
        onAuthStatusChanged: notifyAuthStatusChanged,
    };

    const peer: AcpPeer = {
        family: connInfo.family,
        subject: connInfo.subject ?? null,
        sessions: new Map(),
        client: null,
        closeTransport: connInfo.closeTransport,
        closeWithProblem: async (problem: ProblemDetails) => {
            if (peer.client !== null) {
                const deliveries: Promise<unknown>[] = [];
                for (const session of new Set(peer.sessions.values())) {
                    deliveries.push(
                        peer.client
                            .notify(methods.client.session.update, {
                                sessionId: session.acpSessionId,
                                update: {
                                    sessionUpdate: "notice",
                                    severity: "error",
                                    title: problem.title,
                                    description: `problem:${problem.title} — ${problem.detail}`,
                                    _meta: {
                                        plurnk: {
                                            problem,
                                        },
                                    },
                                },
                            })
                            .catch(() => undefined),
                    );
                }
                await Promise.allSettled(deliveries);
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            peer.closeTransport?.();
        },
    };

    const mcpCaller = new McpOverAcpCaller({
        clientInfo: { name: "@plurnk/plurnk-service", version: "1.0.0" },
    });
    const mcpBridge = new McpOverAcpHttpBridge(mcpCaller);

    const app = agent({
        name: "@plurnk/plurnk-service",
    });

    app.onNotification(methods.agent.mcp.message, mcpCaller.handleNotification);

    app.onConnect((conn) => {
        peer.client = conn.client;
        peers.add(peer);
        void conn.closed.finally(() => {
            peers.delete(peer);
            gates.removePeer(peer);
        });
    });

    app.onRequest(methods.agent.initialize, async (ctx): Promise<InitializeResponse> => {
        peer.client = ctx.client;
        peers.add(peer);
        return {
            protocolVersion: PROTOCOL_VERSION,
            info: {
                name: "@plurnk/plurnk-service",
                title: "PLURNK Service",
                version: "1.0.0",
            },
            capabilities: {
                session: {
                    prompt: {
                        image: {},
                        embeddedContext: {},
                    },
                    mcp: {
                        acp: {},
                    },
                    archive: {},
                    delete: {},
                    fork: {},
                    options: {},
                    status: {},
                    title: {},
                    additionalDirectories: {},
                    systemPrompt: {},
                },
                auth: {
                    status: {},
                },
                providers: {},
            },
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
        if (peer.family !== null) {
            const family = peer.family;
            setImmediate(() => seam.credentials.revokeFamily(family));
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
                _meta: {
                    plurnk: { ...a },
                },
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
                );
            } catch (err) {
                throw toRequestError(err);
            }
        },
    );

    app.onRequest(methods.agent.session.new, async (ctx): Promise<NewSessionResponse> => {
        peer.client = ctx.client;
        try {
            assertSinglePortSecurity(ctx.params);
            const bound = await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                undefined,
                ctx.params.cwd,
                true,
                ctx.params._meta,
                opts.historyPageChars,
            );
            await applyAdditionalDirectories(
                seam,
                bound.workspaceId,
                bound.projectRoot,
                ctx.params.additionalDirectories,
            );
            await applyAcpMcpServers(
                seam,
                mcpBridge,
                ctx.client,
                bound.workspaceId,
                ctx.params.mcpServers,
            );
            await applySystemPrompt(
                seam,
                bound.workspaceId,
                bound.sessionId,
                bound.sessionName,
                ctx.params.systemPrompt,
            );
            await applyInitialConfigOptions(seam, bound, ctx.params.configOptions);
            const providerCatalog = tryListProviders(seam);
            const [configOptions, availableCommands, modelInfo, spend] = await Promise.all([
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                buildAvailableCommands(seam, bound.workspaceId),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionAccounting({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);
            for (const notice of seam.configurationNotices(bound.workspaceId)) {
                for (const { update } of bound.translator.notice(notice)) {
                    notifyPeerSession(peer, bound.acpSessionId, update);
                }
            }
            if (providerCatalog.problem !== null) {
                notifyPeerSession(peer, bound.acpSessionId, {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: providerCatalog.problem.title,
                    description: providerCatalog.problem.detail,
                    _meta: {
                        plurnk: {
                            problem: providerCatalog.problem,
                        },
                    },
                });
            }
            return {
                sessionId: bound.acpSessionId,
                configOptions,
                availableCommands,
                _meta: {
                    plurnk: {
                        sessionId: bound.sessionId,
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                            projectRoot: bound.projectRoot,
                            projectLabel: bound.projectLabel,
                            preparation: seam.workspacePreparationStatus(bound.workspaceId),
                            activity: seam.workspaceDerivationStatus(bound.workspaceId),
                        },
                        session: { id: bound.sessionId, name: bound.sessionName },
                        status: {
                            model: modelInfo.model,
                            spawnModel: modelInfo.spawnModel,
                            spend,
                        },
                        ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                    },
                },
            };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.resume, async (ctx): Promise<ResumeSessionResponse> => {
        peer.client = ctx.client;
        try {
            assertSinglePortSecurity(ctx.params);
            const rawReplayFrom = ctx.params.replayFrom;
            let shouldReplay = false;
            if (rawReplayFrom !== undefined && rawReplayFrom !== null) {
                if (isRecord(rawReplayFrom) && rawReplayFrom.type === "start") {
                    shouldReplay = true;
                } else {
                    throw new RequestError(
                        -32602,
                        "Unsupported or malformed replayFrom cursor; only { type: \"start\" } or null is supported.",
                    );
                }
            }
            const bound = await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                ctx.params.sessionId,
                ctx.params.cwd,
                false,
                ctx.params._meta,
                opts.historyPageChars,
            );
            await applyAdditionalDirectories(
                seam,
                bound.workspaceId,
                bound.projectRoot,
                ctx.params.additionalDirectories,
            );
            await applyAcpMcpServers(
                seam,
                mcpBridge,
                ctx.client,
                bound.workspaceId,
                ctx.params.mcpServers,
            );
            await applySystemPrompt(
                seam,
                bound.workspaceId,
                bound.sessionId,
                bound.sessionName,
                ctx.params.systemPrompt,
            );
            await applyInitialConfigOptions(seam, bound, ctx.params.configOptions);

            const providerCatalog = tryListProviders(seam);
            const [entries, inbox, loops, proposals, interactions, workspaceSessions, configOptions, availableCommands, modelInfo, spend, streams, budget] = await Promise.all([
                readAllLogEntries(seam, { workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.listSessionLoops({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.pendingProposals(bound.workspaceId),
                seam.pendingClientInteractions(bound.workspaceId),
                seam.listSessions(bound.workspaceId),
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                buildAvailableCommands(seam, bound.workspaceId),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionAccounting({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readStreams({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionGauge({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);

            const resumeMeta = extractPlurnkMeta(ctx.params._meta);
            const useWindow =
                !shouldReplay ||
                resumeMeta.window === true ||
                resumeMeta.historyLoops !== undefined ||
                resumeMeta.historyPageChars !== undefined;
            const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                ...(useWindow
                    ? {
                          historyLoops: resumeMeta.historyLoops ?? opts.historyLoops,
                          historyPageChars: resumeMeta.historyPageChars ?? opts.historyPageChars,
                      }
                    : {}),
                openStreamTargets: new Set(streams.map((s) => s.target)),
                subject: peer.subject,
            });

            if (shouldReplay) {
                for (const { update } of replayed) {
                    notifyPeerSession(peer, bound.acpSessionId, update);
                }
            }

            for (const notice of seam.configurationNotices(bound.workspaceId)) {
                for (const { update } of bound.translator.notice(notice)) {
                    notifyPeerSession(peer, bound.acpSessionId, update);
                }
            }
            if (providerCatalog.problem !== null) {
                notifyPeerSession(peer, bound.acpSessionId, {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: providerCatalog.problem.title,
                    description: providerCatalog.problem.detail,
                    _meta: {
                        plurnk: {
                            problem: providerCatalog.problem,
                        },
                    },
                });
            }

            const sessionProposals = proposals.filter(
                (p) =>
                    p.disposition.decision === "review" &&
                    selectBoundSessionForTarget(peer, bound.workspaceId, p.sessionId, workspaceSessions) === bound,
            );
            const sessionInteractions = interactions.filter(
                (i) => selectBoundSessionForTarget(peer, bound.workspaceId, i.sessionId, workspaceSessions) === bound,
            );

            const activeLoop = selectSessionLoop(loops);
            const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
            const hasPendingAction = sessionProposals.length > 0 || sessionInteractions.length > 0;
            const isNamedPrincipal =
                peer.subject !== null &&
                peer.subject !== undefined &&
                peer.subject !== "operator" &&
                peer.subject !== "anonymous";
            const principalHasOpenMessage =
                isNamedPrincipal &&
                typeof peer.subject === "string" &&
                principalHasOpenWork(peer.subject, inbox, activeLoop, entries);
            if (isNamedPrincipal) {
                bound.principalRunning = principalHasOpenMessage;
            }

            const currentState: SessionUpdate = isNamedPrincipal
                ? principalHasOpenMessage
                    ? {
                          sessionUpdate: "state_update",
                          state: "running",
                          _meta: { plurnk: { voice: peer.subject } },
                      }
                    : {
                          sessionUpdate: "state_update",
                          state: "idle",
                          _meta: { plurnk: { voice: peer.subject } },
                      }
                : hasPendingAction
                  ? { sessionUpdate: "state_update", state: "requires_action" }
                  : lifecycle === "running" || lifecycle === "queued"
                    ? { sessionUpdate: "state_update", state: "running" }
                    : lifecycle === "parked" && activeLoop !== null
                      ? {
                            sessionUpdate: "state_update",
                            state: "running",
                            _meta: {
                                plurnk: {
                                    status: {
                                        lifecycle: "parked",
                                        loopId: activeLoop.id,
                                        loopSeq: activeLoop.sequence,
                                        packetCount: activeLoop.packetCount,
                                        waitUntil: activeLoop.waitUntil ?? null,
                                    },
                                    notice: {
                                        source: "engine:lifecycle",
                                        kind: "loop_status",
                                        level: "info",
                                        status: 202,
                                        loopId: activeLoop.id,
                                        loopSeq: activeLoop.sequence,
                                        packetCount: activeLoop.packetCount,
                                        ...(activeLoop.waitUntil !== null ? { waitUntil: activeLoop.waitUntil } : {}),
                                        ...(activeLoop.claimedAt !== null ? { claimedAt: toEpochMs(activeLoop.claimedAt) } : {}),
                                    },
                                },
                            },
                        }
                      : { sessionUpdate: "state_update", state: "idle" };

            notifyPeerSession(peer, bound.acpSessionId, currentState);

            const announcedSubagents = new Set<number>();
            for (const proposal of sessionProposals) {
                if (proposal.sessionId !== bound.sessionId && !announcedSubagents.has(proposal.sessionId)) {
                    announcedSubagents.add(proposal.sessionId);
                    const childRow = workspaceSessions.find((w) => w.id === proposal.sessionId);
                    const childName = childRow?.name ?? proposal.session ?? String(proposal.sessionId);
                    notifyPeerSession(peer, bound.acpSessionId, {
                        sessionUpdate: "subagent_update",
                        sessionId: formatSessionId(bound.workspaceId, childName),
                        title: childName,
                        capabilities: { cancel: {} },
                        state: { state: "requires_action" },
                        _meta: {
                            plurnk: {
                                id: proposal.sessionId,
                                name: childName,
                                ...(childRow !== undefined
                                    ? {
                                          parentSessionId: childRow.parentSessionId,
                                          kind: childRow.kind,
                                          lifecycle: childRow.lifecycle,
                                      }
                                    : {}),
                            },
                        },
                    });
                }
                const gate = gates.openOrGet(bound.workspaceId, proposal.sessionId, "proposal", proposal);
                gates.dispatchToPeer(gate, peer, bound, seam, peers, notifyPeerSession, broadcastSessionUpdate);
            }
            for (const interaction of sessionInteractions) {
                if (interaction.sessionId !== bound.sessionId && !announcedSubagents.has(interaction.sessionId)) {
                    announcedSubagents.add(interaction.sessionId);
                    const childRow = workspaceSessions.find((w) => w.id === interaction.sessionId);
                    const childName = childRow?.name ?? String(interaction.sessionId);
                    notifyPeerSession(peer, bound.acpSessionId, {
                        sessionUpdate: "subagent_update",
                        sessionId: formatSessionId(bound.workspaceId, childName),
                        title: childName,
                        capabilities: { cancel: {} },
                        state: { state: "requires_action" },
                        _meta: {
                            plurnk: {
                                id: interaction.sessionId,
                                name: childName,
                                ...(childRow !== undefined
                                    ? {
                                          parentSessionId: childRow.parentSessionId,
                                          kind: childRow.kind,
                                          lifecycle: childRow.lifecycle,
                                      }
                                    : {}),
                            },
                        },
                    });
                }
                const gate = gates.openOrGet(bound.workspaceId, interaction.sessionId, "interaction", undefined, interaction);
                gates.dispatchToPeer(gate, peer, bound, seam, peers, notifyPeerSession, broadcastSessionUpdate);
            }

            const refLoop = activeLoop ?? loops.at(-1) ?? null;

            return {
                configOptions,
                availableCommands,
                _meta: {
                    plurnk: {
                        sessionId: bound.sessionId,
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                            projectRoot: bound.projectRoot,
                            projectLabel: bound.projectLabel,
                            preparation: seam.workspacePreparationStatus(bound.workspaceId),
                            activity: seam.workspaceDerivationStatus(bound.workspaceId),
                        },
                        session: { id: bound.sessionId, name: bound.sessionName },
                        status: {
                            lifecycle,
                            model: modelInfo.model,
                            spawnModel: modelInfo.spawnModel,
                            loopId: refLoop?.id ?? null,
                            loopSeq: refLoop?.sequence ?? null,
                            packetCount: refLoop?.packetCount ?? null,
                            waitUntil: activeLoop?.waitUntil ?? null,
                            claimedAt: toEpochMs(refLoop?.claimedAt),
                            terminatedAt: toEpochMs(refLoop?.terminatedAt),
                            descendants: buildSessionDescendants(
                                workspaceSessions,
                                proposals,
                                interactions,
                                bound.sessionId,
                            ),
                            inbox: inbox.map((msg) => ({
                                path: msg.path,
                                id: extractMessageId(msg.source ?? msg.path, bound.acpSessionId),
                                loopId: msg.loopId,
                                lifecycle: msg.lifecycle,
                                body: {
                                    url: `${httpOrigin()}/acp/${bound.workspaceId}/${bound.sessionId}/entry?target=${encodeURIComponent(msg.path)}`,
                                    mimeType: "text/plain",
                                },
                            })),
                            spend,
                            streams,
                        },
                        budget,
                        ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                        history: replayed.history,
                    },
                },
            };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    const cancelSubtreeWork = async (
        workspaceId: number,
        subtreeIds: ReadonlySet<number>,
        reason: string,
    ): Promise<void> => {
        const [proposals, interactions] = await Promise.all([
            seam.pendingProposals(workspaceId).catch(() => []),
            seam.pendingClientInteractions(workspaceId).catch(() => []),
        ]);
        for (const p of proposals) {
            if (subtreeIds.has(p.sessionId) && p.disposition.decision === "review") {
                await seam
                    .resolveProposal(p.logEntryId, { decision: "cancel" }, { workspaceId, address: OWNER_ADDRESS })
                    .catch(() => undefined);
            }
        }
        for (const i of interactions) {
            if (subtreeIds.has(i.sessionId)) {
                await seam
                    .resolveClientInteraction(
                        i.interactionId,
                        { action: "cancel" },
                        { workspaceId, address: OWNER_ADDRESS },
                    )
                    .catch(() => undefined);
            }
        }
        for (const sId of subtreeIds) {
            const streams = await seam.readStreams({ workspaceId, sessionId: sId }).catch(() => []);
            for (const st of streams) {
                await seam.cancelStream({ workspaceId, sessionId: sId, entryId: st.entryId }).catch(() => undefined);
            }
            await seam.cancelSession({ workspaceId, sessionId: sId, reason }).catch(() => undefined);
            gates.cancelSessionGates(workspaceId, sId);
        }
    };

    const removeBoundSubtree = (workspaceId: number, subtreeIds: ReadonlySet<number>, targetPeers: Iterable<AcpPeer>): void => {
        for (const p of targetPeers) {
            gates.removePeerSession(p, workspaceId, subtreeIds);
            for (const [key, bound] of [...p.sessions.entries()]) {
                if (bound.workspaceId === workspaceId && subtreeIds.has(bound.sessionId)) {
                    p.sessions.delete(key);
                }
            }
        }
    };

    app.onRequest(methods.agent.session.list, async (ctx): Promise<ListSessionsResponse> => {
        peer.client = ctx.client;
        try {
            const origin = httpOrigin();
            const query = parseOverviewRequest(ctx.params.cwd, ctx.params._meta, ctx.params.archived);
            return await listSessionsOverview(
                seam,
                opts,
                origin,
                query,
            );
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.archive, async (ctx): Promise<ArchiveSessionResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            const allSessions = await seam.listSessions(target.workspaceId);
            const subtreeIds = new Set<number>([target.session.id]);
            for (const s of allSessions) {
                if (isDescendantSession(allSessions, s.id, target.session.id)) {
                    subtreeIds.add(s.id);
                }
            }
            await cancelSubtreeWork(target.workspaceId, subtreeIds, "Archived by ACP client");
            removeBoundSubtree(target.workspaceId, subtreeIds, peers);
            await seam.setSessionArchived({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
                archived: true,
            });
            return {};
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.unarchive, async (ctx): Promise<UnarchiveSessionResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            await seam.setSessionArchived({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
                archived: false,
            });
            return {};
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.delete, async (ctx): Promise<DeleteSessionResponse> => {
        peer.client = ctx.client;
        try {
            const target = await lookupSessionTarget(seam, ctx.params.sessionId, undefined, ctx.params._meta);
            const allSessions = await seam.listSessions(target.workspaceId);
            const subtreeIds = new Set<number>([target.session.id]);
            for (const s of allSessions) {
                if (isDescendantSession(allSessions, s.id, target.session.id)) {
                    subtreeIds.add(s.id);
                }
            }
            await cancelSubtreeWork(target.workspaceId, subtreeIds, "Deleted by ACP client");
            const deleted = await seam.deleteSession({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
            });
            for (const id of deleted.sessionIds) {
                subtreeIds.add(id);
            }
            removeBoundSubtree(target.workspaceId, subtreeIds, peers);
            return {};
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.options, async (ctx): Promise<SessionOptionsResponse> => {
        peer.client = ctx.client;
        try {
            return await resolveSessionOptions(seam, ctx.params);
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
            const isNamedPrincipal =
                peer.subject !== null &&
                peer.subject !== undefined &&
                peer.subject !== "operator" &&
                peer.subject !== "anonymous";
            if (isNamedPrincipal) {
                const [inbox, loopEntries] = await Promise.all([
                    seam.readInbox({
                        workspaceId: target.workspaceId,
                        sessionId: target.session.id,
                    }),
                    activeLoop !== null
                        ? readAllLogEntries(seam, {
                              workspaceId: target.workspaceId,
                              sessionId: target.session.id,
                              loopId: activeLoop.id,
                          })
                        : Promise.resolve([]),
                ]);
                const principalOpen =
                    typeof peer.subject === "string" &&
                    principalHasOpenWork(peer.subject, inbox, activeLoop, loopEntries);
                return {
                    status: "open",
                    state: principalOpen ? { state: "running" } : { state: "idle" },
                };
            }
            const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
            const state: StateUpdate =
                hasPendingProposal || hasPendingInteraction
                    ? { state: "requires_action" }
                    : lifecycle === "running" || lifecycle === "queued"
                      ? { state: "running" }
                      : { state: "idle" };
            return {
                status: "open",
                state,
            };
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

            const interactionMatch = /^interaction:([1-9]\d*)$/u.exec(toolCallId);
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
                await seam.resolveClientInteraction(
                    interactionId,
                    { action: "cancel" },
                    { workspaceId: target.workspaceId, address: OWNER_ADDRESS },
                );
                gates.cancelSessionGates(target.workspaceId, target.session.id);
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
                    `${r.loop_seq}/${r.turn_seq}/${r.sequence}` === toolCallId &&
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

    app.onRequest(methods.agent.session.fork, async (ctx): Promise<ForkSessionResponse> => {
        peer.client = ctx.client;
        try {
            assertSinglePortSecurity(ctx.params);
            const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
            const parent = peer.sessions.get(ctx.params.sessionId)
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    ctx.params.cwd,
                    false,
                    undefined,
                    opts.historyPageChars,
                ));
            const forked = await seam.forkSession({
                workspaceId: parent.workspaceId,
                sessionId: parent.sessionId,
                ...(plurnkMeta.sessionName !== undefined ? { name: plurnkMeta.sessionName } : {}),
            });
            const forkedSession = await seam.readSession({
                workspaceId: parent.workspaceId,
                identity: { id: forked.sessionId },
            });
            const sessionName = forked.sessionName ?? forkedSession?.name ?? String(forked.sessionId);
            const newSessionId = formatSessionId(parent.workspaceId, sessionName);
            await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                newSessionId,
                ctx.params.cwd,
                false,
                undefined,
                opts.historyPageChars,
            );
            await applyAcpMcpServers(
                seam,
                mcpBridge,
                ctx.client,
                parent.workspaceId,
                ctx.params.mcpServers,
            );
            await applySystemPrompt(
                seam,
                parent.workspaceId,
                forked.sessionId,
                sessionName,
                ctx.params.systemPrompt,
            );
            const configOptions = await buildConfigOptions(seam, parent.workspaceId, forked.sessionId);
            return {
                sessionId: newSessionId,
                configOptions,
                _meta: {
                    plurnk: {
                        sessionId: forked.sessionId,
                        sessionName,
                    },
                },
            };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.close, async (ctx): Promise<CloseSessionResponse> => {
        peer.client = ctx.client;
        const bound = peer.sessions.get(ctx.params.sessionId);
        if (bound !== undefined) {
            removeBoundSubtree(bound.workspaceId, new Set([bound.sessionId]), [peer]);
        } else {
            peer.sessions.delete(ctx.params.sessionId);
        }
        return {};
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
                const configOptions = await applyConfigOption(
                    seam,
                    bound,
                    ctx.params.configId,
                    ctx.params.value,
                );
                const availableCommands =
                    ctx.params.configId.startsWith("skills:") || ctx.params.configId.startsWith("mcp:")
                        ? await buildAvailableCommands(seam, bound.workspaceId)
                        : null;
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
                            spawnModel: modelInfo.spawnModel,
                        },
                        ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                    },
                };
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "config_option_update",
                            configOptions,
                            _meta: statusMeta,
                        },
                    },
                    ...(availableCommands !== null
                        ? [
                              {
                                  sessionId: s.acpSessionId,
                                  update: {
                                      sessionUpdate: "available_commands_update" as const,
                                      availableCommands,
                                  },
                              },
                          ]
                        : []),
                ]);
                return { configOptions, _meta: statusMeta };
            } catch (err) {
                throw toRequestError(err);
            }
        },
    );

    app.onRequest(methods.agent.session.prompt, async (ctx): Promise<PromptResponse> => {
        peer.client = ctx.client;
        try {
            const existingBound = peer.sessions.get(ctx.params.sessionId);
            const bound = existingBound
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    undefined,
                    true,
                    ctx.params._meta,
                    opts.historyPageChars,
                ));
            const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
            if (
                existingBound !== undefined &&
                plurnkMeta.control !== false &&
                (plurnkMeta.interactive !== undefined || plurnkMeta.tools !== undefined)
            ) {
                await registerAcpSessionOwner(seam, bound.workspaceId, plurnkMeta);
            }
            const textParts: string[] = [];
            const promptOpenPaths: string[] = [];
            const attachments: MessageResource[] = [];
            let pendingBuiltinCommand: Extract<ResolvedPromptCommand, { readonly kind: "builtin" }> | null = null;
            for (const block of ctx.params.prompt as readonly ContentBlock[]) {
                const rawBlock: unknown = block;
                if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                    textParts.push(block.text);
                } else if (
                    isRecord(rawBlock) &&
                    rawBlock.type === "command" &&
                    typeof rawBlock.name === "string"
                ) {
                    const cmdName = rawBlock.name;
                    const cmdInput = rawBlock.input;
                    const resolved = await resolvePromptCommand(seam, bound.workspaceId, cmdName, cmdInput);
                    if (resolved?.kind === "builtin") {
                        if (ctx.params.prompt.length === 1) {
                            pendingBuiltinCommand = resolved;
                        }
                        const suffix = resolved.rest.length > 0 ? ` ${resolved.rest}` : "";
                        textParts.push(`/${resolved.cmd}${suffix}`);
                    } else if (resolved?.kind === "open_path") {
                        promptOpenPaths.push(resolved.target);
                        if (resolved.text.length > 0) {
                            textParts.push(resolved.text);
                        }
                    } else {
                        const rawInputStr =
                            typeof cmdInput === "string"
                                ? cmdInput.trim()
                                : isRecord(cmdInput) && typeof cmdInput.text === "string"
                                  ? cmdInput.text.trim()
                                  : "";
                        textParts.push(rawInputStr.length > 0 ? `/${cmdName} ${rawInputStr}` : `/${cmdName}`);
                    }
                } else if (block.type === "resource_link" && typeof block.uri === "string" && block.uri.length > 0) {
                    let targetPath = block.uri;
                    if (block.uri.startsWith("file://")) {
                        try {
                            targetPath = fileURLToPath(block.uri);
                        } catch {
                            targetPath = block.uri;
                        }
                    }
                    promptOpenPaths.push(targetPath);
                } else if (block.type === "resource" && isRecord(block.resource)) {
                    const res = block.resource;
                    const uri = typeof res.uri === "string" && res.uri.length > 0 ? res.uri : "resource";
                    const mediaType =
                        typeof res.mimeType === "string" && res.mimeType.length > 0
                            ? res.mimeType
                            : "text" in res
                              ? "text/plain"
                              : "application/octet-stream";
                    if ("text" in res && typeof res.text === "string") {
                        attachments.push({
                            name: uri,
                            mediaType,
                            bytes: new TextEncoder().encode(res.text),
                            target: uri,
                        });
                    } else if ("blob" in res && typeof res.blob === "string") {
                        attachments.push({
                            name: uri,
                            mediaType,
                            bytes: new Uint8Array(Buffer.from(res.blob, "base64")),
                            target: uri,
                        });
                    }
                } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
                    const name = typeof block.uri === "string" && block.uri.length > 0 ? block.uri : "image";
                    attachments.push({
                        name,
                        mediaType: block.mimeType,
                        bytes: new Uint8Array(Buffer.from(block.data, "base64")),
                        ...(typeof block.uri === "string" && block.uri.length > 0 ? { target: block.uri } : {}),
                    });
                }
            }
            if (pendingBuiltinCommand === null && textParts.length === 1 && textParts[0].trim().startsWith("/")) {
                const trimmedPart = textParts[0].trim();
                const spaceIdx = trimmedPart.indexOf(" ");
                const rawCmd = spaceIdx === -1 ? trimmedPart.slice(1) : trimmedPart.slice(1, spaceIdx);
                const rest = spaceIdx === -1 ? "" : trimmedPart.slice(spaceIdx + 1).trim();
                const resolved = await resolvePromptCommand(seam, bound.workspaceId, rawCmd, rest);
                if (resolved?.kind === "builtin") {
                    pendingBuiltinCommand = resolved;
                } else if (resolved?.kind === "open_path") {
                    promptOpenPaths.push(resolved.target);
                    textParts.splice(0, textParts.length, ...(resolved.text.length > 0 ? [resolved.text] : []));
                }
            }
            const mergedOpenPaths = [
                ...(plurnkMeta.openPaths ?? []),
                ...promptOpenPaths,
            ];
            const rawText = textParts.join("\n");
            if (rawText.trim().length === 0 && attachments.length === 0 && mergedOpenPaths.length === 0) {
                throw new RequestError(
                    -32602,
                    "Prompt must contain non-empty text. (user-message-text-required)",
                    Problems.create("acp", "user-message-text-required", 400, "Prompt must contain non-empty text."),
                );
            }
            const text =
                rawText.trim().length > 0
                    ? rawText
                    : mergedOpenPaths.length > 0
                      ? mergedOpenPaths.map((p) => `<${p}>`).join("\n")
                      : "";
            const messageId = plurnkMeta.messageId ?? crypto.randomUUID();
            const rawPrincipal = (requestSubject?.() ?? peer.subject ?? "operator").replace(/^acp:\/\//u, "");
            const principal = rawPrincipal.length > 0 ? rawPrincipal : "operator";
            const messageAddress = `acp://${encodeURIComponent(principal)}/sessions/${encodeURIComponent(bound.acpSessionId)}/messages/${encodeURIComponent(messageId)}`;
            const admissionBody =
                text.length > 0 ? text : attachments.map((a) => `<${a.name}>`).join("\n");

            await seam.messageAdmission({
                workspaceId: bound.workspaceId,
                address: messageAddress,
                body: admissionBody,
            });

            if (pendingBuiltinCommand !== null) {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "running",
                        },
                    },
                ]);
                const replyText = await executeSlashCommand(
                    seam,
                    httpOrigin(),
                    bound,
                    pendingBuiltinCommand.cmd,
                    pendingBuiltinCommand.rest,
                    peer,
                    notifyPeerSession,
                    actionCallbacks,
                );
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId,
                            content: { type: "text", text: replyText },
                        },
                    },
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "idle",
                            stopReason: "end_turn",
                        },
                    },
                ]);
                return { messageId };
            }

            notifyPeerSession(peer, bound.acpSessionId, {
                sessionUpdate: "_plurnk_telemetry",
                _meta: {
                    plurnk: {
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                            projectRoot: bound.projectRoot,
                            projectLabel: bound.projectLabel,
                            preparation: seam.workspacePreparationStatus(bound.workspaceId),
                            activity: seam.workspaceDerivationStatus(bound.workspaceId),
                        },
                    },
                },
            });
            broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "running",
                        _meta: {
                            plurnk: {
                                voice: principal,
                            },
                        },
                    },
                },
            ]);

            const maxTurns = plurnkMeta.maxTurns ?? opts.maxTurns;
            const broadcastPromptRefusal = (problem: ProblemDetails): void => {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "idle",
                            stopReason: "refusal",
                            _meta: {
                                plurnk: {
                                    voice: principal,
                                    terminal: {
                                        status: problem.status ?? 500,
                                        turnCount: 0,
                                        elapsedMs: 0,
                                        reason: "refusal",
                                        problem,
                                    },
                                },
                            },
                        },
                    },
                ]);
            };
            let ack: Awaited<ReturnType<typeof seam.runLoop>>;
            try {
                ack = await seam.runLoop({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                    prompt: text,
                    source: messageAddress,
                    messageAddress,
                    ...(attachments.length > 0 ? { attachments } : {}),
                    ...(maxTurns !== undefined ? { maxTurns } : {}),
                    ...(mergedOpenPaths.length > 0 ? { openPaths: mergedOpenPaths } : {}),
                    ...(plurnkMeta.envelope !== undefined ? { envelope: plurnkMeta.envelope } : {}),
                });
            } catch (runErr) {
                const reqErr = toRequestError(runErr);
                const problemData =
                    Problems.fromError(runErr) ??
                    Problems.create("module:acp", "prompt-failed", 500, reqErr.message);
                broadcastPromptRefusal(problemData);
                throw reqErr;
            }

            if (ack.problem !== undefined) {
                broadcastPromptRefusal(ack.problem);
                throw new RequestError(-32000, ack.problem.detail, ack.problem);
            }

            const rawInbox = await seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId });
            const origin = httpOrigin();
            const mappedInbox = rawInbox.map((msg) => ({
                path: msg.path,
                id: extractMessageId(msg.source ?? msg.path, bound.acpSessionId),
                loopId: msg.loopId,
                lifecycle: msg.lifecycle,
                body: {
                    url: `${origin}/acp/${bound.workspaceId}/${bound.sessionId}/entry?target=${encodeURIComponent(msg.path)}`,
                    mimeType: "text/plain",
                },
            }));
            const queuedMsg = mappedInbox.find((item) => item.id === messageId);
            if (queuedMsg !== undefined) {
                broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "_plurnk_telemetry",
                            _meta: {
                                plurnk: {
                                    status: {
                                        inbox: mappedInbox,
                                    },
                                },
                            },
                        },
                    },
                ]);
            }

            return {
                messageId,
                _meta: {
                    plurnk: {
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                        loopId: ack.loopId,
                        ...(typeof ack.resource === "string" ? { resource: ack.resource } : {}),
                        workspace: {
                            id: bound.workspaceId,
                            name: bound.workspaceName,
                        },
                    },
                },
            };
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

    return app;
};
