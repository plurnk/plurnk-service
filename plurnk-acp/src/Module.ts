// {§acp-session-owner} {§acp-body-reference} {§acp-proposal-resolve} {§acp-topology-scope}
// Pure ACP v2 server module on `/acp`.
// Exposes Streamable HTTP (`http://<host>:<port>/acp`) and WebSocket (`ws://<host>:<port>/acp`)
// backed by `@agentclientprotocol/sdk`, translating between standard ACP v2 methods/notifications
// and daemon operations with symmetric multi-client broadcast and first-responder-wins
// permission/elicitation cancellation.

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
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
    isRecord,
    isSafeInteger,
    lifecycleOfLoopStatus,
    selectSessionLoop,
    type ApplicationLoopPacket,
    type ClientInteractionProjection,
    type Notice,
    type OutsideEventNotification,
    type ProblemDetails,
    type ProposalProjection,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { executeSlashCommand, handlePlurnkAction } from "./actions.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { GateTracker, type ActiveGate } from "./gates.ts";
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
import {
    HEADER_CONNECTION_ID,
    admitRequest,
    applyCorsHeaders,
    credentialRevokedProblem,
    handleEntryRoute,
    handleMessagesRoute,
    httpProblem,
    serviceStoppingProblem,
    writeHttpProblem,
    writeSocketProblem,
} from "./transport.ts";

export type { ModuleOptions } from "./config.ts";

export type AcpSetupSeam = SchemeRegistrationSeam & Pick<ApplicationPort, "httpAddress">;

interface RequestConnectionContext {
    readonly family: string | null;
}

const isLogEntryPayload = (v: unknown): v is Parameters<SessionTranslator["logEntry"]>[0] => isRecord(v);
const isReasoningEvent = (v: unknown): v is ReasoningEventNotification =>
    isRecord(v) && typeof v.sessionId === "number";
const isOutsideEvent = (v: unknown): v is OutsideEventNotification =>
    isRecord(v) && typeof v.sessionId === "number";
const isLoopPacket = (v: unknown): v is ApplicationLoopPacket =>
    isRecord(v) && typeof v.sessionId === "number";
const isTerminatedEvent = (v: unknown): v is TerminatedNotification =>
    isRecord(v) && typeof v.sessionId === "number" && isRecord(v.result);
const isProposalProjection = (v: unknown): v is ProposalProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isClientInteractionProjection = (v: unknown): v is ClientInteractionProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isNoticePayload = (v: unknown): v is { readonly notice: Notice } =>
    isRecord(v) && isRecord(v.notice);

export default class Module implements DaemonModule<AcpSetupSeam> {
    readonly mounts: readonly string[] = Object.freeze(["/acp"]);
    #seam!: ApplicationPort;
    readonly #opts: ResolvedModuleOptions;
    #wss!: WebSocketServer;
    #acpServer!: AcpServer;
    #nodeHttpHandler!: (req: IncomingMessage, res: ServerResponse) => void;
    readonly #requestContext = new AsyncLocalStorage<RequestConnectionContext>();
    #offEvents: (() => void) | null = null;
    #offRevoked: (() => void) | null = null;
    readonly #peers = new Set<AcpPeer>();
    readonly #gates = new GateTracker();
    readonly #streamOffsets = new Map<string, number>();
    readonly #work = new Set<Promise<unknown>>();
    #activated = false;
    #stopped = false;

    private constructor(opts: ModuleOptions) {
        this.#opts = resolveModuleOptions(opts);
    }

    static create(opts: ModuleOptions = {}): Module {
        return new Module(opts);
    }

    async setup(seam: AcpSetupSeam): Promise<void> {
        await seam.registerScheme?.("acp", new MessageScheme("acp"));
    }

