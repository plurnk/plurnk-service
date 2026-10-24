// {§acp-daemon-module} The daemon's ACP v2 client interface, a discovered module: it claims
// `/acp` on the daemon's one listener ({§module-http-mounts}), mounts HTTP and WebSocket upgrade
// handlers at start, and owns no socket of its own.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
    APPLICATION_NOTIFICATIONS,
    Problems,
    UNKNOWN_POSITION,
    Validator,
    excerptOf,
    isRecord,
    isSafeInteger,
    lifecycleOfLoopStatus,
    requestOrigin,
    withoutBodies,
    type ApplicationNotificationContract,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ExecStatement,
    type OperationResult,
    type PlurnkStatement,
    type ProblemDetails,
    type ProposalDecision,
    type ProposalProjection,
    type RequestHeaders,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";
import MessageAddress from "./MessageAddress.ts";
import SessionAddress, { HttpProblemError, acpProblem } from "./SessionAddress.ts";
import Translator, { type AcpSessionUpdate } from "./Translator.ts";
import WebSocketConnection from "./WebSocketConnection.ts";

export type { ModuleOptions } from "./config.ts";

export type AcpSetupSeam = SchemeRegistrationSeam & Pick<ApplicationPort, "httpAddress">;

export type AcpPort = Pick<
    ApplicationPort,
    | "attachWorkspace"
    | "cancelDrain"
    | "claimWorkerOwner"
    | "configurationNotices"
    | "createWorker"
    | "createWorkspace"
    | "credentials"
    | "dispatchClientAction"
    | "ensureWorkerReference"
    | "executorTags"
    | "forkWorker"
    | "httpAddress"
    | "invokeModuleAction"
    | "listClientDisplayCapabilities"
    | "listModels"
    | "listModuleActions"
    | "listPrompts"
    | "listProviders"
    | "listWorkerLoops"
    | "listWorkers"
    | "listWorkspaces"
    | "pendingClientInteractions"
    | "pendingProposals"
    | "readEntry"
    | "readEntryChannel"
    | "readInbox"
    | "readLog"
    | "readStreams"
    | "readWorker"
    | "readWorkerEffort"
    | "readWorkerModel"
    | "readWorkerOverview"
    | "readWorkerReference"
    | "readWorkspaceCapabilities"
    | "registerHttpRoute"
    | "registerHttpUpgrade"
    | "registerWorkerOwner"
    | "renameWorkspace"
    | "resolveClientInteraction"
    | "resolveProposal"
    | "rollback"
    | "runLoop"
    | "setWorkerEffort"
    | "setWorkerHidden"
    | "setWorkerModel"
    | "setWorkerSpawnModel"
    | "setWorkspaceCapabilities"
    | "setWorkspaceHidden"
    | "shareWorkspace"
    | "subscribeToEvents"
    | "workerAccounting"
    | "workerGauge"
    | "workspaceDerivationStatus"
    | "workspacePreparationStatus"
>;

const ACP_SCOPE = "acp";

interface BoundSession {
    readonly sessionId: string;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly workerName: string;
    readonly translator: Translator;
}

interface PendingRpcGate {
    readonly kind: "proposal" | "interaction";
    readonly workspaceId: number;
    readonly targetId: number;
}

interface AcpPeer {
    readonly family: string | null;
    readonly origin: string;
    readonly sessions: Map<string, BoundSession>;
    readonly pendingGates: Map<string | number, PendingRpcGate>;
    sendNotification(method: string, params: unknown): void;
    sendRequest(id: string, method: string, params: unknown, gate: PendingRpcGate): void;
    closeWithProblem(problem: ProblemDetails): void;
}

interface LoopWaiter {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly resolve: (terminated: TerminatedNotification) => void;
    readonly reject: (problem: ProblemDetails) => void;
}

const credentialRevokedProblem = (): ProblemDetails =>
    acpProblem("credential-revoked", 401, "The credential authorizing this connection was revoked.", {
        stage: "authentication",
        retryable: false,
    });

const serviceStoppingProblem = (): ProblemDetails =>
    acpProblem("service-stopping", 503, "The PLURNK service is stopping.", {
        stage: "shutdown",
        retryable: true,
    });

export default class Module implements DaemonModule<AcpSetupSeam, AcpPort> {
    readonly mounts: readonly string[] = Object.freeze(["/acp"]);
    readonly #opts: ResolvedModuleOptions;
    #seam!: AcpPort;
    #listener!: AcpSetupSeam["httpAddress"];
    #offEvents: (() => void) | null = null;
    #offRevoked: (() => void) | null = null;
    readonly #peers = new Set<AcpPeer>();
    readonly #loopWaiters = new Set<LoopWaiter>();
    readonly #work = new Set<Promise<unknown>>();
    #nextServerRequestId = 1;
    #activated = false;
    #stopped = false;

    private constructor(opts: ModuleOptions = {}) {
        this.#opts = resolveModuleOptions(opts);
    }

    static create(opts: ModuleOptions = {}): Module {
        return new Module(opts);
    }

