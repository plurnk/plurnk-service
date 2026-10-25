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
    type AgentContext,
    type AvailableCommand,
    type CloseSessionResponse,
    type ContentBlock,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type NewSessionResponse,
    type PromptResponse,
    type ResumeSessionResponse,
    type SessionConfigOption,
    type SessionInfo,
    type SessionUpdate,
    type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    Validator,
    isRecord,
    isSafeInteger,
    lifecycleOfLoopStatus,
    selectWorkerLoop,
    type AcpDiscovery,
    type ApplicationLoopPacket,
    type ClientInteractionProjection,
    type OutsideEventNotification,
    type ProblemDetails,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { MessageScheme, type SchemeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import SessionTranslator, {
    interactionElicitationRequest,
    interactionResolutionFromResponse,
    interactionToolCall,
    interactionToolCallResult,
    proposalKey,
    proposalPermissionRequest,
    proposalToolCall,
    resolutionFromPermissionResponse,
} from "./SessionTranslator.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";

export type { ModuleOptions } from "./config.ts";

const HEADER_CONNECTION_ID = "Acp-Connection-Id";
const OWNER_ADDRESS = "acp:///owner";

const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
    { name: "mcp", description: "Manage workspace MCP servers" },
    { name: "skills", description: "Manage workspace skills" },
    { name: "a2a", description: "Manage workspace A2A agents" },
    { name: "members", description: "Manage workspace members" },
    { name: "env", description: "Manage workspace environment variables" },
    { name: "schedule", description: "Manage workspace schedules" },
    { name: "rollback", description: "Roll back reversible session operations" },
    { name: "share", description: "Write a diagnostic digest of the workspace" },
    { name: "script", description: "Execute PLURNK statements directly" },
]);