    async start(seam: ApplicationPort): Promise<void> {
        if (this.#stopped) throw new Error("plurnk-acp: stopped module cannot be activated");
        if (this.#activated) throw new Error("plurnk-acp: module already activated");
        seam.registerHttpRoute("/acp", (req, res) => this.#route(req, res));
        seam.registerHttpUpgrade("/acp", (req, socket, head) =>
            this.#track(this.#handleUpgrade(req, socket, head)),
        );
        this.#seam = seam;
        this.#wss = new WebSocketServer({ noServer: true });
        this.#acpServer = new AcpServer({
            createAgent: () => {
                const ctx = this.#requestContext.getStore();
                return this.#createConnectionAgent({ family: ctx?.family ?? null });
            },
        });
        this.#nodeHttpHandler = createNodeHttpHandler(this.#acpServer);
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== null) {
                this.#onDaemonEvent(workspaceId, method, params);
            }
        });
        this.#offRevoked = seam.credentials.onRevoked((family) => {
            const problem = credentialRevokedProblem();
            for (const peer of [...this.#peers]) {
                if (peer.family === family) {
                    void peer.closeWithProblem(problem);
                    this.#peers.delete(peer);
                }
            }
        });
        this.#activated = true;
    }

    stop(): void {
        this.#stopped = true;
    }

    async close(): Promise<void> {
        this.stop();
        if (!this.#activated) return;
        this.#activated = false;
        this.#offEvents?.();
        this.#offRevoked?.();
        this.#gates.clear();
        this.#streamOffsets.clear();
        const stopping = serviceStoppingProblem();
        const closingPeers = [...this.#peers];
        this.#peers.clear();
        await Promise.allSettled(closingPeers.map((peer) => peer.closeWithProblem(stopping)));
        await this.#acpServer.close();
        await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
        // {§module-contract} Join admitted route work before returning from close().
        while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    }

    #track<T>(work: Promise<T>): Promise<T> {
        this.#work.add(work);
        const settled = (): void => {
            this.#work.delete(work);
        };
        void work.then(settled, settled);
        return work;
    }

    #httpOrigin(): string {
        const addr = this.#seam.httpAddress();
        if (typeof addr.host === "string" && typeof addr.port === "number") {
            return `http://${addr.host}:${addr.port}`;
        }
        return "";
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        applyCorsHeaders(res, this.#opts.allowOrigin);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        const admission = admitRequest(this.#seam.credentials, req);
        if (!admission.ok) {
            res.setHeader("www-authenticate", admission.challenge);
            writeHttpProblem(res, admission.problem);
            return;
        }

        const url = new URL(req.url ?? "/acp", "http://listener");
        const entryMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/entry$/.exec(url.pathname);
        if (entryMatch !== null && req.method === "GET") {
            await handleEntryRoute(this.#seam, res, Number(entryMatch[1]), Number(entryMatch[2]), url);
            return;
        }

        const messagesMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/messages$/.exec(url.pathname);
        if (messagesMatch !== null && req.method === "GET") {
            await handleMessagesRoute(
                this.#seam,
                this.#opts,
                this.#httpOrigin(),
                res,
                Number(messagesMatch[1]),
                Number(messagesMatch[2]),
                url,
            );
            return;
        }

        if (
            url.pathname === "/acp" &&
            (req.method === "POST" ||
                req.method === "DELETE" ||
                (req.method === "GET" &&
                    (req.headers["acp-connection-id"] !== undefined ||
                        req.headers.accept?.toLowerCase().includes("text/event-stream") === true)))
        ) {
            this.#requestContext.run({ family: admission.family }, () => {
                this.#nodeHttpHandler(req, res);
            });
            return;
        }

        writeHttpProblem(
            res,
            httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                method: req.method ?? null,
                path: req.url ?? null,
                stage: "routing",
                retryable: false,
            }),
        );
    }

    async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        if (this.#stopped) {
            writeSocketProblem(socket, serviceStoppingProblem());
            return;
        }
        const url = new URL(req.url ?? "/acp", "http://listener");
        if (url.pathname !== "/acp") {
            writeSocketProblem(
                socket,
                httpProblem("route-not-found", 404, "The requested ACP route does not exist.", {
                    stage: "routing",
                    retryable: false,
                }),
            );
            return;
        }
        const admission = admitRequest(this.#seam.credentials, req, true);
        if (!admission.ok) {
            writeSocketProblem(socket, admission.problem, { "WWW-Authenticate": admission.challenge });
            return;
        }
        let closeWs: (() => void) | undefined;
        const app = this.#createConnectionAgent({
            family: admission.family,
            closeTransport: () => closeWs?.(),
        });
        const upgrade = this.#acpServer.prepareWebSocketUpgrade({ agent: app });
        let hasAccepted = false;
        const onHeaders = (headers: string[], request: IncomingMessage): void => {
            if (request !== req) return;
            headers.push(`${HEADER_CONNECTION_ID}: ${upgrade.connectionId}`);
        };
        const cleanup = (): void => {
            this.#wss.off("headers", onHeaders);
            socket.off("close", onUpgradeFailed);
            socket.off("error", onUpgradeFailed);
        };
        const onUpgradeFailed = (): void => {
            if (hasAccepted) return;
            cleanup();
            upgrade.reject();
        };
        try {
            this.#wss.on("headers", onHeaders);
            socket.once("close", onUpgradeFailed);
            socket.once("error", onUpgradeFailed);
            this.#wss.handleUpgrade(req, socket, head, (ws) => {
                hasAccepted = true;
                cleanup();
                closeWs = () => {
                    try {
                        ws.close(1008, "Connection closed");
                    } catch {
                        ws.terminate();
                    }
                };
                upgrade.accept(ws);
            });
        } catch {
            cleanup();
            upgrade.reject();
            writeSocketProblem(
                socket,
                httpProblem("request-failed", 500, "Failed to upgrade ACP WebSocket connection.", {
                    stage: "upgrade",
                    retryable: false,
                }),
            );
        }
    }

    #notifyPeerSession = (peer: AcpPeer, sessionId: string, update: SessionUpdate): void => {
        if (peer.client === null) return;
        void peer.client
            .notify(methods.client.session.update, {
                sessionId,
                update,
            })
            .catch(() => undefined);
    };

    #broadcastSessionUpdate = (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ): void => {
        for (const peer of this.#peers) {
            const visited = new Set<BoundSession>();
            for (const session of peer.sessions.values()) {
                if (visited.has(session)) continue;
                visited.add(session);
                if (session.workspaceId !== workspaceId || session.sessionId !== sessionId) continue;
                for (const { sessionId: acpSessionId, update } of buildUpdates(session)) {
                    this.#notifyPeerSession(peer, acpSessionId, update);
                }
            }
        }
    };

    #dispatchGateToPeer(gate: ActiveGate, peer: AcpPeer, session: BoundSession): void {
        this.#gates.dispatchToPeer(
            gate,
            peer,
            session,
            this.#seam,
            this.#peers,
            this.#notifyPeerSession,
            this.#broadcastSessionUpdate,
        );
    }

    #onDaemonEvent(workspaceId: number, method: string, params: unknown): void {
        switch (method) {
            case "log/entry": {
                if (!isRecord(params) || !isRecord(params.entry)) break;
                const entryRec = params.entry;
                const entryId = typeof entryRec.id === "number" ? entryRec.id : null;
                const sessionId = typeof entryRec.session_id === "number" ? entryRec.session_id : null;
                if (entryId === null || sessionId === null) break;
                if (typeof entryRec.state === "string") {
                    this.#gates.cancelProposalIfSettled(workspaceId, entryId, entryRec.state);
                }
                if (isLogEntryPayload(params)) {
                    this.#broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.logEntry(params));
                }
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId || session.sessionId === sessionId) continue;
                        const summary = isRecord(entryRec.attrs) && typeof entryRec.attrs.body === "string"
                            ? entryRec.attrs.body
                            : typeof entryRec.op === "string"
                              ? entryRec.op
                              : "op";
                        const sessionName = typeof entryRec.session_name === "string" ? entryRec.session_name : String(sessionId);
                        const childSessionId = formatSessionId(workspaceId, sessionName);
                        const loopSeq = isSafeInteger(entryRec.loop_seq) ? entryRec.loop_seq : 1;
                        const coord =
                            isSafeInteger(entryRec.loop_seq) &&
                            isSafeInteger(entryRec.turn_seq) &&
                            isSafeInteger(entryRec.sequence)
                                ? `${entryRec.loop_seq}/${entryRec.turn_seq}/${entryRec.sequence}`
                                : `${loopSeq}/1/1`;
                        const childMeta = {
                            plurnk: {
                                id: sessionId,
                                name: sessionName,
                                coordinate: `session://${sessionName}#${coord}`,
                                subagentRunId: `ops://${sessionName}/${loopSeq}`,
                            },
                        };
                        this.#notifyPeerSession(peer, session.acpSessionId, {
                            sessionUpdate: "subagent_update",
                            sessionId: childSessionId,
                            title: sessionName,
                            description: summary,
                            capabilities: { cancel: {} },
                            state: { state: "running" },
                            _meta: childMeta,
                        });
                        if (entryRec.op === "SEND" && summary.length > 0) {
                            const isChildToParent = entryRec.origin === "model";
                            this.#notifyPeerSession(peer, session.acpSessionId, {
                                sessionUpdate: "session_message",
                                messageId: `session://${sessionName}#${coord}`,
                                senderSessionId: isChildToParent ? childSessionId : session.acpSessionId,
                                recipientSessionId: isChildToParent ? session.acpSessionId : childSessionId,
                                content: [{ type: "text", text: summary }],
                                _meta: childMeta,
                            });
                        }
                    }
                }
                break;
            }
            case "reasoning/event": {
                if (!isReasoningEvent(params)) break;
                this.#broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.reasoning(params));
                break;
            }
            case "stream/event": {
                if (!isRecord(params)) break;
                const entryId = typeof params.entryId === "number" ? params.entryId : null;
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const target = typeof params.target === "string" ? params.target : null;
                const channel = typeof params.channel === "string" ? params.channel : null;
                if (entryId === null || sessionId === null) break;
                const streamMeta: Record<string, unknown> = {
                    sessionId,
                    ...(target !== null ? { target } : {}),
                    ...(channel !== null ? { channel } : {}),
                    ...(typeof params.state === "string" ? { state: params.state } : {}),
                    ...(typeof params.contentLength === "number" ? { contentLength: params.contentLength } : {}),
                };
                this.#broadcastSessionUpdate(workspaceId, sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "terminal_update",
                            terminalId: `term:${entryId}`,
                            _meta: { plurnk: streamMeta },
                        },
                    },
                ]);
                if (target === null || channel === null) break;
                const contentLength = typeof params.contentLength === "number" ? params.contentLength : 0;
                const offsetKey = `${workspaceId}:${entryId}:${channel}`;
                const prevOffset = this.#streamOffsets.get(offsetKey) ?? 0;
                if (contentLength > prevOffset) {
                    this.#streamOffsets.set(offsetKey, contentLength);
                    void this.#seam
                        .readEntry({ workspaceId, sessionId, target, channel, offset: prevOffset })
                        .then((readResult) => {
                            const chunk = readResult.entry !== null
                                ? (readResult.entry.channels[channel]?.content ?? "")
                                : "";
                            if (chunk.length > 0) {
                                this.#broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                                    s.translator.terminalChunk(entryId, chunk, { sessionId, target, channel }),
                                );
                            }
                        })
                        .catch(() => undefined);
                }
                break;
            }
            case "stream/concluded": {
                if (!isRecord(params)) break;
                const entryId = typeof params.entryId === "number" ? params.entryId : null;
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const target = typeof params.target === "string" ? params.target : null;
                const status = isRecord(params.result) && typeof params.result.status === "number"
                    ? params.result.status
                    : 200;
                if (entryId === null || sessionId === null) break;
                const concludedMeta: Record<string, unknown> = {
                    sessionId,
                    ...(target !== null ? { target } : {}),
                    ...(isRecord(params.result) ? { result: params.result } : {}),
                    ...(isRecord(params.summary) ? { summary: params.summary } : {}),
                };
                this.#broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                    s.translator.terminalConcluded(entryId, status, concludedMeta),
                );
                break;
            }
            case "outside/event": {
                if (!isOutsideEvent(params)) break;
                this.#broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.outside(params));
                break;
            }
            case "loop/packet": {
                if (!isLoopPacket(params)) break;
                this.#broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.packet(params));
                break;
            }
            case "loop/terminated": {
                if (!isTerminatedEvent(params)) break;
                const sessionId = params.sessionId;
                this.#broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.terminated(params));
                const status = params.result.status;
                const childState = params.hitMaxTurns || status === 429
                    ? ({ state: "idle" as const, stopReason: "max_turn_requests" as const })
                    : status === 499
                      ? ({ state: "idle" as const, stopReason: "cancelled" as const })
                      : status >= 400
                        ? ({ state: "idle" as const, stopReason: "refusal" as const })
                        : ({ state: "idle" as const, stopReason: "end_turn" as const });
                void this.#seam
                    .listSessions(workspaceId)
                    .then((sessions) => {
                        const sessionRow = sessions.find((w) => w.id === sessionId);
                        const sessionName = sessionRow?.name ?? String(sessionId);
                        for (const peer of this.#peers) {
                            const visited = new Set<BoundSession>();
                            for (const session of peer.sessions.values()) {
                                if (visited.has(session)) continue;
                                visited.add(session);
                                if (session.workspaceId !== workspaceId || session.sessionId === sessionId) continue;
                                this.#notifyPeerSession(peer, session.acpSessionId, {
                                    sessionUpdate: "subagent_update",
                                    sessionId: formatSessionId(workspaceId, sessionName),
                                    state: childState,
                                });
                            }
                        }
                    })
                    .catch(() => undefined);
                break;
            }
            case "loop/proposal": {
                if (!isProposalProjection(params)) break;
                const proposal = params;
                if (proposal.disposition.decision !== "review") break;
                const gate = this.#gates.openOrGet(workspaceId, proposal.sessionId, "proposal", proposal);
                this.#broadcastSessionUpdate(workspaceId, proposal.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "requires_action",
                        },
                    },
                ]);
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    let targetSession: BoundSession | undefined;
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId) continue;
                        if (session.sessionId === proposal.sessionId) {
                            targetSession = session;
                            break;
                        }
                        if (targetSession === undefined) {
                            targetSession = session;
                        }
                    }
                    if (targetSession !== undefined) {
                        this.#dispatchGateToPeer(gate, peer, targetSession);
                    }
                }
                break;
            }
            case "loop/interaction": {
                if (!isClientInteractionProjection(params)) break;
                const interaction = params;
                const gate = this.#gates.openOrGet(workspaceId, interaction.sessionId, "interaction", undefined, interaction);
                this.#broadcastSessionUpdate(workspaceId, interaction.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "requires_action",
                        },
                    },
                ]);
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    let targetSession: BoundSession | undefined;
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId) continue;
                        if (session.sessionId === interaction.sessionId) {
                            targetSession = session;
                            break;
                        }
                        if (targetSession === undefined) {
                            targetSession = session;
                        }
                    }
                    if (targetSession !== undefined) {
                        this.#dispatchGateToPeer(gate, peer, targetSession);
                    }
                }
                break;
            }
            case "notice/event": {
                if (!isNoticePayload(params)) break;
                const notice = params.notice;
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId) continue;
                        for (const { sessionId, update } of session.translator.notice(notice)) {
                            this.#notifyPeerSession(peer, sessionId, update);
                        }
                    }
                }
                break;
            }
            case "workspace/preparation": {
                const preparation =
                    isRecord(params) && Array.isArray(params.preparation)
                        ? params.preparation
                        : this.#seam.workspacePreparationStatus(workspaceId);
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId) continue;
                        this.#notifyPeerSession(peer, session.acpSessionId, {
                            sessionUpdate: "notice",
                            severity: "info",
                            title: "workspace:preparation",
                            description: JSON.stringify(preparation),
                            _meta: {
                                plurnk: {
                                    workspaceId,
                                    preparation,
                                },
                            },
                        });
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    #createConnectionAgent(connInfo: { readonly family: string | null; readonly closeTransport?: () => void }): AgentApp {
        const peer: AcpPeer = {
            family: connInfo.family,
            sessions: new Map(),
            client: null,
            closeTransport: connInfo.closeTransport,
            closeWithProblem: async (problem: ProblemDetails) => {
                if (peer.client !== null) {
                    for (const session of new Set(peer.sessions.values())) {
                        this.#notifyPeerSession(peer, session.acpSessionId, {
                            sessionUpdate: "notice",
                            severity: "error",
                            title: problem.title,
                            description: problem.detail,
                        });
                    }
                }
                peer.closeTransport?.();
            },
        };

        const app = agent({
            name: "@plurnk/plurnk-service",
        });

        app.onConnect((conn) => {
            peer.client = conn.client;
            this.#peers.add(peer);
            void conn.closed.finally(() => {
                this.#peers.delete(peer);
                this.#gates.removePeer(peer);
            });
        });

        app.onRequest(methods.agent.initialize, async (ctx): Promise<InitializeResponse> => {
            peer.client = ctx.client;
            this.#peers.add(peer);
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
            const providers = this.#seam.listProviders();
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
                        this.#seam,
                        this.#httpOrigin(),
                        ctx.params,
                        peer,
                        this.#notifyPeerSession,
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
                    this.#seam,
                    this.#httpOrigin(),
                    peer,
                    undefined,
                    ctx.params.cwd,
                    true,
                    ctx.params._meta,
                );
                const providerCatalog = tryListProviders(this.#seam);
                const [configOptions, modelInfo] = await Promise.all([
                    buildConfigOptions(this.#seam, bound.workspaceId, bound.sessionId),
                    this.#seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                ]);
                for (const notice of this.#seam.configurationNotices()) {
                    for (const { update } of bound.translator.notice(notice)) {
                        this.#notifyPeerSession(peer, bound.acpSessionId, update);
                    }
                }
                if (providerCatalog.problem !== null) {
                    this.#notifyPeerSession(peer, bound.acpSessionId, {
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
                                preparation: this.#seam.workspacePreparationStatus(bound.workspaceId),
                                activity: this.#seam.workspaceDerivationStatus(bound.workspaceId),
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
                    this.#seam,
                    this.#httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    ctx.params.cwd,
                    false,
                    ctx.params._meta,
                );

                const providerCatalog = tryListProviders(this.#seam);
                const [entries, inbox, loops, proposals, interactions, configOptions, modelInfo] = await Promise.all([
                    this.#seam.readLog({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                    this.#seam.readInbox({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                    this.#seam.listSessionLoops({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                    this.#seam.pendingProposals(bound.workspaceId),
                    this.#seam.pendingClientInteractions(bound.workspaceId),
                    buildConfigOptions(this.#seam, bound.workspaceId, bound.sessionId),
                    this.#seam.readSessionModel({ workspaceId: bound.workspaceId, sessionId: bound.sessionId }),
                ]);

                const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                    historyLoops: this.#opts.historyLoops,
                });

                for (const { update } of replayed) {
                    this.#notifyPeerSession(peer, bound.acpSessionId, update);
                }

                for (const notice of this.#seam.configurationNotices()) {
                    for (const { update } of bound.translator.notice(notice)) {
                        this.#notifyPeerSession(peer, bound.acpSessionId, update);
                    }
                }
                if (providerCatalog.problem !== null) {
                    this.#notifyPeerSession(peer, bound.acpSessionId, {
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
                    (p) => p.sessionId === bound.sessionId && p.disposition.decision === "review",
                );
                const sessionInteractions = interactions.filter((i) => i.sessionId === bound.sessionId);

                const activeLoop = selectSessionLoop(loops);
                const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
                const hasPendingAction = sessionProposals.length > 0 || sessionInteractions.length > 0;

                const currentState: SessionUpdate = hasPendingAction
                    ? { sessionUpdate: "state_update", state: "requires_action" }
                    : lifecycle === "running" || lifecycle === "queued"
                        ? { sessionUpdate: "state_update", state: "running" }
                        : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" };

                this.#notifyPeerSession(peer, bound.acpSessionId, currentState);

                for (const proposal of sessionProposals) {
                    const gate = this.#gates.openOrGet(bound.workspaceId, proposal.sessionId, "proposal", proposal);
                    this.#dispatchGateToPeer(gate, peer, bound);
                }
                for (const interaction of sessionInteractions) {
                    const gate = this.#gates.openOrGet(bound.workspaceId, interaction.sessionId, "interaction", undefined, interaction);
                    this.#dispatchGateToPeer(gate, peer, bound);
                }

                return {
                    configOptions,
                    availableCommands: [...AVAILABLE_COMMANDS],
                    _meta: {
                        plurnk: {
                            sessionId: bound.sessionId,
                            workspace: {
                                id: bound.workspaceId,
                                name: bound.workspaceName,
                                preparation: this.#seam.workspacePreparationStatus(bound.workspaceId),
                                activity: this.#seam.workspaceDerivationStatus(bound.workspaceId),
                            },
                            session: { id: bound.sessionId, name: bound.sessionName },
                            status: {
                                model: modelInfo.model,
                                spawnModel: modelInfo.spawnModel,
                            },
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
                    this.#seam,
                    this.#opts,
                    this.#httpOrigin(),
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
                        this.#seam,
                        this.#httpOrigin(),
                        peer,
                        ctx.params.sessionId,
                        undefined,
                        false,
                    ));
                await this.#seam.setSessionHidden({
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
                        this.#seam,
                        this.#httpOrigin(),
                        peer,
                        ctx.params.sessionId,
                        ctx.params.cwd,
                        false,
                    ));
                const forked = await this.#seam.forkSession({
                    workspaceId: parent.workspaceId,
                    sessionId: parent.sessionId,
                });
                const forkedSession = await this.#seam.readSession({
                    workspaceId: parent.workspaceId,
                    identity: { id: forked.sessionId },
                });
                const sessionName = forked.sessionName ?? forkedSession?.name ?? String(forked.sessionId);
                const newSessionId = formatSessionId(parent.workspaceId, sessionName);
                await resolveSessionBinding(
                    this.#seam,
                    this.#httpOrigin(),
                    peer,
                    newSessionId,
                    ctx.params.cwd,
                    false,
                );
                const configOptions = await buildConfigOptions(this.#seam, parent.workspaceId, forked.sessionId);
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
                            this.#seam,
                            this.#httpOrigin(),
                            peer,
                            ctx.params.sessionId,
                            undefined,
                            false,
                        ));
                    const configOptions = await applyConfigOption(
                        this.#seam,
                        bound,
                        ctx.params.configId,
                        ctx.params.value,
                    );
                    this.#broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                        {
                            sessionId: s.acpSessionId,
                            update: {
                                sessionUpdate: "config_option_update",
                                configOptions,
                            },
                        },
                    ]);
                    return { configOptions };
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
                        this.#seam,
                        this.#httpOrigin(),
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
                const messageAddress = `acp:///sessions/${encodeURIComponent(bound.acpSessionId)}/messages/${encodeURIComponent(messageId)}`;

                await this.#seam.messageAdmission({
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
                        this.#broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                            {
                                sessionId: s.acpSessionId,
                                update: {
                                    sessionUpdate: "state_update",
                                    state: "running",
                                },
                            },
                        ]);
                        const replyText = await executeSlashCommand(
                            this.#seam,
                            this.#httpOrigin(),
                            bound,
                            cmd,
                            rest,
                            peer,
                            this.#notifyPeerSession,
                        );
                        this.#broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
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

                this.#notifyPeerSession(peer, bound.acpSessionId, {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "workspace:state",
                    _meta: {
                        plurnk: {
                            workspace: {
                                id: bound.workspaceId,
                                name: bound.workspaceName,
                                preparation: this.#seam.workspacePreparationStatus(bound.workspaceId),
                                activity: this.#seam.workspaceDerivationStatus(bound.workspaceId),
                            },
                        },
                    },
                });
                this.#broadcastSessionUpdate(bound.workspaceId, bound.sessionId, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "running",
                        },
                    },
                ]);

                const maxTurns = plurnkMeta.maxTurns ?? this.#opts.maxTurns;
                const ack = await this.#seam.runLoop({
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
                    this.#seam,
                    this.#httpOrigin(),
                    peer,
                    ctx.params.sessionId,
                    undefined,
                    false,
                ).catch(() => undefined));
            if (bound === undefined) return;
            this.#seam.cancelDrain(bound.sessionId, "Cancelled by ACP client");
            await this.#seam.cancelSession({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                reason: "Cancelled by ACP client",
            });
        });

        return app;
    }
}
