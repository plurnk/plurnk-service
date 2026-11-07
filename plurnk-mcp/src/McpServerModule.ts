// {§mcp-http-server} — Streamable HTTP MCP server mounted at `/mcp[/<workspace>[/<session>]]`
// on the daemon's shared HTTP listener ({§http-host}, {§module-contract}).
// Exposes the unified `plurnk` tool surface and `mcp:///plurnk.md` + `mcp:///plurnk.json`
// resources to external MCP v2 and stateless 2025-era clients, authenticating against
// `seam.credentials` when `PLURNK_AUTH=1` ({§credential-authority}).

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    McpServer,
    ResourceTemplate,
    createMcpHandler,
    fromJsonSchema,
    type JsonSchemaType,
    type JsonSchemaValidator,
    type McpHttpHandler,
    type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import {
    Problems,
    Validator,
    isExecution,
    isRecord,
    type CredentialAuthority,
    type JsonSchema,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { PlurnkParser } from "@plurnk/plurnk-parser";

const MCP_OWNER_ACTOR = "mcp:///owner";

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

interface StreamConcludedWaiter {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly target: string;
    readonly resolve: (result: Readonly<Record<string, unknown>> | null) => void;
}

interface ActiveHttpExchange {
    readonly family: string | null;
    readonly controller: AbortController;
    readonly res: ServerResponse;
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

const admitRequest = (
    credentials: CredentialAuthority,
    req: IncomingMessage,
):
    | { readonly ok: true; readonly family: string | null }
    | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string } => {
    const face = credentials.face();
    const issuer = face?.issuer(req);
    if (face === null || issuer === undefined) {
        return { ok: true, family: null };
    }

    const header = req.headers.authorization;
    const challenge = (parameters: string): string =>
        `Bearer realm="plurnk"${parameters}, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
    const presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
    if (presented === null) {
        return {
            ok: false,
            challenge: challenge(""),
            problem: mcpHttpProblem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                stage: "authorization",
                recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.",
                retryable: false,
            }),
        };
    }
    const token = (presented[1] ?? "").trim();
    const claims = credentials.verify(token);
    if (claims === null || claims.kind !== "access") {
        return {
            ok: false,
            challenge: challenge(
                ', error="invalid_token", error_description="The access token is unknown, expired or revoked."',
            ),
            problem: mcpHttpProblem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                stage: "authorization",
                recovery: "Obtain a new access token from this daemon's token endpoint.",
                retryable: false,
            }),
        };
    }
    if (!claims.scopes.includes("mcp") && !claims.scopes.includes("acp")) {
        return {
            ok: false,
            challenge: challenge(', error="insufficient_scope", scope="mcp"'),
            problem: mcpHttpProblem(
                "bearer-scope-insufficient",
                403,
                "The access token does not carry the scope mcp.",
                {
                    stage: "authorization",
                    scope: "mcp",
                    recovery: "Obtain an access token with the scope mcp.",
                    retryable: false,
                },
            ),
        };
    }
    return { ok: true, family: claims.family };
};

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
    #seam!: ApplicationPort;
    #mcpHandler!: McpHttpHandler;
    readonly #requestContext = new AsyncLocalStorage<McpRouteTarget>();
    readonly #work = new Set<Promise<unknown>>();
    readonly #activeExchanges = new Set<ActiveHttpExchange>();
    readonly #streamWaiters = new Set<StreamConcludedWaiter>();
    readonly #recentConcluded = new Map<string, Readonly<Record<string, unknown>> | null>();
    #offEvents: (() => void) | null = null;
    #offRevoked: (() => void) | null = null;
    #activated = false;
    #stopped = false;

    static create(): McpServerModule {
        return new McpServerModule();
    }

    start(seam: ApplicationPort): void {
        if (this.#stopped) throw new Error("plurnk-mcp: stopped server module cannot be activated");
        if (this.#activated) throw new Error("plurnk-mcp: server module already activated");
        this.#seam = seam;
        this.#mcpHandler = createMcpHandler(() => this.#buildServer());
        this.#offEvents = seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null || method !== "stream/concluded" || !isRecord(params)) return;
            const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            const target = typeof params.target === "string" ? params.target : null;
            if (sessionId === null || target === null) return;
            const result = isRecord(params.result) ? params.result : null;
            const key = `${workspaceId}:${sessionId}:${target}`;
            this.#recentConcluded.set(key, result);
            if (this.#recentConcluded.size > 256) {
                const oldest = this.#recentConcluded.keys().next().value;
                if (oldest !== undefined) this.#recentConcluded.delete(oldest);
            }
            for (const waiter of [...this.#streamWaiters]) {
                if (
                    waiter.workspaceId === workspaceId &&
                    waiter.sessionId === sessionId &&
                    waiter.target === target
                ) {
                    this.#streamWaiters.delete(waiter);
                    waiter.resolve(result);
                }
            }
        });
        this.#offRevoked = seam.credentials.onRevoked((family) => {
            for (const exchange of [...this.#activeExchanges]) {
                if (exchange.family === family) {
                    exchange.controller.abort(new Error("Credential revoked"));
                    if (!exchange.res.writableEnded && !exchange.res.destroyed) {
                        exchange.res.end();
                    }
                }
            }
        });
        seam.registerHttpRoute("/mcp", (req, res) => this.#track(this.#route(req, res)));
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
        this.#offEvents = null;
        this.#offRevoked = null;
        for (const waiter of [...this.#streamWaiters]) {
            this.#streamWaiters.delete(waiter);
            waiter.resolve(null);
        }
        this.#recentConcluded.clear();
        for (const exchange of [...this.#activeExchanges]) {
            exchange.controller.abort(new Error("Service shutting down"));
            if (!exchange.res.writableEnded && !exchange.res.destroyed) {
                exchange.res.end();
            }
        }
        await this.#mcpHandler.close();
        while (this.#work.size > 0) {
            await Promise.allSettled([...this.#work]);
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
        if (this.#stopped) {
            writeHttpProblem(res, serviceStoppingProblem());
            return;
        }
        const admission = admitRequest(this.#seam.credentials, req);
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

        let target: McpRouteTarget;
        try {
            target = await this.#resolveTarget(parsedRoute.workspaceSegment, parsedRoute.sessionSegment);
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem !== null) {
                writeHttpProblem(res, problem);
                return;
            }
            throw cause;
        }

        const method = (req.method ?? "GET").toUpperCase();
        const bodyBuffer = method !== "GET" && method !== "HEAD" ? await readRequestBody(req) : null;

        const controller = new AbortController();
        const exchange: ActiveHttpExchange = { family: admission.family, controller, res };
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

            const response = await this.#requestContext.run(target, () => this.#mcpHandler.fetch(webRequest));
            await this.#writeResponse(req, res, response);
        } finally {
            req.off("aborted", onAbort);
            this.#activeExchanges.delete(exchange);
        }
    }

    async #writeResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
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
            if (!res.writableEnded && !res.destroyed) {
                res.end();
            }
        }
    }

    async #resolveTarget(workspaceSegment?: string, sessionSegment?: string): Promise<McpRouteTarget> {
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
                    if (problem !== null && problem.status === 404) {
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
                    } else {
                        const created = await this.#seam.createWorkspace({ name: "default", projectRoot: null });
                        workspaceId = created.workspaceId;
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
        const created = await this.#seam.createSession({ workspaceId, name: "user" });
        return {
            workspaceId,
            sessionId: created.sessionId,
            runtimeSessionId,
            isModelSession: true,
        };
    }

    async #buildServer(): Promise<McpServer> {
        const target = this.#requestContext.getStore();
        if (target === undefined) {
            throw new Error("plurnk-mcp: missing request target context");
        }
        const { workspaceId, sessionId, runtimeSessionId, isModelSession } = target;
        const server = new McpServer({
            name: "plurnk",
            version: "1.0.0",
            title: "Plurnk",
        });

        const catalogRead = await this.#seam.readEntry({
            workspaceId,
            sessionId,
            target: "mcp:///plurnk.json",
        });
        const catalogChannel = catalogRead.entry !== null ? Object.values(catalogRead.entry.channels)[0] : undefined;
        let tools: Array<{
            readonly name: string;
            readonly description?: string;
            readonly inputSchema?: JsonSchema;
        }> = [];
        if (catalogChannel !== undefined && catalogChannel.content.length > 0) {
            try {
                const parsed: unknown = JSON.parse(catalogChannel.content);
                if (isRecord(parsed) && Array.isArray(parsed.tools)) {
                    tools = parsed.tools.filter(
                        (item): item is { readonly name: string; readonly description?: string; readonly inputSchema?: JsonSchema } =>
                            isRecord(item) && typeof item.name === "string" && item.name.length > 0,
                    );
                }
            } catch {
                // Keep empty tool list if catalog JSON fails to parse.
            }
        }

        for (const tool of tools) {
            const schema: JsonSchema = isRecord(tool.inputSchema)
                ? tool.inputSchema
                : { type: "object", additionalProperties: true };
            server.registerTool(
                tool.name,
                {
                    ...(typeof tool.description === "string" && tool.description.length > 0
                        ? { description: tool.description }
                        : {}),
                    inputSchema: fromJsonSchema(schema as JsonSchemaType, plurnkJsonSchemaValidator),
                },
                async (args, extra) =>
                    this.#executeToolCall(target, tool.name, args, extra.mcpReq.signal),
            );
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
                const text = read.entry !== null ? (Object.values(read.entry.channels)[0]?.content ?? "") : "";
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/markdown",
                            text,
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
                const text = read.entry !== null ? (Object.values(read.entry.channels)[0]?.content ?? "") : "";
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text,
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "session-status",
            "session:///status.json",
            {
                title: "Plurnk Session Status",
                description: "Live workspace, session, loops, inbox, open streams, pending proposals, and pending interactions.",
                mimeType: "application/json",
            },
            async (uri) => {
                const [session, loops, inbox, openStreams, pendingProposals, pendingInteractions] = await Promise.all([
                    this.#seam.readSession({ workspaceId, identity: { id: sessionId } }),
                    typeof this.#seam.listSessionLoops === "function"
                        ? this.#seam.listSessionLoops({ workspaceId, sessionId })
                        : Promise.resolve([]),
                    typeof this.#seam.readInbox === "function"
                        ? this.#seam.readInbox({ workspaceId, sessionId })
                        : Promise.resolve([]),
                    typeof this.#seam.readStreams === "function"
                        ? this.#seam.readStreams({ workspaceId, sessionId })
                        : Promise.resolve([]),
                    typeof this.#seam.pendingProposals === "function"
                        ? this.#seam.pendingProposals(workspaceId)
                        : Promise.resolve([]),
                    typeof this.#seam.pendingClientInteractions === "function"
                        ? this.#seam.pendingClientInteractions(workspaceId)
                        : Promise.resolve([]),
                ]);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: JSON.stringify(
                                {
                                    workspaceId,
                                    sessionId,
                                    isModelSession,
                                    session,
                                    loops,
                                    inbox,
                                    openStreams,
                                    pendingProposals,
                                    pendingInteractions,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            },
        );

        server.registerResource(
            "log-recent",
            "log:///recent.json",
            {
                title: "Plurnk Recent Log Entries",
                description: "Recent durable log entries (with canonical log:/// coordinates) for the active session and runtime.",
                mimeType: "application/json",
            },
            async (uri) => {
                const stampEntries = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
                    rows.map((row) => ({
                        ...row,
                        coordinate: logCoordinateOf(row),
                    }));
                const [sessionRows, runtimeRows] = await Promise.all([
                    this.#seam.readLog({ workspaceId, sessionId, limit: 50 }),
                    runtimeSessionId !== sessionId
                        ? this.#seam.readLog({ workspaceId, sessionId: runtimeSessionId, limit: 50 })
                        : Promise.resolve([]),
                ]);
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: JSON.stringify(
                                {
                                    workspaceId,
                                    sessionId,
                                    entries: stampEntries(sessionRows),
                                    runtimeEntries: stampEntries(runtimeRows),
                                },
                                null,
                                2,
                            ),
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
                const loopSeq = Number(variables.loopSeq);
                const turnSeq = Number(variables.turnSeq);
                const sequence = Number(variables.sequence);
                const primaryRows = await this.#seam.readLog({
                    workspaceId,
                    sessionId,
                    loopSeq,
                    turnSeq,
                    sequence,
                    limit: 1,
                });
                const rows =
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
                const row = rows[0];
                const payload =
                    row !== undefined
                        ? { ...row, coordinate: logCoordinateOf(row) ?? uri.href }
                        : { error: "Log entry not found", coordinate: uri.href };
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
                const tool = String(variables.tool ?? "");
                const read = await this.#seam.readEntry({
                    workspaceId,
                    sessionId,
                    target: `mcp:///plurnk/${tool}.json`,
                });
                const channel = read.entry !== null ? Object.values(read.entry.channels)[0] : undefined;
                const text =
                    channel !== undefined
                        ? channel.content
                        : JSON.stringify({ error: `Tool schema not found for '${tool}'.` });
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text,
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
                const channel = read.entry !== null ? Object.values(read.entry.channels)[0] : undefined;
                const fallbackText = read.entry === null ? read.problem.detail : "";
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: channel?.mimetype ?? "text/plain",
                            text: channel?.content ?? fallbackText,
                        },
                    ],
                };
            },
        );

        return server;
    }

    async #executeToolCall(
        target: McpRouteTarget,
        toolName: string,
        args: unknown,
        signal?: AbortSignal,
    ): Promise<{
        readonly isError?: boolean;
        readonly _meta?: Record<string, unknown>;
        readonly content: Array<{ readonly type: "text"; readonly text: string }>;
    }> {
        const { workspaceId, sessionId, isModelSession } = target;
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
        if (parseErrors.length > 0 || parsed.unparsedTail !== undefined || statements.length === 0) {
            const message = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_OPERATION;
            return {
                isError: true,
                content: [{ type: "text", text: message }],
            };
        }

        const statement = statements[0];
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
                actor: MCP_OWNER_ACTOR,
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
