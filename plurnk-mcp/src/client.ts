import {
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
    MCP_PROTOCOL_VERSION,
    MCP_TASKS_EXTENSION_ID,
} from "./protocol.ts";
import Subscriptions from "./subscriptions.ts";
import {
    callToolWithTasks,
    serverSupportsTasks,
} from "./tasks.ts";

export interface ServerCatalog {
    readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
    readonly server: ReturnType<Client["getServerVersion"]>;
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
}

type ResolvedDefinition = ResolvedStdioDefinition | ResolvedHttpDefinition;

export interface ServerConnectionOptions {
    readonly onCatalogChanged?: (error: Error | null) => void;
    readonly onInfrastructureError?: (error: Error) => void;
}

export type { ClientInteractionHandler } from "./inputRequired.ts";

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

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
            authProvider: new ClientCredentialsProvider({
                clientId: definition.authorization.clientId,
                clientSecret: secret,
                ...(definition.authorization.scope === undefined
                    ? {}
                    : { scope: definition.authorization.scope }),
            }),
            cachePartition: `client:${definition.authorization.clientId}`,
        };
    }
    const oauthProvider = new InteractiveOAuthProvider(definition.authorization);
    return {
        transport: "http",
        url,
        ...(headers === undefined ? {} : { headers }),
        authProvider: oauthProvider,
        oauthProvider,
        cachePartition: `oauth:${definition.authorization.clientMetadataUrl}`,
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
    return new StdioClientTransport({
        command: definition.command,
        args: definition.args,
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
    readonly extensions: ExtensionChannel;
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
    const clientCapabilities = {
        elicitation: {
            form: {},
            url: {},
        },
        extensions: {
            [MCP_TASKS_EXTENSION_ID]: {},
        },
    } satisfies ClientCapabilities;
    const client = new Client(
        clientInfo,
        {
            capabilities: clientCapabilities,
            versionNegotiation: {
                mode: { pin: MCP_PROTOCOL_VERSION },
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
            ? definition.oauthProvider?.authorizationUrl()
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
    const discover = client.getDiscoverResult();
    if (
        client.getProtocolEra() !== "modern"
        || client.getNegotiatedProtocolVersion() !== MCP_PROTOCOL_VERSION
        || discover === undefined
    ) {
        await client.close();
        throw new Error(`MCP server did not negotiate required revision ${MCP_PROTOCOL_VERSION}.`);
    }
    const extensions = new ExtensionChannel(transport, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo,
        clientCapabilities,
        cancelRequest: async (requestId) => client.notification({
            method: "notifications/cancelled",
            params: { requestId },
        }),
        onError: options.onInfrastructureError,
    });
    return {
        client,
        transport,
        extensions,
        subscriptions: new Subscriptions(client, {
            timeout: requestTimeoutMs(environ),
            tasks: serverSupportsTasks(discover.capabilities),
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
            extensions: ExtensionChannel,
        ) => Promise<T>,
    ): Promise<T> {
        this.#activeRequests += 1;
        try {
            const { client, subscriptions, extensions } = await this.#open();
            return await run(client, subscriptions, extensions);
        } finally {
            this.#activeRequests -= 1;
        }
    }

    async tools(signal?: AbortSignal): Promise<Tool[]> {
        return this.#request(async (client) => {
            if (client.getDiscoverResult()?.capabilities.tools === undefined) return [];
            const { tools } = await client.listTools(undefined, this.#requestOptions(signal));
            return tools;
        });
    }

    async catalog(signal?: AbortSignal): Promise<ServerCatalog> {
        return this.#request(async (client) => {
            const discover = client.getDiscoverResult();
            if (discover === undefined) throw new Error("Modern MCP connection omitted its discovery result.");
            const [tools, resources, resourceTemplates, prompts] = await Promise.all([
                discover.capabilities.tools === undefined
                    ? Promise.resolve([])
                    : client.listTools(undefined, this.#requestOptions(signal)).then((result) => result.tools),
                discover.capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResources(undefined, this.#requestOptions(signal)).then((result) => result.resources),
                discover.capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResourceTemplates(undefined, this.#requestOptions(signal))
                        .then((result) => result.resourceTemplates),
                discover.capabilities.prompts === undefined
                    ? Promise.resolve([])
                    : client.listPrompts(undefined, this.#requestOptions(signal)).then((result) => result.prompts),
            ]);
            return {
                protocolVersion: MCP_PROTOCOL_VERSION,
                server: client.getServerVersion(),
                capabilities: discover.capabilities,
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
            if (client.getDiscoverResult()?.capabilities.resources === undefined) {
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
            if (client.getDiscoverResult()?.capabilities.prompts === undefined) return [];
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
            if (serverSupportsTasks(client.getDiscoverResult()?.capabilities)) {
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
                    channel: extensions,
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
                try {
                    await subscriptions.close();
                } catch (error) {
                    failures.push(error);
                }
                extensions.close();
                try {
                    await connected.close();
                } catch (error) {
                    failures.push(error);
                }
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        `MCP server '${this.#definition.name}' connection shutdown failed.`,
                    );
                }
            }));
        }
        if (pending !== undefined) closures.push(pending.transport.close());
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
