// {§mcp-http-server} — Streamable HTTP MCP server mounted at `/mcp[/<workspace>[/<session>]]`
// on the daemon's shared HTTP listener ({§http-host}, {§module-contract}).
// Exposes the unified `plurnk` tool surface and `mcp:///plurnk.md` + `mcp:///plurnk.json`
// resources to external MCP v2 (`2026-07-28`) and standard `2025-06-18` / `2025-11-25` clients,
// authenticating against `seam.credentials` when a credential face is published ({§credential-authority}).

import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import {
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    ResourceTemplate,
    WebStandardStreamableHTTPServerTransport,
    createMcpHandler,
    fromJsonSchema,
    isLegacyRequest,
    type JsonSchemaType,
    type JsonSchemaValidator,
    type McpHttpHandler,
    type RegisteredTool,
    type ServerEvent,
    type ServerEventBus,
    type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import {
    Problems,
    Validator,
    actorsMatch,
    admitBearerRequest,
    admitBrowserOrigin,
    isExecution,
    isRecord,
    parseExteriorActor,
    type BearerAdmission,
    type ClientEntryChannel,
    type CredentialAuthority,
    type EntryReadResult,
    type JsonSchema,
    type ParsedPath,
    type PlurnkStatement,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { allowOrigin as readAllowOrigin } from "./config.ts";

const MCP_OWNER_ACTOR = "mcp:///owner";

export interface McpServerModuleOptions {
    readonly allowOrigin?: string;
    readonly env?: NodeJS.ProcessEnv;
}

const RECOGNIZED_MCP_METHODS: ReadonlySet<string> = new Set([
    "server/discover",
    "initialize",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "subscriptions/listen",
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
]);

const TEXT_APPLICATION_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/javascript",
    "application/ecmascript",
    "application/typescript",
    "application/sql",
    "application/jsonl",
    "application/x-ndjson",
]);

const TEXT_MIMETYPE_SUFFIXES = ["+json", "+xml", "+yaml", "+toml"] as const;

const isBinaryChannelMimetype = (rawMimetype: string): boolean => {
    const essence = (rawMimetype.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (essence.length === 0) return false;
    const slash = essence.indexOf("/");
    if (slash === -1) return true;
    if (essence.slice(0, slash) === "text") return false;
    if (TEXT_APPLICATION_MIMETYPES.has(essence)) return false;
    return !TEXT_MIMETYPE_SUFFIXES.some((suffix) => essence.endsWith(suffix));
};

const resourceReadError = (uri: string, status: number, detail: string): ProtocolError => {
    if (status === 404) {
        return new ResourceNotFoundError(uri, detail);
    }
    if (status >= 500) {
        return new ProtocolError(ProtocolErrorCode.InternalError, detail, { uri, status });
    }
    return new ProtocolError(ProtocolErrorCode.InvalidParams, detail, { uri, status });
};

const requireEntryChannel = (uri: string, read: EntryReadResult, missingMessage?: string): ClientEntryChannel => {
    if (read.entry === null) {
        throw resourceReadError(uri, read.status, read.problem.detail);
    }
    const channel = read.entry.channels.body ?? Object.values(read.entry.channels)[0];
    if (channel === undefined) {
        throw new ResourceNotFoundError(uri, missingMessage);
    }
    return channel;
};

const isSubscribableMcpResourceUri = (uri: string): boolean => {
    if (
        uri === "mcp:///plurnk.md" ||
        uri === "mcp:///plurnk.json" ||
        uri === "plurnk:///status.json" ||
        uri === "plurnk:///recent.json"
    ) {
        return true;
    }
    if (uri.startsWith("workspace:///") && uri.length > "workspace:///".length) return true;
    if (/^mcp:\/\/\/plurnk\/[^/]+\.json$/u.test(uri)) return true;
    if (/^log:\/\/\/\d+\/\d+\/\d+\/[^/]+$/u.test(uri)) return true;
    return false;
};

const isHostPathTarget = (target: ParsedPath | null): boolean => {
    if (target === null) return false;
    if (target.kind !== "url") return true;
    return (
        target.scheme === null ||
        target.scheme === "file" ||
        target.scheme === "ws" ||
        target.scheme === "wss"
    );
};

const isReadOnlyFunctionalityBody = (rawBody: string | null): boolean => {
    const trimmed = (rawBody ?? "").trim();
    if (trimmed.length === 0 || trimmed === "{}") return true;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return false;
    }
    if (!isRecord(parsed)) return false;
    if (typeof parsed.action === "string") {
        return parsed.action === "list" || parsed.action === "discover";
    }
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    return keys.length === 1 && keys[0] === "discover" && typeof parsed.discover === "string";
};

const isHostEffectInvocation = (statement: PlurnkStatement, readOnlyHint?: boolean): boolean => {
    if (readOnlyHint === true) return false;
    if (isExecution(statement)) {
        if (statement.runtime === "plurnk") {
            const familyTarget = statement.target?.raw ?? "";
            if (familyTarget === "question") return false;
            return !isReadOnlyFunctionalityBody(statement.body);
        }
        return true;
    }
    switch (statement.op) {
        case "edit":
            return isHostPathTarget(statement.target);
        case "copy":
            return isHostPathTarget(statement.destination.target);
        case "move":
            return isHostPathTarget(statement.source.target) || isHostPathTarget(statement.destination.target);
        case "kill":
            return isHostPathTarget(statement.target);
        case "send":
            return (
                statement.target !== null &&
                statement.target.kind === "url" &&
                (statement.target.scheme === "http" ||
                    statement.target.scheme === "https" ||
                    statement.target.scheme === "ws" ||
                    statement.target.scheme === "wss")
            );
        default:
            return false;
    }
};

const isJsonContentTypeHeader = (raw: string | readonly string[] | undefined): boolean => {
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== "string") return false;
    const essence = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
    return essence === "application/json" || essence.endsWith("+json");
};

const isRecognizedMcpMessage = (value: unknown): boolean =>
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    RECOGNIZED_MCP_METHODS.has(value.method);

const isRecognizedMcpPost = (req: IncomingMessage, parsedBody: unknown, hasParsedBody: boolean): boolean => {
    if (!hasParsedBody || !isJsonContentTypeHeader(req.headers["content-type"])) return false;
    if (Array.isArray(parsedBody)) {
        return parsedBody.length > 0 && parsedBody.every(isRecognizedMcpMessage);
    }
    return isRecognizedMcpMessage(parsedBody);
};

const isInitializePayload = (parsedBody: unknown): boolean =>
    isRecord(parsedBody) && parsedBody.jsonrpc === "2.0" && parsedBody.method === "initialize";

const BASE_CORS_ALLOW_HEADERS =
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id";

const HEADER_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

