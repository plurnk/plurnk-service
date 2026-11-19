// {§acp-event-translation} {§acp-session-owner} {§acp-body-reference} {§acp-proposal-resolve} {§acp-topology-scope}
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
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import { createConnectionAgent } from "./agent.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { OptionSyncTracker, dispatchDaemonEvent, dispatchRuntimeStreamEvent } from "./events.ts";
import { GateTracker } from "./gates.ts";
import { type AcpPeer, type BoundSession } from "./sessions.ts";
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

export type AcpSetupSeam = SchemeRegistrationSeam & Pick<ModuleSetupSeam, "httpAddress">;

interface RequestConnectionContext {
    readonly family: string | null;
    readonly subject: string | null;
    readonly origin: string;
}

const isLoopbackIp = (ip: string | undefined): boolean =>
    ip === "127.0.0.1" || ip === "::1" || ip === "[::1]" || ip === "::ffff:127.0.0.1";

export default class Module implements DaemonModule<AcpSetupSeam> {
    readonly mounts: readonly string[] = Object.freeze(["/acp"]);
    #seam!: ApplicationPort;
    readonly #opts: ResolvedModuleOptions;
    #wss!: WebSocketServer;
    #acpServer!: AcpServer;
    #nodeHttpHandler!: (req: IncomingMessage, res: ServerResponse) => void;
    readonly #requestContext = new AsyncLocalStorage<RequestConnectionContext>();
    #offEvents: (() => void) | null = null;
    #offRuntimeStream: (() => void) | null = null;
    #offRevoked: (() => void) | null = null;
    readonly #peers = new Set<AcpPeer>();
    readonly #sseResponses = new Set<ServerResponse>();
    readonly #gates = new GateTracker();
    readonly #streamOffsets = new Map<string, number>();
    readonly #optionSync = new OptionSyncTracker();
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
                return createConnectionAgent(this.#agentContext(ctx?.origin), {
                    family: ctx?.family ?? null,
                    subject: ctx?.subject ?? null,
                });
            },
        });
        this.#nodeHttpHandler = createNodeHttpHandler(this.#acpServer);
        const eventCtx = {
            seam: this.#seam,
            peers: this.#peers,
            gates: this.#gates,
            streamOffsets: this.#streamOffsets,
            optionSync: this.#optionSync,
            notifyPeerSession: this.#notifyPeerSession,
            broadcastSessionUpdate: this.#broadcastSessionUpdate,
        };
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== null) {
                dispatchDaemonEvent(eventCtx, workspaceId, method, params);
            }
        });
        this.#offRuntimeStream =
            seam.subscribeToRuntimeStream?.((workspaceId, method, params) => {
                dispatchRuntimeStreamEvent(eventCtx, workspaceId, method, params);
            }) ?? null;
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
        this.#offEvents = null;
        this.#offRuntimeStream?.();
        this.#offRuntimeStream = null;
        this.#offRevoked?.();
        this.#offRevoked = null;
        this.#gates.clear();
        this.#streamOffsets.clear();
        this.#optionSync.clear();
        const stopping = serviceStoppingProblem();
        const closingPeers = [...this.#peers];
        this.#peers.clear();
        await Promise.allSettled(closingPeers.map((peer) => peer.closeWithProblem(stopping)));
        await this.#acpServer.close();
        for (const res of [...this.#sseResponses]) {
            this.#sseResponses.delete(res);
            if (!res.writableEnded && !res.destroyed) {
                res.end();
            }
        }
        await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
        // {§module-contract} Join admitted route work before returning from close().
        while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    }

    #agentContext(defaultOrigin?: string) {
        return {
            seam: this.#seam,
            opts: this.#opts,
            peers: this.#peers,
            gates: this.#gates,
            optionSync: this.#optionSync,
            httpOrigin: () => this.#requestContext.getStore()?.origin ?? defaultOrigin ?? this.#httpOrigin(),
            requestSubject: () => this.#requestContext.getStore()?.subject ?? null,
            notifyPeerSession: this.#notifyPeerSession,
            broadcastSessionUpdate: this.#broadcastSessionUpdate,
        };
    }

    #track<T>(work: Promise<T>): Promise<T> {
        this.#work.add(work);
        const settled = (): void => {
            this.#work.delete(work);
        };
        void work.then(settled, settled);
        return work;
    }

    #httpOrigin(req?: IncomingMessage): string {
        const addr = this.#seam.httpAddress();
        const rawListenerHost =
            typeof addr.host === "string"
                ? addr.host.includes(":") && !addr.host.startsWith("[")
                    ? `[${addr.host}]`
                    : addr.host
                : null;
        const defaultListenerHost =
            typeof addr.host === "string"
                ? addr.host === "0.0.0.0" || addr.host === "::" || addr.host === "[::]"
                    ? "127.0.0.1"
                    : rawListenerHost
                : null;
        const listenerRawOrigin =
            rawListenerHost !== null && typeof addr.port === "number"
                ? `http://${rawListenerHost}:${addr.port}`
                : "";
        const listenerDefaultOrigin =
            defaultListenerHost !== null && typeof addr.port === "number"
                ? `http://${defaultListenerHost}:${addr.port}`
                : "";

        const face = this.#seam?.credentials?.face() ?? null;
        if (face !== null) {
            const candidate = (req !== undefined ? face.issuer(req) : face.issuer()).trim();
            const unconfigured = face.issuer().trim();
            const probe = face.issuer({ headers: { host: "issuer-probe.invalid" } }).trim();
            const reflectsHostHeader = probe === "http://issuer-probe.invalid";
            const isDefaultListenerIssuer =
                reflectsHostHeader ||
                unconfigured === listenerRawOrigin ||
                unconfigured === listenerDefaultOrigin;
            if (candidate.length > 0) {
                try {
                    const parsedIssuer = new URL(candidate);
                    if (
                        (parsedIssuer.protocol === "https:" || parsedIssuer.protocol === "http:") &&
                        (!isDefaultListenerIssuer || parsedIssuer.protocol === "https:")
                    ) {
                        return parsedIssuer.origin;
                    }
                } catch {
                    // Fall back to request/listener resolution when configured issuer is malformed.
                }
            }
        }

        const rawForwardedProto = req?.headers["x-forwarded-proto"];
        const forwardedProto = (
            Array.isArray(rawForwardedProto) ? rawForwardedProto[0] : rawForwardedProto
        )
            ?.split(",", 1)[0]
            ?.trim()
            .toLowerCase();
        const remoteAddress = req?.socket?.remoteAddress;
        const localAddress = req?.socket?.localAddress;
        const onLoopbackSocket =
            (remoteAddress === undefined ? isLoopbackIp(addr.host) : isLoopbackIp(remoteAddress)) &&
            (isLoopbackIp(addr.host) ||
                ((addr.host === "0.0.0.0" || addr.host === "::" || addr.host === "[::]") &&
                    isLoopbackIp(localAddress)));
        const scheme = forwardedProto === "https" && onLoopbackSocket ? "https" : "http";

        const rawForwardedHost = scheme === "https" ? req?.headers["x-forwarded-host"] : undefined;
        const forwardedHost = (
            Array.isArray(rawForwardedHost) ? rawForwardedHost[0] : rawForwardedHost
        )
            ?.split(",", 1)[0]
            ?.trim();
        const rawHeader =
            forwardedHost && forwardedHost.length > 0
                ? forwardedHost
                : typeof req?.headers.host === "string"
                  ? req.headers.host.trim()
                  : "";
        if (rawHeader.length > 0) {
            try {
                const parsed = new URL(`${scheme}://${rawHeader}`);
                if (
                    parsed.username === "" &&
                    parsed.password === "" &&
                    parsed.pathname === "/" &&
                    parsed.search === "" &&
                    parsed.hash === "" &&
                    parsed.hostname !== "0.0.0.0" &&
                    parsed.hostname !== "::" &&
                    parsed.hostname !== "[::]"
                ) {
                    if (
                        scheme === "https" ||
                        parsed.port.length > 0 ||
                        rawHeader.endsWith(":80") ||
                        typeof addr.port !== "number"
                    ) {
                        return parsed.origin;
                    }
                    return `http://${parsed.hostname}:${addr.port}`;
                }
            } catch {
                // Fall back to listener address when Host header is malformed.
            }
        }
        if (listenerDefaultOrigin.length > 0) {
            return scheme === "https" && defaultListenerHost !== null && typeof addr.port === "number"
                ? `https://${defaultListenerHost}:${addr.port}`
                : listenerDefaultOrigin;
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
        let url: URL;
        try {
            url = new URL(req.url ?? "/acp", "http://listener");
        } catch {
            writeHttpProblem(
                res,
                httpProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                    method: req.method ?? null,
                    path: req.url ?? null,
                    stage: "routing",
                    retryable: false,
                }),
            );
            return;
        }
        const entryMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/entry$/.exec(url.pathname);
        const isEntryRead = entryMatch !== null && (req.method === "GET" || req.method === "HEAD");
        const admission = admitRequest(this.#seam.credentials, req, isEntryRead);
        if (!admission.ok) {
            res.setHeader("www-authenticate", admission.challenge);
            writeHttpProblem(res, admission.problem);
            return;
        }

        if (isEntryRead && entryMatch !== null) {
            await handleEntryRoute(
                this.#seam,
                res,
                Number(entryMatch[1]),
                Number(entryMatch[2]),
                url,
                req.method === "HEAD" ? "HEAD" : "GET",
            );
            return;
        }

        const messagesMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/messages$/.exec(url.pathname);
        if (messagesMatch !== null && req.method === "GET") {
            await handleMessagesRoute(
                this.#seam,
                this.#opts,
                this.#httpOrigin(req),
                res,
                Number(messagesMatch[1]),
                Number(messagesMatch[2]),
                url,
                admission.subject ?? null,
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
            if (req.method === "GET") {
                req.socket.setTimeout(0);
                this.#sseResponses.add(res);
                const origFlushHeaders = res.flushHeaders.bind(res);
                let initialCommentSent = false;
                res.flushHeaders = (): void => {
                    const isEventStream =
                        res.statusCode === 200 &&
                        String(res.getHeader("content-type") ?? "")
                            .toLowerCase()
                            .includes("text/event-stream");
                    if (!initialCommentSent && isEventStream && !res.headersSent) {
                        res.setHeader("X-Accel-Buffering", "no");
                    }
                    origFlushHeaders();
                    if (
                        !initialCommentSent &&
                        isEventStream &&
                        !res.writableEnded &&
                        !res.destroyed
                    ) {
                        initialCommentSent = true;
                        res.write(": heartbeat\n\n");
                    }
                };
                let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
                if (this.#opts.heartbeatMs > 0) {
                    heartbeatTimer = setInterval(() => {
                        if (
                            res.headersSent &&
                            !res.writableEnded &&
                            !res.destroyed &&
                            String(res.getHeader("content-type") ?? "")
                                .toLowerCase()
                                .includes("text/event-stream")
                        ) {
                            res.write(": heartbeat\n\n");
                        }
                    }, this.#opts.heartbeatMs);
                    heartbeatTimer.unref();
                }
                res.once("close", () => {
                    this.#sseResponses.delete(res);
                    if (heartbeatTimer !== null) {
                        clearInterval(heartbeatTimer);
                        heartbeatTimer = null;
                    }
                });
            }
            this.#requestContext.run(
                { family: admission.family, subject: admission.subject, origin: this.#httpOrigin(req) },
                () => {
                    this.#nodeHttpHandler(req, res);
                },
            );
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
        const app = createConnectionAgent(this.#agentContext(this.#httpOrigin(req)), {
            family: admission.family,
            subject: admission.subject,
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
        const heldTarget = peer.sessions.get(sessionId);
        if (heldTarget?.heldUpdates !== undefined) {
            heldTarget.heldUpdates.push(update);
            return;
        }
        const isNamedPrincipalPeer =
            peer.subject !== null &&
            peer.subject !== undefined &&
            peer.subject !== "operator" &&
            peer.subject !== "anonymous";
        if (isNamedPrincipalPeer) {
            const plurnkMeta =
                isRecord(update._meta) && isRecord(update._meta.plurnk)
                    ? update._meta.plurnk
                    : undefined;
            const updateVoice = plurnkMeta?.voice;
            const updateVoices = Array.isArray(plurnkMeta?.voices) ? plurnkMeta.voices : undefined;
            if (
                update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "user_message" ||
                update.sessionUpdate === "agent_message"
            ) {
                if (updateVoice !== peer.subject && !updateVoices?.includes(peer.subject)) {
                    return;
                }
            } else if (update.sessionUpdate === "state_update") {
                const boundSession = peer.sessions.get(sessionId);
                if (update.state === "running") {
                    if (updateVoice !== peer.subject) {
                        return;
                    }
                    if (boundSession !== undefined) {
                        boundSession.principalRunning = true;
                    }
                } else if (update.state === "idle") {
                    if (updateVoice !== undefined) {
                        if (updateVoice !== peer.subject) {
                            return;
                        }
                        if (boundSession !== undefined) {
                            boundSession.principalRunning = false;
                        }
                    } else if (plurnkMeta?.terminal !== undefined) {
                        if (boundSession?.principalRunning !== true) {
                            return;
                        }
                        const statusRec = isRecord(plurnkMeta.status) ? plurnkMeta.status : null;
                        const inboxArr = Array.isArray(statusRec?.inbox) ? statusRec.inbox : [];
                        const stillOpenForPeer = inboxArr.some(
                            (item) =>
                                isRecord(item) &&
                                (item.lifecycle === "running" ||
                                    item.lifecycle === "queued" ||
                                    item.lifecycle === "parked") &&
                                item.voice === peer.subject,
                        );
                        if (stillOpenForPeer) {
                            return;
                        }
                        boundSession.principalRunning = false;
                    }
                } else {
                    return;
                }
            } else if (
                update.sessionUpdate !== "session_info_update" &&
                update.sessionUpdate !== "config_option_update" &&
                update.sessionUpdate !== "available_commands_update" &&
                update.sessionUpdate !== "replay_complete"
            ) {
                return;
            }
        }
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
}
