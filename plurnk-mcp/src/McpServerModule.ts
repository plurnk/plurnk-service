// {§mcp-http-server} — Streamable HTTP MCP server mounted at `/mcp[/<workspace>[/<session>]]`
// on the daemon's shared HTTP listener ({§http-host}, {§module-contract}).

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type {
    McpHttpHandler,
    McpServer,
    RegisteredTool,
} from "@modelcontextprotocol/server";
import { Problems, admitBrowserOrigin, isRecord } from "@plurnk/plurnk-contracts";
import { InFlightTracker, writeHttpProblem, type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { allowOrigin as readAllowOrigin } from "./config.ts";
import {
    MCP_SERVER_SUBSCRIBED_EVENTS,
    RouteScopedEventBus,
    workspaceMutationUrisOf,
    type McpCallerClaims,
    type McpRequestContext,
    type McpRouteTarget,
    type PublishScope,
} from "./server/EventBus.ts";
import {
    admitRequest,
    applyCorsHeaders,
    isInitializePayload,
    isRecognizedMcpPost,
    mcpHttpProblem,
    parseRouteSegments,
    readRequestBody,
    serveHttpExchange,
    serviceStoppingProblem,
    writeJsonRpcHttpError,
    type ActiveHttpExchange,
} from "./server/HttpExchange.ts";
import type { LegacyMcpSession } from "./server/ResourceSurface.ts";
import { resolveMcpRouteTarget } from "./server/RouteTarget.ts";
import type * as ServerRuntimeModule from "./server/ServerRuntime.ts";
import type { CatalogToolCache } from "./server/ToolCatalog.ts";
import { StreamCompletionTracker, executeMcpToolCall } from "./server/ToolDispatch.ts";

interface LoadedServerRuntime {
    readonly module: typeof ServerRuntimeModule;
    readonly mcpHandler: McpHttpHandler;
    readonly catalogTools: CatalogToolCache;
}

export interface McpServerModuleOptions {
    readonly allowOrigin?: string;
    readonly env?: NodeJS.ProcessEnv;
}

export default class McpServerModule implements DaemonModule<never> {
    readonly mounts: readonly string[] = Object.freeze(["/mcp"]);
    readonly #allowOrigin: string;
    #seam!: ApplicationPort;
    #runtime: LoadedServerRuntime | null = null;
    #runtimePromise: Promise<LoadedServerRuntime> | null = null;
    readonly #requestContext = new AsyncLocalStorage<McpRequestContext>();
    readonly #eventBus = new RouteScopedEventBus(this.#requestContext);
    readonly #legacySessions = new Map<string, LegacyMcpSession>();
    readonly #inFlight = new InFlightTracker();
    readonly #activeExchanges = new Set<ActiveHttpExchange>();
    readonly #streamTracker = new StreamCompletionTracker();
    #offEvents: (() => void) | null = null;
    #offRuntimeStream: (() => void) | null = null;
    #activated = false;
    #stopped = false;

    private constructor(opts: McpServerModuleOptions) {
        this.#allowOrigin =
            opts.allowOrigin === undefined ? readAllowOrigin(opts.env ?? process.env) : opts.allowOrigin;
    }

    static create(opts: McpServerModuleOptions = {}): McpServerModule {
        return new McpServerModule(opts);
    }

    // Load `@modelcontextprotocol/server`, resource surface, and tool catalog lazily
    // on the first `/mcp` HTTP request so idle daemons retain zero MCP server SDK heap (#1578).
    #ensureRuntime(): Promise<LoadedServerRuntime> {
        if (this.#runtime !== null) return Promise.resolve(this.#runtime);
        if (this.#runtimePromise === null) {
            const pending = import("./server/ServerRuntime.ts").then((mod): LoadedServerRuntime => {
                const catalogTools = new mod.CatalogToolCache();
                const mcpHandler = mod.createMcpHandler((ctx) => this.#buildServer(ctx.era), { bus: this.#eventBus });
                const loaded: LoadedServerRuntime = { module: mod, mcpHandler, catalogTools };
                this.#runtime = loaded;
                return loaded;
            }).catch((error: unknown) => {
                if (this.#runtimePromise === pending) this.#runtimePromise = null;
                throw error;
            });
            this.#runtimePromise = pending;
        }
        return this.#runtimePromise;
    }

    start(seam: ApplicationPort): void {
        if (this.#stopped) throw new Error("plurnk-mcp: stopped server module cannot be activated");
        if (this.#activated) throw new Error("plurnk-mcp: server module already activated");
        this.#seam = seam;
        this.#offEvents = seam.subscribeToEvents(
            (workspaceId, method, params) => {
                this.#handleDaemonEvent(workspaceId, method, params);
            },
            { events: MCP_SERVER_SUBSCRIBED_EVENTS },
        );
        this.#offRuntimeStream =
            seam.subscribeToRuntimeStream?.((workspaceId, method, params) => {
                if (method === "log/entry") {
                    this.#handleDaemonEvent(workspaceId, method, params);
                }
            }) ?? null;
        seam.registerHttpRoute("/mcp", (req, res) => this.#inFlight.track(this.#route(req, res)));
        this.#activated = true;
    }

    stop(): void {
        this.#stopped = true;
        this.#runtime?.catalogTools.clear();
    }

    async close(): Promise<void> {
        this.stop();
        if (!this.#activated) return;
        this.#activated = false;
        this.#offEvents?.();
        this.#offEvents = null;
        this.#offRuntimeStream?.();
        this.#offRuntimeStream = null;
        this.#streamTracker.abortAll();
        const runtime = this.#runtime ?? (this.#runtimePromise === null ? null : await this.#runtimePromise.catch(() => null));
        this.#runtime = null;
        this.#runtimePromise = null;
        runtime?.catalogTools.clear();
        const closingSessions = [...this.#legacySessions.values()];
        this.#legacySessions.clear();
        await Promise.allSettled(closingSessions.map((session) => session.close()));
        for (const exchange of [...this.#activeExchanges]) {
            exchange.controller.abort(new Error("Service shutting down"));
            if (!exchange.res.writableEnded && !exchange.res.destroyed) {
                exchange.res.end();
            }
        }
        if (runtime !== null) {
            await runtime.mcpHandler.close();
        }
        this.#eventBus.clear();
        await this.#inFlight.drain();
    }

    #handleDaemonEvent(workspaceId: number | null, method: string, params: unknown): void {
        const runtime = this.#runtime;
        if (runtime === null) return;
        if (!isRecord(params)) return;
        const resolvedWorkspaceId =
            workspaceId ?? (typeof params.workspaceId === "number" ? params.workspaceId : null);
        if (resolvedWorkspaceId === null) return;

        switch (method) {
            case "stream/concluded": {
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const target = typeof params.target === "string" ? params.target : null;
                if (sessionId === null || target === null) return;
                this.#streamTracker.recordConcluded(
                    resolvedWorkspaceId,
                    sessionId,
                    target,
                    isRecord(params.result) ? params.result : null,
                );
                return;
            }
            case "functionality/changed": {
                const family =
                    typeof params.family === "string" && params.family.length > 0 ? params.family : null;
                if (family === null) return;
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const scope: PublishScope = { workspaceId: resolvedWorkspaceId, sessionId };
                if (family === "mcp" || family === "skills") {
                    runtime.catalogTools.invalidate(resolvedWorkspaceId, sessionId);
                    this.#eventBus.publishScoped({ kind: "tools_list_changed" }, scope);
                    this.#eventBus.publishScoped({ kind: "resource_updated", uri: "mcp:///plurnk.md" }, scope);
                    this.#eventBus.publishScoped({ kind: "resource_updated", uri: "mcp:///plurnk.json" }, scope);
                }
                this.#eventBus.publishScoped(
                    { kind: "resource_updated", uri: `mcp:///plurnk/${family}.json` },
                    scope,
                );
                this.#eventBus.publishScoped({ kind: "resources_list_changed" }, scope);
                return;
            }
            case "log/entry": {
                const entry = isRecord(params.entry) ? params.entry : params;
                const sessionId = typeof entry.sessionId === "number" ? entry.sessionId : null;
                if (sessionId !== null) {
                    this.#eventBus.publishScoped(
                        { kind: "resource_updated", uri: "plurnk:///recent.json" },
                        { workspaceId: resolvedWorkspaceId, sessionId, allowRuntimeSession: true },
                    );
                    this.#eventBus.publishScoped(
                        { kind: "resource_updated", uri: "plurnk:///status.json" },
                        { workspaceId: resolvedWorkspaceId, sessionId },
                    );
                }
                const mutatedUris = workspaceMutationUrisOf(entry);
                if (mutatedUris.length > 0) {
                    const mutationScope: PublishScope =
                        sessionId !== null
                            ? { workspaceId: resolvedWorkspaceId, sessionId, allowRuntimeSession: true }
                            : { workspaceId: resolvedWorkspaceId };
                    for (const uri of mutatedUris) {
                        this.#eventBus.publishScoped({ kind: "resource_updated", uri }, mutationScope);
                    }
                    this.#eventBus.publishScoped({ kind: "resources_list_changed" }, mutationScope);
                }
                return;
            }
            case "session/policy":
            case "session/titled":
            case "loop/started":
            case "loop/parked":
            case "loop/proposal":
            case "loop/interaction":
            case "loop/gate-settled":
            case "loop/terminated": {
                const sessionId =
                    typeof params.sessionId === "number"
                        ? params.sessionId
                        : typeof params.id === "number"
                          ? params.id
                          : null;
                if (sessionId !== null) {
                    this.#eventBus.publishScoped(
                        { kind: "resource_updated", uri: "plurnk:///status.json" },
                        { workspaceId: resolvedWorkspaceId, sessionId },
                    );
                }
                return;
            }
            case "session/created":
            case "session/archived":
            case "session/deleted": {
                if (method === "session/archived" || method === "session/deleted") {
                    const removedSessionId =
                        typeof params.id === "number"
                            ? params.id
                            : typeof params.sessionId === "number"
                              ? params.sessionId
                              : null;
                    runtime.catalogTools.invalidate(resolvedWorkspaceId, removedSessionId);
                }
                this.#eventBus.publishScoped(
                    { kind: "resources_list_changed" },
                    { workspaceId: resolvedWorkspaceId },
                );
                return;
            }
            default:
                return;
        }
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        applyCorsHeaders(res, this.#allowOrigin, req);
        const method = (req.method ?? "GET").toUpperCase();
        if (method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        const browserOrigin = admitBrowserOrigin(req, {
            allowOrigin: this.#allowOrigin,
            listener: this.#seam.httpAddress(),
            domain: "mcp:http",
            codePrefix: "mcp/http",
        });
        if (!browserOrigin.ok) {
            writeHttpProblem(res, browserOrigin.problem);
            return;
        }
        const admission = await admitRequest(this.#seam.credentials, req);
        if (!admission.ok) {
            writeHttpProblem(res, admission.problem, { "www-authenticate": admission.challenge });
            return;
        }

        const hostHeader = typeof req.headers.host === "string" && req.headers.host.trim().length > 0
            ? req.headers.host.trim()
            : "127.0.0.1";
        let url: URL;
        try {
            url = new URL(req.url ?? "/mcp", `http://${hostHeader}`);
        } catch {
            writeHttpProblem(
                res,
                mcpHttpProblem("request-target-invalid", 400, "The HTTP request target is invalid.", {
                    path: req.url ?? null,
                    stage: "routing",
                    retryable: false,
                }),
            );
            return;
        }

        const parsedRoute = parseRouteSegments(url.pathname);
        if (!parsedRoute.ok) {
            writeHttpProblem(res, parsedRoute.problem);
            return;
        }

        if (method !== "POST" && method !== "GET" && method !== "DELETE") {
            writeJsonRpcHttpError(res, 405, -32_000, "Method not allowed.", {
                allow: "GET, POST, DELETE, OPTIONS",
            });
            return;
        }

        const rawSessionHeader = req.headers["mcp-session-id"];
        const mcpSessionId =
            typeof rawSessionHeader === "string" && rawSessionHeader.trim().length > 0
                ? rawSessionHeader.trim()
                : null;

        if (method === "GET" || method === "DELETE") {
            if (mcpSessionId === null) {
                writeJsonRpcHttpError(res, 405, -32_000, "Method not allowed.", { allow: "POST" });
                return;
            }
            let target: McpRouteTarget;
            try {
                target = await resolveMcpRouteTarget(
                    this.#seam,
                    parsedRoute.workspaceSegment,
                    parsedRoute.sessionSegment,
                    false,
                );
            } catch (cause) {
                const problem = Problems.fromError(cause);
                if (problem !== null) {
                    writeHttpProblem(res, problem);
                    return;
                }
                throw cause;
            }
            const legacySession = this.#lookupLegacySession(mcpSessionId, admission.subject, target);
            if (legacySession === null) {
                writeJsonRpcHttpError(res, 404, -32_001, "Session not found");
                return;
            }
            await serveHttpExchange({
                activeExchanges: this.#activeExchanges,
                requestContext: this.#requestContext,
                req,
                res,
                url,
                method,
                bodyBuffer: null,
                target,
                subject: admission.subject,
                ...(admission.handle !== undefined ? { handle: admission.handle } : {}),
                ...(admission.name !== undefined ? { name: admission.name } : {}),
                ...(admission.canDelegateActor === true ? { canDelegateActor: true } : {}),
                dispatch: (webRequest) => legacySession.transport.handleRequest(webRequest),
            });
            return;
        }

        const bodyBuffer = await readRequestBody(req);
        let parsedBody: unknown;
        let hasParsedBody = false;
        if (bodyBuffer.byteLength > 0) {
            try {
                parsedBody = JSON.parse(bodyBuffer.toString("utf8"));
                hasParsedBody = true;
            } catch {
                hasParsedBody = false;
            }
        }

        const allowAutoCreate = isRecognizedMcpPost(req, parsedBody, hasParsedBody);
        let target: McpRouteTarget;
        try {
            target = await resolveMcpRouteTarget(
                this.#seam,
                parsedRoute.workspaceSegment,
                parsedRoute.sessionSegment,
                allowAutoCreate,
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem !== null) {
                writeHttpProblem(res, problem);
                return;
            }
            throw cause;
        }

        const runtime = await this.#ensureRuntime();
        await serveHttpExchange({
            activeExchanges: this.#activeExchanges,
            requestContext: this.#requestContext,
            req,
            res,
            url,
            method,
            bodyBuffer,
            target,
            subject: admission.subject,
            ...(admission.handle !== undefined ? { handle: admission.handle } : {}),
            ...(admission.name !== undefined ? { name: admission.name } : {}),
            ...(admission.canDelegateActor === true ? { canDelegateActor: true } : {}),
            dispatch: async (webRequest) => {
                const legacy = await runtime.module.isLegacyRequest(webRequest, hasParsedBody ? parsedBody : undefined);
                if (!legacy) {
                    return runtime.mcpHandler.fetch(webRequest);
                }
                if (mcpSessionId !== null) {
                    const legacySession = this.#lookupLegacySession(mcpSessionId, admission.subject, target);
                    if (legacySession === null) {
                        return Response.json(
                            { jsonrpc: "2.0", error: { code: -32_001, message: "Session not found" }, id: null },
                            { status: 404 },
                        );
                    }
                    if (legacySession.toolsDirty) {
                        await this.#syncTools(
                            runtime,
                            legacySession.server,
                            legacySession.target,
                            legacySession.claims,
                            legacySession.registeredTools,
                        );
                        legacySession.toolsDirty = false;
                    }
                    return legacySession.transport.handleRequest(
                        webRequest,
                        hasParsedBody ? { parsedBody } : undefined,
                    );
                }
                if (hasParsedBody && isInitializePayload(parsedBody)) {
                    const claims: McpCallerClaims = {
                        subject: admission.subject,
                        ...(admission.handle !== undefined ? { handle: admission.handle } : {}),
                        ...(admission.name !== undefined ? { name: admission.name } : {}),
                        ...(admission.canDelegateActor === true ? { canDelegateActor: true } : {}),
                    };
                    return this.#serveLegacyInitialize(runtime, webRequest, parsedBody, claims, target);
                }
                return runtime.mcpHandler.fetch(webRequest);
            },
        });
    }

    #lookupLegacySession(
        sessionId: string,
        subject: string | null,
        target: McpRouteTarget,
    ): LegacyMcpSession | null {
        const existing = this.#legacySessions.get(sessionId);
        if (
            existing === undefined ||
            existing.closed ||
            existing.subject !== subject ||
            existing.target.workspaceId !== target.workspaceId ||
            existing.target.sessionId !== target.sessionId
        ) {
            return null;
        }
        this.#legacySessions.delete(sessionId);
        this.#legacySessions.set(sessionId, existing);
        return existing;
    }

    async #serveLegacyInitialize(
        runtime: LoadedServerRuntime,
        webRequest: Request,
        parsedBody: unknown,
        claims: McpCallerClaims,
        target: McpRouteTarget,
    ): Promise<Response> {
        const registeredTools = new Map<string, RegisteredTool>();
        const subscribedUris = new Set<string>();
        let server!: McpServer;
        const transport = new runtime.module.WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid) => {
                legacySession.sessionId = sid;
                this.#legacySessions.set(sid, legacySession);
                while (this.#legacySessions.size > 256) {
                    const oldestKey = this.#legacySessions.keys().next().value;
                    if (oldestKey === undefined) break;
                    const evicted = this.#legacySessions.get(oldestKey);
                    this.#legacySessions.delete(oldestKey);
                    void evicted?.close();
                }
            },
        });
        const legacySession: LegacyMcpSession = {
            sessionId: null,
            subject: claims.subject,
            claims,
            target,
            get server(): McpServer {
                return server;
            },
            transport,
            subscribedUris,
            registeredTools,
            toolsDirty: false,
            unsubscribeBus: null,
            closed: false,
            close: async () => {
                if (legacySession.closed) return;
                legacySession.closed = true;
                legacySession.unsubscribeBus?.();
                legacySession.unsubscribeBus = null;
                if (legacySession.sessionId !== null) {
                    this.#legacySessions.delete(legacySession.sessionId);
                }
                await Promise.allSettled([transport.close(), server.close()]);
            },
        };
        server = await this.#buildServer("legacy", legacySession, runtime);
        legacySession.unsubscribeBus = this.#requestContext.run({ target, ...claims }, () =>
            this.#eventBus.subscribe((event) => {
                if (legacySession.closed) return;
                switch (event.kind) {
                    case "tools_list_changed":
                        legacySession.toolsDirty = true;
                        server.sendToolListChanged();
                        return;
                    case "resources_list_changed":
                        server.sendResourceListChanged();
                        return;
                    case "resource_updated":
                        if (legacySession.subscribedUris.has(event.uri)) {
                            void server.server
                                .sendResourceUpdated({ uri: event.uri })
                                .catch(() => undefined);
                        }
                        return;
                    case "prompts_list_changed":
                        return;
                }
            }),
        );
        transport.onclose = () => {
            void legacySession.close();
        };
        await server.connect(transport);
        const response = await transport.handleRequest(webRequest, { parsedBody });
        if (!response.ok || legacySession.sessionId === null) {
            await legacySession.close();
        }
        return response;
    }

    #syncTools(
        runtime: LoadedServerRuntime,
        server: McpServer,
        target: McpRouteTarget,
        fallbackClaims: McpCallerClaims,
        registry?: Map<string, RegisteredTool>,
    ): Promise<void> {
        return runtime.catalogTools.syncServerTools({
            seam: this.#seam,
            server,
            target,
            fallbackClaims,
            registry,
            invokeTool: (call) =>
                executeMcpToolCall({
                    seam: this.#seam,
                    streamTracker: this.#streamTracker,
                    requestContext: this.#requestContext,
                    ...call,
                }),
        });
    }

    async #buildServer(
        era: "modern" | "legacy" = "modern",
        legacySession?: LegacyMcpSession,
        loadedRuntime?: LoadedServerRuntime,
    ): Promise<McpServer> {
        const runtime = loadedRuntime ?? await this.#ensureRuntime();
        const reqCtx = this.#requestContext.getStore();
        const target = legacySession?.target ?? reqCtx?.target;
        if (target === undefined) {
            throw new Error("plurnk-mcp: missing request target context");
        }
        const fallbackClaims: McpCallerClaims = legacySession?.claims ?? {
            subject: reqCtx?.subject ?? null,
            ...(reqCtx?.handle !== undefined ? { handle: reqCtx.handle } : {}),
            ...(reqCtx?.name !== undefined ? { name: reqCtx.name } : {}),
            ...(reqCtx?.canDelegateActor === true ? { canDelegateActor: true } : {}),
        };
        const mcpPkg: unknown = createRequire(import.meta.url)("../package.json");
        const version =
            isRecord(mcpPkg) && typeof mcpPkg.version === "string" && mcpPkg.version.length > 0
                ? mcpPkg.version
                : "4.0.0";
        const server = new runtime.module.McpServer(
            { name: "plurnk", version, title: "Plurnk" },
            {
                capabilities: {
                    tools: { listChanged: true },
                    resources: { subscribe: true, listChanged: true },
                },
            },
        );
        await this.#syncTools(runtime, server, target, fallbackClaims, legacySession?.registeredTools);
        runtime.module.registerMcpResources({ server, seam: this.#seam, target, era, legacySession });
        return server;
    }
}