const applyCorsHeaders = (res: ServerResponse, origin: string, req?: IncomingMessage): void => {
    if (origin.length === 0) return;
    const requested = req?.headers["access-control-request-headers"];
    const requestedRaw = Array.isArray(requested) ? requested.join(",") : requested;
    const extraParamHeaders: string[] = [];
    if (typeof requestedRaw === "string" && requestedRaw.length > 0) {
        for (const item of requestedRaw.split(",")) {
            const token = item.trim().toLowerCase();
            if (token.startsWith("mcp-param-") && HEADER_TOKEN_PATTERN.test(token)) {
                extraParamHeaders.push(token);
            }
        }
    }
    const allowHeaders =
        extraParamHeaders.length > 0
            ? `${BASE_CORS_ALLOW_HEADERS}, ${[...new Set(extraParamHeaders)].join(", ")}`
            : BASE_CORS_ALLOW_HEADERS;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", allowHeaders);
    res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
};

const logCoordinateOf = (row: Readonly<Record<string, unknown>> | undefined): string | null => {
    if (
        row === undefined ||
        typeof row.loop_seq !== "number" ||
        typeof row.turn_seq !== "number" ||
        typeof row.sequence !== "number" ||
        typeof row.op !== "string" ||
        row.op.length === 0
    ) {
        return null;
    }
    return `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/${row.op.toLowerCase()}`;
};

interface McpRouteTarget {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly runtimeSessionId: number;
    readonly isModelSession: boolean;
}

interface McpRequestContext {
    readonly target: McpRouteTarget;
    readonly subject: string | null;
}

interface CompiledCatalogToolEntry {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: ReturnType<typeof fromJsonSchema>;
    readonly readOnlyHint?: boolean;
}

interface CachedCatalogTools {
    readonly rawContent: string;
    readonly tools: readonly CompiledCatalogToolEntry[];
}

interface LegacyMcpSession {
    sessionId: string | null;
    readonly subject: string | null;
    readonly target: McpRouteTarget;
    readonly server: McpServer;
    readonly transport: WebStandardStreamableHTTPServerTransport;
    readonly subscribedUris: Set<string>;
    readonly registeredTools: Map<string, RegisteredTool>;
    toolsDirty: boolean;
    unsubscribeBus: (() => void) | null;
    closed: boolean;
    close: () => Promise<void>;
}

interface StreamConcludedWaiter {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly resolve: (result: Readonly<Record<string, unknown>> | null) => void;
}

interface ActiveHttpExchange {
    readonly controller: AbortController;
    readonly res: ServerResponse;
}

interface ScopedSubscription {
    readonly target: McpRouteTarget;
    readonly listener: (event: ServerEvent) => void;
}

interface PublishScope {
    readonly workspaceId: number;
    readonly sessionId?: number | null;
    readonly allowRuntimeSession?: boolean;
}

const MCP_SERVER_SUBSCRIBED_EVENTS = Object.freeze([
    "functionality/changed",
    "session/created",
    "session/archived",
    "session/deleted",
    "session/titled",
    "session/policy",
    "loop/started",
    "loop/parked",
    "loop/proposal",
    "loop/interaction",
    "loop/gate-settled",
    "loop/terminated",
    "log/entry",
    "stream/concluded",
] as const);

const MUTATING_WORKSPACE_OPS: ReadonlySet<string> = new Set(["edit", "copy", "move", "kill"]);

