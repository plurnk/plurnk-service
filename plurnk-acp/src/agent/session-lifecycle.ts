// {§acp-daemon-client} {§acp-history-window} {§acp-overview}
// Session lifecycle handlers: `session/new`, `session/resume`, `session/list`, `session/archive`,
// `session/unarchive`, `session/delete`, `session/fork`, and `session/close`.

import {
    RequestError,
    methods,
    type AgentApp,
    type ArchiveSessionResponse,
    type CloseSessionResponse,
    type DeleteSessionResponse,
    type ForkSessionResponse,
    type ListSessionsResponse,
    type NewSessionResponse,
    type ResumeSessionResponse,
    type SessionUpdate,
    type UnarchiveSessionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord, lifecycleOfLoopStatus, selectSessionLoop } from "@plurnk/plurnk-contracts";
import { broadcastConfigOptionsUpdate } from "../events.ts";
import { projectInboxItems, readAllLogEntries } from "../log-entry-projection.ts";
import SessionTranslator from "../SessionTranslator.ts";
import { buildAvailableCommands } from "../session-commands.ts";
import {
    applyAdditionalDirectories,
    applyInitialConfigOptions,
    buildConfigOptions,
    isCommandAffectingConfigId,
    isWorkspaceScopedConfigId,
} from "../session-options.ts";
import { listSessionsOverview, parseOverviewRequest } from "../session-overview.ts";
import {
    applyAcpMcpServers,
    applySystemPrompt,
    assertSinglePortSecurity,
    buildSessionDescendants,
    extractPlurnkMeta,
    formatSessionId,
    isDescendantSession,
    lookupSessionTarget,
    resolveSessionBinding,
    selectBoundSessionForTarget,
    toRequestError,
    tryListProviders,
    type BoundSession,
} from "../sessions.ts";
import { cancelSubtreeWork, removeBoundSubtree, toEpochMs, type AgentPeerRuntime } from "./context.ts";

