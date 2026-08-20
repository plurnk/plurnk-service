import {
    OAuthClientFlowError,
    OAuthError,
    UnauthorizedError,
    Client,
    ClientCredentialsProvider,
    StreamableHTTPClientTransport,
    type AuthProvider,
    type CallToolRequest,
    type CallToolResult,
    type ClientCapabilities,
    type CompleteRequest,
    type CompleteResult,
    type DiscoverResult,
    type GetPromptRequest,
    type GetPromptResult,
    type InputRequiredResult,
    type OAuthClientProvider,
    type Progress,
    type ReadResourceRequest,
    type ReadResourceResult,
    type Tool,
} from "@modelcontextprotocol/client";
import {
    StdioClientTransport,
    getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
    Validator,
    type McpServerDefinition,
} from "@plurnk/plurnk-contracts";
import packageJson from "../package.json" with { type: "json" };
import {
    connectTimeoutMs,
    expandReferences,
    requestTimeoutMs,
} from "./config.ts";
import {
    INPUT_REQUIRED_MAX_ROUNDS,
    runInputRequiredRequest,
    type ClientInteractionHandler,
} from "./inputRequired.ts";
import InteractiveOAuthProvider from "./oauth.ts";
import ExtensionChannel from "./extensionChannel.ts";
import { mcpRoutingHeaderValue } from "./protocolHeaders.ts";
import {
    MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
    MCP_PROTOCOL_VERSION,
} from "./protocol.ts";
import { staticClientCapabilities } from "./capabilityMatrix.ts";
import Subscriptions from "./subscriptions.ts";
import {
    callToolWithTasks,
    serverSupportsTasks,
} from "./tasks.ts";

// {§mcp-authority} — capability source: the modern discover result when the
// server offered it, else the legacy initialize result the SDK already folded.
const serverCapabilities = (client: Client): DiscoverResult["capabilities"] | undefined =>
    client.getDiscoverResult()?.capabilities
    ?? client.getServerCapabilities() as DiscoverResult["capabilities"] | undefined;

export interface ServerCatalog {
    readonly protocolVersion: string;
    readonly server: ReturnType<Client["getServerVersion"]>;
    // {§mcp-summary-derivation} — the initialize result's orientation essay;
    // its first sentence is the last server-summary tier.
    readonly instructions?: string;
    readonly capabilities: DiscoverResult["capabilities"];
    readonly tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    readonly resources: Awaited<ReturnType<Client["listResources"]>>["resources"];
    readonly resourceTemplates: Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
    readonly prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
}

interface ResolvedStdioDefinition {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
}

interface ResolvedHttpDefinition {
    readonly transport: "http";
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly authProvider?: AuthProvider | OAuthClientProvider;
    readonly oauthProvider?: InteractiveOAuthProvider;
    readonly cachePartition: string;
    // {§oauth-client-credentials} — the connection advertises the extension
    // capability only when its definition holds a client-credentials grant.
    readonly clientCredentials?: boolean;
}

type ResolvedDefinition = ResolvedStdioDefinition | ResolvedHttpDefinition;

export interface ServerConnectionOptions {
    readonly onCatalogChanged?: (error: Error | null) => void;
    readonly onInfrastructureError?: (error: Error) => void;
}

export type { ClientInteractionHandler } from "./inputRequired.ts";

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const errorsOf = (error: unknown): unknown[] =>
    error instanceof AggregateError ? [...error.errors] : [error];

