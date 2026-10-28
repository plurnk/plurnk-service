// {§acp-session-owner} {§acp-proposal-resolve} {§acp-topology-scope}
// Per-connection ACP v2 AgentApp factory and JSON-RPC request/notification handlers.

import {
    PROTOCOL_VERSION,
    RequestError,
    agent,
    methods,
    type AgentApp,
    type CloseSessionResponse,
    type ContentBlock,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type NewSessionResponse,
    type PromptResponse,
    type ResumeSessionResponse,
    type SessionUpdate,
    type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    lifecycleOfLoopStatus,
    selectSessionLoop,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { executeSlashCommand, handlePlurnkAction } from "./actions.ts";
import type { ResolvedModuleOptions } from "./config.ts";
import type { GateTracker } from "./gates.ts";
import SessionTranslator from "./SessionTranslator.ts";
import {
    AVAILABLE_COMMANDS,
    applyConfigOption,
    assertSinglePortSecurity,
    buildConfigOptions,
    extractPlurnkMeta,
    formatSessionId,
    listSessionsOverview,
    resolveSessionBinding,
    toRequestError,
    tryListProviders,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

export interface ConnectionAgentContext {
    readonly seam: ApplicationPort;
    readonly opts: ResolvedModuleOptions;
    readonly peers: Set<AcpPeer>;
    readonly gates: GateTracker;
    readonly httpOrigin: () => string;
    readonly notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void;
    readonly broadcastSessionUpdate: (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ) => void;
}

export const createConnectionAgent = (
    host: ConnectionAgentContext,
    connInfo: { readonly family: string | null; readonly closeTransport?: () => void },
): AgentApp => {
    const { seam, opts, peers, gates, httpOrigin, notifyPeerSession, broadcastSessionUpdate } = host;

    const peer: AcpPeer = {
        family: connInfo.family,
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

    const app = agent({
        name: "@plurnk/plurnk-service",
    });

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
            protocolVersion: ctx.params.protocolVersion ?? PROTOCOL_VERSION,
            info: {
                name: "@plurnk/plurnk-service",
                title: "PLURNK Service",
                version: "1.0.0",
            },
            capabilities: {
                session: {
                    prompt: {
                        image: {},
                        audio: {},
                        embeddedContext: {},
                    },
                    delete: {},
                    fork: {},
                },
            },
        };
    });

    app.onRequest(methods.agent.providers.list, async (ctx): Promise<ListProvidersResponse> => {
        peer.client = ctx.client;
        const providers = seam.listProviders();
        return {
            providers: providers.aliases.map((a) => ({
                providerId: a.alias,
                supported: [a.provider],
                required: false,
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
            );
            const providerCatalog = tryListProviders(seam);
            const [configOptions, modelInfo] = await Promise.all([
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);
            for (const notice of seam.configurationNotices()) {
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
                availableCommands: [...AVAILABLE_COMMANDS],
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
            const bound = await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                ctx.params.sessionId,
                ctx.params.cwd,
                false,
                ctx.params._meta,
            );

            const providerCatalog = tryListProviders(seam);
            const [entries, inbox, loops, proposals, interactions, configOptions, modelInfo, spend, streams, budget] = await Promise.all([
                seam.readLog({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.listSessionLoops({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.pendingProposals(bound.workspaceId),
                seam.pendingClientInteractions(bound.workspaceId),
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionAccounting({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.readStreams({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionGauge({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
            ]);

            const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                historyLoops: opts.historyLoops,
            });

            for (const { update } of replayed) {
                notifyPeerSession(peer, bound.acpSessionId, update);
            }

            for (const notice of seam.configurationNotices()) {
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

            const peerBoundSessionIds = new Set(
                [...peer.sessions.values()]
                    .filter((s) => s.workspaceId === bound.workspaceId)
                    .map((s) => s.sessionId),
            );
            const sessionProposals = proposals.filter(
                (p) =>
                    p.disposition.decision === "review" &&
                    (p.sessionId === bound.sessionId || !peerBoundSessionIds.has(p.sessionId)),
            );
            const sessionInteractions = interactions.filter(
                (i) => i.sessionId === bound.sessionId || !peerBoundSessionIds.has(i.sessionId),
            );

            const activeLoop = selectSessionLoop(loops);
            const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
            const hasPendingAction = sessionProposals.length > 0 || sessionInteractions.length > 0;

            const currentState: SessionUpdate = hasPendingAction
                ? { sessionUpdate: "state_update", state: "requires_action" }
                : lifecycle === "running" || lifecycle === "queued"
                    ? { sessionUpdate: "state_update", state: "running" }
                    : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" };

            notifyPeerSession(peer, bound.acpSessionId, currentState);

            for (const proposal of sessionProposals) {
                const gate = gates.openOrGet(bound.workspaceId, proposal.sessionId, "proposal", proposal);
                gates.dispatchToPeer(gate, peer, bound, seam, peers, notifyPeerSession, broadcastSessionUpdate);
            }
            for (const interaction of sessionInteractions) {
                const gate = gates.openOrGet(bound.workspaceId, interaction.sessionId, "interaction", undefined, interaction);
                gates.dispatchToPeer(gate, peer, bound, seam, peers, notifyPeerSession, broadcastSessionUpdate);
            }

            const refLoop = activeLoop ?? loops.at(-1) ?? null;

            return {
                configOptions,
                availableCommands: [...AVAILABLE_COMMANDS],
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
                            loopSeq: refLoop?.sequence ?? null,
                            waitUntil: activeLoop?.waitUntil ?? null,
                            claimedAt: refLoop?.claimedAt ?? null,
                            terminatedAt: refLoop?.terminatedAt ?? null,
                            inbox,
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

    app.onRequest(methods.agent.session.list, async (ctx): Promise<ListSessionsResponse> => {
        peer.client = ctx.client;
        try {
            const sessions = await listSessionsOverview(
                seam,
                opts,
                httpOrigin(),
                ctx.params.cwd,
            );
            return { sessions };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.delete, async (ctx) => {
        peer.client = ctx.client;
        try {
            const bound = peer.sessions.get(ctx.params.sessionId)
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    undefined,
                    false,
                ));
            await seam.setSessionHidden({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                hidden: true,
            });
            peer.sessions.delete(ctx.params.sessionId);
            return {};
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.fork, async (ctx): Promise<ForkSessionResponse> => {
        peer.client = ctx.client;
        try {
            assertSinglePortSecurity(ctx.params);
            const parent = peer.sessions.get(ctx.params.sessionId)
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    ctx.params.cwd,
                    false,
                ));
            const forked = await seam.forkSession({
                workspaceId: parent.workspaceId,
                sessionId: parent.sessionId,
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
            );
            const configOptions = await buildConfigOptions(seam, parent.workspaceId, forked.sessionId);
            return {
                sessionId: newSessionId,
                configOptions,
            };
        } catch (err) {
            throw toRequestError(err);
        }
    });

    app.onRequest(methods.agent.session.close, async (ctx): Promise<CloseSessionResponse> => {
        peer.client = ctx.client;
        peer.sessions.delete(ctx.params.sessionId);
        return {};
    });

    app.onRequest(
        methods.agent.session.setConfigOption,
        async (ctx): Promise<SetSessionConfigOptionResponse> => {
            peer.client = ctx.client;
            try {
                const bound = peer.sessions.get(ctx.params.sessionId)
                    ?? (await resolveSessionBinding(
                        seam,
                        httpOrigin(),
                        peer,
                        ctx.params.sessionId,
                        undefined,
                        false,
                    ));
                const configOptions = await applyConfigOption(
                    seam,
                    bound,
                    ctx.params.configId,
                    ctx.params.value,
                );
                const modelInfo = await seam.readSessionModel({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                });
                const statusMeta = {
                    plurnk: {
                        status: {
                            model: modelInfo.model,
                            spawnModel: modelInfo.spawnModel,
                        },
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
            const bound = peer.sessions.get(ctx.params.sessionId)
                ?? (await resolveSessionBinding(
                    seam,
                    httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    undefined,
                    true,
                    ctx.params._meta,
                ));
            const text = ctx.params.prompt
                .map((block: ContentBlock): string => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
                .filter((part: string) => part.length > 0)
                .join("\n");
            if (text.trim().length === 0) {
                throw new RequestError(
                    -32602,
                    "Prompt must contain non-empty text. (user-message-text-required)",
                    Problems.create("acp", "user-message-text-required", 400, "Prompt must contain non-empty text."),
                );
            }
            const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
            const messageId = plurnkMeta.messageId ?? crypto.randomUUID();
            const messageAddress = `acp://operator/sessions/${encodeURIComponent(bound.acpSessionId)}/messages/${encodeURIComponent(messageId)}`;

            await seam.messageAdmission({
                workspaceId: bound.workspaceId,
                address: messageAddress,
                body: text,
            });

            const trimmed = text.trim();
            if (trimmed.startsWith("/")) {
                const spaceIdx = trimmed.indexOf(" ");
                const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
                const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
                if (AVAILABLE_COMMANDS.some((c) => c.name === cmd)) {
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
                        cmd,
                        rest,
                        peer,
                        notifyPeerSession,
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
            }

            notifyPeerSession(peer, bound.acpSessionId, {
                sessionUpdate: "notice",
                severity: "info",
                title: "workspace:state",
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
                    },
                },
            ]);

            const maxTurns = plurnkMeta.maxTurns ?? opts.maxTurns;
            const ack = await seam.runLoop({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                prompt: text,
                source: messageAddress,
                messageAddress,
                ...(maxTurns !== undefined ? { maxTurns } : {}),
                ...(plurnkMeta.openPaths !== undefined ? { openPaths: plurnkMeta.openPaths } : {}),
                ...(plurnkMeta.envelope !== undefined ? { envelope: plurnkMeta.envelope } : {}),
            });

            if (ack.problem !== undefined) {
                throw new RequestError(-32000, ack.problem.detail, ack.problem);
            }

            return {
                messageId,
                _meta: {
                    plurnk: {
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
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
        const bound = peer.sessions.get(ctx.params.sessionId)
            ?? (await resolveSessionBinding(
                seam,
                httpOrigin(),
                peer,
                ctx.params.sessionId,
                undefined,
                false,
            ).catch(() => undefined));
        if (bound === undefined) return;
        await seam.cancelSession({
            workspaceId: bound.workspaceId,
            sessionId: bound.sessionId,
            reason: "Cancelled by ACP client",
        });
    });

    return app;
};
