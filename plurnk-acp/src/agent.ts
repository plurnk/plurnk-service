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
    isRecord,
    lifecycleOfLoopStatus,
    selectSessionLoop,
    type MessageResource,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { executeSlashCommand, handlePlurnkAction } from "./actions.ts";
import type { ResolvedModuleOptions } from "./config.ts";
import type { GateTracker } from "./gates.ts";
import SessionTranslator from "./SessionTranslator.ts";
import {
    applyAcpMcpServers,
    applyAdditionalDirectories,
    applyConfigOption,
    applySystemPrompt,
    assertSinglePortSecurity,
    buildAvailableCommands,
    buildConfigOptions,
    extractPlurnkMeta,
    formatSessionId,
    listSessionsOverview,
    resolvePromptCommand,
    resolveSessionBinding,
    selectBoundSessionForTarget,
    toRequestError,
    tryListProviders,
    type AcpPeer,
    type BoundSession,
    type ResolvedPromptCommand,
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
                        embeddedContext: {},
                    },
                    mcp: {
                        acp: {},
                    },
                    delete: {},
                    fork: {},
                    additionalDirectories: {},
                    systemPrompt: {},
                },
                providers: {},
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
            const providerCatalog = tryListProviders(seam);
            const [configOptions, availableCommands, modelInfo, spend] = await Promise.all([
                buildConfigOptions(seam, bound.workspaceId, bound.sessionId),
                buildAvailableCommands(seam, bound.workspaceId),
                seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                seam.sessionAccounting({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
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

            const providerCatalog = tryListProviders(seam);
            const [entries, inbox, loops, proposals, interactions, workspaceSessions, configOptions, availableCommands, modelInfo, spend, streams, budget] = await Promise.all([
                seam.readLog({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
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

            const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                historyLoops: opts.historyLoops,
            });

            if (shouldReplay) {
                for (const { update } of replayed) {
                    notifyPeerSession(peer, bound.acpSessionId, update);
                }
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

            const currentState: SessionUpdate = hasPendingAction
                ? { sessionUpdate: "state_update", state: "requires_action" }
                : lifecycle === "running" || lifecycle === "queued"
                    ? { sessionUpdate: "state_update", state: "running" }
                    : lifecycle === "parked" && activeLoop !== null
                        ? {
                              sessionUpdate: "notice",
                              severity: "info",
                              title: "engine:lifecycle:loop_status",
                              _meta: {
                                  plurnk: {
                                      notice: {
                                          source: "engine:lifecycle",
                                          kind: "loop_status",
                                          level: "info",
                                          status: 202,
                                          loopId: activeLoop.id,
                                          loopSeq: activeLoop.sequence,
                                          packetCount: activeLoop.packetCount,
                                          ...(activeLoop.waitUntil !== null ? { waitUntil: activeLoop.waitUntil } : {}),
                                      },
                                  },
                              },
                          }
                        : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" };

            notifyPeerSession(peer, bound.acpSessionId, currentState);

            for (const proposal of sessionProposals) {
                if (proposal.sessionId !== bound.sessionId) {
                    const childRow = workspaceSessions.find((w) => w.id === proposal.sessionId);
                    const childName = childRow?.name ?? proposal.session ?? String(proposal.sessionId);
                    notifyPeerSession(peer, bound.acpSessionId, {
                        sessionUpdate: "subagent_update",
                        sessionId: formatSessionId(bound.workspaceId, childName),
                        title: childName,
                        capabilities: { cancel: {} },
                        state: { state: "requires_action" },
                    });
                }
                const gate = gates.openOrGet(bound.workspaceId, proposal.sessionId, "proposal", proposal);
                gates.dispatchToPeer(gate, peer, bound, seam, peers, notifyPeerSession, broadcastSessionUpdate);
            }
            for (const interaction of sessionInteractions) {
                if (interaction.sessionId !== bound.sessionId) {
                    const childRow = workspaceSessions.find((w) => w.id === interaction.sessionId);
                    const childName = childRow?.name ?? String(interaction.sessionId);
                    notifyPeerSession(peer, bound.acpSessionId, {
                        sessionUpdate: "subagent_update",
                        sessionId: formatSessionId(bound.workspaceId, childName),
                        title: childName,
                        capabilities: { cancel: {} },
                        state: { state: "requires_action" },
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
                const availableCommands =
                    ctx.params.configId.startsWith("skills:") || ctx.params.configId.startsWith("mcp:")
                        ? await buildAvailableCommands(seam, bound.workspaceId)
                        : null;
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
            const plurnkMeta = extractPlurnkMeta(ctx.params._meta);
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
            const messageAddress = `acp://operator/sessions/${encodeURIComponent(bound.acpSessionId)}/messages/${encodeURIComponent(messageId)}`;
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
