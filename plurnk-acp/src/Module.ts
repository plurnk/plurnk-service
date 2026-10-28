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
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { createConnectionAgent } from "./agent.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import { dispatchDaemonEvent } from "./events.ts";
import { GateTracker } from "./gates.ts";
import type { AcpPeer, BoundSession } from "./sessions.ts";
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
    readonly #sseResponses = new Set<ServerResponse>();
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
                return createConnectionAgent(this.#agentContext(), { family: ctx?.family ?? null });
            },
        });
        this.#nodeHttpHandler = createNodeHttpHandler(this.#acpServer);
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== null) {
                dispatchDaemonEvent(
                    {
                        seam: this.#seam,
                        peers: this.#peers,
                        gates: this.#gates,
                        streamOffsets: this.#streamOffsets,
                        notifyPeerSession: this.#notifyPeerSession,
                        broadcastSessionUpdate: this.#broadcastSessionUpdate,
                    },
                    workspaceId,
                    method,
                    params,
                );
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

    #agentContext() {
        return {
            seam: this.#seam,
            opts: this.#opts,
            peers: this.#peers,
            gates: this.#gates,
            httpOrigin: () => this.#httpOrigin(),
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
            if (req.method === "GET") {
                req.socket.setTimeout(0);
                this.#sseResponses.add(res);
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
        const app = createConnectionAgent(this.#agentContext(), {
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
}