const toWorkspaceResourceUri = (scheme: unknown, rawCandidate: string): string | null => {
    const base = rawCandidate.split(/[?#]/u, 1)[0] ?? "";
    if (base.length === 0) return null;
    if (base.startsWith("workspace:///")) {
        const rel = base.slice("workspace:///".length).replace(/^\/+/u, "");
        return rel.length > 0 ? `workspace:///${rel}` : null;
    }
    if (base.includes("://")) return null;
    if (scheme === "workspace" || scheme === null || scheme === undefined) {
        const rel = base.replace(/^\/+/u, "");
        return rel.length > 0 ? `workspace:///${rel}` : null;
    }
    return null;
};

const workspaceMutationUrisOf = (entry: Readonly<Record<string, unknown>>): readonly string[] => {
    const statusRx = typeof entry.status_rx === "number" ? entry.status_rx : 200;
    if (statusRx >= 400) return [];
    if (entry.state === "proposed" || entry.state === "failed" || entry.state === "cancelled") {
        return [];
    }
    const rawOp = typeof entry.op === "string" ? entry.op.toLowerCase() : null;
    const isMaterializedWorkspace =
        rawOp === null &&
        entry.scheme === "workspace" &&
        isRecord(entry.attrs) &&
        entry.attrs.kind === "entry_materialized";
    if (!isMaterializedWorkspace && (rawOp === null || !MUTATING_WORKSPACE_OPS.has(rawOp))) {
        return [];
    }

    const uris = new Set<string>();
    const addCandidate = (scheme: unknown, candidate: unknown): void => {
        if (typeof candidate !== "string" || candidate.length === 0) return;
        const resolved = toWorkspaceResourceUri(scheme, candidate);
        if (resolved !== null) uris.add(resolved);
    };

    if (typeof entry.pathname === "string" && entry.pathname.length > 0) {
        addCandidate(entry.scheme, entry.pathname);
    }
    if (typeof entry.tx === "string") {
        addCandidate(entry.scheme, entry.tx);
    } else if (isRecord(entry.tx)) {
        if (isRecord(entry.tx.target) && typeof entry.tx.target.raw === "string") {
            addCandidate(entry.scheme, entry.tx.target.raw);
        } else if (typeof entry.tx.path === "string") {
            addCandidate(entry.scheme, entry.tx.path);
        }
        if (isRecord(entry.tx.destination) && typeof entry.tx.destination.raw === "string") {
            addCandidate(undefined, entry.tx.destination.raw);
        }
    }
    return [...uris];
};

class RouteScopedEventBus implements ServerEventBus {
    readonly #requestContext: AsyncLocalStorage<McpRequestContext>;
    readonly #subscriptions = new Set<ScopedSubscription>();

    constructor(requestContext: AsyncLocalStorage<McpRequestContext>) {
        this.#requestContext = requestContext;
    }

    publish(event: ServerEvent): void {
        const target = this.#requestContext.getStore()?.target;
        if (target !== undefined) {
            this.publishScoped(event, { workspaceId: target.workspaceId, sessionId: target.sessionId });
            return;
        }
        for (const sub of this.#subscriptions) {
            try {
                sub.listener(event);
            } catch {
                // Isolate listener failures so peer streams continue receiving notifications.
            }
        }
    }

    publishScoped(event: ServerEvent, scope: PublishScope): void {
        for (const sub of this.#subscriptions) {
            if (sub.target.workspaceId !== scope.workspaceId) continue;
            if (scope.sessionId !== undefined && scope.sessionId !== null) {
                const matchesSession = sub.target.sessionId === scope.sessionId;
                const matchesRuntime =
                    scope.allowRuntimeSession === true && sub.target.runtimeSessionId === scope.sessionId;
                if (!matchesSession && !matchesRuntime) continue;
            }
            try {
                sub.listener(event);
            } catch {
                // Isolate listener failures so peer streams continue receiving notifications.
            }
        }
    }

    subscribe(listener: (event: ServerEvent) => void): () => void {
        const target = this.#requestContext.getStore()?.target;
        if (target === undefined) {
            return () => undefined;
        }
        const entry: ScopedSubscription = { target, listener };
        this.#subscriptions.add(entry);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.#subscriptions.delete(entry);
        };
    }

    clear(): void {
        this.#subscriptions.clear();
    }
}

const mcpHttpProblem = (
    slug: string,
    status: number,
    detail: string,
    fields: Readonly<Record<string, unknown>> = {},
): ProblemDetails =>
    Problems.create("mcp:http", slug, status, detail, { code: `mcp/http/${slug}`, ...fields });

const serviceStoppingProblem = (): ProblemDetails =>
    mcpHttpProblem("service-stopping", 503, "The PLURNK service is shutting down.", {
        stage: "shutdown",
        retryable: true,
    });

const writeHttpProblem = (
    res: ServerResponse,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(problem);
    res.writeHead(problem.status, {
        "content-type": "application/problem+json",
        "content-length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
};

const writeJsonRpcHttpError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const body = JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
};

const admitRequest = (
    credentials: CredentialAuthority,
    req: IncomingMessage,
): Promise<BearerAdmission> =>
    admitBearerRequest(credentials, req, {
        domain: "mcp:http",
        codePrefix: "mcp/http",
    });

const plurnkJsonSchemaValidator: jsonSchemaValidator = {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        return (input: unknown) => {
            const result = Validator.validateJsonSchemaInstance(schema, input);
            if (result.valid) {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema validation guarantees input satisfies T
                return { valid: true, data: input as T, errorMessage: undefined };
            }
            const errorMessage =
                result.errors
                    .map((err) => `${err.instanceLocation || "/"}: ${err.error}`)
                    .join("; ") || "Invalid arguments";
            return { valid: false, data: undefined, errorMessage };
        };
    },
};

const parseRouteSegments = (
    pathname: string,
):
    | { readonly ok: true; readonly workspaceSegment?: string; readonly sessionSegment?: string }
    | { readonly ok: false; readonly problem: ProblemDetails } => {
    if (pathname === "/mcp" || pathname === "/mcp/") {
        return { ok: true };
    }
    if (!pathname.startsWith("/mcp/")) {
        return {
            ok: false,
            problem: mcpHttpProblem("route-not-found", 404, "The requested MCP route does not exist.", {
                path: pathname,
                stage: "routing",
                retryable: false,
            }),
        };
    }
    const trimmed = pathname.endsWith("/") ? pathname.slice("/mcp/".length, -1) : pathname.slice("/mcp/".length);
    const rawParts = trimmed.split("/");
    if (rawParts.length > 2 || rawParts.some((part) => part.length === 0)) {
        return {
            ok: false,
            problem: mcpHttpProblem("route-not-found", 404, "The requested MCP route does not exist.", {
                path: pathname,
                stage: "routing",
                recovery: "Use `/mcp`, `/mcp/<workspace>`, or `/mcp/<workspace>/<session>`.",
                retryable: false,
            }),
        };
    }
    try {
        const decoded = rawParts.map((part) => decodeURIComponent(part));
        return {
            ok: true,
            workspaceSegment: decoded[0],
            sessionSegment: decoded[1],
        };
    } catch {
        return {
            ok: false,
            problem: mcpHttpProblem("request-target-invalid", 400, "The MCP route contains malformed percent-encoding.", {
                path: pathname,
                stage: "routing",
                retryable: false,
            }),
        };
    }
};

const readRequestBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

export default class McpServerModule implements DaemonModule<never> {
    readonly mounts: readonly string[] = Object.freeze(["/mcp"]);
    readonly #allowOrigin: string;
    #seam!: ApplicationPort;
    #mcpHandler!: McpHttpHandler;
    readonly #requestContext = new AsyncLocalStorage<McpRequestContext>();
    readonly #eventBus = new RouteScopedEventBus(this.#requestContext);
    readonly #legacySessions = new Map<string, LegacyMcpSession>();
    readonly #work = new Set<Promise<unknown>>();
    readonly #activeExchanges = new Set<ActiveHttpExchange>();
    readonly #streamWaiters = new Set<StreamConcludedWaiter>();
    readonly #recentConcluded = new Map<string, Readonly<Record<string, unknown>> | null>();
    readonly #catalogToolsCache = new Map<string, CachedCatalogTools>();
    #offEvents: (() => void) | null = null;
    #activated = false;
    #stopped = false;

    private constructor(opts: McpServerModuleOptions) {
        this.#allowOrigin =
            opts.allowOrigin === undefined ? readAllowOrigin(opts.env ?? process.env) : opts.allowOrigin;
    }

    static create(opts: McpServerModuleOptions = {}): McpServerModule {
        return new McpServerModule(opts);
    }

    start(seam: ApplicationPort): void {
        if (this.#stopped) throw new Error("plurnk-mcp: stopped server module cannot be activated");
        if (this.#activated) throw new Error("plurnk-mcp: server module already activated");
        this.#seam = seam;
        this.#mcpHandler = createMcpHandler((ctx) => this.#buildServer(ctx.era), { bus: this.#eventBus });
        this.#offEvents = seam.subscribeToEvents(
            (workspaceId, method, params) => {
                this.#handleDaemonEvent(workspaceId, method, params);
            },
            { events: MCP_SERVER_SUBSCRIBED_EVENTS },
        );
        seam.registerHttpRoute("/mcp", (req, res) => this.#track(this.#route(req, res)));
        this.#activated = true;
    }

    stop(): void {
        this.#stopped = true;
        this.#catalogToolsCache.clear();
    }

    async close(): Promise<void> {
        this.stop();
        if (!this.#activated) return;
        this.#activated = false;
        this.#offEvents?.();
        this.#offEvents = null;
        for (const waiter of [...this.#streamWaiters]) {
            this.#streamWaiters.delete(waiter);
            waiter.resolve(null);
        }
        this.#recentConcluded.clear();
        this.#catalogToolsCache.clear();
        const closingSessions = [...this.#legacySessions.values()];
        this.#legacySessions.clear();
        await Promise.allSettled(closingSessions.map((session) => session.close()));
        for (const exchange of [...this.#activeExchanges]) {
            exchange.controller.abort(new Error("Service shutting down"));
            if (!exchange.res.writableEnded && !exchange.res.destroyed) {
                exchange.res.end();
            }
        }
        await this.#mcpHandler.close();
        this.#eventBus.clear();
        while (this.#work.size > 0) {
            await Promise.allSettled([...this.#work]);
        }
    }

    #handleDaemonEvent(workspaceId: number | null, method: string, params: unknown): void {
        if (!isRecord(params)) return;
        const resolvedWorkspaceId =
            workspaceId ?? (typeof params.workspaceId === "number" ? params.workspaceId : null);
        if (resolvedWorkspaceId === null) return;

        switch (method) {
            case "stream/concluded": {
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const target = typeof params.target === "string" ? params.target : null;
                if (sessionId === null || target === null) return;
                const result = isRecord(params.result) ? params.result : null;
                const key = `${resolvedWorkspaceId}:${sessionId}:${target}`;
                this.#recentConcluded.set(key, result);
                if (this.#recentConcluded.size > 256) {
                    const oldest = this.#recentConcluded.keys().next().value;
                    if (oldest !== undefined) this.#recentConcluded.delete(oldest);
                }
                for (const waiter of [...this.#streamWaiters]) {
                    if (
                        waiter.workspaceId === resolvedWorkspaceId &&
                        waiter.sessionId === sessionId &&
                        waiter.target === target
                    ) {
                        this.#streamWaiters.delete(waiter);
                        waiter.resolve(result);
                    }
                }
                return;
            }
            case "functionality/changed": {
                const family =
                    typeof params.family === "string" && params.family.length > 0 ? params.family : null;
                if (family === null) return;
                const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
                const scope: PublishScope = { workspaceId: resolvedWorkspaceId, sessionId };
                if (family === "mcp" || family === "skills") {
                    this.#invalidateCatalogToolsCache(resolvedWorkspaceId, sessionId);
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
                const sessionId =
                    typeof entry.session_id === "number"
                        ? entry.session_id
                        : typeof entry.sessionId === "number"
                          ? entry.sessionId
                          : null;
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
                    this.#invalidateCatalogToolsCache(resolvedWorkspaceId, removedSessionId);
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

    #track<T>(work: Promise<T>): Promise<T> {
        this.#work.add(work);
        const settled = (): void => {
            this.#work.delete(work);
        };
        void work.then(settled, settled);
        return work;
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
                target = await this.#resolveTarget(
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
            await this.#serveExchange(req, res, url, method, null, target, admission.subject, (webRequest) =>
                legacySession.transport.handleRequest(webRequest),
            );
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
            target = await this.#resolveTarget(
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

        await this.#serveExchange(req, res, url, method, bodyBuffer, target, admission.subject, async (webRequest) => {
            const legacy = await isLegacyRequest(webRequest, hasParsedBody ? parsedBody : undefined);
            if (!legacy) {
                return this.#mcpHandler.fetch(webRequest);
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
                    await this.#syncServerTools(
                        legacySession.server,
                        legacySession.target,
                        legacySession.subject,
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
                return this.#serveLegacyInitialize(webRequest, parsedBody, admission.subject, target);
            }
            return this.#mcpHandler.fetch(webRequest);
        });
    }

    async #serveExchange(
        req: IncomingMessage,
        res: ServerResponse,
        url: URL,
        method: string,
        bodyBuffer: Buffer | null,
        target: McpRouteTarget,
        subject: string | null,
        dispatch: (webRequest: Request) => Promise<Response>,
    ): Promise<void> {
        const controller = new AbortController();
        const exchange: ActiveHttpExchange = { controller, res };
        this.#activeExchanges.add(exchange);
        const onAbort = (): void => {
            if (!controller.signal.aborted) {
                controller.abort(new Error("HTTP client disconnected"));
            }
        };
        req.once("aborted", onAbort);
        res.once("close", () => {
            this.#activeExchanges.delete(exchange);
            if (!res.writableEnded) onAbort();
        });

        try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === "string") {
                    headers.set(key, value);
                } else if (Array.isArray(value)) {
                    for (const item of value) headers.append(key, item);
                }
            }
            const webRequest = new Request(url.href, {
                method,
                headers,
                signal: controller.signal,
                ...(bodyBuffer !== null && bodyBuffer.byteLength > 0 ? { body: new Uint8Array(bodyBuffer) } : {}),
            });

            const response = await this.#requestContext.run({ target, subject }, () => dispatch(webRequest));
            await this.#writeResponse(req, res, response, controller.signal);
        } finally {
            req.off("aborted", onAbort);
            this.#activeExchanges.delete(exchange);
        }
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
        webRequest: Request,
        parsedBody: unknown,
        subject: string | null,
        target: McpRouteTarget,
    ): Promise<Response> {
        const registeredTools = new Map<string, RegisteredTool>();
        const subscribedUris = new Set<string>();
        let server!: McpServer;
        const transport = new WebStandardStreamableHTTPServerTransport({
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
            subject,
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
        server = await this.#buildServer("legacy", legacySession);
        legacySession.unsubscribeBus = this.#requestContext.run({ target, subject }, () =>
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

    async #writeResponse(
        req: IncomingMessage,
        res: ServerResponse,
        response: Response,
        signal: AbortSignal,
    ): Promise<void> {
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        const headerObj: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headerObj[key] = value;
        });
        const isEventStream = (headerObj["content-type"] ?? "").toLowerCase().includes("text/event-stream");
        if (isEventStream) {
            req.socket.setTimeout(0);
            headerObj["x-accel-buffering"] = "no";
        }
        res.writeHead(response.status, headerObj);
        if (isEventStream) {
            res.flushHeaders();
        }
        if (response.body === null) {
            res.end();
            return;
        }
        const reader = response.body.getReader();
        const abortSub = addAbortListener(signal, () => {
            void reader.cancel().catch(() => undefined);
        });
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (res.writableEnded || res.destroyed) {
                    await reader.cancel().catch(() => undefined);
                    break;
                }
                res.write(Buffer.from(value));
            }
        } finally {
            abortSub[Symbol.dispose]();
            if (!res.writableEnded && !res.destroyed) {
                res.end();
            }
        }
    }

    async #resolveTarget(
        workspaceSegment?: string,
        sessionSegment?: string,
        allowAutoCreate = true,
    ): Promise<McpRouteTarget> {
        let workspaceId: number;
        if (workspaceSegment !== undefined) {
            if (/^[1-9]\d*$/u.test(workspaceSegment)) {
                const attached = await this.#seam.attachWorkspace({ workspaceId: Number(workspaceSegment) });
                workspaceId = attached.workspaceId;
            } else {
                try {
                    const attached = await this.#seam.attachWorkspace({ name: workspaceSegment });
                    workspaceId = attached.workspaceId;
                } catch (cause) {
                    const problem = Problems.fromError(cause);
                    if (allowAutoCreate && problem !== null && problem.status === 404) {
                        const created = await this.#seam.createWorkspace({ name: workspaceSegment, projectRoot: null });
                        workspaceId = created.workspaceId;
                    } else {
                        throw cause;
                    }
                }
            }
        } else {
            try {
                const attached = await this.#seam.attachWorkspace({ name: "default" });
                workspaceId = attached.workspaceId;
            } catch (cause) {
                const problem = Problems.fromError(cause);
                if (problem !== null && problem.status === 404) {
                    const existing = await this.#seam.listWorkspaces({ archived: false });
                    if (existing.length > 0) {
                        workspaceId = existing[0].id;
                    } else if (allowAutoCreate) {
                        const created = await this.#seam.createWorkspace({ name: "default", projectRoot: null });
                        workspaceId = created.workspaceId;
                    } else {
                        throw cause;
                    }
                } else {
                    throw cause;
                }
            }
        }

        await this.#seam.activateWorkspace({ workspaceId });
        const runtimeSessionId = await this.#seam.ensureRuntimeSession(workspaceId);

        if (sessionSegment !== undefined) {
            if (/^[1-9]\d*$/u.test(sessionSegment)) {
                const requestedId = Number(sessionSegment);
                const existing = await this.#seam.readSession({ workspaceId, identity: { id: requestedId } });
                if (existing === null) {
                    const err = new Error(`Session ${requestedId} does not exist in workspace ${workspaceId}.`);
                    Object.assign(err, {
                        problem: mcpHttpProblem(
                            "session-not-found",
                            404,
                            `Session ${requestedId} does not exist in workspace ${workspaceId}.`,
                            { workspaceId, sessionId: requestedId, stage: "routing", retryable: false },
                        ),
                    });
                    throw err;
                }
                return {
                    workspaceId,
                    sessionId: existing.id,
                    runtimeSessionId,
                    isModelSession: existing.origin === "model",
                };
            }
            if (sessionSegment === "_plurnk") {
                return {
                    workspaceId,
                    sessionId: runtimeSessionId,
                    runtimeSessionId,
                    isModelSession: false,
                };
            }
            const existing = await this.#seam.readSession({ workspaceId, identity: { name: sessionSegment } });
            if (existing !== null) {
                return {
                    workspaceId,
                    sessionId: existing.id,
                    runtimeSessionId,
                    isModelSession: existing.origin === "model",
                };
            }
            if (!allowAutoCreate) {
                const err = new Error(`Session '${sessionSegment}' does not exist in workspace ${workspaceId}.`);
                Object.assign(err, {
                    problem: mcpHttpProblem(
                        "session-not-found",
                        404,
                        `Session '${sessionSegment}' does not exist in workspace ${workspaceId}.`,
                        { workspaceId, session: sessionSegment, stage: "routing", retryable: false },
                    ),
                });
                throw err;
            }
            const created = await this.#seam.createSession({ workspaceId, name: sessionSegment });
            return {
                workspaceId,
                sessionId: created.sessionId,
                runtimeSessionId,
                isModelSession: true,
            };
        }

        const userSession = await this.#seam.readSession({ workspaceId, identity: { name: "user" } });
        if (userSession !== null) {
            return {
                workspaceId,
                sessionId: userSession.id,
                runtimeSessionId,
                isModelSession: userSession.origin === "model",
            };
        }
        const sessions = await this.#seam.listSessions(workspaceId, { archived: false });
        const firstModelSession = sessions.find((s) => s.origin === "model");
        if (firstModelSession !== undefined) {
            return {
                workspaceId,
                sessionId: firstModelSession.id,
                runtimeSessionId,
                isModelSession: true,
            };
        }
        if (!allowAutoCreate) {
            return {
                workspaceId,
                sessionId: runtimeSessionId,
                runtimeSessionId,
                isModelSession: false,
            };
        }
        const created = await this.#seam.createSession({ workspaceId, name: "user" });
        return {
            workspaceId,
            sessionId: created.sessionId,
            runtimeSessionId,
            isModelSession: true,
        };
    }

    #invalidateCatalogToolsCache(workspaceId: number, sessionId: number | null): void {
        if (sessionId !== null) {
            this.#catalogToolsCache.delete(`${workspaceId}:${sessionId}`);
            return;
        }
        const prefix = `${workspaceId}:`;
        for (const key of [...this.#catalogToolsCache.keys()]) {
            if (key.startsWith(prefix)) {
                this.#catalogToolsCache.delete(key);
            }
        }
    }

    async #readCatalogTools(
        workspaceId: number,
        sessionId: number,
    ): Promise<readonly CompiledCatalogToolEntry[]> {
        const cacheKey = `${workspaceId}:${sessionId}`;
        const catalogRead = await this.#seam.readEntry({
            workspaceId,
            sessionId,
            target: "mcp:///plurnk.json",
        });
        const catalogChannel =
            catalogRead.entry !== null
                ? (catalogRead.entry.channels.body ?? Object.values(catalogRead.entry.channels)[0])
                : undefined;
        if (catalogChannel === undefined || catalogChannel.content.length === 0) {
            this.#catalogToolsCache.delete(cacheKey);
            return [];
        }
        const rawContent = catalogChannel.content;
        const cached = this.#catalogToolsCache.get(cacheKey);
        if (cached !== undefined && cached.rawContent === rawContent) {
            this.#catalogToolsCache.delete(cacheKey);
            this.#catalogToolsCache.set(cacheKey, cached);
            return cached.tools;
        }
        try {
            const parsed: unknown = JSON.parse(rawContent);
            if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
                this.#catalogToolsCache.delete(cacheKey);
                return [];
            }
            const out: CompiledCatalogToolEntry[] = [];
            for (const item of parsed.tools) {
                if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) continue;
                const description =
                    typeof item.description === "string" && item.description.length > 0
                        ? item.description
                        : undefined;
                const baseSchema: JsonSchema = isRecord(item.inputSchema)
                    ? item.inputSchema
                    : { type: "object", additionalProperties: true };
                const schema: JsonSchema =
                    item.name === "send" && isRecord(baseSchema.properties)
                        ? {
                              ...baseSchema,
                              properties: {
                                  ...baseSchema.properties,
                                  actor: {
                                      type: "string",
                                      description:
                                          "Optional exterior actor name or URI (`<name>`, `mcp://<name>`, `acp://<name>`) when addressing `session://<name>`.",
                                  },
                              },
                          }
                        : baseSchema;
                const inputSchema = fromJsonSchema(schema as JsonSchemaType, plurnkJsonSchemaValidator);
                const readOnlyHint =
                    isRecord(item.annotations) && item.annotations.readOnlyHint === true ? true : undefined;
                out.push({
                    name: item.name,
                    ...(description !== undefined ? { description } : {}),
                    inputSchema,
                    ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
                });
            }
            const compiled: CachedCatalogTools = { rawContent, tools: out };
            this.#catalogToolsCache.set(cacheKey, compiled);
            if (this.#catalogToolsCache.size > 256) {
                const oldest = this.#catalogToolsCache.keys().next().value;
                if (oldest !== undefined) this.#catalogToolsCache.delete(oldest);
            }
            return out;
        } catch {
            this.#catalogToolsCache.delete(cacheKey);
            return [];
        }
    }

    async #syncServerTools(
        server: McpServer,
        target: McpRouteTarget,
        fallbackSubject: string | null,
        registry?: Map<string, RegisteredTool>,
    ): Promise<void> {
        const tools = await this.#readCatalogTools(target.workspaceId, target.sessionId);
        if (registry !== undefined) {
            const nextNames = new Set(tools.map((tool) => tool.name));
            for (const [name, handle] of [...registry.entries()]) {
                if (!nextNames.has(name)) {
                    handle.remove();
                    registry.delete(name);
                }
            }
        }
        for (const tool of tools) {
            const existing = registry?.get(tool.name);
            if (existing !== undefined) {
                existing.update({
                    description: tool.description,
                    paramsSchema: tool.inputSchema,
                    callback: async (args: unknown, extra: { mcpReq: { signal?: AbortSignal } }) =>
                        this.#executeToolCall(
                            target,
                            fallbackSubject,
                            tool.name,
                            args,
                            tool.readOnlyHint,
                            extra.mcpReq.signal,
                        ),
                });
                continue;
            }
            const registered = server.registerTool(
                tool.name,
                {
                    ...(tool.description !== undefined ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema,
                },
                async (args, extra) =>
                    this.#executeToolCall(
                        target,
                        fallbackSubject,
                        tool.name,
                        args,
                        tool.readOnlyHint,
                        extra.mcpReq.signal,
                    ),
            );
            registry?.set(tool.name, registered);
        }
    }

    async #buildServer(
        era: "modern" | "legacy" = "modern",
        legacySession?: LegacyMcpSession,
    ): Promise<McpServer> {
        const reqCtx = this.#requestContext.getStore();
        const target = legacySession?.target ?? reqCtx?.target;
        if (target === undefined) {
            throw new Error("plurnk-mcp: missing request target context");
        }
        const subject = legacySession?.subject ?? reqCtx?.subject ?? null;
        const { workspaceId, sessionId, runtimeSessionId } = target;
        const mcpPkg: unknown = createRequire(import.meta.url)("../package.json");
        const version =
            isRecord(mcpPkg) && typeof mcpPkg.version === "string" && mcpPkg.version.length > 0
                ? mcpPkg.version
                : "4.0.0";
        const server = new McpServer(
            {
                name: "plurnk",
                version,
                title: "Plurnk",
            },
            {
                capabilities: {
                    tools: { listChanged: true },
                    resources: { subscribe: true, listChanged: true },
                },
            },
        );

        await this.#syncServerTools(server, target, subject, legacySession?.registeredTools);

        if (era === "legacy") {
            server.server.setRequestHandler("resources/subscribe", async (request) => {
                const uri = request.params.uri;
                let parsedUri: URL;
                try {
                    parsedUri = new URL(uri);
                } catch {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI ${uri} is invalid`, {
                        uri,
                        reason: "invalid_uri",
                    });
                }
                if (!isSubscribableMcpResourceUri(parsedUri.href) && !isSubscribableMcpResourceUri(uri)) {
                    throw new ResourceNotFoundError(uri);
                }
                legacySession?.subscribedUris.add(parsedUri.href);
                legacySession?.subscribedUris.add(uri);
                return {};
            });
            server.server.setRequestHandler("resources/unsubscribe", async (request) => {
                const uri = request.params.uri;
                let parsedUri: URL;
                try {
                    parsedUri = new URL(uri);
                } catch {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI ${uri} is invalid`, {
                        uri,
                        reason: "invalid_uri",
                    });
                }
                legacySession?.subscribedUris.delete(parsedUri.href);
                legacySession?.subscribedUris.delete(uri);
                return {};
            });
        }

        server.registerResource(
            "plurnk-docs",
            "mcp:///plurnk.md",
            {
                title: "Plurnk Server Documentation",
                description: "Overview and invocation signatures for all Plurnk server tools.",
                mimeType: "text/markdown",
            },
            async (uri) => {
                const read = await this.#seam.readEntry({ workspaceId, sessionId, target: "mcp:///plurnk.md" });
                const channel = requireEntryChannel(uri.href, read);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/markdown",
                            text: channel.content,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "plurnk-catalog",
            "mcp:///plurnk.json",
            {
                title: "Plurnk Tool Catalog",
                description: "JSON tool definitions for all Plurnk server tools.",
                mimeType: "application/json",
            },
            async (uri) => {
                const read = await this.#seam.readEntry({ workspaceId, sessionId, target: "mcp:///plurnk.json" });
                const channel = requireEntryChannel(uri.href, read);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: channel.content,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "plurnk-status",
            "plurnk:///status.json",
            {
                title: "Plurnk Session Status",
                description: "Live workspace, session, loops, inbox, open streams, pending proposals, and pending interactions.",
                mimeType: "application/json",
            },
            async (uri) => {
                const read = await this.#seam.readEntry({ workspaceId, sessionId, target: "plurnk:///status.json" });
                const channel = requireEntryChannel(uri.href, read);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: channel.content,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "plurnk-recent",
            "plurnk:///recent.json",
            {
                title: "Plurnk Recent Log Entries",
                description: "Recent durable log entries (with canonical log:/// coordinates) for the active session and runtime.",
                mimeType: "application/json",
            },
            async (uri) => {
                const read = await this.#seam.readEntry({ workspaceId, sessionId, target: "plurnk:///recent.json" });
                const channel = requireEntryChannel(uri.href, read);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: channel.content,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "log-entry",
            new ResourceTemplate("log:///{loopSeq}/{turnSeq}/{sequence}/{op}", { list: undefined }),
            {
                title: "Plurnk Durable Log Entry",
                description: "Read a durable log entry by coordinate (`log:///<loopSeq>/<turnSeq>/<sequence>/<op>`).",
                mimeType: "application/json",
            },
            async (uri, variables) => {
                const rawLoopSeq = Array.isArray(variables.loopSeq) ? variables.loopSeq[0] : variables.loopSeq;
                const rawTurnSeq = Array.isArray(variables.turnSeq) ? variables.turnSeq[0] : variables.turnSeq;
                const rawSequence = Array.isArray(variables.sequence) ? variables.sequence[0] : variables.sequence;
                const rawOp = Array.isArray(variables.op) ? variables.op[0] : variables.op;
                if (
                    typeof rawLoopSeq !== "string" ||
                    !/^\d+$/u.test(rawLoopSeq) ||
                    typeof rawTurnSeq !== "string" ||
                    !/^\d+$/u.test(rawTurnSeq) ||
                    typeof rawSequence !== "string" ||
                    !/^\d+$/u.test(rawSequence) ||
                    typeof rawOp !== "string" ||
                    rawOp.length === 0
                ) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Log coordinate '${uri.href}' must contain non-negative integer coordinates and an operation name.`,
                        { uri: uri.href, status: 400 },
                    );
                }
                const loopSeq = Number(rawLoopSeq);
                const turnSeq = Number(rawTurnSeq);
                const sequence = Number(rawSequence);
                if (
                    !Number.isSafeInteger(loopSeq) ||
                    !Number.isSafeInteger(turnSeq) ||
                    !Number.isSafeInteger(sequence)
                ) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Log coordinate '${uri.href}' exceeds safe integer range.`,
                        { uri: uri.href, status: 400 },
                    );
                }
                let rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
                try {
                    const primaryRows = await this.#seam.readLog({
                        workspaceId,
                        sessionId,
                        loopSeq,
                        turnSeq,
                        sequence,
                        limit: 1,
                    });
                    rows =
                        primaryRows.length > 0 || runtimeSessionId === sessionId
                            ? primaryRows
                            : await this.#seam.readLog({
                                  workspaceId,
                                  sessionId: runtimeSessionId,
                                  loopSeq,
                                  turnSeq,
                                  sequence,
                                  limit: 1,
                              });
                } catch (cause) {
                    const problem = Problems.fromError(cause);
                    if (problem !== null) {
                        throw resourceReadError(uri.href, problem.status, problem.detail);
                    }
                    throw cause;
                }
                const row = rows[0];
                if (
                    row === undefined ||
                    (typeof row.op === "string" &&
                        row.op.length > 0 &&
                        row.op.toLowerCase() !== rawOp.toLowerCase())
                ) {
                    throw new ResourceNotFoundError(uri.href, `Log entry not found at '${uri.href}'.`);
                }
                const payload = { ...row, coordinate: logCoordinateOf(row) ?? uri.href };
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: JSON.stringify(payload, null, 2),
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "plurnk-tool-schema",
            new ResourceTemplate("mcp:///plurnk/{tool}.json", { list: undefined }),
            {
                title: "Plurnk Tool Schema",
                description: "JSON schema and invocation metadata for an individual Plurnk tool.",
                mimeType: "application/json",
            },
            async (uri, variables) => {
                const rawTool = Array.isArray(variables.tool) ? variables.tool[0] : variables.tool;
                const tool = typeof rawTool === "string" ? rawTool : "";
                if (tool.length === 0) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Tool name is required in '${uri.href}'.`,
                        { uri: uri.href, status: 400 },
                    );
                }
                const read = await this.#seam.readEntry({
                    workspaceId,
                    sessionId,
                    target: `mcp:///plurnk/${tool}.json`,
                });
                const channel = requireEntryChannel(uri.href, read, `Tool schema not found for '${tool}'.`);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: channel.content,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "workspace-entry",
            new ResourceTemplate("workspace:///{+path}", { list: undefined }),
            {
                title: "Workspace Entry",
                description: "Read a workspace file or directory entry by path (`workspace:///<path>`).",
                mimeType: "text/plain",
            },
            async (uri, variables) => {
                const rawPath = Array.isArray(variables.path) ? variables.path.join("/") : (variables.path ?? "");
                const read = await this.#seam.readEntry({
                    workspaceId,
                    sessionId,
                    target: `workspace:///${rawPath}`,
                });
                const channel = requireEntryChannel(uri.href, read);
                const mimeType = channel.mimetype.length > 0 ? channel.mimetype : "text/plain";
                return {
                    contents: [
                        isBinaryChannelMimetype(mimeType)
                            ? {
                                  uri: uri.href,
                                  mimeType,
                                  blob: channel.content,
                              }
                            : {
                                  uri: uri.href,
                                  mimeType,
                                  text: channel.content,
                              },
                    ],
                };
            },
        );

        return server;
    }

    async #executeToolCall(
        target: McpRouteTarget,
        fallbackSubject: string | null,
        toolName: string,
        args: unknown,
        readOnlyHint?: boolean,
        signal?: AbortSignal,
    ): Promise<{
        readonly isError?: boolean;
        readonly _meta?: Record<string, unknown>;
        readonly content: Array<{ readonly type: "text"; readonly text: string }>;
    }> {
        const { workspaceId, sessionId, isModelSession } = target;
        const verifiedSubject = this.#requestContext.getStore()?.subject ?? fallbackSubject;
        const normalizedArgs = isRecord(args) ? args : {};
        const executors = this.#seam.executorTags(workspaceId);
        const parsed = PlurnkParser.lowerToolCall("plurnk", toolName, normalizedArgs, { executors });
        const parseErrors = parsed.items.filter(
            (item): item is Extract<typeof item, { kind: "error" }> =>
                item.kind === "error" && item.error.severity === "error",
        );
        const statements = parsed.items
            .filter((item): item is Extract<typeof item, { kind: "statement" }> => item.kind === "statement")
            .map((item) => item.statement);
        if (parseErrors.length > 0 || statements.length === 0) {
            const message = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_EXPRESSION;
            return {
                isError: true,
                content: [{ type: "text", text: message }],
            };
        }

        const statement = statements[0];
        if (statement.op === "send" && typeof statement.actor === "string") {
            const parsedActor = parseExteriorActor(statement.actor, "mcp");
            if (parsedActor === null) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Invalid exterior actor '${statement.actor}'. (actor-invalid)` }],
                };
            }
            if (this.#seam.credentials.face() !== null) {
                if (verifiedSubject === null || !actorsMatch(statement.actor, verifiedSubject)) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Actor '${parsedActor.name}' does not match authenticated subject '${verifiedSubject ?? ""}'. (actor-not-authorized)`,
                            },
                        ],
                    };
                }
            }
        }

        const callerActor =
            typeof verifiedSubject === "string" && verifiedSubject.trim().length > 0
                ? (parseExteriorActor(verifiedSubject, "mcp")?.uri ?? `mcp://${encodeURIComponent(verifiedSubject.trim())}`)
                : MCP_OWNER_ACTOR;
        if (
            isHostEffectInvocation(statement, readOnlyHint) &&
            typeof this.#seam.readWorkspaceProposalPolicy === "function"
        ) {
            const { effective } = await this.#seam.readWorkspaceProposalPolicy({ workspaceId });
            if (effective === "reject") {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                `Workspace proposal policy 'reject' forbids host-effecting tool '${toolName}' over /mcp.\n` +
                                "Recovery: Set the workspace proposal policy to 'accept' before invoking host-effecting tools over /mcp.",
                        },
                    ],
                };
            }
            if (effective === "review") {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                `Workspace proposal policy 'review' requires interactive approval, and /mcp has no approval channel for host-effecting tool '${toolName}'.\n` +
                                "Recovery: Approve host-effecting work interactively over /acp or set the workspace proposal policy to 'accept'.",
                        },
                    ],
                };
            }
        }

        let capturedLoop: { readonly sessionId: number; readonly loopId: number } | null = null;
        const readCapturedLoop = (): { readonly sessionId: number; readonly loopId: number } | null => capturedLoop;
        const onAbort = (): void => {
            if (capturedLoop !== null) {
                void this.#seam
                    .cancelLoop({
                        workspaceId,
                        loopId: capturedLoop.loopId,
                        reason: "mcp_client_cancelled",
                    })
                    .catch(() => undefined);
            }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const results = await this.#seam.dispatchClientAction({
                workspaceId,
                actor: callerActor,
                ...(isModelSession ? { contextSessionId: sessionId } : {}),
                statements: [statement],
                onLoop: (loop) => {
                    capturedLoop = loop;
                    if (signal?.aborted === true) {
                        onAbort();
                    }
                },
            });
            const result = results[0] ?? { status: 500, detail: "No operation result returned." };
            if (result.status >= 400) {
                return {
                    isError: true,
                    content: [{ type: "text", text: McpServerModule.#formatFailure(result) }],
                };
            }

            const activeLoop = readCapturedLoop();
            if (isExecution(statement) && activeLoop !== null) {
                return await this.#formatExecutionOutcome(
                    workspaceId,
                    activeLoop,
                    statement.runtime,
                    result,
                    signal,
                );
            }

            const logCoordinate =
                activeLoop !== null
                    ? logCoordinateOf(
                          (
                              await this.#seam.readLog({
                                  workspaceId,
                                  sessionId: activeLoop.sessionId,
                                  loopId: activeLoop.loopId,
                                  limit: 1,
                              })
                          )[0],
                      )
                    : null;
            return {
                ...(logCoordinate !== null ? { _meta: { logCoordinate } } : {}),
                content: [{ type: "text", text: McpServerModule.#formatSuccess(result) }],
            };
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem !== null) {
                const recovery =
                    typeof problem.recovery === "string" && problem.recovery.length > 0
                        ? `\nRecovery: ${problem.recovery}`
                        : "";
                return {
                    isError: true,
                    content: [{ type: "text", text: `${problem.detail}${recovery}` }],
                };
            }
            return {
                isError: true,
                content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
            };
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    async #formatExecutionOutcome(
        workspaceId: number,
        capturedLoop: { readonly sessionId: number; readonly loopId: number },
        runtime: string,
        result: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
    ): Promise<{
        readonly isError?: boolean;
        readonly _meta?: Record<string, unknown>;
        readonly content: Array<{ readonly type: "text"; readonly text: string }>;
    }> {
        const rows = await this.#seam.readLog({
            workspaceId,
            sessionId: capturedLoop.sessionId,
            loopId: capturedLoop.loopId,
            limit: 1,
        });
        const row = rows[0];
        const logCoordinate = logCoordinateOf(row);
        const meta = logCoordinate !== null ? { _meta: { logCoordinate } } : {};
        const attrs: Record<string, unknown> = {
            ...(isRecord(result.attrs) ? result.attrs : {}),
            ...(row !== undefined && isRecord(row.attrs) ? row.attrs : {}),
        };
        const pathname = typeof attrs.pathname === "string" ? attrs.pathname : null;
        const streamTarget =
            typeof attrs.stream === "string"
                ? attrs.stream
                : pathname !== null
                  ? `${runtime}://${pathname}`
                  : null;
        if (streamTarget === null) {
            return {
                ...meta,
                content: [{ type: "text", text: McpServerModule.#formatSuccess(result) }],
            };
        }

        const concludedResult = await this.#waitForStreamConclusion(
            workspaceId,
            capturedLoop.sessionId,
            streamTarget,
            signal,
        );
        const entryRead = await this.#seam.readEntry({
            workspaceId,
            sessionId: capturedLoop.sessionId,
            target: streamTarget,
        });
        const channels = entryRead.entry?.channels ?? {};
        const resultChannel = channels.results ?? channels.result;
        if (resultChannel !== undefined) {
            const isError =
                (concludedResult !== null &&
                    typeof concludedResult.status === "number" &&
                    concludedResult.status >= 400) ||
                resultChannel.state === "errored";
            return {
                ...(isError ? { isError: true } : {}),
                ...meta,
                content: [
                    {
                        type: "text",
                        text:
                            resultChannel.content.length > 0
                                ? resultChannel.content
                                : JSON.stringify(concludedResult ?? result),
                    },
                ],
            };
        }

        const parts: string[] = [];
        for (const [name, ch] of Object.entries(channels)) {
            if (ch.content.length > 0) {
                parts.push(name === "stderr" && parts.length > 0 ? ch.content : ch.content);
            }
        }
        const concludedStatus =
            concludedResult !== null && typeof concludedResult.status === "number"
                ? concludedResult.status
                : typeof result.status === "number"
                  ? result.status
                  : 200;
        const hasChannelError = Object.values(channels).some((ch) => ch.state === "errored");
        const isError = concludedStatus >= 400 || hasChannelError;
        if (isError && concludedResult !== null && isRecord(concludedResult.problem)) {
            const detail =
                typeof concludedResult.problem.detail === "string" ? concludedResult.problem.detail : "";
            if (detail.length > 0 && !parts.some((p) => p.includes(detail))) {
                parts.push(detail);
            }
        }
        const text =
            parts.length > 0
                ? parts.join(parts.every((p) => p.endsWith("\n")) ? "" : "\n")
                : JSON.stringify(concludedResult ?? { status: concludedStatus });
        return {
            ...(isError ? { isError: true } : {}),
            ...meta,
            content: [{ type: "text", text }],
        };
    }

    async #waitForStreamConclusion(
        workspaceId: number,
        sessionId: number,
        streamTarget: string,
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>> | null> {
        const key = `${workspaceId}:${sessionId}:${streamTarget}`;
        if (this.#recentConcluded.has(key)) {
            const cached = this.#recentConcluded.get(key) ?? null;
            this.#recentConcluded.delete(key);
            return cached;
        }

        const openStreams = await this.#seam.readStreams({ workspaceId, sessionId });
        const stillOpen = openStreams.some(
            (s) => s.target === streamTarget && s.channels.some((ch) => ch.state === "active"),
        );
        if (!stillOpen) {
            const cached = this.#recentConcluded.get(key) ?? null;
            this.#recentConcluded.delete(key);
            return cached;
        }

        return new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
            const waiter: StreamConcludedWaiter = {
                workspaceId,
                sessionId,
                target: streamTarget,
                resolve: (res) => {
                    signal?.removeEventListener("abort", onAbort);
                    this.#recentConcluded.delete(key);
                    resolve(res);
                },
            };
            const onAbort = (): void => {
                this.#streamWaiters.delete(waiter);
                resolve({ status: 499 });
            };
            this.#streamWaiters.add(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (this.#recentConcluded.has(key)) {
                this.#streamWaiters.delete(waiter);
                signal?.removeEventListener("abort", onAbort);
                const cached = this.#recentConcluded.get(key) ?? null;
                this.#recentConcluded.delete(key);
                resolve(cached);
            }
        });
    }

    static #formatFailure(result: Readonly<Record<string, unknown>>): string {
        const problem = isRecord(result.problem) ? result.problem : null;
        const detail =
            typeof problem?.detail === "string"
                ? problem.detail
                : typeof result.detail === "string"
                  ? result.detail
                  : typeof result.message === "string"
                    ? result.message
                    : typeof result.content === "string"
                      ? result.content
                      : JSON.stringify(result);
        const recovery =
            typeof problem?.recovery === "string" && problem.recovery.length > 0
                ? `\nRecovery: ${problem.recovery}`
                : "";
        return `${detail}${recovery}`;
    }

    static #formatSuccess(result: Readonly<Record<string, unknown>>): string {
        if (typeof result.content === "string") return result.content;
        if (typeof result.body === "string") return result.body;
        if (result.results !== undefined) return JSON.stringify(result.results, null, 2);
        if (typeof result.detail === "string") return result.detail;
        return JSON.stringify(result, null, 2);
    }
}