const httpProblem = (
    slug: string,
    status: number,
    detail: string,
    fields: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("acp:http", slug, status, detail, { code: `acp/http/${slug}`, ...fields });

const serviceStoppingProblem = (): ProblemDetails =>
    httpProblem("service-stopping", 503, "The PLURNK service is shutting down.", {
        stage: "shutdown",
        retryable: true,
    });

const credentialRevokedProblem = (): ProblemDetails =>
    httpProblem("credential-revoked", 401, "The credential this stream was admitted under has been revoked.", {
        stage: "authorization",
        recovery: "Obtain a new access token from this daemon's token endpoint.",
        retryable: false,
    });

const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

const formatSessionId = (workspaceId: number, workerName: string): string => `${workspaceId}#${workerName}`;

const parseSessionId = (raw: string): { readonly workspaceId: number; readonly workerName: string } | null => {
    const idx = raw.indexOf("#");
    if (idx <= 0 || idx === raw.length - 1) return null;
    const prefix = raw.slice(0, idx);
    if (!/^[1-9]\d*$/.test(prefix)) return null;
    const wsId = Number(prefix);
    const workerName = raw.slice(idx + 1);
    if (!isSafeInteger(wsId) || wsId <= 0 || workerName.length === 0) return null;
    return { workspaceId: wsId, workerName };
};

export type AcpSetupSeam = SchemeRegistrationSeam & Pick<ApplicationPort, "httpAddress">;

interface BoundSession {
    readonly sessionId: string;
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly workerId: number;
    readonly workerName: string;
    readonly translator: SessionTranslator;
}

interface AcpPeer {
    readonly family: string | null;
    readonly sessions: Map<string, BoundSession>;
    client: AgentContext | null;
    closeTransport?: () => void;
    closeWithProblem(problem: ProblemDetails): Promise<void>;
}

interface ActiveGate {
    readonly key: string;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly kind: "proposal" | "interaction";
    readonly proposal?: ProposalProjection;
    readonly interaction?: ClientInteractionProjection;
    readonly peerControllers: Map<AcpPeer, AbortController>;
    settled: boolean;
}

interface RequestConnectionContext {
    readonly family: string | null;
}

const isLogEntryPayload = (v: unknown): v is Parameters<SessionTranslator["logEntry"]>[0] => isRecord(v);
const isOutsideEvent = (v: unknown): v is OutsideEventNotification =>
    isRecord(v) && typeof v.workerId === "number";
const isLoopPacket = (v: unknown): v is ApplicationLoopPacket =>
    isRecord(v) && typeof v.workerId === "number";
const isProposalProjection = (v: unknown): v is ProposalProjection =>
    isRecord(v) && typeof v.workerId === "number";
const isClientInteractionProjection = (v: unknown): v is ClientInteractionProjection =>
    isRecord(v) && typeof v.workerId === "number";

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
    readonly #activeGates = new Map<string, ActiveGate>();
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
        seam.registerHttpUpgrade?.("/acp", (req, socket, head) =>
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
        const subscribeFn: (cb: (first: unknown, second?: string, third?: unknown) => void) => () => void =
            Reflect.get(seam, "subscribeToEvents").bind(seam);
        this.#offEvents = subscribeFn((first: unknown, second?: string, third?: unknown) => {
            if (typeof first === "number") {
                if (typeof second === "string") {
                    this.#onDaemonEvent(first, second, third);
                }
                return;
            }
            if (isRecord(first) && typeof first.type === "string") {
                const wsId = typeof first.workspaceId === "number" ? first.workspaceId : 1;
                const method = first.type;
                const payload =
                    method === "log/entry"
                        ? { entry: first.entry }
                        : method === "loop/proposal" && isRecord(first.proposal)
                          ? first.proposal
                          : method === "loop/interaction" && isRecord(first.interaction)
                            ? first.interaction
                            : first;
                this.#onDaemonEvent(wsId, method, payload);
            }
        });

        const onRevokeHandler = (family: string): void => {
            const problem = credentialRevokedProblem();
            for (const peer of [...this.#peers]) {
                if (peer.family === family) {
                    void peer.closeWithProblem(problem);
                    this.#peers.delete(peer);
                }
            }
        };
        if (typeof seam.credentials.onRevoked === "function") {
            this.#offRevoked = seam.credentials.onRevoked(onRevokeHandler);
        } else if (isRecord(seam.credentials) && typeof seam.credentials.onRevoke === "function") {
            this.#offRevoked = Reflect.apply(seam.credentials.onRevoke, seam.credentials, [onRevokeHandler]);
        }
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
        for (const gate of this.#activeGates.values()) {
            gate.settled = true;
            for (const ctrl of gate.peerControllers.values()) ctrl.abort();
            gate.peerControllers.clear();
        }
        this.#activeGates.clear();
        this.#streamOffsets.clear();
        const stopping = serviceStoppingProblem();
        const closingPeers = [...this.#peers];
        this.#peers.clear();
        await Promise.allSettled(closingPeers.map((peer) => peer.closeWithProblem(stopping)));
        await this.#acpServer.close();
        await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
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
        const addr = this.#seam.httpAddress?.();
        if (addr && typeof addr.host === "string" && typeof addr.port === "number") {
            return `http://${addr.host}:${addr.port}`;
        }
        return "";
    }

    #applyCorsHeaders(res: ServerResponse): void {
        res.setHeader("access-control-allow-origin", this.#opts.allowOrigin);
        res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader(
            "access-control-allow-headers",
            "authorization, content-type, acp-connection-id, acp-session-id, accept",
        );
        res.setHeader("access-control-expose-headers", "acp-connection-id, acp-session-id");
    }

    async #admit(
        req: IncomingMessage,
        allowQueryToken = false,
    ): Promise<
        | { readonly ok: true; readonly family: string | null }
        | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string }
    > {
        const creds: Record<string, unknown> = isRecord(this.#seam.credentials) ? this.#seam.credentials : {};
        if (typeof creds.verifyBearer === "function") {
            const mode = typeof creds.mode === "function" ? String(Reflect.apply(creds.mode, this.#seam.credentials, [])) : "none";
            if (mode === "none") return { ok: true, family: null };
            let authHeader = req.headers.authorization;
            if (authHeader === undefined && allowQueryToken) {
                const url = new URL(req.url ?? "/acp", "http://listener");
                const queryToken = url.searchParams.get("access_token");
                if (queryToken !== null) authHeader = `Bearer ${queryToken}`;
            }
            const rawVerified: unknown = await Reflect.apply(creds.verifyBearer, this.#seam.credentials, [authHeader, "acp"]);
            const verified = isRecord(rawVerified) ? rawVerified : {};
            if (verified.ok === true) {
                const grant = isRecord(verified.grant) ? verified.grant : {};
                const family = typeof grant.familyId === "string" ? grant.familyId : null;
                return { ok: true, family };
            }
            const code = typeof verified.code === "string" ? verified.code : "bearer-token-invalid";
            const status = typeof verified.status === "number" ? verified.status : 401;
            const detail = typeof verified.detail === "string" ? verified.detail : "Authentication failed.";
            const challenge =
                typeof verified.wwwAuthenticate === "string" ? verified.wwwAuthenticate : 'Bearer realm="plurnk"';
            return {
                ok: false,
                challenge,
                problem: httpProblem(code, status, detail, { stage: "authorization", retryable: false }),
            };
        }

        const face = this.#seam.credentials.face?.() ?? null;
        const issuer = face?.issuer(req);
        if (face === null || issuer === undefined) {
            return { ok: true, family: null };
        }

        const header = req.headers.authorization;
        const challenge = (parameters: string): string =>
            `Bearer realm="plurnk"${parameters}, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
        let presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
        if (presented === null && allowQueryToken) {
            const url = new URL(req.url ?? "/acp", "http://listener");
            const queryToken = url.searchParams.get("access_token");
            if (queryToken !== null) presented = /^Bearer(?:\s+(.*))?$/iu.exec(`Bearer ${queryToken}`);
        }
        if (presented === null) {
            return {
                ok: false,
                challenge: challenge(""),
                problem: httpProblem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                    stage: "authorization",
                    recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.",
                    retryable: false,
                }),
            };
        }
        const token = (presented[1] ?? "").trim();
        const claims = this.#seam.credentials.verify(token);
        if (claims === null || claims.kind !== "access") {
            return {
                ok: false,
                challenge: challenge(
                    ', error="invalid_token", error_description="The access token is unknown, expired or revoked."',
                ),
                problem: httpProblem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                    stage: "authorization",
                    recovery: "Obtain a new access token from this daemon's token endpoint.",
                    retryable: false,
                }),
            };
        }
        if (!claims.scopes.includes("acp")) {
            return {
                ok: false,
                challenge: challenge(', error="insufficient_scope", scope="acp"'),
                problem: httpProblem(
                    "bearer-scope-insufficient",
                    403,
                    "The access token does not carry the scope acp.",
                    {
                        stage: "authorization",
                        scope: "acp",
                        recovery: "Obtain an access token with the scope acp.",
                        retryable: false,
                    },
                ),
            };
        }
        return { ok: true, family: claims.family };
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        this.#applyCorsHeaders(res);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        const admission = await this.#admit(req);
        if (!admission.ok) {
            res.setHeader("www-authenticate", admission.challenge);
            writeHttpProblem(res, admission.problem);
            return;
        }

        const url = new URL(req.url ?? "/acp", "http://listener");
        const entryMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/entry$/.exec(url.pathname);
        if (entryMatch !== null && req.method === "GET") {
            const workspaceId = Number(entryMatch[1]);
            const workerId = Number(entryMatch[2]);
            const target = url.searchParams.get("target");
            if (!target || target.trim().length === 0) {
                writeHttpProblem(
                    res,
                    httpProblem("entry-target-required", 400, "Query parameter 'target' is required.", {
                        stage: "validation",
                        retryable: false,
                    }),
                );
                return;
            }
            const channel = url.searchParams.get("channel") ?? "body";
            const offsetParam = url.searchParams.get("offset");
            const offset = offsetParam !== null && /^\d+$/.test(offsetParam) ? Number(offsetParam) : undefined;
            const rawReadResult: unknown = await this.#seam.readEntry({
                workspaceId,
                workerId,
                target,
                channel,
                ...(offset !== undefined ? { offset } : {}),
            });
            const readResult = isRecord(rawReadResult) ? rawReadResult : {};
            const directContent = typeof readResult.content === "string" ? readResult.content : undefined;
            const directMimetype = typeof readResult.mimetype === "string" ? readResult.mimetype : undefined;
            const entryChannelVal = isRecord(readResult.entry) && isRecord(readResult.entry.channels)
                ? readResult.entry.channels[channel]
                : undefined;
            const entryObj = isRecord(entryChannelVal) ? entryChannelVal : undefined;
            const content = directContent ?? (typeof entryObj?.content === "string" ? entryObj.content : "");
            const mimetype = directMimetype ?? (typeof entryObj?.mimetype === "string" ? entryObj.mimetype : "text/plain");
            res.writeHead(200, { "content-type": mimetype });
            res.end(content);
            return;
        }

        const messagesMatch = /^\/acp\/([1-9]\d*)\/([1-9]\d*)\/messages$/.exec(url.pathname);
        if (messagesMatch !== null && req.method === "GET") {
            const workspaceId = Number(messagesMatch[1]);
            const workerId = Number(messagesMatch[2]);
            const sessionId = url.searchParams.get("session") ?? `${workspaceId}#user`;
            const beforeParam = url.searchParams.get("before");
            const loopParam = url.searchParams.get("loop");
            const [allEntries, inbox] = await Promise.all([
                this.#seam.readLog({ workspaceId, workerId }),
                this.#seam.readInbox({ workspaceId, workerId }),
            ]);
            let filtered = allEntries;
            if (loopParam !== null && /^\d+$/.test(loopParam)) {
                const targetLoop = Number(loopParam);
                filtered = allEntries.filter((e) => (e.loop_seq ?? e.loop_id ?? 0) === targetLoop);
            } else if (beforeParam !== null && /^\d+$/.test(beforeParam)) {
                const beforeLoop = Number(beforeParam);
                filtered = allEntries.filter((e) => (e.loop_seq ?? e.loop_id ?? 0) < beforeLoop);
            }
            const translator = new SessionTranslator({
                sessionId,
                workspaceId,
                workerId,
                origin: this.#httpOrigin(),
            });
            const replayed = SessionTranslator.replay(translator, filtered, inbox, {
                historyLoops: this.#opts.historyLoops,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    session: sessionId,
                    updates: replayed.map((r) => r.update),
                    history: replayed.history,
                }),
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

    static #writeSocketProblem(
        socket: Duplex,
        problem: ProblemDetails,
        extraHeaders: Readonly<Record<string, string>> = {},
    ): void {
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
            Module.#writeSocketProblem(
                socket,
                httpProblem("route-not-found", 404, "The requested ACP route does not exist.", {
                    stage: "routing",
                    retryable: false,
                }),
            );
            return;
        }
        const admission = await this.#admit(req, true);
        if (!admission.ok) {
            Module.#writeSocketProblem(socket, admission.problem, { "WWW-Authenticate": admission.challenge });
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
            Module.#writeSocketProblem(
                socket,
                httpProblem("request-failed", 500, "Failed to upgrade ACP WebSocket connection.", {
                    stage: "upgrade",
                    retryable: false,
                }),
            );
        }
    }

    #tryListProviders(): {
        readonly aliases: ReturnType<ApplicationPort["listProviders"]>["aliases"] | null;
        readonly problem: ProblemDetails | null;
    } {
        try {
            return { aliases: this.#seam.listProviders().aliases, problem: null };
        } catch (err) {
            const problem =
                Problems.fromError(err) ??
                (isRecord(err) && isRecord(err.problem)
                    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                      (err.problem as unknown as ProblemDetails)
                    : null);
            return { aliases: null, problem };
        }
    }

    async #configOptions(workspaceId: number, workerId: number): Promise<SessionConfigOption[]> {
        const providerCatalog = this.#tryListProviders();
        const aliases = providerCatalog.aliases ?? [];
        const [{ model, spawnModel }, capabilities] = await Promise.all([
            this.#seam.readWorkerModel({ workspaceId, workerId }),
            this.#seam.readWorkspaceCapabilities({ workspaceId }),
        ]);
        const effortInfo = model !== null
            ? await this.#seam.readWorkerEffort({ workspaceId, workerId })
            : { effort: null, supportedEfforts: [] as const };

        const modelOptions = aliases.map((a) => ({
            value: a.alias,
            name: `${a.alias} (${a.provider}/${a.model})`,
            description: a.inputCapacity ? `${Math.round(a.inputCapacity / 1000)}k context` : null,
        }));
        const currentModelValue = model !== null
            ? (model.alias ?? `${model.provider}/${model.model}`)
            : (aliases.find((a) => a.active)?.alias ?? "");
        if (currentModelValue.length > 0 && !modelOptions.some((o) => o.value === currentModelValue)) {
            modelOptions.unshift({
                value: currentModelValue,
                name: currentModelValue,
                description: null,
            });
        }

        const effortLevels = effortInfo.supportedEfforts.length > 0
            ? effortInfo.supportedEfforts
            : (["low", "medium", "high"] as const);
        const currentEffort = effortInfo.effort ?? "medium";

        const spawnOptions = [
            { value: "inherit", name: "Inherit from parent", description: null },
            ...modelOptions,
        ];
        const currentSpawnValue = spawnModel !== null
            ? (spawnModel.alias ?? `${spawnModel.provider}/${spawnModel.model}`)
            : "inherit";

        const wsDeny = isRecord(capabilities) && isRecord(capabilities.workspace) ? capabilities.workspace.deny : undefined;
        const currentPolicy = Array.isArray(wsDeny) && wsDeny.length > 0 ? "deny" : "propose";

        return [
            {
                configId: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: currentModelValue,
                options: modelOptions,
            },
            {
                configId: "thought_level",
                name: "Thinking Effort",
                category: "thought_level",
                type: "select",
                currentValue: currentEffort,
                options: effortLevels.map((lvl) => ({
                    value: lvl,
                    name: lvl,
                    description: null,
                })),
            },
            {
                configId: "spawn_model",
                name: "Child Worker Model",
                category: "model_config",
                type: "select",
                currentValue: currentSpawnValue,
                options: spawnOptions,
            },
            {
                configId: "mode",
                name: "Approval Policy",
                category: "mode",
                type: "select",
                currentValue: currentPolicy,
                options: [
                    { value: "propose", name: "Ask before external mutations", description: null },
                    { value: "allow", name: "Auto-approve all operations", description: null },
                    { value: "deny", name: "Deny gated operations", description: null },
                ],
            },
        ];
    }

    static #assertSinglePortSecurity(params: unknown): void {
        if (!isRecord(params)) return;
        if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
            throw RequestError.invalidParams({
                detail: "Client-supplied mcpServers are forbidden by the single-port security contract.",
            });
        }
        if (params.systemPrompt !== undefined && params.systemPrompt !== null) {
            throw RequestError.invalidParams({
                detail: "Client-supplied systemPrompt overrides are forbidden by the single-port security contract.",
            });
        }
    }

    static #toRequestError(err: unknown): RequestError {
        if (err instanceof RequestError) return err;
        const problem = Problems.fromError(err);
        if (problem !== null) {
            const slug = typeof problem.code === "string" ? problem.code : problem.type;
            return new RequestError(-32000, `${problem.detail} (${slug})`, { ...problem, problem });
        }
        if (isRecord(err) && isRecord(err.problem)) {
            const p = err.problem;
            const detail = typeof p.detail === "string" ? p.detail : "Operation failed.";
            const slug = typeof p.code === "string" ? p.code : typeof p.type === "string" ? p.type : "error";
            return new RequestError(-32000, `${detail} (${slug})`, { ...p, problem: p });
        }
        return RequestError.internalError(err instanceof Error ? { detail: err.message } : undefined);
    }

    async #resolveWorkspace(
        cwd: string | undefined,
        workspaceIdHint: number | undefined,
        workspaceNameHint: string | undefined,
        createIfMissing: boolean,
        explicitProjectRoot?: string | null,
        settings?: Record<string, unknown>,
    ): Promise<{ readonly workspaceId: number; readonly workspaceName: string }> {
        if (workspaceIdHint !== undefined) {
            const attached = await this.#seam.attachWorkspace({ workspaceId: workspaceIdHint });
            return { workspaceId: attached.workspaceId, workspaceName: attached.workspaceName };
        }

        const effectiveProjectRoot = explicitProjectRoot !== undefined
            ? (explicitProjectRoot === "" ? null : explicitProjectRoot)
            : typeof cwd === "string" && cwd.length > 0 && cwd !== "/"
              ? cwd
              : undefined;

        if (workspaceNameHint !== undefined && workspaceNameHint.length > 0) {
            try {
                const attached = await this.#seam.attachWorkspace({ name: workspaceNameHint });
                return { workspaceId: attached.workspaceId, workspaceName: attached.workspaceName };
            } catch (err) {
                const problem = Problems.fromError(err) ?? (isRecord(err) && isRecord(err.problem) ? err.problem : null);
                if (!createIfMissing || (problem !== null && problem.status !== 404)) {
                    throw err;
                }
                const created = await this.#seam.createWorkspace({
                    name: workspaceNameHint,
                    ...(effectiveProjectRoot !== undefined ? { projectRoot: effectiveProjectRoot } : {}),
                    ...(settings !== undefined ? { settings } : {}),
                });
                return { workspaceId: created.workspaceId, workspaceName: created.workspaceName };
            }
        }

        if (effectiveProjectRoot !== undefined && effectiveProjectRoot !== null) {
            try {
                const attached = await this.#seam.attachWorkspace({ projectRoot: effectiveProjectRoot });
                return { workspaceId: attached.workspaceId, workspaceName: attached.workspaceName };
            } catch (err) {
                const problem = Problems.fromError(err) ?? (isRecord(err) && isRecord(err.problem) ? err.problem : null);
                if (!createIfMissing || (problem !== null && problem.status !== 404)) {
                    throw err;
                }
                const created = await this.#seam.createWorkspace({
                    projectRoot: effectiveProjectRoot,
                    ...(settings !== undefined ? { settings } : {}),
                });
                return { workspaceId: created.workspaceId, workspaceName: created.workspaceName };
            }
        }

        try {
            const attached = await this.#seam.attachWorkspace({ name: "default" });
            return { workspaceId: attached.workspaceId, workspaceName: attached.workspaceName };
        } catch (err) {
            const problem = Problems.fromError(err) ?? (isRecord(err) && isRecord(err.problem) ? err.problem : null);
            if (!createIfMissing || (problem !== null && problem.status !== 404)) {
                throw err;
            }
            const created = await this.#seam.createWorkspace({
                name: "default",
                ...(settings !== undefined ? { settings } : {}),
            });
            return { workspaceId: created.workspaceId, workspaceName: created.workspaceName };
        }
    }

    static #extractPlurnkMeta(meta: unknown): {
        readonly workspaceId?: number;
        readonly workspaceName?: string;
        readonly workerName?: string;
        readonly create?: boolean;
        readonly activate?: boolean;
        readonly messageId?: string;
        readonly selector?: string;
        readonly childSelector?: string | null;
        readonly projectRoot?: string | null;
        readonly settings?: Record<string, unknown>;
        readonly maxTurns?: number;
        readonly openPaths?: string[];
        readonly envelope?: Readonly<Record<string, unknown>>;
    } {
        if (!isRecord(meta) || !isRecord(meta.plurnk)) return {};
        const p = meta.plurnk;
        const workspaceId = typeof p.workspaceId === "number" && Number.isInteger(p.workspaceId) && p.workspaceId > 0
            ? p.workspaceId
            : undefined;
        const workspaceName = typeof p.workspaceName === "string" && p.workspaceName.trim().length > 0
            ? p.workspaceName.trim()
            : typeof p.workspace === "string" && p.workspace.trim().length > 0
                ? p.workspace.trim()
                : undefined;
        const workerName = typeof p.workerName === "string" && p.workerName.trim().length > 0
            ? p.workerName.trim()
            : typeof p.worker === "string" && p.worker.trim().length > 0
                ? p.worker.trim()
                : typeof p.name === "string" && p.name.trim().length > 0
                    ? p.name.trim()
                    : undefined;
        const create = typeof p.create === "boolean" ? p.create : undefined;
        const activate = typeof p.activate === "boolean" ? p.activate : undefined;
        const messageId = typeof p.messageId === "string" && p.messageId.trim().length > 0
            ? p.messageId.trim()
            : undefined;
        const selector = typeof p.selector === "string" && p.selector.trim().length > 0
            ? p.selector.trim()
            : undefined;
        const childSelector = p.childSelector === null
            ? null
            : typeof p.childSelector === "string" && p.childSelector.trim().length > 0
                ? p.childSelector.trim()
                : undefined;
        const projectRoot = p.projectRoot === null || typeof p.projectRoot === "string"
            ? p.projectRoot
            : undefined;
        const settings = isRecord(p.settings) ? p.settings : undefined;
        const maxTurns = typeof p.maxTurns === "number" && Number.isInteger(p.maxTurns) && p.maxTurns > 0
            ? p.maxTurns
            : undefined;
        const openPaths = Array.isArray(p.openPaths)
            ? p.openPaths.filter((x): x is string => typeof x === "string")
            : undefined;
        const envelope = isRecord(p.envelope) ? p.envelope : undefined;
        return {
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(workspaceName !== undefined ? { workspaceName } : {}),
            ...(workerName !== undefined ? { workerName } : {}),
            ...(create !== undefined ? { create } : {}),
            ...(activate !== undefined ? { activate } : {}),
            ...(messageId !== undefined ? { messageId } : {}),
            ...(selector !== undefined ? { selector } : {}),
            ...(childSelector !== undefined ? { childSelector } : {}),
            ...(projectRoot !== undefined ? { projectRoot } : {}),
            ...(settings !== undefined ? { settings } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(openPaths !== undefined ? { openPaths } : {}),
            ...(envelope !== undefined ? { envelope } : {}),
        };
    }

    async #resolveSessionBinding(
        peer: AcpPeer,
        rawSessionId: string | undefined,
        cwd: string | undefined,
        createIfMissing: boolean,
        meta?: unknown,
    ): Promise<BoundSession> {
        const plurnkMeta = Module.#extractPlurnkMeta(meta);
        const allowCreate = plurnkMeta.create ?? createIfMissing;

        let workspaceId: number;
        let workspaceName: string;
        let requestedWorkerName: string | undefined;

        if (rawSessionId !== undefined && rawSessionId.includes("#")) {
            const parsed = parseSessionId(rawSessionId);
            if (parsed === null) {
                throw new RequestError(
                    -32602,
                    `Invalid session address '${rawSessionId}'. (session-address-invalid)`,
                    Problems.create("acp", "session-address-invalid", 400, `Invalid session address '${rawSessionId}'.`),
                );
            }
            try {
                const attached = await this.#seam.attachWorkspace({ workspaceId: parsed.workspaceId });
                workspaceId = attached.workspaceId;
                workspaceName = attached.workspaceName;
            } catch (err) {
                const problem = Problems.fromError(err) ?? (isRecord(err) && isRecord(err.problem) ? err.problem : null);
                if (problem !== null && problem.status === 404) {
                    throw new RequestError(
                        -32004,
                        `Session '${rawSessionId}' does not exist. (session-not-found)`,
                        Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                    );
                }
                throw err;
            }
            requestedWorkerName = parsed.workerName;
        } else if (rawSessionId !== undefined && rawSessionId.length > 0) {
            const ref = await this.#seam.readWorkerReference({ namespace: "acp", reference: rawSessionId });
            if (ref !== null) {
                const attached = await this.#seam.attachWorkspace({ workspaceId: ref.workspaceId });
                const worker = await this.#seam.readWorker({
                    workspaceId: ref.workspaceId,
                    identity: { id: ref.workerId },
                });
                if (worker === null) {
                    throw new RequestError(
                        -32004,
                        `Session '${rawSessionId}' does not exist. (session-not-found)`,
                        Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                    );
                }
                workspaceId = attached.workspaceId;
                workspaceName = attached.workspaceName;
                requestedWorkerName = worker.name;
            } else {
                try {
                    const resolved = await this.#resolveWorkspace(
                        cwd,
                        plurnkMeta.workspaceId,
                        plurnkMeta.workspaceName,
                        allowCreate,
                        plurnkMeta.projectRoot,
                        plurnkMeta.settings,
                    );
                    workspaceId = resolved.workspaceId;
                    workspaceName = resolved.workspaceName;
                } catch (err) {
                    const problem = Problems.fromError(err) ?? (isRecord(err) && isRecord(err.problem) ? err.problem : null);
                    if (!allowCreate && problem !== null && problem.status === 404) {
                        throw new RequestError(
                            -32004,
                            `Session '${rawSessionId}' does not exist. (session-not-found)`,
                            Problems.create("acp", "session-not-found", 404, `Session '${rawSessionId}' does not exist.`),
                        );
                    }
                    throw err;
                }
                requestedWorkerName = rawSessionId;
            }
        } else {
            const resolved = await this.#resolveWorkspace(
                cwd,
                plurnkMeta.workspaceId,
                plurnkMeta.workspaceName,
                allowCreate,
                plurnkMeta.projectRoot,
                plurnkMeta.settings,
            );
            workspaceId = resolved.workspaceId;
            workspaceName = resolved.workspaceName;
            requestedWorkerName = plurnkMeta.workerName;
        }

        if (plurnkMeta.activate === true) {
            await this.#seam.activateWorkspace?.({ workspaceId });
        }
        await this.#seam.registerWorkerOwner(workspaceId, {
            address: OWNER_ADDRESS,
            tools: ["request_approval", "question", "mcp_input_required"],
            interactive: true,
        });

        let worker = requestedWorkerName !== undefined
            ? await this.#seam.readWorker({ workspaceId, identity: { name: requestedWorkerName } })
            : null;

        if (worker === null) {
            if (!allowCreate) {
                const label = rawSessionId ?? requestedWorkerName ?? "unknown";
                throw new RequestError(
                    -32004,
                    `Session '${label}' does not exist. (session-not-found)`,
                    Problems.create("acp", "session-not-found", 404, `Session '${label}' does not exist.`),
                );
            }
            const created = await this.#seam.createWorker({
                workspaceId,
                ...(requestedWorkerName !== undefined ? { name: requestedWorkerName } : {}),
                owner: OWNER_ADDRESS,
            });
            worker = await this.#seam.readWorker({
                workspaceId,
                identity: { id: created.workerId },
            });
            if (worker === null) throw new Error(`Failed to read newly created worker ${created.workerId}`);
        } else {
            const workerRec: Record<string, unknown> = isRecord(worker) ? worker : {};
            const hiddenAt = workerRec.hidden_at ?? workerRec.hiddenAt ?? null;
            if (hiddenAt !== null) {
                await this.#seam.setWorkerHidden({
                    workspaceId,
                    workerId: worker.id,
                    hidden: false,
                });
            }
            await this.#seam.claimWorkerOwner({
                workspaceId,
                workerId: worker.id,
                owner: OWNER_ADDRESS,
            });
        }

        const canonicalSessionId = formatSessionId(workspaceId, worker.name);
        const sessionId = rawSessionId !== undefined && rawSessionId.length > 0 ? rawSessionId : canonicalSessionId;
        const translator = new SessionTranslator({
            sessionId,
            workspaceId,
            workerId: worker.id,
            origin: this.#httpOrigin(),
        });

        const bound: BoundSession = {
            sessionId,
            workspaceId,
            workspaceName,
            workerId: worker.id,
            workerName: worker.name,
            translator,
        };
        peer.sessions.set(sessionId, bound);
        if (canonicalSessionId !== sessionId) {
            peer.sessions.set(canonicalSessionId, bound);
        }
        return bound;
    }

    #notifyPeerSession(peer: AcpPeer, sessionId: string, update: SessionUpdate): void {
        if (peer.client === null) return;
        void peer.client.notify(methods.client.session.update, {
            sessionId,
            update,
        }).catch(() => undefined);
    }

    #broadcastWorkerUpdate(
        workspaceId: number,
        workerId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ): void {
        for (const peer of this.#peers) {
            const visited = new Set<BoundSession>();
            for (const session of peer.sessions.values()) {
                if (visited.has(session)) continue;
                visited.add(session);
                if (session.workspaceId !== workspaceId || session.workerId !== workerId) continue;
                for (const { sessionId, update } of buildUpdates(session)) {
                    this.#notifyPeerSession(peer, sessionId, update);
                }
            }
        }
    }

    #dispatchGateToPeer(gate: ActiveGate, peer: AcpPeer, session: BoundSession): void {
        if (peer.client === null || gate.settled) return;
        if (gate.peerControllers.has(peer)) return;

        const controller = new AbortController();
        gate.peerControllers.set(peer, controller);

        if (gate.kind === "proposal" && gate.proposal !== undefined) {
            const proposal = gate.proposal;
            this.#notifyPeerSession(peer, session.sessionId, proposalToolCall(proposal));
            const req = proposalPermissionRequest(session.sessionId, proposal);
            void peer.client
                .request(methods.client.session.requestPermission, req, { cancellationSignal: controller.signal })
                .then(async (response) => {
                    if (gate.settled || controller.signal.aborted) return;
                    const resolution = resolutionFromPermissionResponse(proposal.logEntryId, response);
                    if (resolution === null) return;
                    await this.#settleGate(gate, peer, session, async () => {
                        await this.#seam.resolveProposal(
                            resolution.logEntryId,
                            { decision: resolution.decision },
                            { workspaceId: gate.workspaceId, address: OWNER_ADDRESS },
                        );
                    });
                })
                .catch(() => {
                    gate.peerControllers.delete(peer);
                });
        } else if (gate.kind === "interaction" && gate.interaction !== undefined) {
            const interaction = gate.interaction;
            this.#notifyPeerSession(peer, session.sessionId, interactionToolCall(interaction));
            const req = interactionElicitationRequest(session.sessionId, interaction);
            void peer.client
                .request(methods.client.elicitation.create, req, { cancellationSignal: controller.signal })
                .then(async (response) => {
                    if (gate.settled || controller.signal.aborted) return;
                    const resolved = interactionResolutionFromResponse(interaction.interactionId, response);
                    if (resolved === null) return;
                    await this.#settleGate(gate, peer, session, async () => {
                        await this.#seam.resolveClientInteraction(
                            resolved.interactionId,
                            resolved.resolution,
                            { workspaceId: gate.workspaceId, address: OWNER_ADDRESS },
                        );
                        for (const p of this.#peers) {
                            if (p.client !== null) {
                                void p.client
                                    .notify(methods.client.elicitation.complete, {
                                        elicitationId: String(interaction.interactionId),
                                    })
                                    .catch(() => undefined);
                            }
                        }
                        this.#broadcastWorkerUpdate(gate.workspaceId, gate.workerId, (s) => [
                            {
                                sessionId: s.sessionId,
                                update: interactionToolCallResult(resolved.interactionId, resolved.resolution),
                            },
                        ]);
                    });
                })
                .catch(() => {
                    gate.peerControllers.delete(peer);
                });
        }
    }

    async #settleGate(
        gate: ActiveGate,
        winner: AcpPeer,
        session: BoundSession,
        resolveInCore: () => Promise<void>,
    ): Promise<void> {
        if (gate.settled) return;
        try {
            await resolveInCore();
        } catch (err) {
            gate.peerControllers.delete(winner);
            const problem =
                Problems.fromError(err) ??
                (isRecord(err) && isRecord(err.problem)
                    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                      (err.problem as unknown as ProblemDetails)
                    : null);
            if (problem !== null) {
                this.#notifyPeerSession(winner, session.sessionId, {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: problem.title,
                    description: problem.detail,
                    _meta: {
                        plurnk: {
                            problem,
                        },
                    },
                });
            }
            return;
        }
        gate.settled = true;
        this.#activeGates.delete(gate.key);

        for (const [peer, ctrl] of gate.peerControllers.entries()) {
            if (peer !== winner) {
                ctrl.abort();
            }
        }
        gate.peerControllers.clear();

        this.#broadcastWorkerUpdate(gate.workspaceId, gate.workerId, (s) => [
            {
                sessionId: s.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "running",
                },
            },
        ]);
    }

    #openOrGetGate(
        workspaceId: number,
        workerId: number,
        kind: "proposal" | "interaction",
        proposal?: ProposalProjection,
        interaction?: ClientInteractionProjection,
    ): ActiveGate {
        const id = kind === "proposal" ? proposal!.logEntryId : interaction!.interactionId;
        const key = `${workspaceId}:${kind}:${id}`;
        let gate = this.#activeGates.get(key);
        if (gate === undefined || gate.settled) {
            gate = {
                key,
                workspaceId,
                workerId,
                kind,
                proposal,
                interaction,
                peerControllers: new Map(),
                settled: false,
            };
            this.#activeGates.set(key, gate);
        }
        return gate;
    }

    #onDaemonEvent(workspaceId: number, method: string, params: unknown): void {
        switch (method) {
            case "log/entry": {
                if (!isRecord(params) || !isRecord(params.entry)) break;
                const entryRec = params.entry;
                const entryId = typeof entryRec.id === "number" ? entryRec.id : null;
                const workerId = typeof entryRec.worker_id === "number" ? entryRec.worker_id : null;
                if (entryId === null || workerId === null) break;
                const gateKey = `${workspaceId}:proposal:${entryId}`;
                const existingGate = this.#activeGates.get(gateKey);
                if (existingGate !== undefined && entryRec.state !== "proposed") {
                    existingGate.settled = true;
                    this.#activeGates.delete(gateKey);
                    for (const ctrl of existingGate.peerControllers.values()) ctrl.abort();
                    existingGate.peerControllers.clear();
                }
                if (isLogEntryPayload(params)) {
                    this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => s.translator.logEntry(params));
                }
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId || session.workerId === workerId) continue;
                        const summary = isRecord(entryRec.attrs) && typeof entryRec.attrs.body === "string"
                            ? entryRec.attrs.body
                            : typeof entryRec.op === "string"
                              ? entryRec.op
                              : "op";
                        const workerName = typeof entryRec.worker_name === "string" ? entryRec.worker_name : String(workerId);
                        this.#notifyPeerSession(peer, session.sessionId, {
                            sessionUpdate: "subagent_update",
                            sessionId: formatSessionId(workspaceId, workerName),
                            title: workerName,
                            description: summary,
                            state: { state: "running" },
                        });
                    }
                }
                break;
            }
            case "reasoning/event": {
                if (!isRecord(params) || typeof params.workerId !== "number") break;
                const workerId = params.workerId;
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => s.translator.reasoning(params));
                break;
            }
            case "stream/event": {
                if (!isRecord(params)) break;
                const entryId = typeof params.entryId === "number" ? params.entryId : null;
                const workerId = typeof params.workerId === "number" ? params.workerId : null;
                const target = typeof params.target === "string" ? params.target : null;
                const channel = typeof params.channel === "string" ? params.channel : null;
                if (entryId === null || workerId === null) break;
                const streamMeta: Record<string, unknown> = {
                    workerId,
                    ...(target !== null ? { target } : {}),
                    ...(channel !== null ? { channel } : {}),
                    ...(typeof params.state === "string" ? { state: params.state } : {}),
                    ...(typeof params.contentLength === "number" ? { contentLength: params.contentLength } : {}),
                };
                const delta = typeof params.delta === "string" ? params.delta : "";
                if (delta.length > 0) {
                    this.#broadcastWorkerUpdate(workspaceId, workerId, (s) =>
                        s.translator.terminalChunk(entryId, delta, streamMeta),
                    );
                    break;
                }
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => [
                    {
                        sessionId: s.sessionId,
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
                        .readEntry({ workspaceId, workerId, target, channel, offset: prevOffset })
                        .then((readResult) => {
                            const chunk = readResult.entry !== null
                                ? (readResult.entry.channels[channel]?.content ?? "")
                                : "";
                            if (chunk.length > 0) {
                                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) =>
                                    s.translator.terminalChunk(entryId, chunk, { workerId, target, channel }),
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
                const workerId = typeof params.workerId === "number" ? params.workerId : null;
                const target = typeof params.target === "string" ? params.target : null;
                const status = isRecord(params.result) && typeof params.result.status === "number"
                    ? params.result.status
                    : typeof params.status === "number"
                      ? params.status
                      : 200;
                if (entryId === null || workerId === null) break;
                const concludedMeta: Record<string, unknown> = {
                    workerId,
                    ...(target !== null ? { target } : {}),
                    ...(isRecord(params.result) ? { result: params.result } : {}),
                    ...(isRecord(params.summary) ? { summary: params.summary } : {}),
                };
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) =>
                    s.translator.terminalConcluded(entryId, status, concludedMeta),
                );
                break;
            }
            case "outside/event": {
                if (!isOutsideEvent(params)) break;
                const workerId = params.workerId;
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => s.translator.outside(params));
                break;
            }
            case "loop/packet": {
                if (!isLoopPacket(params)) break;
                const workerId = params.workerId;
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => s.translator.packet(params));
                break;
            }
            case "loop/terminated": {
                if (!isRecord(params) || typeof params.workerId !== "number") break;
                const workerId = params.workerId;
                this.#broadcastWorkerUpdate(workspaceId, workerId, (s) => s.translator.terminated(params));
                break;
            }
            case "loop/proposal": {
                if (!isProposalProjection(params)) break;
                const proposal = params;
                const decision = isRecord(proposal.disposition)
                    ? proposal.disposition.decision
                    : typeof proposal.disposition === "string"
                      ? proposal.disposition
                      : "";
                if (decision !== "review") break;
                const gate = this.#openOrGetGate(workspaceId, proposal.workerId, "proposal", proposal);
                this.#broadcastWorkerUpdate(workspaceId, proposal.workerId, (s) => [
                    {
                        sessionId: s.sessionId,
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
                        if (session.workerId === proposal.workerId) {
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
                const gate = this.#openOrGetGate(workspaceId, interaction.workerId, "interaction", undefined, interaction);
                this.#broadcastWorkerUpdate(workspaceId, interaction.workerId, (s) => [
                    {
                        sessionId: s.sessionId,
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
                        if (session.workerId === interaction.workerId) {
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
                if (!isRecord(params) || !isRecord(params.notice)) break;
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
                        : (this.#seam.workspacePreparationStatus?.(workspaceId) ?? []);
                for (const peer of this.#peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId) continue;
                        this.#notifyPeerSession(peer, session.sessionId, {
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

    async #buildDiscovery(): Promise<AcpDiscovery> {
        const display = (await this.#seam.listClientDisplayCapabilities?.()) ?? [];
        const moduleActions = this.#seam.listModuleActions?.() ?? [];
        const objSchema = { type: "object", additionalProperties: true } as const;
        const actions: Record<
            string,
            { readonly scope: "daemon" | "workspace" | "worker"; readonly inputSchema: Record<string, unknown>; readonly outputSchema: Record<string, unknown> }
        > = {
            ping: { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            discover: { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            "models.list": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.create": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.attach": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.list": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.workers": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.rename": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.share": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.rollback": { scope: "worker", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.capabilities.get": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.capabilities.set": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "workspace.prompts": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "worker.loops": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "log.read": { scope: "worker", inputSchema: objSchema, outputSchema: objSchema },
            "entry.read": { scope: "worker", inputSchema: objSchema, outputSchema: objSchema },
            "op.parse": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
            "op.exec": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        };
        for (const act of moduleActions) {
            actions[act.name] = {
                scope: act.scope,
                inputSchema: act.inputSchema,
                outputSchema: act.outputSchema,
            };
        }
        return {
            schemaVersion: 1,
            actions,
            notifications: {
                "session/update": { payloadSchema: objSchema },
            },
            display,
        };
    }

    async #resolveActionTarget(
        rawParams: Record<string, unknown>,
        params: Record<string, unknown>,
        createWorkspace = true,
    ): Promise<{ readonly workspaceId: number; readonly workerName: string; readonly workerId: number; readonly hasWorker: boolean }> {
        const sessionHint = typeof rawParams.sessionId === "string"
            ? rawParams.sessionId
            : typeof params.sessionId === "string"
              ? params.sessionId
              : undefined;
        const parsedSession = sessionHint !== undefined ? parseSessionId(sessionHint) : null;
        const explicitWsId = typeof rawParams.workspaceId === "number"
            ? rawParams.workspaceId
            : typeof params.workspaceId === "number"
              ? params.workspaceId
              : parsedSession?.workspaceId;
        const workspaceHint = typeof rawParams.workspace === "string"
            ? rawParams.workspace
            : typeof params.workspace === "string"
              ? params.workspace
              : undefined;
        const cwdHint = typeof rawParams.cwd === "string"
            ? rawParams.cwd
            : typeof params.cwd === "string"
              ? params.cwd
              : undefined;
        const explicitProjectRoot = rawParams.projectRoot === null || typeof rawParams.projectRoot === "string"
            ? rawParams.projectRoot
            : params.projectRoot === null || typeof params.projectRoot === "string"
              ? params.projectRoot
              : undefined;
        const ws = await this.#resolveWorkspace(cwdHint, explicitWsId, workspaceHint, createWorkspace, explicitProjectRoot);
        const explicitWorkerName = typeof rawParams.worker === "string"
            ? rawParams.worker
            : typeof params.worker === "string"
              ? params.worker
              : parsedSession?.workerName;
        let worker = explicitWorkerName !== undefined
            ? await this.#seam.readWorker({ workspaceId: ws.workspaceId, identity: { name: explicitWorkerName } })
            : null;
        if (worker === null && sessionHint !== undefined && parsedSession === null) {
            const ref = await this.#seam.readWorkerReference({ namespace: "acp", reference: sessionHint });
            if (ref !== null && ref.workspaceId === ws.workspaceId) {
                worker = await this.#seam.readWorker({ workspaceId: ws.workspaceId, identity: { id: ref.workerId } });
            } else {
                worker = await this.#seam.readWorker({ workspaceId: ws.workspaceId, identity: { name: sessionHint } });
            }
        }
        if (worker === null && explicitWorkerName === undefined) {
            worker = await this.#seam.readWorker({ workspaceId: ws.workspaceId, identity: { name: "user" } });
        }
        const workerName = worker?.name ?? explicitWorkerName ?? sessionHint ?? "user";
        return {
            workspaceId: ws.workspaceId,
            workerName,
            workerId: worker?.id ?? 1,
            hasWorker: worker !== null,
        };
    }

    async #handlePlurnkAction(rawParams: unknown, peer?: AcpPeer): Promise<unknown> {
        if (!isRecord(rawParams) || typeof rawParams.kind !== "string") {
            throw RequestError.invalidParams({ detail: "_plurnk/action requires a string 'kind'." });
        }
        const kind = rawParams.kind;
        const params = isRecord(rawParams.params) ? rawParams.params : {};
        const sessionHint = typeof rawParams.sessionId === "string" && rawParams.sessionId.length > 0
            ? rawParams.sessionId
            : "1#user";

        if (kind === "ping") {
            return {};
        }

        if (kind === "discover") {
            if (peer?.client !== null && peer !== undefined) {
                const tempTranslator = new SessionTranslator({
                    sessionId: sessionHint,
                    workspaceId: 1,
                    workerId: 1,
                    origin: this.#httpOrigin(),
                });
                for (const notice of this.#seam.configurationNotices()) {
                    for (const { update } of tempTranslator.notice(notice)) {
                        this.#notifyPeerSession(peer, sessionHint, update);
                    }
                }
            }
            return await this.#buildDiscovery();
        }

        if (kind === "workspace.create") {
            const created = await this.#seam.createWorkspace({
                ...(typeof params.name === "string" ? { name: params.name } : {}),
                ...(typeof params.projectRoot === "string" || params.projectRoot === null ? { projectRoot: params.projectRoot } : {}),
                ...(typeof params.settings === "string" || isRecord(params.settings) ? { settings: params.settings } : {}),
            });
            return {
                ...created,
                id: created.workspaceId,
                name: created.workspaceName,
            };
        }

        if (kind === "workspace.attach") {
            const wsId = typeof params.id === "number"
                ? params.id
                : typeof params.workspaceId === "number"
                  ? params.workspaceId
                  : undefined;
            const attached = await this.#seam.attachWorkspace(
                wsId !== undefined
                    ? { workspaceId: wsId }
                    : typeof params.name === "string"
                      ? { name: params.name }
                      : { projectRoot: typeof params.projectRoot === "string" ? params.projectRoot : "" },
            );
            return {
                ...attached,
                id: attached.workspaceId,
                name: attached.workspaceName,
            };
        }

        if (kind === "models.list") {
            return this.#seam.listModels({
                ...(typeof params.search === "string" ? { search: params.search } : {}),
                ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
                ...(typeof params.all === "boolean" ? { all: params.all } : {}),
                ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
                ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            });
        }

        if (kind === "workspace.list") {
            const workspaces = await this.#seam.listWorkspaces({
                ...(typeof params.hidden === "boolean" ? { hidden: params.hidden } : {}),
            });
            return { workspaces };
        }

        if (kind === "workspace.workers") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            const workers = await this.#seam.listWorkers(target.workspaceId, {
                ...(typeof params.hidden === "boolean" ? { hidden: params.hidden } : {}),
            });
            return { workers };
        }

        if (kind === "workspace.rename") {
            const fromHint = typeof params.from === "string" ? params.from : undefined;
            const target = await this.#resolveActionTarget(
                fromHint ? { ...rawParams, workspace: fromHint } : rawParams,
                params,
                false,
            );
            const nextName = typeof params.name === "string" ? params.name : typeof params.to === "string" ? params.to : "";
            return await this.#seam.renameWorkspace(target.workspaceId, nextName);
        }

        if (kind === "workspace.share") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            return await this.#seam.shareWorkspace({
                workspaceId: target.workspaceId,
                folder: typeof params.folder === "string" ? params.folder : "",
            });
        }

        if (kind === "workspace.rollback") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            return await this.#seam.rollback({
                workspaceId: target.workspaceId,
                workerId: target.workerId,
                actor: OWNER_ADDRESS,
                to: typeof params.to === "string" ? params.to : "",
            });
        }

        if (kind === "workspace.capabilities.get") {
            const target = await this.#resolveActionTarget(rawParams, params);
            return await this.#seam.readWorkspaceCapabilities({ workspaceId: target.workspaceId });
        }

        if (kind === "workspace.capabilities.set") {
            const target = await this.#resolveActionTarget(rawParams, params);
            const policyObj: Parameters<ApplicationPort["setWorkspaceCapabilities"]>[0]["policy"] =
                isRecord(params.policy) ? params.policy : {};
            return await this.#seam.setWorkspaceCapabilities({
                workspaceId: target.workspaceId,
                policy: policyObj,
            });
        }

        if (kind === "workspace.prompts") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            const prompts = await this.#seam.listPrompts(
                target.workspaceId,
                typeof params.limit === "number" ? params.limit : undefined,
                typeof params.workerId === "number" ? params.workerId : undefined,
            );
            return { prompts };
        }

        if (kind === "worker.loops") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            const items = await this.#seam.listWorkerLoops({ workspaceId: target.workspaceId, workerId: target.workerId });
            return { items };
        }

        if (kind === "log.read") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            const entries = await this.#seam.readLog({
                workspaceId: target.workspaceId,
                workerId: target.workerId,
                ...(typeof params.loopId === "number" ? { loopId: params.loopId } : {}),
                ...(typeof params.turnId === "number" ? { turnId: params.turnId } : {}),
                ...(typeof params.sinceId === "number" ? { sinceId: params.sinceId } : {}),
                ...(typeof params.beforeId === "number" ? { beforeId: params.beforeId } : {}),
                ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
                ...(typeof params.loopSeq === "number" ? { loopSeq: params.loopSeq } : {}),
                ...(typeof params.turnSeq === "number" ? { turnSeq: params.turnSeq } : {}),
                ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
            });
            return { entries };
        }

        if (kind === "entry.read") {
            const target = await this.#resolveActionTarget(rawParams, params, false);
            return await this.#seam.readEntry({
                workspaceId: target.workspaceId,
                workerId: target.workerId,
                target: typeof params.target === "string" ? params.target : "",
                ...(typeof params.channel === "string" ? { channel: params.channel } : {}),
                ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            });
        }

        if (kind === "op.parse" || kind === "op.exec") {
            const target = await this.#resolveActionTarget(rawParams, params, true);
            await this.#seam.activateWorkspace?.({ workspaceId: target.workspaceId });
            const text = typeof params.text === "string" ? params.text : "";
            const executors = this.#seam.executorTags?.(target.workspaceId) ?? ["sh", "js"];
            const parsed = PlurnkParser.parseStatements(text, { executors });
            const parseErrors = parsed.items.filter(
                (i): i is Extract<typeof i, { kind: "error" }> => i.kind === "error" && i.error.severity === "error",
            );
            const statements = parsed.items
                .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
                .map((i) => i.statement);
            if (parseErrors.length > 0 || parsed.unparsedTail !== undefined || statements.length === 0) {
                const msg = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_OPERATION;
                return {
                    results: [
                        {
                            status: 400,
                            message: msg,
                            content: msg,
                            mimetype: "text/plain",
                        },
                    ],
                };
            }
            await this.#seam.ensureRuntimeWorker(target.workspaceId);
            const results = await this.#seam.dispatchClientAction({
                workspaceId: target.workspaceId,
                actor: OWNER_ADDRESS,
                ...(target.hasWorker ? { contextWorkerId: target.workerId } : {}),
                statements,
            });
            return { results };
        }

        const moduleActions = this.#seam.listModuleActions?.() ?? [];
        const registered = moduleActions.find((a) => a.name === kind);
        if (!registered) {
            throw new RequestError(
                -32601,
                `Action '${kind}' is not registered. Recovery: Use an action advertised by discover.`,
            );
        }

        if (isRecord(registered.inputSchema)) {
            const validation = Validator.validateJsonSchemaInstance(registered.inputSchema, params);
            if (!validation.valid) {
                throw new RequestError(-32602, `Action '${kind}' rejected parameters.`);
            }
        }

        if (registered.scope === "daemon") {
            return await this.#seam.invokeModuleAction(kind, params, { scope: "daemon" });
        }
        const target = await this.#resolveActionTarget(rawParams, params);
        if (peer?.client !== null && peer !== undefined) {
            const preparation = this.#seam.workspacePreparationStatus?.(target.workspaceId) ?? [];
            const activity = this.#seam.workspaceDerivationStatus?.(target.workspaceId) ?? null;
            this.#notifyPeerSession(peer, sessionHint, {
                sessionUpdate: "notice",
                severity: "info",
                title: "workspace:state",
                _meta: {
                    plurnk: {
                        workspace: {
                            id: target.workspaceId,
                            preparation,
                            activity,
                        },
                    },
                },
            });
        }
        if (registered.scope === "worker") {
            return await this.#seam.invokeModuleAction(kind, params, {
                scope: "worker",
                workspaceId: target.workspaceId,
                workerId: target.workerId,
            });
        }
        return await this.#seam.invokeModuleAction(kind, params, {
            scope: "workspace",
            workspaceId: target.workspaceId,
        });
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
                        this.#notifyPeerSession(peer, session.sessionId, {
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
                for (const gate of this.#activeGates.values()) {
                    const ctrl = gate.peerControllers.get(peer);
                    if (ctrl !== undefined) {
                        ctrl.abort();
                        gate.peerControllers.delete(peer);
                    }
                }
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
                    return await this.#handlePlurnkAction(ctx.params, peer);
                } catch (err) {
                    throw Module.#toRequestError(err);
                }
            },
        );

        app.onRequest(methods.agent.session.new, async (ctx): Promise<NewSessionResponse> => {
            peer.client = ctx.client;
            try {
                Module.#assertSinglePortSecurity(ctx.params);
                const bound = await this.#resolveSessionBinding(
                    peer,
                    undefined,
                    ctx.params.cwd,
                    true,
                    ctx.params._meta,
                );
                const providerCatalog = this.#tryListProviders();
                const [configOptions, modelInfo] = await Promise.all([
                    this.#configOptions(bound.workspaceId, bound.workerId),
                    this.#seam.readWorkerModel({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                ]);
                for (const notice of this.#seam.configurationNotices()) {
                    for (const { update } of bound.translator.notice(notice)) {
                        this.#notifyPeerSession(peer, bound.sessionId, update);
                    }
                }
                if (providerCatalog.problem !== null) {
                    this.#notifyPeerSession(peer, bound.sessionId, {
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
                    sessionId: bound.sessionId,
                    configOptions,
                    availableCommands: [...AVAILABLE_COMMANDS],
                    _meta: {
                        plurnk: {
                            sessionId: bound.sessionId,
                            workspace: {
                                id: bound.workspaceId,
                                name: bound.workspaceName,
                                preparation: this.#seam.workspacePreparationStatus?.(bound.workspaceId) ?? [],
                                activity: this.#seam.workspaceDerivationStatus?.(bound.workspaceId) ?? null,
                            },
                            worker: { id: bound.workerId, name: bound.workerName },
                            status: {
                                model: modelInfo.model,
                                spawnModel: modelInfo.spawnModel,
                            },
                            ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                        },
                    },
                };
            } catch (err) {
                throw Module.#toRequestError(err);
            }
        });

        app.onRequest(methods.agent.session.resume, async (ctx): Promise<ResumeSessionResponse> => {
            peer.client = ctx.client;
            try {
                Module.#assertSinglePortSecurity(ctx.params);
                const bound = await this.#resolveSessionBinding(
                    peer,
                    ctx.params.sessionId,
                    ctx.params.cwd,
                    false,
                    ctx.params._meta,
                );

                const providerCatalog = this.#tryListProviders();
                const [entries, inbox, loops, proposals, interactions, configOptions, modelInfo] = await Promise.all([
                    this.#seam.readLog({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.readInbox({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.listWorkerLoops({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                    this.#seam.pendingProposals(bound.workspaceId),
                    this.#seam.pendingClientInteractions(bound.workspaceId),
                    this.#configOptions(bound.workspaceId, bound.workerId),
                    this.#seam.readWorkerModel({ workspaceId: bound.workspaceId, workerId: bound.workerId }),
                ]);

                const replayed = SessionTranslator.replay(bound.translator, entries, inbox, {
                    historyLoops: this.#opts.historyLoops,
                });

                for (const { update } of replayed) {
                    this.#notifyPeerSession(peer, bound.sessionId, update);
                }

                for (const notice of this.#seam.configurationNotices()) {
                    for (const { update } of bound.translator.notice(notice)) {
                        this.#notifyPeerSession(peer, bound.sessionId, update);
                    }
                }
                if (providerCatalog.problem !== null) {
                    this.#notifyPeerSession(peer, bound.sessionId, {
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

                const workerProposals = proposals.filter((p) => {
                    const decision = isRecord(p.disposition)
                        ? p.disposition.decision
                        : typeof p.disposition === "string"
                          ? p.disposition
                          : "";
                    return p.workerId === bound.workerId && decision === "review";
                });
                const workerInteractions = interactions.filter((i) => i.workerId === bound.workerId);

                const activeLoop = selectWorkerLoop(loops);
                const lifecycle = activeLoop !== null ? lifecycleOfLoopStatus(activeLoop.status) : "idle";
                const hasPendingAction = workerProposals.length > 0 || workerInteractions.length > 0;

                const currentState: SessionUpdate = hasPendingAction
                    ? { sessionUpdate: "state_update", state: "requires_action" }
                    : lifecycle === "running" || lifecycle === "queued"
                        ? { sessionUpdate: "state_update", state: "running" }
                        : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" };

                this.#notifyPeerSession(peer, bound.sessionId, currentState);

                for (const proposal of workerProposals) {
                    const gate = this.#openOrGetGate(bound.workspaceId, proposal.workerId, "proposal", proposal);
                    this.#dispatchGateToPeer(gate, peer, bound);
                }
                for (const interaction of workerInteractions) {
                    const gate = this.#openOrGetGate(bound.workspaceId, interaction.workerId, "interaction", undefined, interaction);
                    this.#dispatchGateToPeer(gate, peer, bound);
                }

                if (isRecord(ctx.params._meta) && isRecord(ctx.params._meta.plurnk) && isRecord(ctx.params._meta.plurnk.resolveInteraction)) {
                    const ri = ctx.params._meta.plurnk.resolveInteraction;
                    const targetId = Number(ri.interactionId);
                    if (!workerInteractions.some((i) => i.interactionId === targetId)) {
                        const resolution: Parameters<ApplicationPort["resolveClientInteraction"]>[1] = ri.status === "cancelled"
                            ? { status: "cancelled" }
                            : {
                                status: "resolved",
                                ...(ri.payload !== undefined ? { payload: ri.payload } : {}),
                            };
                        await this.#seam.resolveClientInteraction(
                            targetId,
                            resolution,
                            { workspaceId: bound.workspaceId, address: OWNER_ADDRESS },
                        );
                    }
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
                                preparation: this.#seam.workspacePreparationStatus?.(bound.workspaceId) ?? [],
                                activity: this.#seam.workspaceDerivationStatus?.(bound.workspaceId) ?? null,
                            },
                            worker: { id: bound.workerId, name: bound.workerName },
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
                throw Module.#toRequestError(err);
            }
        });

        app.onRequest(methods.agent.session.list, async (ctx): Promise<ListSessionsResponse> => {
            peer.client = ctx.client;
            try {
                const overview = await this.#seam.readWorkerOverview({
                    limit: this.#opts.overviewWorkers,
                    excerptChars: this.#opts.excerptChars,
                });
                const rawWorkspaces: unknown[] = Array.isArray(overview.workspaces)
                    ? overview.workspaces
                    : isRecord(overview.workspaces)
                      ? Object.values(overview.workspaces)
                      : [];
                const rawWorkers: unknown[] = Array.isArray(overview.workers)
                    ? overview.workers
                    : isRecord(overview.workers)
                      ? Object.values(overview.workers)
                      : [];

                const wsById = new Map<number, Record<string, unknown>>();
                for (const ws of rawWorkspaces) {
                    if (isRecord(ws) && typeof ws.id === "number") {
                        wsById.set(ws.id, ws);
                    }
                }
                const origin = this.#httpOrigin();
                const sessions: SessionInfo[] = rawWorkers
                    .filter((w): w is Record<string, unknown> => {
                        if (!isRecord(w) || typeof w.workspaceId !== "number" || typeof w.name !== "string") return false;
                        const ws = wsById.get(w.workspaceId);
                        const projectRoot = typeof ws?.projectRoot === "string"
                            ? ws.projectRoot
                            : typeof ws?.project_root === "string"
                              ? ws.project_root
                              : null;
                        if (ctx.params.cwd && projectRoot !== ctx.params.cwd) return false;
                        return true;
                    })
                    .map((w) => {
                        const wsId = typeof w.workspaceId === "number" ? w.workspaceId : 1;
                        const workerId = typeof w.id === "number" ? w.id : 1;
                        const workerName = typeof w.name === "string" ? w.name : "user";
                        const ws = wsById.get(wsId);
                        const wsName = typeof ws?.name === "string" ? ws.name : String(wsId);
                        const projectRoot = typeof ws?.projectRoot === "string"
                            ? ws.projectRoot
                            : typeof ws?.project_root === "string"
                              ? ws.project_root
                              : "/";
                        const reply = isRecord(w.reply) ? w.reply : null;
                        const replyCoord = typeof reply?.coordinate === "string" ? reply.coordinate : "1/1/1";
                        const replyAt = typeof reply?.at === "string" || typeof reply?.at === "number"
                            ? new Date(reply.at).toISOString()
                            : undefined;
                        const replyMeta = reply !== null
                            ? {
                                  ...reply,
                                  body: {
                                      url: `${origin}/acp/${wsId}/${workerId}/entry?target=${encodeURIComponent(
                                          `log:///${replyCoord}/SEND`,
                                      )}`,
                                  },
                              }
                            : null;
                        return {
                            sessionId: formatSessionId(wsId, workerName),
                            cwd: projectRoot,
                            title: `${wsName}#${workerName}`,
                            updatedAt: replyAt,
                            _meta: {
                                plurnk: {
                                    workspaceId: wsId,
                                    workspaceName: wsName,
                                    workerId,
                                    workerName,
                                    lifecycle: w.lifecycle ?? "idle",
                                    reply: replyMeta,
                                },
                            },
                        };
                    });
                return { sessions };
            } catch (err) {
                throw Module.#toRequestError(err);
            }
        });

        app.onRequest(methods.agent.session.delete, async (ctx) => {
            peer.client = ctx.client;
            try {
                const bound = peer.sessions.get(ctx.params.sessionId)
                    ?? (await this.#resolveSessionBinding(peer, ctx.params.sessionId, undefined, false));
                await this.#seam.setWorkerHidden({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    hidden: true,
                });
                peer.sessions.delete(ctx.params.sessionId);
                return {};
            } catch (err) {
                throw Module.#toRequestError(err);
            }
        });

        app.onRequest(methods.agent.session.fork, async (ctx): Promise<ForkSessionResponse> => {
            peer.client = ctx.client;
            try {
                Module.#assertSinglePortSecurity(ctx.params);
                const parent = peer.sessions.get(ctx.params.sessionId)
                    ?? (await this.#resolveSessionBinding(peer, ctx.params.sessionId, ctx.params.cwd, false));
                const forked = await this.#seam.forkWorker({
                    workspaceId: parent.workspaceId,
                    workerId: parent.workerId,
                });
                const forkedWorker = await this.#seam.readWorker({
                    workspaceId: parent.workspaceId,
                    identity: { id: forked.workerId },
                });
                const workerName = forked.workerName ?? forkedWorker?.name ?? String(forked.workerId);
                const newSessionId = formatSessionId(parent.workspaceId, workerName);
                await this.#resolveSessionBinding(peer, newSessionId, ctx.params.cwd, false);
                const configOptions = await this.#configOptions(parent.workspaceId, forked.workerId);
                return {
                    sessionId: newSessionId,
                    configOptions,
                };
            } catch (err) {
                throw Module.#toRequestError(err);
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
                        ?? (await this.#resolveSessionBinding(peer, ctx.params.sessionId, undefined, false));
                    const value = typeof ctx.params.value === "string" ? ctx.params.value : String(ctx.params.value);

                    switch (ctx.params.configId) {
                        case "model":
                            await this.#seam.setWorkerModel({
                                workspaceId: bound.workspaceId,
                                workerId: bound.workerId,
                                selector: value,
                            });
                            break;
                        case "effort":
                        case "thought_level":
                            await this.#seam.setWorkerEffort({
                                workspaceId: bound.workspaceId,
                                workerId: bound.workerId,
                                effort: value,
                            });
                            break;
                        case "spawn_model":
                            await this.#seam.setWorkerSpawnModel({
                                workspaceId: bound.workspaceId,
                                workerId: bound.workerId,
                                selector: value === "inherit" ? null : value,
                            });
                            break;
                        case "mode":
                            if (value === "propose" || value === "allow") {
                                await this.#seam.setWorkspaceCapabilities({
                                    workspaceId: bound.workspaceId,
                                    policy: {},
                                });
                            } else if (value === "deny") {
                                await this.#seam.setWorkspaceCapabilities({
                                    workspaceId: bound.workspaceId,
                                    policy: { deny: [{ access: "mutate" }, { access: "execute" }] },
                                });
                            } else {
                                throw RequestError.invalidParams({ detail: `Unsupported mode '${value}'.` });
                            }
                            break;
                        default:
                            throw RequestError.invalidParams({ detail: `Unknown configId '${ctx.params.configId}'.` });
                    }

                    const configOptions = await this.#configOptions(bound.workspaceId, bound.workerId);
                    this.#broadcastWorkerUpdate(bound.workspaceId, bound.workerId, (s) => [
                        {
                            sessionId: s.sessionId,
                            update: {
                                sessionUpdate: "config_option_update",
                                configOptions,
                            },
                        },
                    ]);
                    return { configOptions };
                } catch (err) {
                    throw Module.#toRequestError(err);
                }
            },
        );

        app.onRequest(methods.agent.session.prompt, async (ctx): Promise<PromptResponse> => {
            peer.client = ctx.client;
            try {
                const bound = peer.sessions.get(ctx.params.sessionId)
                    ?? (await this.#resolveSessionBinding(
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
                const plurnkMeta = Module.#extractPlurnkMeta(ctx.params._meta);
                const messageId = plurnkMeta.messageId ?? crypto.randomUUID();
                const messageAddress = `acp:///sessions/${encodeURIComponent(bound.sessionId)}/messages/${encodeURIComponent(messageId)}`;

                if (typeof this.#seam.messageAdmission === "function") {
                    await this.#seam.messageAdmission({
                        workspaceId: bound.workspaceId,
                        address: messageAddress,
                        body: text,
                    });
                }

                const trimmed = text.trim();
                if (trimmed.startsWith("/")) {
                    const spaceIdx = trimmed.indexOf(" ");
                    const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
                    if (AVAILABLE_COMMANDS.some((c) => c.name === cmd)) {
                        this.#broadcastWorkerUpdate(bound.workspaceId, bound.workerId, (s) => [
                            {
                                sessionId: s.sessionId,
                                update: {
                                    sessionUpdate: "agent_message_chunk",
                                    messageId,
                                    content: { type: "text", text: `Executed /${cmd}` },
                                },
                            },
                            {
                                sessionId: s.sessionId,
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

                this.#notifyPeerSession(peer, bound.sessionId, {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "workspace:state",
                    _meta: {
                        plurnk: {
                            workspace: {
                                id: bound.workspaceId,
                                name: bound.workspaceName,
                                preparation: this.#seam.workspacePreparationStatus?.(bound.workspaceId) ?? [],
                                activity: this.#seam.workspaceDerivationStatus?.(bound.workspaceId) ?? null,
                            },
                        },
                    },
                });
                this.#broadcastWorkerUpdate(bound.workspaceId, bound.workerId, (s) => [
                    {
                        sessionId: s.sessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "running",
                        },
                    },
                ]);

                const maxTurns = plurnkMeta.maxTurns ?? this.#opts.maxTurns;
                const ack = await this.#seam.runLoop({
                    workspaceId: bound.workspaceId,
                    workerId: bound.workerId,
                    prompt: text,
                    source: messageAddress,
                    messageAddress,
                    ...(plurnkMeta.selector !== undefined ? { selector: plurnkMeta.selector } : {}),
                    ...(plurnkMeta.childSelector !== undefined ? { childSelector: plurnkMeta.childSelector } : {}),
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
                            workerId: bound.workerId,
                            workspace: {
                                id: bound.workspaceId,
                                name: bound.workspaceName,
                            },
                        },
                    },
                };
            } catch (err) {
                throw Module.#toRequestError(err);
            }
        });

        app.onNotification(methods.agent.session.cancel, async (ctx) => {
            const bound = peer.sessions.get(ctx.params.sessionId);
            if (bound === undefined) return;
            this.#seam.cancelDrain(bound.workerId, "Cancelled by ACP client");
            await this.#seam.cancelWorker({
                workspaceId: bound.workspaceId,
                workerId: bound.workerId,
                reason: "Cancelled by ACP client",
            });
        });

        return app;
    }
}

export { proposalKey };
