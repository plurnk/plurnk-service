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
import { resolvePublicOrigin } from "@plurnk/plurnk-contracts";
import { InFlightTracker, attachSseKeepAlive, type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import { createConnectionAgent } from "./agent.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import {
    OptionSyncTracker,
    dispatchDaemonEvent,
    dispatchGlobalDaemonEvent,
    dispatchRuntimeStreamEvent,
} from "./events.ts";
import { GateTracker } from "./gates.ts";
import { type AcpPeer, type BoundSession } from "./sessions.ts";
import {
    HEADER_CONNECTION_ID,
    admitAcpBrowserOrigin,
    admitRequest,
    applyCorsHeaders,
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
    readonly subject: string | null;
    readonly handle?: string;
    readonly name?: string;
    readonly canDelegateActor: boolean;
    readonly origin: string;
}

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
    readonly #peers = new Set<AcpPeer>();
    readonly #sseResponses = new Set<ServerResponse>();
    readonly #gates = new GateTracker();
    readonly #streamOffsets = new Map<string, number>();
    readonly #optionSync = new OptionSyncTracker();
    readonly #inFlight = new InFlightTracker();
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
            this.#inFlight.track(this.#handleUpgrade(req, socket, head)),
        );
        this.#seam = seam;
        this.#wss = new WebSocketServer({
            noServer: true,
            handleProtocols: (protocols) => (protocols.has("acp") ? "acp" : protocols.values().next().value ?? false),
        });
        this.#acpServer = new AcpServer({
            createAgent: () => {
                const ctx = this.#requestContext.getStore();
                return createConnectionAgent(this.#agentContext(ctx?.origin), {
                    subject: ctx?.subject ?? null,
                    ...(ctx?.handle !== undefined ? { handle: ctx.handle } : {}),
                    ...(ctx?.name !== undefined ? { name: ctx.name } : {}),
                    canDelegateActor: ctx?.canDelegateActor === true,
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
            } else {
                dispatchGlobalDaemonEvent(eventCtx, method, params);
            }
        });
        this.#offRuntimeStream =
            seam.subscribeToRuntimeStream?.((workspaceId, method, params) => {
                dispatchRuntimeStreamEvent(eventCtx, workspaceId, method, params);
            }) ?? null;
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
        this.#gates.clear();
        this.#streamOffsets.clear();
        this.#optionSync.clear();
        const stopping = serviceStoppingProblem();
        const closingPeers = [...this.#peers];
        this.#peers.clear();
        await Promise.allSettled(closingPeers.map((peer) => peer.closeWithProblem(stopping)));
        for (const peer of closingPeers) {
            for (const bound of new Set(peer.sessions.values())) {
                bound.translator.clear();
            }
            peer.sessions.clear();
        }
        await this.#acpServer.close();
        for (const res of [...this.#sseResponses]) {
            this.#sseResponses.delete(res);
            if (!res.writableEnded && !res.destroyed) {
                res.end();
            }
        }
        await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
        // {§module-contract} Join admitted route work before returning from close().
        await this.#inFlight.drain();
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
            requestHandle: () => this.#requestContext.getStore()?.handle,
            requestName: () => this.#requestContext.getStore()?.name,
            requestCanDelegateActor: () => this.#requestContext.getStore()?.canDelegateActor,
            notifyPeerSession: this.#notifyPeerSession,
            broadcastSessionUpdate: this.#broadcastSessionUpdate,
        };
    }

    #httpOrigin(req?: IncomingMessage): string {
        return resolvePublicOrigin(req, this.#seam.httpAddress(), this.#seam?.credentials);
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        applyCorsHeaders(res, this.#opts.allowOrigin);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        res.setHeader("cache-control", "no-store");
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
        const browserOrigin = admitAcpBrowserOrigin(req, this.#opts.allowOrigin, this.#seam.httpAddress());
        if (!browserOrigin.ok) {
            writeHttpProblem(res, browserOrigin.problem);
            return;
        }
        const entryMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/entry$/.exec(url.pathname);
        const isEntryRead = entryMatch !== null && (req.method === "GET" || req.method === "HEAD");
        const admission = await admitRequest(this.#seam.credentials, req, isEntryRead);
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
            const origFlushHeaders = res.flushHeaders.bind(res);
            let initialCommentSent = false;
            res.flushHeaders = (): void => {
                if (!res.headersSent) {
                    res.setHeader("cache-control", "no-store");
                }
                const isEventStream =
                    req.method === "GET" &&
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
            if (req.method === "GET") {
                this.#sseResponses.add(res);
                attachSseKeepAlive(req, res, {
                    heartbeatMs: this.#opts.heartbeatMs,
                    requireEventStreamHeader: true,
                    onClose: () => {
                        this.#sseResponses.delete(res);
                    },
                });
            }
            this.#requestContext.run(
                {
                    subject: admission.subject,
                    ...(admission.handle !== undefined ? { handle: admission.handle } : {}),
                    ...(admission.name !== undefined ? { name: admission.name } : {}),
                    canDelegateActor: admission.canDelegateActor === true,
                    origin: this.#httpOrigin(req),
                },
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
        const browserOrigin = admitAcpBrowserOrigin(req, this.#opts.allowOrigin, this.#seam.httpAddress());
        if (!browserOrigin.ok) {
            writeSocketProblem(socket, browserOrigin.problem);
            return;
        }
        const admission = await admitRequest(this.#seam.credentials, req, true);
        if (!admission.ok) {
            writeSocketProblem(socket, admission.problem, { "WWW-Authenticate": admission.challenge });
            return;
        }
        let closeWs: (() => void) | undefined;
        const app = createConnectionAgent(this.#agentContext(this.#httpOrigin(req)), {
            subject: admission.subject,
            ...(admission.handle !== undefined ? { handle: admission.handle } : {}),
            ...(admission.name !== undefined ? { name: admission.name } : {}),
            canDelegateActor: admission.canDelegateActor === true,
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