    #origin(req: RequestHeaders = { headers: {} }): string {
        return this.#seam.credentials.face()?.issuer(req) ?? requestOrigin(req, this.#listener());
    }

    async setup(seam: AcpSetupSeam): Promise<void> {
        await seam.registerScheme("acp", new MessageScheme("acp"));
        this.#listener = () => seam.httpAddress();
    }

    async start(seam: AcpPort): Promise<void> {
        if (this.#stopped) throw new Error("plurnk-acp: stopped module cannot be activated");
        if (this.#activated) throw new Error("plurnk-acp: module already activated");
        this.#seam = seam;
        this.#listener = () => seam.httpAddress();
        seam.registerHttpRoute("/acp", (req, res) => this.#track(this.#handleHttp(req, res)));
        seam.registerHttpUpgrade("/acp", (req, socket, head) => this.#track(this.#handleUpgrade(req, socket, head)));
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            this.#onDaemonEvent(workspaceId, method, params);
        });
        this.#offRevoked = seam.credentials.onRevoked((family) => {
            const problem = credentialRevokedProblem();
            for (const peer of [...this.#peers]) {
                if (peer.family === family) {
                    peer.closeWithProblem(problem);
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
        const problem = serviceStoppingProblem();
        for (const waiter of [...this.#loopWaiters]) {
            this.#loopWaiters.delete(waiter);
            waiter.reject(problem);
        }
        for (const peer of [...this.#peers]) {
            this.#peers.delete(peer);
            peer.closeWithProblem(problem);
        }
        while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
    }

    #track<T>(promise: Promise<T>): Promise<T> {
        this.#work.add(promise);
        void promise.finally(() => this.#work.delete(promise));
        return promise;
    }

    #corsHeaders(): Record<string, string> {
        if (this.#opts.allowOrigin.length === 0) return {};
        return {
            "access-control-allow-origin": this.#opts.allowOrigin,
            "access-control-allow-headers": "authorization, content-type, accept",
            "access-control-allow-methods": "GET, POST, OPTIONS",
        };
    }

    #authorize(
        req: IncomingMessage,
        allowQueryToken: boolean = false,
    ): { ok: true; family: string | null } | { ok: false; problem: ProblemDetails; wwwAuthenticate: string } {
        const face = this.#seam.credentials.face();
        if (face === null) return { ok: true, family: null };
        const origin = face.issuer(req);
        const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
        let token: string | null = null;
        const authHeader = req.headers.authorization;
        if (typeof authHeader === "string") {
            const match = /^Bearer\s+(\S+)$/iu.exec(authHeader.trim());
            if (match !== null) token = match[1]!;
        }
        if (token === null && allowQueryToken) {
            const url = new URL(req.url ?? "/acp", "http://listener");
            token = url.searchParams.get("access_token");
        }
        if (token === null) {
            return {
                ok: false,
                problem: acpProblem("unauthorized", 401, "A valid Bearer access token is required.", {
                    stage: "authentication",
                    retryable: false,
                }),
                wwwAuthenticate: `Bearer realm="plurnk", resource_metadata="${resourceMetadata}"`,
            };
        }
        const claims = this.#seam.credentials.verify(token);
        if (claims === null || claims.kind !== "access") {
            return {
                ok: false,
                problem: acpProblem("unauthorized", 401, "The Bearer access token is invalid, expired or revoked.", {
                    stage: "authentication",
                    retryable: false,
                }),
                wwwAuthenticate: `Bearer error="invalid_token", realm="plurnk", resource_metadata="${resourceMetadata}"`,
            };
        }
        if (!claims.scopes.includes(ACP_SCOPE)) {
            return {
                ok: false,
                problem: acpProblem("insufficient-scope", 403, `The Bearer token does not grant the '${ACP_SCOPE}' scope.`, {
                    stage: "authorization",
                    retryable: false,
                }),
                wwwAuthenticate: `Bearer error="insufficient_scope", scope="${ACP_SCOPE}", resource_metadata="${resourceMetadata}"`,
            };
        }
        return { ok: true, family: claims.family };
    }

    #writeProblem(res: ServerResponse, problem: ProblemDetails, extraHeaders: Readonly<Record<string, string>> = {}): void {
        res.writeHead(problem.status, {
            ...this.#corsHeaders(),
            ...extraHeaders,
            "content-type": "application/problem+json",
        });
        res.end(JSON.stringify(problem));
    }

    static #writeSocketProblem(socket: Duplex, problem: ProblemDetails, extraHeaders: Readonly<Record<string, string>> = {}): void {
        const body = JSON.stringify(problem);
        const headerLines = [
            `HTTP/1.1 ${problem.status} Error`,
            "Content-Type: application/problem+json",
            "Connection: close",
            `Content-Length: ${Buffer.byteLength(body)}`,
            ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
            "\r\n",
        ];
        socket.end(`${headerLines.join("\r\n")}${body}`);
    }

    async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        if (this.#stopped) {
            Module.#writeSocketProblem(socket, serviceStoppingProblem());
            return;
        }
        const url = new URL(req.url ?? "/acp", "http://listener");
        if (url.pathname !== "/acp") {
            Module.#writeSocketProblem(socket, acpProblem("route-not-found", 404, "The requested ACP route does not exist.", {
                stage: "routing",
                retryable: false,
            }));
            return;
        }
        const auth = this.#authorize(req, true);
        if (!auth.ok) {
            Module.#writeSocketProblem(socket, auth.problem, { "WWW-Authenticate": auth.wwwAuthenticate });
            return;
        }
        const origin = this.#origin(req);
        const sessions = new Map<string, BoundSession>();
        const pendingGates = new Map<string | number, PendingRpcGate>();
        let ws: WebSocketConnection | null = null;
        const peer: AcpPeer = {
            family: auth.family,
            origin,
            sessions,
            pendingGates,
            sendNotification: (method, params) => {
                ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
            },
            sendRequest: (id, method, params, gate) => {
                pendingGates.set(id, gate);
                ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            },
            closeWithProblem: (problem) => {
                ws?.send(JSON.stringify({
                    jsonrpc: "2.0",
                    method: "_plurnk/error",
                    params: { problem },
                }));
                ws?.close(1001, typeof problem.code === "string" ? problem.code : "closed");
            },
        };
        ws = WebSocketConnection.upgrade(req, socket, head, {
            onMessage: (text) => {
                void this.#track(this.#handleWebSocketMessage(peer, ws!, text, req));
            },
            onClose: () => {
                this.#peers.delete(peer);
            },
        }, this.#corsHeaders());
        if (ws === null) {
            Module.#writeSocketProblem(socket, acpProblem("invalid-json", 400, "Invalid WebSocket upgrade handshake.", {
                stage: "transport",
                retryable: false,
            }));
            return;
        }
        this.#peers.add(peer);
    }

    async #handleWebSocketMessage(peer: AcpPeer, ws: WebSocketConnection, text: string, req: IncomingMessage): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" },
            }));
            return;
        }
        if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: isRecord(parsed) && (typeof parsed.id === "string" || typeof parsed.id === "number") ? parsed.id : null,
                error: { code: -32600, message: "Invalid JSON-RPC 2.0 message" },
            }));
            return;
        }
        // Check if this is a client->server response to a server->client gate request (`session/request_permission` or `_plurnk/question`).
        if (typeof parsed.method !== "string" && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
            const gate = peer.pendingGates.get(parsed.id);
            if (gate !== undefined) {
                peer.pendingGates.delete(parsed.id);
                await this.#resolveRpcGate(gate, parsed.result, parsed.error);
            }
            return;
        }
        if (typeof parsed.method !== "string") {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null,
                error: { code: -32600, message: "Missing JSON-RPC method" },
            }));
            return;
        }
        const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null;
        const params = isRecord(parsed.params) ? parsed.params : {};
        try {
            const result = await this.#dispatchRpc(peer, parsed.method, params, req);
            if (id !== null) {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
            }
        } catch (err) {
            const problem = err instanceof HttpProblemError
                ? err.problem
                : Problems.fromError(err) ?? acpProblem("action-failed", 500, err instanceof Error ? err.message : "The ACP method failed.", { stage: "execution", retryable: false });
            if (id !== null) {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: problem.status === 404 ? -32004 : problem.status === 400 ? -32602 : -32000,
                        message: problem.detail,
                        data: { problem },
                    },
                }));
            }
        }
    }

    async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopped) {
            this.#writeProblem(res, serviceStoppingProblem());
            return;
        }
        const url = new URL(req.url ?? "/acp", "http://listener");
        if (req.method === "OPTIONS") {
            res.writeHead(204, this.#corsHeaders());
            res.end();
            return;
        }
        if (url.pathname === "/acp/entry") {
            if (req.method !== "GET") {
                this.#writeProblem(res, acpProblem("method-not-allowed", 405, "Only GET is supported on /acp/entry.", {
                    stage: "routing",
                    retryable: false,
                }));
                return;
            }
            const auth = this.#authorize(req, false);
            if (!auth.ok) {
                this.#writeProblem(res, auth.problem, { "www-authenticate": auth.wwwAuthenticate });
                return;
            }
            const workspaceId = Number(url.searchParams.get("workspaceId") ?? "");
            const workerId = Number(url.searchParams.get("workerId") ?? "");
            const target = url.searchParams.get("target") ?? "";
            if (!isSafeInteger(workspaceId) || workspaceId < 1 || !isSafeInteger(workerId) || workerId < 1 || target.length === 0) {
                this.#writeProblem(res, acpProblem("entry-query-invalid", 400, "workspaceId, workerId and target are required to read an entry channel.", {
                    stage: "request-validation",
                    retryable: false,
                }));
                return;
            }
            try {
                const read = await this.#seam.readEntryChannel({ workspaceId, workerId, target });
                if (read.entry === null) {
                    this.#writeProblem(res, read.problem);
                    return;
                }
                for (const { content, mimetype } of Object.values(read.entry.channels)) {
                    res.writeHead(200, {
                        ...this.#corsHeaders(),
                        "content-type": `${mimetype}; charset=utf-8`,
                        "cache-control": "no-store",
                    });
                    res.end(content);
                    return;
                }
                res.writeHead(200, {
                    ...this.#corsHeaders(),
                    "content-type": "text/plain; charset=utf-8",
                });
                res.end("");
            } catch (err) {
                const problem = Problems.fromError(err) ?? acpProblem("action-failed", 500, "Failed to read entry channel.", { stage: "execution", retryable: false });
                this.#writeProblem(res, problem);
            }
            return;
        }
        if (url.pathname !== "/acp") {
            this.#writeProblem(res, acpProblem("route-not-found", 404, "The requested ACP route does not exist.", {
                stage: "routing",
                retryable: false,
            }));
            return;
        }
        if (req.method !== "POST") {
            this.#writeProblem(res, acpProblem("method-not-allowed", 405, "Use POST or WebSocket upgrade on /acp.", {
                stage: "routing",
                retryable: false,
            }));
            return;
        }
        const auth = this.#authorize(req, false);
        if (!auth.ok) {
            this.#writeProblem(res, auth.problem, { "www-authenticate": auth.wwwAuthenticate });
            return;
        }
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
            this.#writeProblem(res, acpProblem("unsupported-media-type", 415, "POST /acp requires application/json.", {
                stage: "request-validation",
                retryable: false,
            }));
            return;
        }
        let rawBody = "";
        for await (const chunk of req) {
            rawBody += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        }
        let body: unknown;
        try {
            body = JSON.parse(rawBody);
        } catch {
            this.#writeProblem(res, acpProblem("invalid-json", 400, "The request body is not valid JSON.", {
                stage: "request-validation",
                retryable: false,
            }));
            return;
        }
        if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
            this.#writeProblem(res, acpProblem("invalid-json", 400, "The request body is not a JSON-RPC 2.0 request.", {
                stage: "request-validation",
                retryable: false,
            }));
            return;
        }
        const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
        const method = body.method;
        const params = isRecord(body.params) ? body.params : {};
        const wantsSse = (req.headers.accept ?? "").includes("text/event-stream")
            && (method === "session/prompt" || method === "session/load" || method === "session/resume");
        const origin = this.#origin(req);
        const sessions = new Map<string, BoundSession>();
        const pendingGates = new Map<string | number, PendingRpcGate>();
        const bufferedNotifications: Array<Record<string, unknown>> = [];

        let heartbeat: ReturnType<typeof setInterval> | null = null;
        if (wantsSse) {
            res.writeHead(200, {
                ...this.#corsHeaders(),
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            const heartbeatInterval = this.#opts.heartbeatMs;
            if (heartbeatInterval > 0) {
                heartbeat = setInterval(() => {
                    if (!res.writableEnded) res.write(": keepalive\n\n");
                }, heartbeatInterval);
            }
        }

        const peer: AcpPeer = {
            family: auth.family,
            origin,
            sessions,
            pendingGates,
            sendNotification: (notifMethod, notifParams) => {
                const payload = { jsonrpc: "2.0", method: notifMethod, params: notifParams };
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                } else {
                    bufferedNotifications.push(payload);
                }
            },
            sendRequest: (reqId, reqMethod, reqParams, gate) => {
                pendingGates.set(reqId, gate);
                const payload = { jsonrpc: "2.0", id: reqId, method: reqMethod, params: reqParams };
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                } else {
                    bufferedNotifications.push(payload);
                }
            },
            closeWithProblem: (problem) => {
                if (wantsSse && !res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "_plurnk/error", params: { problem } })}\n\n`);
                    res.end();
                }
            },
        };
        this.#peers.add(peer);
        try {
            const result = await this.#dispatchRpc(peer, method, params, req);
            const enrichedResult = !wantsSse && bufferedNotifications.length > 0 && isRecord(result)
                ? { ...result, notifications: bufferedNotifications.map((n) => n.params) }
                : result;
            const rpcResponse = { jsonrpc: "2.0", id, result: enrichedResult };
            if (wantsSse) {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(rpcResponse)}\n\n`);
                    res.end();
                }
            } else {
                res.writeHead(200, {
                    ...this.#corsHeaders(),
                    "content-type": "application/json",
                });
                res.end(JSON.stringify(rpcResponse));
            }
        } catch (err) {
            const problem = err instanceof HttpProblemError
                ? err.problem
                : Problems.fromError(err) ?? acpProblem("action-failed", 500, err instanceof Error ? err.message : "The ACP method failed.", { stage: "execution", retryable: false });
            const rpcError = {
                jsonrpc: "2.0",
                id,
                error: {
                    code: problem.status === 404 ? -32004 : problem.status === 400 ? -32602 : -32000,
                    message: problem.detail,
                    data: { problem },
                },
            };
            if (wantsSse) {
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify(rpcError)}\n\n`);
                    res.end();
                }
            } else {
                res.writeHead(200, {
                    ...this.#corsHeaders(),
                    "content-type": "application/json",
                });
                res.end(JSON.stringify(rpcError));
            }
        } finally {
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#peers.delete(peer);
        }
    }

    async #resolveRpcGate(gate: PendingRpcGate, result: unknown, error: unknown): Promise<void> {
        if (gate.kind === "proposal") {
            let decision: ProposalDecision = "cancel";
            let body: string | undefined;
            let outcome: string | undefined;
            if (error === undefined && isRecord(result)) {
                const rawOutcome = isRecord(result.outcome) ? result.outcome : result;
                const optionId = typeof rawOutcome.optionId === "string"
                    ? rawOutcome.optionId
                    : typeof rawOutcome.decision === "string"
                        ? rawOutcome.decision
                        : rawOutcome.outcome === "cancelled"
                            ? "cancel"
                            : "cancel";
                if (optionId === "accept" || optionId === "allow_once" || optionId === "allow_always") decision = "accept";
                else if (optionId === "reject" || optionId === "reject_once" || optionId === "reject_always") decision = "reject";
                else decision = "cancel";
                if (typeof rawOutcome.body === "string") body = rawOutcome.body;
                if (typeof rawOutcome.reason === "string") outcome = rawOutcome.reason;
            }
            await this.#seam.resolveProposal(
                gate.targetId,
                {
                    decision,
                    ...(body === undefined ? {} : { body }),
                    ...(outcome === undefined ? {} : { outcome }),
                },
                { workspaceId: gate.workspaceId, address: MessageAddress.OWNER },
            );
            return;
        }
        const resolution: ClientInteractionResolution = error !== undefined || (isRecord(result) && result.status === "cancelled")
            ? { status: "cancelled" }
            : {
                status: "resolved",
                ...(isRecord(result) && Object.hasOwn(result, "payload") ? { payload: result.payload } : { payload: result }),
            };
        await this.#seam.resolveClientInteraction(
            gate.targetId,
            resolution,
            { workspaceId: gate.workspaceId, address: MessageAddress.OWNER },
        );
    }

    async #resolveSession(
        sessionId: string,
        origin: string,
        allowCreate: boolean = false,
    ): Promise<BoundSession> {
        const qualified = SessionAddress.parse(sessionId);
        if (qualified !== null) {
            const worker = await this.#seam.readWorker({
                workspaceId: qualified.workspaceId,
                identity: { name: qualified.workerName },
            });
            if (worker === null) {
                throw new HttpProblemError(acpProblem(
                    "session-not-found",
                    404,
                    `Session '${sessionId}' does not exist.`,
                    { sessionId, stage: "Lookup", retryable: false },
                ));
            }
            return {
                sessionId: SessionAddress.format(qualified.workspaceId, worker.name),
                workspaceId: qualified.workspaceId,
                workerId: worker.id,
                workerName: worker.name,
                translator: new Translator({
                    sessionId: SessionAddress.format(qualified.workspaceId, worker.name),
                    workspaceId: qualified.workspaceId,
                    workerId: worker.id,
                    origin,
                    historyPageChars: this.#opts.historyPageChars,
                }),
            };
        }
        const ref = allowCreate
            ? await this.#seam.ensureWorkerReference({ namespace: "acp", reference: sessionId })
            : await this.#seam.readWorkerReference({ namespace: "acp", reference: sessionId });
        if (ref === null) {
            throw new HttpProblemError(acpProblem(
                "session-not-found",
                404,
                `Session '${sessionId}' does not exist.`,
                { sessionId, stage: "lookup", retryable: false },
            ));
        }
        const worker = await this.#seam.readWorker({
            workspaceId: ref.workspaceId,
            identity: { id: ref.workerId },
        });
        const workerName = worker?.name ?? "main";
        return {
            sessionId,
            workspaceId: ref.workspaceId,
            workerId: ref.workerId,
            workerName,
            translator: new Translator({
                sessionId,
                workspaceId: ref.workspaceId,
                workerId: ref.workerId,
                origin,
                historyPageChars: this.#opts.historyPageChars,
            }),
        };
    }

    async #sessionConfigState(workspaceId: number, workerId: number): Promise<Record<string, unknown>> {
        const [{ model, spawnModel }, effort, capabilities, providers] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.readWorkerEffort({ workspaceId, workerId }),
            this.#seam.readWorkspaceCapabilities({ workspaceId }),
            Promise.resolve(this.#seam.listProviders()),
        ]);
        const currentModelId = model === null ? "" : model.alias ?? `${model.provider}/${model.model}`;
        return {
            modes: {
                currentModeId: "default",
                availableModes: [
                    { id: "default", name: "Default", description: "Workspace capability policy as configured." },
                ],
            },
            models: {
                currentModelId,
                availableModels: providers.aliases.map((alias) => ({
                    modelId: alias.alias,
                    name: `${alias.alias} (${alias.provider}/${alias.model})`,
                    provider: alias.provider,
                    model: alias.model,
                    effort: alias.effort,
                })),
            },
            configOptions: [
                {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: currentModelId,
                    options: providers.aliases.map((alias) => ({
                        value: alias.alias,
                        name: `${alias.alias} (${alias.provider}/${alias.model})`,
                    })),
                },
                {
                    id: "effort",
                    name: "Thinking Effort",
                    category: "thought_level",
                    type: "select",
                    currentValue: effort.effort ?? "off",
                    options: effort.supportedEfforts.map((value) => ({ value, name: value })),
                },
            ],
            _meta: {
                plurnk: {
                    workspaceId,
                    workerId,
                    model,
                    spawnModel,
                    effort,
                    capabilities,
                },
            },
        };
    }

    static #extractPromptText(promptParam: unknown): string {
        if (typeof promptParam === "string") return promptParam;
        if (!Array.isArray(promptParam)) return "";
        const parts: string[] = [];
        for (const block of promptParam) {
            if (!isRecord(block)) continue;
            if (block.type === "text" && typeof block.text === "string") {
                parts.push(block.text);
            } else if (block.type === "resource_link" && typeof block.uri === "string") {
                parts.push(block.uri);
            } else if (block.type === "resource" && isRecord(block.resource)) {
                if (typeof block.resource.text === "string") parts.push(block.resource.text);
                else if (typeof block.resource.uri === "string") parts.push(block.resource.uri);
            }
        }
        return parts.join("\n");
    }

    async #dispatchRpc(
        peer: AcpPeer,
        method: string,
        params: Readonly<Record<string, unknown>>,
        req: IncomingMessage,
    ): Promise<unknown> {
        switch (method) {
            case "initialize": {
                const face = this.#seam.credentials.face();
                const issuer = face?.issuer(req);
                return {
                    protocolVersion: 2,
                    agentInfo: {
                        name: "plurnk",
                        title: "Plurnk Service",
                        version: "1.0.0",
                    },
                    agentCapabilities: {
                        loadSession: true,
                        promptCapabilities: {
                            image: true,
                            audio: true,
                            embeddedContext: true,
                        },
                        sessionCapabilities: {
                            list: {},
                            fork: {},
                            resume: {},
                            close: {},
                        },
                    },
                    authMethods: issuer === undefined ? [] : [{
                        id: "oauth2",
                        name: "Plurnk OAuth 2.1",
                        type: "oauth2",
                        issuer,
                        metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
                        scope: ACP_SCOPE,
                    }],
                };
            }
            case "session/new": {
                const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk) ? params._meta.plurnk : {};
                const workspaceIdParam = typeof params.workspaceId === "number" ? params.workspaceId : metaPlurnk.workspaceId;
                const workspaceNameParam = typeof params.workspaceName === "string" ? params.workspaceName : metaPlurnk.workspaceName;
                const cwdParam = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;

                let workspace;
                if (typeof workspaceIdParam === "number" && isSafeInteger(workspaceIdParam) && workspaceIdParam > 0) {
                    workspace = await this.#seam.attachWorkspace({ workspaceId: workspaceIdParam });
                } else if (typeof workspaceNameParam === "string" && workspaceNameParam.length > 0) {
                    try {
                        workspace = await this.#seam.attachWorkspace({ name: workspaceNameParam });
                    } catch {
                        workspace = await this.#seam.createWorkspace({ name: workspaceNameParam, projectRoot: cwdParam });
                    }
                } else if (cwdParam !== null) {
                    workspace = await this.#seam.attachWorkspace({ projectRoot: cwdParam });
                } else {
                    workspace = await this.#seam.createWorkspace({ projectRoot: null });
                }
                await this.#seam.registerWorkerOwner(workspace.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                const requestedWorkerName = typeof params.workerName === "string" && params.workerName.length > 0
                    ? params.workerName
                    : typeof metaPlurnk.workerName === "string" && metaPlurnk.workerName.length > 0
                        ? metaPlurnk.workerName
                        : undefined;
                let workerId: number;
                let workerName: string;
                if (requestedWorkerName !== undefined) {
                    const existing = await this.#seam.readWorker({
                        workspaceId: workspace.workspaceId,
                        identity: { name: requestedWorkerName },
                    });
                    if (existing !== null) {
                        workerId = existing.id;
                        workerName = existing.name;
                    } else {
                        const created = await this.#seam.createWorker({
                            workspaceId: workspace.workspaceId,
                            name: requestedWorkerName,
                            owner: MessageAddress.OWNER,
                        });
                        workerId = created.workerId;
                        workerName = created.workerName;
                    }
                } else {
                    const created = await this.#seam.createWorker({
                        workspaceId: workspace.workspaceId,
                        owner: MessageAddress.OWNER,
                    });
                    workerId = created.workerId;
                    workerName = created.workerName;
                }
                await this.#seam.claimWorkerOwner({
                    workspaceId: workspace.workspaceId,
                    workerId,
                    owner: MessageAddress.OWNER,
                });
                const sessionId = SessionAddress.format(workspace.workspaceId, workerName);
                const bound: BoundSession = {
                    sessionId,
                    workspaceId: workspace.workspaceId,
                    workerId,
                    workerName,
                    translator: new Translator({
                        sessionId,
                        workspaceId: workspace.workspaceId,
                        workerId,
                        origin: peer.origin,
                        historyPageChars: this.#opts.historyPageChars,
                    }),
                };
                peer.sessions.set(sessionId, bound);
                return {
                    sessionId,
                    workspaceId: workspace.workspaceId,
                    workerId,
                    workerName,
                    ...(await this.#sessionConfigState(workspace.workspaceId, workerId)),
                };
            }
            case "session/load":
            case "session/resume": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        `${method} requires a non-empty sessionId.`,
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = await this.#resolveSession(params.sessionId, peer.origin, params.create === true);
                await this.#seam.registerWorkerOwner(bound.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                await this.#seam.claimWorkerOwner({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    owner: MessageAddress.OWNER,
                });
                peer.sessions.set(bound.sessionId, bound);
                const [entries, inbox, proposals, interactions] = await Promise.all([
                    this.#seam.readLog({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.readInbox({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.pendingProposals(bound.workspaceId),
                    this.#seam.pendingClientInteractions(bound.workspaceId),
                ]);
                const beforeLoopSeq = typeof params.beforeLoopSeq === "number" && isSafeInteger(params.beforeLoopSeq)
                    ? params.beforeLoopSeq
                    : undefined;
                const replayed = Translator.replay(bound.translator, entries, inbox, {
                    historyLoops: this.#opts.historyLoops,
                    ...(beforeLoopSeq === undefined ? {} : { beforeLoopSeq }),
                });
                for (const update of replayed.updates) {
                    peer.sendNotification("session/update", update);
                }
                for (const proposal of proposals) {
                    if (proposal.workerId === bound.workerId) {
                        this.#emitProposalToPeer(peer, bound, proposal);
                    }
                }
                for (const interaction of interactions) {
                    if (interaction.workerId === bound.workerId) {
                        this.#emitInteractionToPeer(peer, bound, interaction);
                    }
                }
                return {
                    sessionId: bound.sessionId,
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    workerName: bound.workerName,
                    hasMore: replayed.hasMore,
                    beforeLoopSeq: replayed.beforeLoopSeq,
                    ...(await this.#sessionConfigState(bound.workspaceId, bound.workerId)),
                };
            }
            case "session/list": {
                const includeHidden = params.includeHidden === true;
                const workspaces = await this.#seam.listWorkspaces(includeHidden ? {} : { hidden: false });
                const sessions: Array<Record<string, unknown>> = [];
                for (const ws of workspaces) {
                    const workers = await this.#seam.listWorkers(ws.id, {
                        origin: "model",
                        ...(includeHidden ? {} : { hidden: false }),
                    });
                    for (const worker of workers) {
                        sessions.push({
                            sessionId: SessionAddress.format(ws.id, worker.name),
                            workspaceId: ws.id,
                            workspaceName: ws.name,
                            cwd: ws.project_root,
                            projectLabel: ws.project_label,
                            workerId: worker.id,
                            workerName: worker.name,
                            kind: worker.kind,
                            lifecycle: worker.lifecycle,
                            updatedAt: worker.created_at,
                            hiddenAt: worker.hidden_at,
                        });
                    }
                }
                return { sessions };
            }
            case "session/fork": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/fork requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = await this.#resolveSession(params.sessionId, peer.origin);
                const forked = await this.#seam.forkWorker({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    ...(typeof params.name === "string" && params.name.length > 0 ? { name: params.name } : {}),
                });
                const forkedName = forked.workerName ?? String(forked.workerId);
                const forkedSessionId = SessionAddress.format(bound.workspaceId, forkedName);
                return {
                    sessionId: forkedSessionId,
                    workspaceId: bound.workspaceId,
                    workerId: forked.workerId,
                    workerName: forked.workerName,
                    parentWorkerId: forked.parentWorkerId,
                };
            }
            case "session/close": {
                if (typeof params.sessionId === "string") {
                    peer.sessions.delete(params.sessionId);
                }
                return { closed: true };
            }
            case "session/prompt": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/prompt requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const promptText = Module.#extractPromptText(params.prompt);
                if (promptText.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/prompt requires non-empty prompt content.",
                        { field: "prompt", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId)
                    ?? await this.#resolveSession(params.sessionId, peer.origin, true);
                peer.sessions.set(bound.sessionId, bound);
                await this.#seam.registerWorkerOwner(bound.workspaceId, {
                    address: MessageAddress.OWNER,
                    tools: [],
                    interactive: true,
                });
                await this.#seam.claimWorkerOwner({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    owner: MessageAddress.OWNER,
                });
                const messageId = typeof params.messageId === "string" && params.messageId.length > 0
                    ? params.messageId
                    : crypto.randomUUID();
                const submission = MessageAddress.submission(bound.sessionId, messageId, promptText);
                const admission = await this.#seam.runLoop({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    prompt: promptText,
                    ...submission,
                    ...(this.#opts.maxTurns === undefined ? {} : { maxTurns: this.#opts.maxTurns }),
                    ...(typeof params.selector === "string" && params.selector.length > 0 ? { selector: params.selector } : {}),
                });
                if (params.wait === false) {
                    return {
                        stopReason: "end_turn",
                        loopId: admission.loopId,
                        action: admission.action,
                    };
                }
                const terminated = await new Promise<TerminatedNotification>((resolve, reject) => {
                    const waiter: LoopWaiter = {
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        loopId: admission.loopId,
                        resolve: (notification) => {
                            this.#loopWaiters.delete(waiter);
                            resolve(notification);
                        },
                        reject: (problem) => {
                            this.#loopWaiters.delete(waiter);
                            reject(new HttpProblemError(problem));
                        },
                    };
                    this.#loopWaiters.add(waiter);
                });
                const stopReason = terminated.hitMaxTurns || terminated.result.status === 429
                    ? "max_turn_requests"
                    : terminated.result.status === 499
                        ? "cancelled"
                        : terminated.result.status >= 400
                            ? "refusal"
                            : "end_turn";
                return {
                    stopReason,
                    loopId: terminated.loopId,
                    loopSeq: terminated.loopSeq,
                    result: terminated.result,
                    usage: terminated.usage,
                };
            }
            case "session/cancel": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        "session/cancel requires a non-empty sessionId.",
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin);
                const cancelled = this.#seam.cancelDrain(
                    bound.workerId,
                    typeof params.reason === "string" && params.reason.length > 0 ? params.reason : "user_cancelled",
                );
                return { cancelled };
            }
            case "session/set_config_option":
            case "session/set_mode": {
                if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
                    throw new HttpProblemError(acpProblem(
                        "invalid-action-parameters",
                        400,
                        `${method} requires a non-empty sessionId.`,
                        { field: "sessionId", retryable: false },
                    ));
                }
                const bound = peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin);
                const configId = method === "session/set_mode"
                    ? "mode"
                    : typeof params.configId === "string"
                        ? params.configId
                        : "";
                const value = method === "session/set_mode" ? params.modeId : params.value;
                if (configId === "model") {
                    if (typeof value !== "string" || value.length === 0) {
                        throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "Model selector must be a non-empty string."));
                    }
                    await this.#seam.setWorkerModel({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        selector: value,
                    });
                } else if (configId === "effort") {
                    await this.#seam.setWorkerEffort({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        effort: value,
                    });
                } else if (configId === "spawn_model") {
                    if (value !== null && typeof value !== "string") {
                        throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "spawn_model must be a string or null."));
                    }
                    await this.#seam.setWorkerSpawnModel({
                        workspaceId: bound.workspaceId,
                        workerId: bound.workerId,
                        selector: value,
                    });
                } else if (configId === "mode" && isRecord(params.policy)) {
                    await this.#seam.setWorkspaceCapabilities({
                        workspaceId: bound.workspaceId,
                        policy: Validator.assertCapabilityPolicy(params.policy),
                    });
                }
                return await this.#sessionConfigState(bound.workspaceId, bound.workerId);
            }
            case "session/resolve_permission": {
                const logEntryId = typeof params.logEntryId === "number" ? params.logEntryId : Number(params.toolCallId);
                const workspaceId = typeof params.workspaceId === "number"
                    ? params.workspaceId
                    : typeof params.sessionId === "string"
                        ? (await this.#resolveSession(params.sessionId, peer.origin)).workspaceId
                        : 0;
                if (!isSafeInteger(logEntryId) || logEntryId < 1 || !isSafeInteger(workspaceId) || workspaceId < 1) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "session/resolve_permission requires workspaceId (or sessionId) and logEntryId."));
                }
                const rawDecision = typeof params.decision === "string" ? params.decision : params.optionId;
                const decision: ProposalDecision = rawDecision === "accept" || rawDecision === "allow_once" || rawDecision === "allow_always"
                    ? "accept"
                    : rawDecision === "reject" || rawDecision === "reject_once" || rawDecision === "reject_always"
                        ? "reject"
                        : "cancel";
                await this.#seam.resolveProposal(
                    logEntryId,
                    {
                        decision,
                        ...(typeof params.body === "string" ? { body: params.body } : {}),
                        ...(typeof params.outcome === "string" ? { outcome: params.outcome } : {}),
                    },
                    { workspaceId, address: MessageAddress.OWNER },
                );
                return { resolved: true };
            }
            case "_plurnk/interaction.resolve": {
                const interactionId = Number(params.interactionId);
                const workspaceId = typeof params.workspaceId === "number"
                    ? params.workspaceId
                    : typeof params.sessionId === "string"
                        ? (await this.#resolveSession(params.sessionId, peer.origin)).workspaceId
                        : 0;
                if (!isSafeInteger(interactionId) || interactionId < 1 || !isSafeInteger(workspaceId) || workspaceId < 1) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "_plurnk/interaction.resolve requires workspaceId (or sessionId) and interactionId."));
                }
                const resolution: ClientInteractionResolution = params.status === "cancelled"
                    ? { status: "cancelled" }
                    : { status: "resolved", ...(Object.hasOwn(params, "payload") ? { payload: params.payload } : {}) };
                await this.#seam.resolveClientInteraction(
                    interactionId,
                    resolution,
                    { workspaceId, address: MessageAddress.OWNER },
                );
                return { resolved: true };
            }
            case "_plurnk/discover": {
                const display = await this.#seam.listClientDisplayCapabilities();
                const moduleActions = Object.fromEntries(
                    this.#seam.listModuleActions().map((a) => [a.name, { scope: a.scope, inputSchema: a.inputSchema, outputSchema: a.outputSchema }]),
                );
                return {
                    protocolVersion: 2,
                    actions: moduleActions,
                    notifications: APPLICATION_NOTIFICATIONS,
                    display,
                    configurationNotices: this.#seam.configurationNotices(),
                };
            }
            case "_plurnk/overview": {
                const workspaceId = typeof params.workspaceId === "number" && isSafeInteger(params.workspaceId) && params.workspaceId > 0
                    ? params.workspaceId
                    : undefined;
                return await this.#seam.readWorkerOverview({
                    ...(workspaceId === undefined ? {} : { workspaceId }),
                    limit: this.#opts.overviewWorkers,
                    excerptChars: this.#opts.excerptChars,
                });
            }
            case "_plurnk/action": {
                const kind = typeof params.kind === "string" ? params.kind : "";
                const actionParams = isRecord(params.params) ? params.params : {};
                if (kind.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "_plurnk/action requires a non-empty action kind."));
                }
                const bound = typeof params.sessionId === "string" && params.sessionId.length > 0
                    ? peer.sessions.get(params.sessionId) ?? await this.#resolveSession(params.sessionId, peer.origin)
                    : undefined;
                const workspaceId = typeof params.workspaceId === "number" && isSafeInteger(params.workspaceId) && params.workspaceId > 0
                    ? params.workspaceId
                    : bound?.workspaceId;
                const workerId = typeof params.workerId === "number" && isSafeInteger(params.workerId) && params.workerId > 0
                    ? params.workerId
                    : bound?.workerId;
                return await this.#executeAction(kind, actionParams, workspaceId, workerId);
            }
            default:
                throw new HttpProblemError(acpProblem(
                    "route-not-found",
                    404,
                    `Unknown ACP method '${method}'.`,
                    { method, stage: "routing", retryable: false },
                ));
        }
    }

    async #executeAction(
        kind: string,
        p: Readonly<Record<string, unknown>>,
        workspaceId?: number,
        workerId?: number,
    ): Promise<unknown> {
        switch (kind) {
            case "ping":
                return {};
            case "providers.list":
                return this.#seam.listProviders();
            case "models.list":
                return this.#seam.listModels(Validator.assertModelCatalogQuery(p));
            case "workspace.list":
                return { workspaces: await this.#seam.listWorkspaces(p.includeHidden === true ? {} : { hidden: false }) };
            case "workspace.create": {
                const created = await this.#seam.createWorkspace({
                    ...(typeof p.name === "string" ? { name: p.name } : {}),
                    ...(typeof p.projectRoot === "string" || p.projectRoot === null ? { projectRoot: p.projectRoot } : {}),
                    ...(typeof p.settings === "string" || isRecord(p.settings) ? { settings: p.settings } : {}),
                });
                return { id: created.workspaceId, name: created.workspaceName };
            }
            case "workspace.attach": {
                const selector = typeof p.id === "number" ? { workspaceId: p.id }
                    : typeof p.name === "string" ? { name: p.name }
                        : typeof p.projectRoot === "string" ? { projectRoot: p.projectRoot } : null;
                if (selector === null) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.attach requires id, name or projectRoot."));
                }
                const attached = await this.#seam.attachWorkspace(selector);
                return { id: attached.workspaceId, name: attached.workspaceName };
            }
        }
        const moduleAction = this.#seam.listModuleActions().find((a) => a.name === kind);
        if (moduleAction !== undefined) {
            if (moduleAction.scope === "daemon") {
                return await this.#seam.invokeModuleAction(kind, p, { scope: "daemon" });
            }
            if (workspaceId === undefined) {
                throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workspaceId or sessionId.`));
            }
            if (moduleAction.scope === "workspace") {
                return await this.#seam.invokeModuleAction(kind, p, { scope: "workspace", workspaceId });
            }
            if (workerId === undefined) {
                throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workerId or sessionId.`));
            }
            return await this.#seam.invokeModuleAction(kind, p, { scope: "worker", workspaceId, workerId });
        }
        if (workspaceId === undefined) {
            throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, `Action '${kind}' requires a workspaceId or sessionId.`));
        }
        switch (kind) {
            case "workspace.workers":
                return {
                    workers: await this.#seam.listWorkers(
                        typeof p.id === "number" ? p.id : workspaceId,
                        p.includeHidden === true ? {} : { hidden: false },
                    ),
                };
            case "workspace.rename": {
                if (typeof p.name !== "string" || p.name.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.rename requires a non-empty name."));
                }
                return await this.#seam.renameWorkspace(workspaceId, p.name);
            }
            case "workspace.share": {
                if (typeof p.folder !== "string" || p.folder.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.share requires a non-empty folder."));
                }
                return await this.#seam.shareWorkspace({ workspaceId, folder: p.folder });
            }
            case "workspace.hidden.set":
                return await this.#seam.setWorkspaceHidden({ workspaceId, hidden: p.hidden === true });
            case "worker.hidden.set": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "worker.hidden.set requires workerId."));
                }
                return await this.#seam.setWorkerHidden({ workspaceId, workerId: targetWorkerId, hidden: p.hidden === true });
            }
            case "workspace.rollback": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined || typeof p.to !== "string" || p.to.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "workspace.rollback requires workerId and coordinate 'to'."));
                }
                return await this.#seam.rollback({
                    workspaceId,
                    workerId: targetWorkerId,
                    actor: MessageAddress.OWNER,
                    to: p.to,
                });
            }
            case "workspace.prompts": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                return {
                    prompts: await this.#seam.listPrompts(
                        workspaceId,
                        typeof p.limit === "number" ? p.limit : undefined,
                        targetWorkerId,
                    ),
                };
            }
            case "worker.loops": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "worker.loops requires workerId."));
                }
                const loops = await this.#seam.listWorkerLoops({ workspaceId, workerId: targetWorkerId });
                return {
                    loops: loops.map((loop) => {
                        const { excerpt: opening, continued } = excerptOf(loop.prompt, this.#opts.excerptChars);
                        return {
                            id: loop.id,
                            sequence: loop.sequence,
                            lifecycle: lifecycleOfLoopStatus(loop.status),
                            source: loop.promptSource,
                            opening,
                            continued,
                        };
                    }),
                };
            }
            case "log.read": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "log.read requires workerId."));
                }
                return {
                    entries: await this.#seam.readLog({
                        workspaceId,
                        workerId: targetWorkerId,
                        ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
                        ...(typeof p.sinceId === "number" ? { sinceId: p.sinceId } : {}),
                        ...(typeof p.loopId === "number" ? { loopId: p.loopId } : {}),
                        ...(typeof p.turnId === "number" ? { turnId: p.turnId } : {}),
                        ...(typeof p.loopSeq === "number" ? { loopSeq: p.loopSeq } : {}),
                        ...(typeof p.turnSeq === "number" ? { turnSeq: p.turnSeq } : {}),
                        ...(typeof p.sequence === "number" ? { sequence: p.sequence } : {}),
                    }),
                };
            }
            case "entry.read": {
                const targetWorkerId = typeof p.workerId === "number" ? p.workerId : workerId;
                if (targetWorkerId === undefined || typeof p.target !== "string" || p.target.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "entry.read requires workerId and target."));
                }
                return await this.#seam.readEntry({
                    workspaceId,
                    workerId: targetWorkerId,
                    target: p.target,
                    ...(typeof p.channel === "string" ? { channel: p.channel } : {}),
                    ...(typeof p.offset === "number" ? { offset: p.offset } : {}),
                });
            }
            case "op.exec": {
                if (typeof p.command !== "string" || p.command.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "op.exec requires a non-empty command."));
                }
                const statement: ExecStatement = {
                    runtime: "sh",
                    aside: null,
                    target: null,
                    metadata: p.env === undefined ? null : [JSON.stringify({ env: p.env })],
                    lineMarker: null,
                    body: p.command,
                    position: UNKNOWN_POSITION,
                };
                const [result] = await this.#seam.dispatchClientAction({
                    workspaceId,
                    actor: MessageAddress.OWNER,
                    ...(workerId === undefined ? {} : { contextWorkerId: workerId }),
                    statements: [statement],
                });
                return result;
            }
            case "op.parse": {
                if (typeof p.text !== "string" || p.text.length === 0) {
                    throw new HttpProblemError(acpProblem("invalid-action-parameters", 400, "op.parse requires non-empty PLURNK text."));
                }
                const parsed = PlurnkParser.parseStatements(p.text, { executors: this.#seam.executorTags(workspaceId) });
                const results: Array<OperationResult | null> = [];
                const statements: PlurnkStatement[] = [];
                for (const item of parsed.items) {
                    if (item.kind === "error") {
                        results.push({
                            status: 400,
                            problem: acpProblem("parse-failed", 400, item.error.message, {
                                line: item.error.line,
                                column: item.error.column,
                                source: item.error.source,
                                severity: item.error.severity,
                                stage: "parsing",
                                retryable: false,
                            }),
                        });
                        continue;
                    }
                    if (item.kind === "statement") {
                        statements.push(item.statement);
                        results.push(null);
                    }
                }
                if (parsed.unparsedTail !== undefined) {
                    results.push({
                        status: 400,
                        problem: acpProblem("parse-failed", 400, parsed.unparsedTail.reason, {
                            line: parsed.unparsedTail.from.line,
                            column: parsed.unparsedTail.from.column,
                            source: "grammar",
                            severity: "error",
                            stage: "parsing",
                            retryable: false,
                        }),
                    });
                }
                const dispatched = statements.length === 0
                    ? []
                    : await this.#seam.dispatchClientAction({
                        workspaceId,
                        actor: MessageAddress.OWNER,
                        ...(workerId === undefined ? {} : { contextWorkerId: workerId }),
                        statements,
                    });
                let idx = 0;
                for (let i = 0; i < results.length; i++) {
                    if (results[i] === null) results[i] = dispatched[idx++]!;
                }
                return { results };
            }
            case "workspace.capabilities.get":
                return await this.#seam.readWorkspaceCapabilities({ workspaceId });
            case "workspace.capabilities.set":
                return await this.#seam.setWorkspaceCapabilities({
                    workspaceId,
                    policy: Validator.assertCapabilityPolicy(p.policy),
                });
            default:
                throw new HttpProblemError(acpProblem("route-not-found", 404, `Unknown action '${kind}'.`));
        }
    }

    #emitProposalToPeer(peer: AcpPeer, bound: BoundSession, proposal: ProposalProjection): void {
        const reqId = `perm:${this.#nextServerRequestId++}`;
        const leanProposal = { ...proposal, attrs: withoutBodies(proposal.attrs) };
        const targetText = [proposal.target.scheme, proposal.target.authority, proposal.target.pathname]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("");
        peer.sendRequest(
            reqId,
            "session/request_permission",
            {
                sessionId: bound.sessionId,
                toolCall: {
                    toolCallId: String(proposal.logEntryId),
                    title: `${proposal.op} (${targetText})`,
                    kind: Translator.toolKindOf(proposal.op, null),
                    status: "pending",
                    rawInput: { body: proposal.body, target: proposal.target },
                    _meta: { plurnk: { proposal: leanProposal } },
                },
                options: [
                    { optionId: "accept", name: "Accept", kind: "allow_once" },
                    { optionId: "reject", name: "Reject", kind: "reject_once" },
                    { optionId: "cancel", name: "Cancel", kind: "reject_once" },
                ],
                _meta: { plurnk: { proposal: leanProposal } },
            },
            { kind: "proposal", workspaceId: bound.workspaceId, targetId: proposal.logEntryId },
        );
    }

    #emitInteractionToPeer(peer: AcpPeer, bound: BoundSession, interaction: ClientInteractionProjection): void {
        const reqId = `int:${this.#nextServerRequestId++}`;
        peer.sendRequest(
            reqId,
            "_plurnk/question",
            {
                sessionId: bound.sessionId,
                interactionId: interaction.interactionId,
                toolName: interaction.request.toolName,
                message: interaction.request.message ?? "Provide the requested input.",
                arguments: interaction.request.arguments,
                responseSchema: interaction.request.responseSchema,
                _meta: { plurnk: { interaction } },
            },
            { kind: "interaction", workspaceId: bound.workspaceId, targetId: interaction.interactionId },
        );
    }

    static #readNotification<T>(method: string, contract: ApplicationNotificationContract<T>, params: unknown): T {
        Validator.assertJsonSchemaInstance(`${method} notification`, contract.payloadSchema, params);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the payload schema just proved the shape the table names
        return params as T;
    }

    #onDaemonEvent(workspaceId: number | null, method: string, params: unknown): void {
        if (workspaceId === null) return;
        const contracts: Readonly<Record<string, ApplicationNotificationContract>> = APPLICATION_NOTIFICATIONS;
        const contract = contracts[method];
        if (contract !== undefined) {
            Module.#readNotification(method, contract, params);
        }

        if (method === "loop/terminated") {
            const terminated = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/terminated"], params);
            for (const waiter of [...this.#loopWaiters]) {
                if (waiter.workspaceId === workspaceId && waiter.workerId === terminated.workerId && waiter.loopId === terminated.loopId) {
                    waiter.resolve(terminated);
                }
            }
        }

        for (const peer of this.#peers) {
            for (const bound of peer.sessions.values()) {
                if (bound.workspaceId !== workspaceId) continue;
                let updates: AcpSessionUpdate[] = [];
                switch (method) {
                    case "log/entry":
                        updates = bound.translator.logEntry(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["log/entry"], params));
                        break;
                    case "reasoning/event":
                        updates = bound.translator.reasoning(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["reasoning/event"], params));
                        break;
                    case "outside/event":
                        updates = bound.translator.outside(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["outside/event"], params));
                        break;
                    case "loop/packet":
                        updates = bound.translator.packet(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/packet"], params));
                        break;
                    case "loop/terminated":
                        updates = bound.translator.terminated(Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/terminated"], params));
                        break;
                    case "loop/proposal": {
                        const proposal = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/proposal"], params);
                        if (proposal.workerId === bound.workerId) {
                            this.#emitProposalToPeer(peer, bound, proposal);
                        }
                        break;
                    }
                    case "loop/interaction": {
                        const interaction = Module.#readNotification(method, APPLICATION_NOTIFICATIONS["loop/interaction"], params);
                        if (interaction.workerId === bound.workerId) {
                            this.#emitInteractionToPeer(peer, bound, interaction);
                        }
                        break;
                    }
                    case "notice/event":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/notice",
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                    case "stream/event":
                    case "stream/concluded":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/stream",
                                event: method,
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                    case "workspace/preparation":
                        updates = [{
                            sessionId: bound.sessionId,
                            update: {
                                sessionUpdate: "_plurnk/workspace/preparation",
                                ...(isRecord(params) ? params : {}),
                            },
                        }];
                        break;
                }
                for (const update of updates) {
                    peer.sendNotification("session/update", update);
                }
            }
        }
    }
}