// {§oauth-client-credentials} — a rejected client-credentials grant is an
// authorization fact, never a generic unavailability.
export const isClientCredentialsRejection = (error: unknown): boolean => errorsOf(error).some((candidate) => {
    let current: unknown = candidate;
    while (current !== undefined && current !== null) {
        if (
            OAuthError.isInstance(current) ||
            UnauthorizedError.isInstance(current) ||
            OAuthClientFlowError.isInstance(current)
        ) {
            return true;
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return false;
});

const expandedRecord = (
    source: Readonly<Record<string, string>> | undefined,
    environ: NodeJS.ProcessEnv,
    field: string,
): Record<string, string> | undefined => source === undefined
    ? undefined
    : Object.fromEntries(Object.entries(source).map(([key, value]) => [
        key,
        expandReferences(value, environ, `${field}.${key}`),
    ]));

const requireString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value;
};

const resolveDefinition = (
    source: McpServerDefinition,
    environ: NodeJS.ProcessEnv,
): ResolvedDefinition => {
    const definition = Validator.assertMcpServerDefinition(source);
    if (definition.transport === "stdio") {
        return {
            transport: "stdio",
            command: expandReferences(
                requireString(definition.command, `${definition.name}.command`),
                environ,
                `${definition.name}.command`,
            ),
            args: (definition.args ?? []).map((argument, index) =>
                expandReferences(argument, environ, `${definition.name}.args[${index}]`)),
            ...(definition.cwd === undefined
                ? {}
                : { cwd: expandReferences(definition.cwd, environ, `${definition.name}.cwd`) }),
            ...(definition.env === undefined
                ? {}
                : { env: expandedRecord(definition.env, environ, `${definition.name}.env`) }),
        };
    }

    const url = requireString(definition.url, `${definition.name}.url`);
    const headers = expandedRecord(definition.headers, environ, `${definition.name}.headers`);
    const authorizationHeader = Object.keys(headers ?? {}).find(
        (name) => name.toLowerCase() === "authorization",
    );
    if (definition.authorization !== undefined && authorizationHeader !== undefined) {
        throw new Error(
            `${definition.name}.authorization conflicts with the Authorization header.`,
        );
    }
    if (definition.authorization === undefined) {
        return {
            transport: "http",
            url,
            ...(headers === undefined ? {} : { headers }),
            cachePartition: "anonymous",
        };
    }
    if (definition.authorization.type === "bearer") {
        const token = expandReferences(
            definition.authorization.token,
            environ,
            `${definition.name}.authorization.token`,
        );
        if (token.length === 0) throw new Error(`${definition.name}.authorization.token resolved empty.`);
        return {
            transport: "http",
            url,
            ...(headers === undefined ? {} : { headers }),
            authProvider: { token: async () => token },
            cachePartition: `bearer:${definition.authorization.token}`,
        };
    }
    if (definition.authorization.type === "client-credentials") {
        const secret = expandReferences(
            definition.authorization.clientSecret,
            environ,
            `${definition.name}.authorization.clientSecret`,
        );
        if (secret.length === 0) {
            throw new Error(`${definition.name}.authorization.clientSecret resolved empty.`);
        }
        return {
            transport: "http",
            url,
            ...(headers === undefined ? {} : { headers }),
            clientCredentials: true,
            authProvider: new ClientCredentialsProvider({
                clientId: definition.authorization.clientId,
                clientSecret: secret,
                // {§oauth-client-credentials} — a declared issuer binds the static
                // credential to that authorization server (SEP-2352); absent, the
                // SDK's legacy no-binding behaviour applies.
                ...(definition.authorization.issuer === undefined
                    ? {}
                    : { expectedIssuer: definition.authorization.issuer }),
                ...(definition.authorization.scope === undefined
                    ? {}
                    : { scope: definition.authorization.scope }),
            }),
            cachePartition: `client:${definition.authorization.clientId}`,
        };
    }
    const oauthAuthorization = definition.authorization;
    // {§oauth-lifetime} — registration data, tokens, PKCE verifier, and
    // callback state remain process-memory in this provider; the durable
    // definition stays unexpanded.
    const oauthProvider = new InteractiveOAuthProvider({
        redirectUrl: oauthAuthorization.redirectUrl,
        ...(oauthAuthorization.scope === undefined ? {} : { scope: oauthAuthorization.scope }),
        ...("clientMetadataUrl" in oauthAuthorization
            ? { clientMetadataUrl: oauthAuthorization.clientMetadataUrl }
            : {}),
        ...("clientId" in oauthAuthorization
            ? {
                clientId: oauthAuthorization.clientId,
                clientSecret: expandReferences(
                    oauthAuthorization.clientSecret,
                    environ,
                    `${definition.name}.authorization.clientSecret`,
                ),
            }
            : {}),
    });
    const cachePartition = "clientMetadataUrl" in oauthAuthorization
        ? `oauth:cimd:${oauthAuthorization.clientMetadataUrl}`
        : "clientId" in oauthAuthorization
            ? `oauth:client:${oauthAuthorization.clientId}`
            : "oauth:dynamic";
    return {
        transport: "http",
        url,
        ...(headers === undefined ? {} : { headers }),
        authProvider: oauthProvider,
        oauthProvider,
        cachePartition,
    };
};

const openTransport = (
    definition: ResolvedDefinition,
): StdioClientTransport | StreamableHTTPClientTransport => {
    if (definition.transport === "http") {
        return new StreamableHTTPClientTransport(
            new URL(definition.url),
            {
                ...(definition.headers === undefined
                    ? {}
                    : { requestInit: { headers: definition.headers } }),
                ...(definition.authProvider === undefined
                    ? {}
                    : { authProvider: definition.authProvider }),
                fetch: async (url, init) => {
                    const body = typeof init?.body === "string"
                        ? (() => {
                            try {
                                return JSON.parse(init.body) as unknown;
                            } catch {
                                return undefined;
                            }
                        })()
                        : undefined;
                    const request = body !== null && typeof body === "object" && !Array.isArray(body)
                        ? body as { method?: unknown; params?: { taskId?: unknown } }
                        : undefined;
                    if (
                        ["tasks/get", "tasks/update", "tasks/cancel"].includes(String(request?.method))
                        && typeof request?.params?.taskId === "string"
                    ) {
                        const headers = new Headers(init?.headers);
                        headers.set("Mcp-Name", mcpRoutingHeaderValue(request.params.taskId));
                        return fetch(url, { ...init, headers });
                    }
                    return fetch(url, init);
                },
            },
        );
    }
    // {§mcp-stdio-process-ownership} — stdio servers spawn through the
    // parent-death watchdog wrapper: the real server runs detached (own
    // process group) and the wrapper group-kills it (grandchildren included)
    // when the daemon dies by ANY path, including SIGKILL where close()
    // never runs. Protocol bytes are forwarded verbatim.
    return new StdioClientTransport({
        command: process.execPath,
        args: [
            new URL("./mcp-watchdog.mjs", import.meta.url).pathname,
            String(process.pid),
            "--",
            definition.command,
            ...definition.args,
        ],
        cwd: definition.cwd,
        env: {
            ...getDefaultEnvironment(),
            ...definition.env,
        },
    });
};

export class AuthorizationRequiredError extends Error {
    readonly authorizationUrl: string;

    constructor(authorizationUrl: string, cause?: unknown) {
        super("MCP server requires interactive OAuth authorization.", { cause });
        this.name = "AuthorizationRequiredError";
        this.authorizationUrl = authorizationUrl;
    }
}

interface OpenClient {
    readonly client: Client;
    readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
    readonly extensions: ExtensionChannel | null;
    readonly protocolVersion: string;
    readonly subscriptions: Subscriptions;
}

const openClient = async (
    definition: ResolvedDefinition,
    environ: NodeJS.ProcessEnv,
    options: ServerConnectionOptions,
    transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<OpenClient> => {
    const changed = (error?: Error): void => options.onCatalogChanged?.(error ?? null);
    const clientInfo = {
        name: packageJson.name,
        version: packageJson.version,
    };
    // {§mcp-capability-matrix} — static advertisement derives from the
    // capability matrix by construction; the conditional client-credentials
    // extension ({§oauth-client-credentials}) is added only on connections
    // that actually hold a client-credentials definition.
    const matrixCapabilities = staticClientCapabilities();
    const clientCapabilities = {
        ...matrixCapabilities,
        extensions: {
            ...matrixCapabilities.extensions,
            ...(definition.transport === "http" && definition.clientCredentials === true
                ? { [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {} }
                : {}),
        },
    } satisfies ClientCapabilities;
    const client = new Client(
        clientInfo,
        {
            capabilities: clientCapabilities,
            versionNegotiation: {
                mode: "auto",
            },
            inputRequired: {
                autoFulfill: false,
                maxRounds: INPUT_REQUIRED_MAX_ROUNDS,
            },
            listChanged: {
                tools: {
                    autoRefresh: false,
                    onChanged: (error) => changed(error ?? undefined),
                },
                resources: {
                    autoRefresh: false,
                    onChanged: (error) => changed(error ?? undefined),
                },
                prompts: {
                    autoRefresh: false,
                    onChanged: (error) => changed(error ?? undefined),
                },
            },
            ...(definition.transport === "http"
                ? { cachePartition: definition.cachePartition }
                : {}),
        },
    );
    client.onerror = (error): void => options.onInfrastructureError?.(error);
    try {
        await client.connect(transport, {
            timeout: connectTimeoutMs(environ),
        });
    } catch (cause) {
        const authorizationUrl = definition.transport === "http"
            ? definition.oauthProvider?.takeAuthorizationUrl()
            : undefined;
        let closeFailure: unknown;
        try {
            await client.close();
        } catch (error) {
            closeFailure = error;
        }
        if (authorizationUrl !== undefined) {
            throw new AuthorizationRequiredError(
                authorizationUrl.href,
                closeFailure === undefined ? cause : new AggregateError([cause, closeFailure]),
            );
        }
        if (closeFailure !== undefined) {
            throw new AggregateError(
                [cause, closeFailure],
                `MCP ${MCP_PROTOCOL_VERSION} connection and cleanup failed.`,
            );
        }
        throw new Error(`MCP ${MCP_PROTOCOL_VERSION} connection failed.`, { cause });
    }
    // {§mcp-authority} — negotiate-and-degrade. The pinned revision is the host's
    // own wire authority: a modern pinned server with a discover result gets the
    // complete extension wire. Anything the SDK negotiated below it is an
    // ordinary MCP server — standard tool/resource/prompt surface from its
    // initialize result, no discover identity, no tasks, no extension channel.
    const era = client.getProtocolEra();
    const negotiated = client.getNegotiatedProtocolVersion() ?? "";
    const discover = client.getDiscoverResult();
    const modern = era === "modern" && negotiated === MCP_PROTOCOL_VERSION && discover !== undefined;
    const extensions = modern
        ? new ExtensionChannel(transport, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            clientInfo,
            clientCapabilities,
            cancelRequest: async (requestId) => client.notification({
                method: "notifications/cancelled",
                params: { requestId },
            }),
            onError: options.onInfrastructureError,
        })
        : null;
    return {
        client,
        transport,
        extensions,
        protocolVersion: negotiated,
        subscriptions: new Subscriptions(client, {
            timeout: requestTimeoutMs(environ),
            tasks: serverSupportsTasks(discover?.capabilities ?? client.getServerCapabilities()),
            onError: options.onInfrastructureError,
        }),
    };
};

export default class ServerConnection {
    readonly #definition: McpServerDefinition;
    readonly #resolved: ResolvedDefinition;
    readonly #environ: NodeJS.ProcessEnv;
    readonly #options: ServerConnectionOptions;
    #client: Promise<OpenClient> | undefined;
    #pendingAuthorization: {
        readonly transport: StreamableHTTPClientTransport;
        readonly provider: InteractiveOAuthProvider;
        readonly authorizationUrl: string;
        readonly standaloneTransport: boolean;
    } | undefined;
    #activeRequests = 0;
    #closed = false;

    constructor(
        definition: McpServerDefinition,
        environ: NodeJS.ProcessEnv = process.env,
        options: ServerConnectionOptions = {},
    ) {
        this.#definition = structuredClone(Validator.assertMcpServerDefinition(definition));
        this.#resolved = resolveDefinition(this.#definition, environ);
        this.#environ = environ;
        this.#options = options;
    }

    get definition(): McpServerDefinition {
        return structuredClone(this.#definition);
    }

    get activeRequests(): number {
        return this.#activeRequests;
    }

    get authorizationUrl(): string | null {
        return this.#pendingAuthorization?.authorizationUrl ?? null;
    }

    assertReplaceable(): void {
        if (this.#activeRequests !== 0) {
            throw new Error(
                `MCP server '${this.#definition.name}' has ${this.#activeRequests} active user request(s).`,
            );
        }
    }

    async #open(): Promise<OpenClient> {
        if (this.#closed) throw new Error(`MCP server '${this.#definition.name}' connection is closed.`);
        if (this.#pendingAuthorization !== undefined) {
            throw new AuthorizationRequiredError(this.#pendingAuthorization.authorizationUrl);
        }
        if (this.#client !== undefined) return this.#client;
        const transport = openTransport(this.#resolved);
        const pending = openClient(
            this.#resolved,
            this.#environ,
            this.#options,
            transport,
        ).catch((cause: unknown) => {
            if (
                cause instanceof AuthorizationRequiredError
                && this.#resolved.transport === "http"
                && this.#resolved.oauthProvider !== undefined
                && transport instanceof StreamableHTTPClientTransport
            ) {
                this.#pendingAuthorization = {
                    transport,
                    provider: this.#resolved.oauthProvider,
                    authorizationUrl: cause.authorizationUrl,
                    standaloneTransport: true,
                };
            }
            if (this.#client === pending) this.#client = undefined;
            throw cause;
        });
        this.#client = pending;
        return pending;
    }

    async connect(): Promise<Client> {
        return (await this.#open()).client;
    }

    async finishAuthorization(callbackUrl: string): Promise<void> {
        const pending = this.#pendingAuthorization;
        if (pending === undefined) {
            throw new Error(`MCP server '${this.#definition.name}' has no pending OAuth authorization.`);
        }
        const callback = new URL(callbackUrl);
        const expected = new URL(pending.provider.redirectUrl);
        if (
            callback.protocol !== expected.protocol
            || callback.host !== expected.host
            || callback.pathname !== expected.pathname
        ) {
            throw new Error("OAuth callback URL does not match the configured redirect URL.");
        }
        pending.provider.assertCallbackState(callback);
        await pending.transport.finishAuth(callback.searchParams);
        this.#pendingAuthorization = undefined;
        await this.connect();
    }

    async #request<T>(
        run: (
            client: Client,
            subscriptions: Subscriptions,
            extensions: ExtensionChannel | null,
        ) => Promise<T>,
    ): Promise<T> {
        this.#activeRequests += 1;
        try {
            const opened = await this.#open();
            try {
                return await run(opened.client, opened.subscriptions, opened.extensions);
            } catch (cause) {
                const authorization = this.#takeAuthorization(opened, cause);
                if (authorization !== null) throw authorization;
                throw cause;
            }
        } finally {
            this.#activeRequests -= 1;
        }
    }

    #takeAuthorization(opened: OpenClient, cause: unknown): AuthorizationRequiredError | null {
        if (
            this.#resolved.transport !== "http"
            || this.#resolved.oauthProvider === undefined
            || !(opened.transport instanceof StreamableHTTPClientTransport)
        ) {
            return null;
        }
        const authorizationUrl = this.#resolved.oauthProvider.takeAuthorizationUrl();
        if (authorizationUrl === undefined) return null;
        this.#pendingAuthorization = {
            transport: opened.transport,
            provider: this.#resolved.oauthProvider,
            authorizationUrl: authorizationUrl.href,
            standaloneTransport: false,
        };
        return new AuthorizationRequiredError(authorizationUrl.href, cause);
    }

    async tools(signal?: AbortSignal): Promise<Tool[]> {
        return this.#request(async (client) => {
            if (serverCapabilities(client)?.tools === undefined) return [];
            const { tools } = await client.listTools(undefined, this.#requestOptions(signal));
            return tools;
        });
    }

    async catalog(signal?: AbortSignal): Promise<ServerCatalog> {
        return this.#request(async (client) => {
            // {§mcp-authority} — the discover result is the modern identity and
            // capability source; a legacy server's initialize result supplies the
            // same facts at its negotiated revision.
            const capabilities = serverCapabilities(client) ?? {};
            const [tools, resources, resourceTemplates, prompts] = await Promise.all([
                capabilities.tools === undefined
                    ? Promise.resolve([])
                    : client.listTools(undefined, this.#requestOptions(signal)).then((result) => result.tools),
                capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResources(undefined, this.#requestOptions(signal)).then((result) => result.resources),
                capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResourceTemplates(undefined, this.#requestOptions(signal))
                        .then((result) => result.resourceTemplates),
                capabilities.prompts === undefined
                    ? Promise.resolve([])
                    : client.listPrompts(undefined, this.#requestOptions(signal)).then((result) => result.prompts),
            ]);
            return {
                protocolVersion: client.getNegotiatedProtocolVersion() ?? "",
                server: client.getServerVersion(),
                instructions: client.getInstructions(),
                capabilities,
                tools,
                resources,
                resourceTemplates,
                prompts,
            };
        });
    }

    async resources(signal?: AbortSignal): Promise<{
        resources: ServerCatalog["resources"];
        resourceTemplates: ServerCatalog["resourceTemplates"];
    }> {
        return this.#request(async (client) => {
            if (serverCapabilities(client)?.resources === undefined) {
                return { resources: [], resourceTemplates: [] };
            }
            const [resources, resourceTemplates] = await Promise.all([
                client.listResources(undefined, this.#requestOptions(signal))
                    .then((result) => result.resources),
                client.listResourceTemplates(undefined, this.#requestOptions(signal))
                    .then((result) => result.resourceTemplates),
            ]);
            return { resources, resourceTemplates };
        });
    }

    async prompts(signal?: AbortSignal): Promise<ServerCatalog["prompts"]> {
        return this.#request(async (client) => {
            if (serverCapabilities(client)?.prompts === undefined) return [];
            return (await client.listPrompts(undefined, this.#requestOptions(signal))).prompts;
        });
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
        onProgress?: (progress: Progress) => void,
        interact?: ClientInteractionHandler,
        toolDefinition?: Tool,
    ): Promise<CallToolResult> {
        return this.#request(async (client, subscriptions, extensions) => {
            const timeout = requestTimeoutMs(this.#environ);
            if (serverSupportsTasks(serverCapabilities(client))) {
                const tool = toolDefinition ?? (await client.listTools(
                    undefined,
                    this.#requestOptions(signal),
                )).tools.find((candidate) => candidate.name === name);
                if (tool === undefined) {
                    throw new Error(`MCP server '${this.#definition.name}' did not list tool '${name}'.`);
                }
                return callToolWithTasks({
                    server: this.#definition.name,
                    name,
                    args,
                    tool,
                    signal,
                    onProgress,
                    interact,
                    timeout,
                    channel: extensions ?? (() => { throw new Error("MCP tasks channel absent on a non-modern connection."); })(),
                    subscriptions,
                });
            }
            return runInputRequiredRequest<CallToolResult>({
                server: this.#definition.name,
                operation: "tools/call",
                originalParams: { name, arguments: args },
                signal,
                interact,
                onProgress,
                timeout,
                requestLeg: (params, options) => client.callTool(
                    params as CallToolRequest["params"],
                    {
                        ...options,
                        ...(toolDefinition === undefined ? {} : { toolDefinition }),
                    },
                ) as Promise<CallToolResult | InputRequiredResult>,
            });
        });
    }

    async readResource(
        uri: string,
        signal?: AbortSignal,
        interact?: ClientInteractionHandler,
    ): Promise<ReadResourceResult> {
        return this.#request(async (client, subscriptions) => {
            await subscriptions.selectResource(uri);
            return runInputRequiredRequest<ReadResourceResult>({
                server: this.#definition.name,
                operation: "resources/read",
                originalParams: { uri },
                signal,
                interact,
                timeout: requestTimeoutMs(this.#environ),
                requestLeg: (params, options, retry) => client.readResource(
                    params as ReadResourceRequest["params"],
                    retry ? { ...options, cacheMode: "refresh" } : options,
                ) as Promise<ReadResourceResult | InputRequiredResult>,
            });
        });
    }

    async getPrompt(
        name: string,
        args: Record<string, string> | undefined,
        signal?: AbortSignal,
        interact?: ClientInteractionHandler,
    ): Promise<GetPromptResult> {
        return this.#request(async (client) => runInputRequiredRequest<GetPromptResult>({
            server: this.#definition.name,
            operation: "prompts/get",
            originalParams: { name, ...(args === undefined ? {} : { arguments: args }) },
            signal,
            interact,
            timeout: requestTimeoutMs(this.#environ),
            requestLeg: (params, options) => client.getPrompt(
                params as GetPromptRequest["params"],
                options,
            ) as Promise<GetPromptResult | InputRequiredResult>,
        }));
    }

    async complete(
        params: CompleteRequest["params"],
        signal?: AbortSignal,
    ): Promise<CompleteResult> {
        return this.#request(async (client) => client.complete(
            params,
            this.#requestOptions(signal),
        ));
    }

    #requestOptions(
        signal?: AbortSignal,
        onProgress?: (progress: Progress) => void,
    ): {
        signal?: AbortSignal;
        timeout: number;
        maxTotalTimeout: number;
        onprogress?: (progress: Progress) => void;
    } {
        const timeout = requestTimeoutMs(this.#environ);
        return {
            signal,
            timeout,
            maxTotalTimeout: timeout,
            ...(onProgress === undefined ? {} : { onprogress: onProgress }),
        };
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const client = this.#client;
        this.#client = undefined;
        const pending = this.#pendingAuthorization;
        this.#pendingAuthorization = undefined;
        const closures: Promise<void>[] = [];
        if (client !== undefined) {
            closures.push(client.then(async ({ client: connected, extensions, subscriptions }) => {
                const failures: unknown[] = [];
                extensions?.close();
                // A full connection close terminates its listen request. Retiring first
                // avoids a redundant cancellation racing the SDK's removed listen ID.
                const settled = await Promise.allSettled([
                    subscriptions.retire(),
                    connected.close(),
                ]);
                failures.push(...settled.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : []));
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        `MCP server '${this.#definition.name}' connection shutdown failed.`,
                    );
                }
            }));
        }
        if (pending?.standaloneTransport === true) closures.push(pending.transport.close());
        const settled = await Promise.allSettled(closures);
        const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `MCP server '${this.#definition.name}' shutdown failed.`);
        }
    }

    describeError(error: unknown): string {
        return message(error);
    }
}