export const registerSessionLifecycleHandlers = (app: AgentApp, rt: AgentPeerRuntime): void => {
    const { peer, mcpBridge, notifyWorkspaceCommandsChanged } = rt;
    const { seam, opts, peers, gates, optionSync, httpOrigin, notifyPeerSession, broadcastSessionUpdate } = rt.host;

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
            peer.suppressInitialOptionUpdates = (peer.suppressInitialOptionUpdates ?? 0) + 1;
            try {
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
            } finally {
                peer.suppressInitialOptionUpdates = Math.max(0, (peer.suppressInitialOptionUpdates ?? 1) - 1);
            }
            const providerCatalog = tryListProviders(seam);
            const [configOptions, availableCommands, modelInfo, spend] = await Promise.all([
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                buildAvailableCommands(seam, bound.workspaceId, {
                    includeSkills: peer.supportsSkillCommands === true,
                }),
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
                    _meta: { plurnk: { problem: providerCatalog.problem } },
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
                            childModel: modelInfo.childModel,
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
        let heldBound: BoundSession | undefined;
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
            if (shouldReplay) {
                bound.heldUpdates = [];
                heldBound = bound;
            }
            const prevConfigGen = optionSync.configGeneration(bound.workspaceId);
            const prevCommandsGen = optionSync.commandsGeneration(bound.workspaceId);
            let optionsApplied = false;
            peer.suppressInitialOptionUpdates = (peer.suppressInitialOptionUpdates ?? 0) + 1;
            try {
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
                optionsApplied = await applyInitialConfigOptions(seam, bound, ctx.params.configOptions);
            } finally {
                peer.suppressInitialOptionUpdates = Math.max(0, (peer.suppressInitialOptionUpdates ?? 1) - 1);
            }

            const resumeMeta = extractPlurnkMeta(ctx.params._meta);
            const useWindow =
                !shouldReplay ||
                resumeMeta.window === true ||
                resumeMeta.historyLoops !== undefined ||
                resumeMeta.historyPageChars !== undefined;
            const effectiveHistoryLoops = resumeMeta.historyLoops ?? opts.historyLoops;
            const providerCatalog = tryListProviders(seam);
            const [entries, inbox, openMessages, loops, proposals, interactions, workspaceSessions, configOptions, availableCommands, modelInfo, spend, streams, budget] = await Promise.all([
                readAllLogEntries(seam, {
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                    ...(useWindow ? { lastLoops: effectiveHistoryLoops + 1 } : {}),
                }),
                seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readOpenMessages({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.listSessionLoops({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.pendingProposals(bound.workspaceId),
                seam.pendingClientInteractions(bound.workspaceId),
                seam.listSessions(bound.workspaceId),
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                buildAvailableCommands(seam, bound.workspaceId, {
                    includeSkills: peer.supportsSkillCommands === true,
                }),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionAccounting({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readStreams({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionGauge({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);

            if (optionsApplied) {
                if (optionSync.configGeneration(bound.workspaceId) > prevConfigGen) {
                    await optionSync.flush(bound.workspaceId);
                } else {
                    const hasWorkspaceScoped =
                        ctx.params.configOptions?.some((entry) => isWorkspaceScopedConfigId(entry.configId)) === true;
                    await broadcastConfigOptionsUpdate(
                        seam,
                        peers,
                        notifyPeerSession,
                        bound.workspaceId,
                        hasWorkspaceScoped ? null : bound.sessionId,
                        {
                            excludePeer: peer,
                            prebuilt: {
                                sessionId: bound.sessionId,
                                configOptions,
                                modelInfo,
                            },
                        },
                    );
                }
                if (
                    ctx.params.configOptions?.some((entry) => isCommandAffectingConfigId(entry.configId)) === true
                ) {
                    if (optionSync.commandsGeneration(bound.workspaceId) > prevCommandsGen) {
                        await optionSync.flush(bound.workspaceId);
                    } else {
                        await notifyWorkspaceCommandsChanged(bound.workspaceId, peer);
                    }
                }
            }

            const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                ...(useWindow
                    ? {
                          historyLoops: effectiveHistoryLoops,
                          historyPageChars: resumeMeta.historyPageChars ?? opts.historyPageChars,
                      }
                    : {}),
                openStreamTargets: new Set(streams.map((s) => s.target)),
            });

            const heldUpdates = bound.heldUpdates;
            bound.heldUpdates = undefined;
            heldBound = undefined;

            if (shouldReplay) {
                for (const { update } of replayed) {
                    notifyPeerSession(peer, bound.acpSessionId, update);
                }
                notifyPeerSession(peer, bound.acpSessionId, { sessionUpdate: "replay_complete" });
                if (heldUpdates !== undefined) {
                    for (const heldUpdate of heldUpdates) {
                        notifyPeerSession(peer, bound.acpSessionId, heldUpdate);
                    }
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
                    _meta: { plurnk: { problem: providerCatalog.problem } },
                });
            }

            const activeGates = gates.activeForWorkspace(bound.workspaceId);
            const proposalMap = new Map(proposals.map((p) => [p.logEntryId, p]));
            const interactionMap = new Map(interactions.map((i) => [i.interactionId, i]));
            for (const activeGate of activeGates) {
                if (activeGate.kind === "proposal" && activeGate.proposal !== undefined) {
                    proposalMap.set(activeGate.proposal.logEntryId, activeGate.proposal);
                } else if (activeGate.kind === "interaction" && activeGate.interaction !== undefined) {
                    interactionMap.set(activeGate.interaction.interactionId, activeGate.interaction);
                }
            }
            const mergedProposals = [...proposalMap.values()];
            const mergedInteractions = [...interactionMap.values()];

            const sessionProposals = mergedProposals.filter(
                (p) =>
                    p.disposition.decision === "review" &&
                    selectBoundSessionForTarget(peer, bound.workspaceId, p.sessionId, workspaceSessions) === bound,
            );
            const sessionInteractions = mergedInteractions.filter(
                (i) => selectBoundSessionForTarget(peer, bound.workspaceId, i.sessionId, workspaceSessions) === bound,
            );

            const activeLoop = selectSessionLoop(loops);
            const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
            const hasPendingAction = sessionProposals.length > 0 || sessionInteractions.length > 0;

            const currentState: SessionUpdate = hasPendingAction
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
            const resumeOrigin = httpOrigin();

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
                            childModel: modelInfo.childModel,
                            loopId: refLoop?.id ?? null,
                            loopSeq: refLoop?.sequence ?? null,
                            packetCount: refLoop?.packetCount ?? null,
                            waitUntil: activeLoop?.waitUntil ?? null,
                            claimedAt: toEpochMs(refLoop?.claimedAt),
                            terminatedAt: toEpochMs(refLoop?.terminatedAt),
                            descendants: buildSessionDescendants(workspaceSessions, proposals, interactions, bound.sessionId),
                            inbox: projectInboxItems(inbox, bound.acpSessionId, resumeOrigin, bound.workspaceId, bound.sessionId),
                            openMessages: projectInboxItems(openMessages, bound.acpSessionId, resumeOrigin, bound.workspaceId, bound.sessionId),
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
            if (heldBound !== undefined) {
                heldBound.heldUpdates = undefined;
            }
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.list, async (ctx): Promise<ListSessionsResponse> => {
        peer.client = ctx.client;
        try {
            const origin = httpOrigin();
            const query = parseOverviewRequest(ctx.params.cwd, ctx.params._meta, ctx.params.archived);
            return await listSessionsOverview(seam, opts, origin, query);
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
            await cancelSubtreeWork(seam, gates, target.workspaceId, subtreeIds, "Archived by ACP client");
            removeBoundSubtree(gates, target.workspaceId, subtreeIds, peers);
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
            await cancelSubtreeWork(seam, gates, target.workspaceId, subtreeIds, "Deleted by ACP client");
            const deleted = await seam.deleteSession({
                workspaceId: target.workspaceId,
                sessionId: target.session.id,
            });
            for (const id of deleted.sessionIds) {
                subtreeIds.add(id);
            }
            removeBoundSubtree(gates, target.workspaceId, subtreeIds, peers);
            return {};
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
            const forkedBound = await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                newSessionId,
                ctx.params.cwd,
                false,
                undefined,
                opts.historyPageChars,
            );
            peer.suppressInitialOptionUpdates = (peer.suppressInitialOptionUpdates ?? 0) + 1;
            try {
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
                await applyInitialConfigOptions(seam, forkedBound, ctx.params.configOptions);
            } finally {
                peer.suppressInitialOptionUpdates = Math.max(0, (peer.suppressInitialOptionUpdates ?? 1) - 1);
            }
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
            removeBoundSubtree(gates, bound.workspaceId, new Set([bound.sessionId]), [peer]);
        } else {
            peer.sessions.delete(ctx.params.sessionId);
        }
        return {};
    });
};
