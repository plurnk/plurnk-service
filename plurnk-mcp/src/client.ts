import { isAbsolute } from "node:path";
import {
    OAuthClientFlowError,
    OAuthError,
    UnauthorizedError,
    SdkHttpError,
    ProtocolError,
    METHOD_NOT_FOUND,
    Client,
    ClientCredentialsProvider,
    StreamableHTTPClientTransport,
    auth,
    createFetchWithInit,
    type AuthProvider,
    type CallToolResult,
    type ClientCapabilities,
    type CompleteRequest,
    type CompleteResult,
    type DiscoverResult,
    type FetchLike,
    type GetPromptResult,
    type OAuthClientProvider,
    type Progress,
    type ReadResourceResult,
    type Request,
    type RequestMethod,
    type RequestOptions,
    type ResultTypeMap,
    type StandardSchemaV1,
    type Tool,
} from "@modelcontextprotocol/client";
import {
    StdioClientTransport,
    getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { CallToolRequestParamsSchema, GetPromptRequestParamsSchema, ReadResourceRequestParamsSchema } from "@modelcontextprotocol/core";
import {
    isRecord,
    Validator,
    type McpServerDefinition,
} from "@plurnk/plurnk-contracts";
import packageJson from "../package.json" with { type: "json" };
import { ErrorDetail } from "@plurnk/plurnk-execs";
import PreparationDiagnostics, { type PreparationDiagnostic } from "./PreparationDiagnostics.ts";
import {
    connectTimeoutMs,
    expandReferences,
    requestTimeoutMs,
    retryPacing,
} from "./config.ts";
import { readDefinition } from "./definition.ts";
import {
    INPUT_REQUIRED_MAX_ROUNDS,
    runInputRequiredRequest,
    type ClientInteractionHandler,
} from "./inputRequired.ts";
import InteractiveOAuthProvider, { OAuthGrant } from "./oauth.ts";
import ExtensionChannel from "./extensionChannel.ts";
import { assertHeaderDeclarations, mcpRoutingHeaderValue } from "./protocolHeaders.ts";
import {
    MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
    MCP_PROTOCOL_VERSION,
} from "./protocol.ts";
import { staticClientCapabilities } from "./capabilityMatrix.ts";
import Subscriptions from "./subscriptions.ts";
import PluginConfiguration, { type PluginContext } from "./PluginConfiguration.ts";
import {
    callToolWithTasks,
    serverSupportsTasks,
} from "./tasks.ts";

// A request leg's params are proved by the protocol's schema and forwarded whole: the continuation state an
// input-required round appends rides beside the fields the schema names ({§mcp-host-composition}).
const CALL_TOOL_PARAMS = CallToolRequestParamsSchema.loose();
const READ_RESOURCE_PARAMS = ReadResourceRequestParamsSchema.loose();
const GET_PROMPT_PARAMS = GetPromptRequestParamsSchema.loose();

// {§mcp-authority} — capability source: the modern discover result when the
// server offered it, else the legacy initialize result the SDK already folded.
const serverCapabilities = (client: Client): DiscoverResult["capabilities"] | undefined =>
    client.getDiscoverResult()?.capabilities
    ?? client.getServerCapabilities();

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
    readonly unsupportedLists: readonly string[];
}

interface ResolvedStdioDefinition {
    readonly type: "stdio";
    readonly command: string;
    readonly args: string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
}

interface ResolvedHttpDefinition {
    readonly type: "streamable-http";
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
    // {§oauth-continuation} Callback supplied by the client, never persisted configuration; it begins a new grant.
    readonly oauthRedirectUrl?: string;
    // {§oauth-grant} The alias's accepted sign-in, which a connection without a client's callback carries.
    readonly oauthGrant?: OAuthGrant;
    readonly plugin?: PluginContext;
    // {§mcp-launch-environment} Exact admitted environment, separate from reference resolution.
    readonly environment?: NodeJS.ProcessEnv;
    // {§mcp-launch-directory} Host-owned cwd when the definition does not select one.
    readonly cwd?: string;
    readonly onCatalogChanged?: (error: Error | null) => void;
    readonly onInfrastructureError?: (error: Error) => void;
    // {§mcp-request-unauthorized} A request was refused for want of a sign-in the definition does not configure.
    readonly onAuthorizationRequired?: () => void;
}

export type { ClientInteractionHandler } from "./inputRequired.ts";

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

// The first error of a type anywhere in a cause chain or aggregate.
export const causeOf = <T>(error: unknown, type: abstract new (...args: never[]) => T, seen = new Set<unknown>()): T | undefined => {
    if (error === null || typeof error !== "object" || seen.has(error)) return undefined;
    seen.add(error);
    if (error instanceof type) return error;
    for (const inner of error instanceof AggregateError ? error.errors : []) {
        const found = causeOf(inner, type, seen);
        if (found !== undefined) return found;
    }
    return causeOf((error as { cause?: unknown }).cause, type, seen);
};

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

// {§mcp-transports} Protocol headers are transport-owned; application authentication is not.
const clientOwnedHeader = (name: string): boolean =>
    ["accept", "content-type", "last-event-id"].includes(name.toLowerCase()) || name.toLowerCase().startsWith("mcp-");

const resolveDefinition = (
    source: McpServerDefinition,
    environ: NodeJS.ProcessEnv,
    { cwd: defaultCwd, plugin, oauthRedirectUrl, oauthGrant }: ServerConnectionOptions,
): ResolvedDefinition => {
    const definition = readDefinition(source);
    const field = `MCP server '${definition.name}'`;
    if (definition.type === "stdio") {
        if (plugin !== undefined) return PluginConfiguration.resolve(definition, plugin);
        const expand = (value: string): string => expandReferences(value, environ, field);
        const cwd = definition.cwd === undefined ? defaultCwd : expand(definition.cwd);
        if (cwd === undefined || !isAbsolute(cwd)) throw new TypeError(`${field} requires an absolute working directory from its definition or host.`);
        return {
            type: "stdio",
            command: definition.command,
            args: (definition.args ?? []).map(expand),
            cwd,
            env: Object.fromEntries(Object.entries(definition.env ?? {}).map(([name, value]) => [name, expand(value)])),
        };
    }

    const configured = Object.entries(definition.headers ?? {}).filter(([name]) => !clientOwnedHeader(name));
    const headers = configured.length === 0 ? undefined : Object.fromEntries(configured.map(([name, value]) => [name, plugin === undefined ? expandReferences(value, environ, `${field}.headers.${name}`) : value]));
    const url = definition.url;
    const authorization = definition.authorization;
    const configuredRedirect = authorization?.type === "oauth" ? authorization.redirectUrl : undefined;
    const redirectUrl = configuredRedirect ?? oauthRedirectUrl;
    // {§oauth-grant} A client's callback begins a new grant; any other connection carries the alias's accepted one, or
    // begins one at the redirect the definition configures.
    const grant = oauthRedirectUrl === undefined && oauthGrant !== undefined
        ? oauthGrant
        : redirectUrl === undefined ? undefined : new OAuthGrant(redirectUrl);
    if ((authorization === undefined || authorization.type === "oauth") && grant === undefined) {
        return {
            type: "streamable-http",
            url,
            ...(headers === undefined ? {} : { headers }),
            cachePartition: "anonymous",
        };
    }
    if (authorization?.type === "bearer") {
        const tokenField = `MCP server '${definition.name}'.authorization.token`;
        const token = expandReferences(authorization.token, environ, tokenField);
        if (token.length === 0) throw new Error(`${tokenField} resolved empty.`);
        return {
            type: "streamable-http",
            url,
            ...(headers === undefined ? {} : { headers }),
            authProvider: { token: async () => token },
            cachePartition: `bearer:${authorization.token}`,
        };
    }
    if (authorization?.type === "client-credentials") {
        const secret = expandReferences(authorization.clientSecret, environ, `${field}.clientSecret`);
        if (secret.length === 0) throw new Error(`${field}.clientSecret resolved empty.`);
        return {
            type: "streamable-http",
            url,
            ...(headers === undefined ? {} : { headers }),
            clientCredentials: true,
            // oxlint-disable-next-line typescript/no-deprecated -- {§oauth-client-credentials} keeps `issuer` optional; without one the SDK's unbound overload, which it deprecates, is the declared behaviour
            authProvider: new ClientCredentialsProvider({
                clientId: authorization.clientId,
                clientSecret: secret,
                // {§oauth-client-credentials} — a declared issuer binds the static
                // credential to that authorization server (SEP-2352); absent, the
                // SDK's legacy no-binding behaviour applies.
                ...(authorization.issuer === undefined ? {} : { expectedIssuer: authorization.issuer }),
                ...(authorization.scope === undefined ? {} : { scope: authorization.scope }),
            }),
            cachePartition: `client:${authorization.clientId}`,
        };
    }
    // {§oauth-lifetime} — the registration and tokens are the grant's, which outlives this connection; the PKCE
    // verifier and callback state are this provider's. All of it is process memory.
    const oauthProvider = new InteractiveOAuthProvider({
        grant: grant!,
        redirectConfigured: configuredRedirect !== undefined,
        ...(authorization?.scope === undefined ? {} : { scope: authorization.scope }),
        ...(authorization?.issuer === undefined ? {} : { issuer: authorization.issuer }),
        ...(authorization?.authorizationParams === undefined ? {} : { authorizationParams: authorization.authorizationParams }),
        ...(authorization !== undefined && "clientMetadataUrl" in authorization ? { clientMetadataUrl: authorization.clientMetadataUrl } : {}),
        ...(authorization !== undefined && "clientId" in authorization
            ? { clientId: authorization.clientId, clientSecret: expandReferences(authorization.clientSecret, environ, `${field}.clientSecret`) }
            : {}),
    });
    const cachePartition = authorization !== undefined && "clientMetadataUrl" in authorization
        ? `oauth:cimd:${authorization.clientMetadataUrl}`
        : authorization !== undefined && "clientId" in authorization
            ? `oauth:client:${authorization.clientId}`
            : "oauth:dynamic";
    return {
        type: "streamable-http",
        url,
        ...(headers === undefined ? {} : { headers }),
        authProvider: oauthProvider,
        oauthProvider,
        cachePartition,
    };
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// The SDK re-wraps a transport failure without keeping it as a cause, so each HTTP transport's refused
// redirect is kept beside it for the connection failure to carry.
const refusedRedirects = new WeakMap<StreamableHTTPClientTransport, McpRedirectError>();
// The fetch each HTTP transport authorizes through, as the SDK composes it, for a sign-in this host starts itself.
const authorizationFetches = new WeakMap<StreamableHTTPClientTransport, FetchLike>();

const openTransport = (
    definition: ResolvedDefinition,
    environment: NodeJS.ProcessEnv = getDefaultEnvironment(),
): StdioClientTransport | StreamableHTTPClientTransport => {
    if (definition.type === "streamable-http") {
        const requestInit = definition.headers === undefined ? undefined : { headers: definition.headers };
        const transportFetch: FetchLike = async (url, init) => {
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
            let sent = init;
            if (
                ["tasks/get", "tasks/update", "tasks/cancel"].includes(String(request?.method))
                && typeof request?.params?.taskId === "string"
            ) {
                const headers = new Headers(init?.headers);
                headers.set("Mcp-Name", mcpRoutingHeaderValue(request.params.taskId));
                sent = { ...init, headers };
            }
            // {§mcp-redirect-refused} — configured headers never reach another origin: no
            // redirect is followed, and a redirected endpoint fails naming where it pointed.
            const response = await fetch(url, { ...sent, redirect: "manual" });
            if (REDIRECT_STATUSES.has(response.status)) {
                const location = response.headers.get("location");
                await response.body?.cancel();
                const refused = new McpRedirectError(String(url), location === null ? null : new URL(location, String(url)).href);
                refusedRedirects.set(transport, refused);
                throw refused;
            }
            return response;
        };
        const transport: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(
            new URL(definition.url),
            {
                ...(requestInit === undefined ? {} : { requestInit }),
                ...(definition.authProvider === undefined
                    ? {}
                    : { authProvider: definition.authProvider }),
                fetch: transportFetch,
            },
        );
        authorizationFetches.set(transport, createFetchWithInit(transportFetch, requestInit));
        return transport;
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
        stderr: "pipe",
        env: {
            // The SDK merges its defaults even with an explicit env. Node spawn
            // accepts undefined to omit a key; the SDK's narrower type does not.
            ...Object.fromEntries(Object.keys(getDefaultEnvironment()).map((name) => [name, undefined])),
            ...environment,
            ...definition.env,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK types the env narrower than spawn's contract; an undefined value omits a key
        } as Record<string, string>,
    });
};

// {§mcp-catalog-convergence} — a catalog is complete or it is an error. The SDK's aggregating list
// walk (`listTools`, `listResources`, `listResourceTemplates`, `listPrompts`) stops silently when a
// server hands back a cursor it already handed back, then drops `nextCursor` and caches the partial
// aggregate as if it were whole. This client watches the pages the SDK requests and refuses the page
// that repeats a cursor, so a non-converging server fails the listing loudly and nothing partial is
// published or cached. Pagination, caching, and the page cap stay the SDK's.
const LIST_COLLECTIONS = new Map([
    ["tools/list", "tools"],
    ["resources/list", "resources"],
    ["resources/templates/list", "resourceTemplates"],
    ["prompts/list", "prompts"],
]);

export class CatalogNonConvergenceError extends Error {
    readonly method: string;
    readonly cursor: string;
    constructor(method: string, cursor: string) {
        super(`${method}: server pagination did not converge; cursor ${JSON.stringify(cursor)} was returned twice, so the catalog is incomplete`);
        this.name = "CatalogNonConvergenceError";
        this.method = method;
        this.cursor = cursor;
    }
}

class CatalogClient extends Client {
    // Cursors the server has returned in the current walk of each list method; a walk begins at
    // the SDK's cursorless first page.
    readonly #returned = new Map<string, Set<string>>();
    readonly #unsupported = new Set<string>();

    get unsupportedLists(): readonly string[] {
        return [...this.#unsupported].toSorted();
    }

    override request<M extends RequestMethod>(request: { method: M; params?: Record<string, unknown> }, options?: RequestOptions): Promise<ResultTypeMap[M]>;
    override request<T extends StandardSchemaV1>(request: Request, resultSchema: T, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T>>;
    override async request(...args: unknown[]): Promise<unknown> {
        const sent: unknown = args[0];
        const method = isRecord(sent) && typeof sent.method === "string" ? sent.method : undefined;
        const cursor = isRecord(sent) && isRecord(sent.params) ? sent.params.cursor : undefined;
        const collection = method === undefined ? undefined : LIST_COLLECTIONS.get(method);
        let result: unknown;
        try {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK's overloaded request is forwarded verbatim with the caller's arguments
            result = await (super.request as unknown as (...inner: unknown[]) => Promise<unknown>)(...args);
        } catch (error) {
            // {§mcp-catalog-list-absence} — never turn a later-page error into a partial success.
            if (
                collection === undefined || method === undefined
                || cursor !== undefined
                || !ProtocolError.isInstance(error) || error.code !== METHOD_NOT_FOUND
            ) throw error;
            this.#unsupported.add(method);
            return { resultType: "complete", [collection]: [], ttlMs: 0, cacheScope: "private" };
        }
        if (collection === undefined || method === undefined) return result;
        this.#unsupported.delete(method);
        if (cursor === undefined) this.#returned.set(method, new Set());
        const returned = this.#returned.get(method) ?? new Set<string>();
        this.#returned.set(method, returned);
        const next = isRecord(result) ? result.nextCursor : undefined;
        if (typeof next !== "string") return result;
        if (next === cursor || returned.has(next)) throw new CatalogNonConvergenceError(method, next);
        returned.add(next);
        return result;
    }
}

// {§mcp-redirect-refused} — an HTTP endpoint answered with a redirect, which plurnk never follows.
export class McpRedirectError extends Error {
    readonly url: string;
    readonly location: string | null;

    constructor(url: string, location: string | null) {
        super(`MCP endpoint ${url} redirected${location === null ? "" : ` to ${location}`}; plurnk follows no redirect, so the server's url must be the endpoint itself.`);
        this.name = "McpRedirectError";
        this.url = url;
        this.location = location;
    }
}

// {§mcp-request-unauthorized} The sentence each surface refuses a request awaiting a sign-in with.
export const awaitsSignIn = (server: string): string =>
    `MCP server '${server}' awaits the operator's sign-in; the request was not completed.`;

export class AuthorizationRequiredError extends Error {
    readonly authorizationUrl: string | undefined;

    constructor(authorizationUrl?: string, cause?: unknown) {
        super("MCP server requires authorization.", { cause });
        this.name = "AuthorizationRequiredError";
        this.authorizationUrl = authorizationUrl;
    }
}

interface OpenClient {
    readonly client: CatalogClient;
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
            ...(definition.type === "streamable-http" && definition.clientCredentials === true
                ? { [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {} }
                : {}),
        },
    } satisfies ClientCapabilities;
    const client = new CatalogClient(
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
            ...(definition.type === "streamable-http"
                ? { cachePartition: definition.cachePartition }
                : {}),
        },
    );
    client.onerror = (error): void => options.onInfrastructureError?.(error);
    try {
        await client.connect(transport, {
            timeout: connectTimeoutMs(environ),
        });
    } catch (failure) {
        const refused = transport instanceof StreamableHTTPClientTransport ? refusedRedirects.get(transport) : undefined;
        const cause = refused ?? failure;
        const authorization = definition.type === "streamable-http"
            ? definition.oauthProvider?.takeAuthorization()
            : undefined;
        let closeFailure: unknown;
        try {
            await client.close();
        } catch (error) {
            closeFailure = error;
        }
        if (authorization !== undefined) {
            throw new AuthorizationRequiredError(
                authorization.url?.href,
                closeFailure === undefined ? cause : new AggregateError([cause, closeFailure]),
            );
        }
        if (closeFailure === undefined && definition.type === "streamable-http"
            && definition.authProvider === undefined
            && !Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
            && cause instanceof SdkHttpError && cause.status === 401) {
            throw new AuthorizationRequiredError(undefined, cause);
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
            retry: retryPacing(environ),
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
    readonly #diagnostics: PreparationDiagnostics;
    #client: Promise<OpenClient> | undefined;
    #pendingAuthorization: {
        readonly transport: StreamableHTTPClientTransport;
        readonly provider: InteractiveOAuthProvider;
        readonly authorizationUrl: string;
        readonly standaloneTransport: boolean;
    } | undefined;
    #openingTransport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    readonly #requests = new Set<Promise<void>>();
    readonly #abort = new AbortController();
    #closure: Promise<void> | undefined;
    #closed = false;

    constructor(
        definition: McpServerDefinition,
        environ: NodeJS.ProcessEnv = process.env,
        options: ServerConnectionOptions = {},
    ) {
        this.#definition = structuredClone(Validator.assertMcpServerDefinition(definition));
        this.#resolved = resolveDefinition(this.#definition, environ, options);
        this.#environ = environ;
        this.#options = options;
        const symbolic = JSON.stringify(definition);
        const references = Object.entries(environ).flatMap(([name, value]) =>
            value !== undefined && symbolic.includes(`\${${name}}`) ? [value] : []);
        const values = this.#resolved.type === "stdio"
            ? [...Object.values(options.environment ?? getDefaultEnvironment()), ...Object.values(this.#resolved.env), ...this.#resolved.args]
            : [...Object.values(this.#resolved.headers ?? {}), new URL(this.#resolved.url).username, new URL(this.#resolved.url).password];
        this.#diagnostics = new PreparationDiagnostics([...references, ...values.filter((value): value is string => value !== undefined)], ErrorDetail.limit());
    }

    get definition(): McpServerDefinition {
        return structuredClone(this.#definition);
    }

    get activeRequests(): number {
        return this.#requests.size;
    }

    get authorizationUrl(): string | null {
        return this.#pendingAuthorization?.authorizationUrl ?? null;
    }

    // {§oauth-grant} The grant this connection presents, or begins.
    get oauthGrant(): OAuthGrant | undefined {
        return this.#resolved.type === "streamable-http" ? this.#resolved.oauthProvider?.grant : undefined;
    }

    preparationDiagnostic(cause: unknown): PreparationDiagnostic {
        return this.#diagnostics.describe(cause);
    }

    async #open(): Promise<OpenClient> {
        if (this.#closed) throw new Error(`MCP server '${this.#definition.name}' connection is closed.`);
        if (this.#pendingAuthorization !== undefined) {
            throw new AuthorizationRequiredError(this.#pendingAuthorization.authorizationUrl);
        }
        if (this.#client !== undefined) return this.#client;
        let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
        const pending = (async () => {
            const definition = this.#resolved;
            if (this.#options.plugin !== undefined && this.#definition.type === "stdio") {
                await PluginConfiguration.prepare(this.#definition, this.#options.plugin);
            }
            if (this.#closed) throw new Error(`MCP server '${this.#definition.name}' connection is closed.`);
            transport = openTransport(definition, this.#options.environment);
            if (transport instanceof StdioClientTransport && transport.stderr !== null) {
                transport.stderr.on("data", (chunk: Buffer) => this.#diagnostics.write(chunk));
                transport.stderr.pipe(process.stderr, { end: false });
            }
            this.#openingTransport = transport;
            return openClient(definition, this.#environ, this.#options, transport);
        })().catch((cause: unknown) => {
            if (
                cause instanceof AuthorizationRequiredError
                && cause.authorizationUrl !== undefined
                && this.#resolved.type === "streamable-http"
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
        }).finally(() => {
            if (this.#openingTransport === transport) this.#openingTransport = undefined;
        });
        this.#client = pending;
        return pending;
    }

    async connect(): Promise<Client> {
        return (await this.#open()).client;
    }

    // {§oauth-begin-unchallenged} A server whose catalog answers anonymously challenges no connection, so the SDK never
    // starts its authorization; a sign-in the client begins starts it here, as the transport would on a challenge.
    async beginAuthorization(): Promise<string | undefined> {
        const resolved = this.#resolved;
        if (resolved.type !== "streamable-http" || resolved.oauthProvider === undefined) {
            throw new Error(`MCP server '${this.#definition.name}' has no interactive OAuth sign-in.`);
        }
        const opened = await this.#open();
        if (!(opened.transport instanceof StreamableHTTPClientTransport)) {
            throw new Error(`MCP server '${this.#definition.name}' is not connected over Streamable HTTP.`);
        }
        const result = await auth(resolved.oauthProvider, {
            serverUrl: new URL(resolved.url),
            fetchFn: authorizationFetches.get(opened.transport),
        });
        if (result === "AUTHORIZED") return undefined;
        const authorizationUrl = resolved.oauthProvider.takeAuthorization()?.url;
        if (authorizationUrl === undefined) throw new Error("OAuth authorization redirected without an authorization URL.");
        this.#pendingAuthorization = {
            transport: opened.transport,
            provider: resolved.oauthProvider,
            authorizationUrl: authorizationUrl.href,
            standaloneTransport: false,
        };
        return authorizationUrl.href;
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
    }

    async #request<T>(
        run: (opened: OpenClient, signal: AbortSignal) => Promise<T>,
        owner?: AbortSignal,
    ): Promise<T> {
        const settled = Promise.withResolvers<void>();
        this.#requests.add(settled.promise);
        const signal = owner === undefined ? this.#abort.signal : AbortSignal.any([owner, this.#abort.signal]);
        try {
            signal.throwIfAborted();
            const opened = await this.#open();
            signal.throwIfAborted();
            try {
                return await run(opened, signal);
            } catch (cause) {
                // A nested request already took its authorization and said so.
                if (cause instanceof AuthorizationRequiredError) throw cause;
                const authorization = this.#takeAuthorization(opened, cause) ?? this.#refusedUnsigned(cause);
                if (authorization !== null) {
                    this.#options.onAuthorizationRequired?.();
                    throw authorization;
                }
                throw cause;
            }
        } finally {
            this.#requests.delete(settled.promise);
            settled.resolve();
        }
    }

    // {§mcp-request-unauthorized} A request the server refused with HTTP 401, on a definition that configures no credential
    // of its own, awaits a sign-in exactly as a challenge at connection does.
    #refusedUnsigned(cause: unknown): AuthorizationRequiredError | null {
        if (this.#resolved.type !== "streamable-http") return null;
        const configured = (this.#resolved.authProvider !== undefined && this.#resolved.oauthProvider === undefined)
            || Object.keys(this.#resolved.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
        if (configured) return null;
        const refused = causeOf(cause, SdkHttpError)?.status === 401 || causeOf(cause, UnauthorizedError) !== undefined;
        return refused ? new AuthorizationRequiredError(undefined, cause) : null;
    }

    #takeAuthorization(opened: OpenClient, cause: unknown): AuthorizationRequiredError | null {
        if (
            this.#resolved.type !== "streamable-http"
            || this.#resolved.oauthProvider === undefined
            || !(opened.transport instanceof StreamableHTTPClientTransport)
        ) {
            return null;
        }
        const authorization = this.#resolved.oauthProvider.takeAuthorization();
        if (authorization === undefined) return null;
        // {§oauth-grant} The grant no longer answers, and no client waits at its redirect.
        const authorizationUrl = authorization.url;
        if (authorizationUrl === undefined) return new AuthorizationRequiredError(undefined, cause);
        this.#pendingAuthorization = {
            transport: opened.transport,
            provider: this.#resolved.oauthProvider,
            authorizationUrl: authorizationUrl.href,
            standaloneTransport: false,
        };
        return new AuthorizationRequiredError(authorizationUrl.href, cause);
    }

    async #list<T>(run: (client: CatalogClient, options: RequestOptions) => Promise<T>, owner?: AbortSignal): Promise<T> {
        return this.#request(async ({ client }, signal) => {
            const timeout = connectTimeoutMs(this.#environ);
            const settled = new AbortController();
            // {§mcp-catalog-deadline}: one bound across parallel lists and every SDK pagination leg.
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout), settled.signal]);
            try {
                return await run(client, { signal: deadline, timeout, maxTotalTimeout: timeout });
            } finally {
                settled.abort();
            }
        }, owner);
    }

    async tools(signal?: AbortSignal): Promise<Tool[]> {
        return this.#list(async (client, options) => {
            if (serverCapabilities(client)?.tools === undefined) return [];
            const { tools } = await client.listTools(undefined, options);
            return tools;
        }, signal);
    }

    async catalog(signal?: AbortSignal): Promise<ServerCatalog> {
        return this.#list(async (client, options) => {
            // {§mcp-authority} — the discover result is the modern identity and
            // capability source; a legacy server's initialize result supplies the
            // same facts at its negotiated revision.
            const capabilities = serverCapabilities(client) ?? {};
            const [tools, resources, resourceTemplates, prompts] = await Promise.all([
                capabilities.tools === undefined
                    ? Promise.resolve([])
                    : client.listTools(undefined, options).then((result) => result.tools),
                capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResources(undefined, options).then((result) => result.resources),
                capabilities.resources === undefined
                    ? Promise.resolve([])
                    : client.listResourceTemplates(undefined, options)
                        .then((result) => result.resourceTemplates),
                capabilities.prompts === undefined
                    ? Promise.resolve([])
                    : client.listPrompts(undefined, options).then((result) => result.prompts),
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
                unsupportedLists: client.unsupportedLists,
            };
        }, signal);
    }

    async resources(signal?: AbortSignal): Promise<{
        resources: ServerCatalog["resources"];
        resourceTemplates: ServerCatalog["resourceTemplates"];
    }> {
        return this.#list(async (client, options) => {
            if (serverCapabilities(client)?.resources === undefined) {
                return { resources: [], resourceTemplates: [] };
            }
            const [resources, resourceTemplates] = await Promise.all([
                client.listResources(undefined, options)
                    .then((result) => result.resources),
                client.listResourceTemplates(undefined, options)
                    .then((result) => result.resourceTemplates),
            ]);
            return { resources, resourceTemplates };
        }, signal);
    }

    async prompts(signal?: AbortSignal): Promise<ServerCatalog["prompts"]> {
        return this.#list(async (client, options) => {
            if (serverCapabilities(client)?.prompts === undefined) return [];
            return (await client.listPrompts(undefined, options)).prompts;
        }, signal);
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
        onProgress?: (progress: Progress) => void,
        interact?: ClientInteractionHandler,
        toolDefinition?: Tool,
    ): Promise<CallToolResult> {
        return this.#request(async ({ client, subscriptions, extensions }, requestSignal) => {
            const timeout = requestTimeoutMs(this.#environ);
            // {§mcp-header-declarations} — the definition is scanned before either leg; an invalid declaration
            // refuses the call here and nothing reaches the transport.
            const listed = async (): Promise<Tool | undefined> => (await this.tools(requestSignal))
                .find((candidate) => candidate.name === name);
            if (serverSupportsTasks(serverCapabilities(client))) {
                const tool = toolDefinition ?? await listed();
                if (tool === undefined) {
                    throw new Error(`MCP server '${this.#definition.name}' did not list tool '${name}'.`);
                }
                assertHeaderDeclarations(tool);
                return callToolWithTasks({
                    server: this.#definition.name,
                    name,
                    args,
                    tool,
                    signal: requestSignal,
                    onProgress,
                    interact,
                    timeout,
                    channel: extensions ?? (() => { throw new Error("MCP tasks channel absent on a non-modern connection."); })(),
                    subscriptions,
                });
            }
            // The direct leg never waits on a failed listing ({§mcp-catalog-deadline}): a definition at hand is
            // scanned, and a call with none to scan proceeds as it always has, with no routing headers.
            const tool = toolDefinition ?? await listed().catch(() => {
                requestSignal.throwIfAborted();
                return undefined;
            });
            if (tool !== undefined) assertHeaderDeclarations(tool);
            return runInputRequiredRequest<CallToolResult>({
                server: this.#definition.name,
                operation: "tools/call",
                originalParams: { name, arguments: args },
                signal,
                interact,
                onProgress,
                timeout,
                requestLeg: (params, options) => client.callTool(
                    CALL_TOOL_PARAMS.parse(params),
                    { ...options, ...(tool === undefined ? {} : { toolDefinition: tool }) },
                ),
            });
        }, signal);
    }

    async readResource(
        uri: string,
        signal?: AbortSignal,
        interact?: ClientInteractionHandler,
    ): Promise<ReadResourceResult> {
        return this.#request(async ({ client, subscriptions }, requestSignal) => {
            await subscriptions.selectResource(uri, requestSignal);
            return runInputRequiredRequest<ReadResourceResult>({
                server: this.#definition.name,
                operation: "resources/read",
                originalParams: { uri },
                signal: requestSignal,
                interact,
                timeout: requestTimeoutMs(this.#environ),
                requestLeg: (params, options, retry) => client.readResource(
                    READ_RESOURCE_PARAMS.parse(params),
                    retry ? { ...options, cacheMode: "refresh" } : options,
                ),
            });
        }, signal);
    }

    async getPrompt(
        name: string,
        args: Record<string, string> | undefined,
        signal?: AbortSignal,
        interact?: ClientInteractionHandler,
    ): Promise<GetPromptResult> {
        return this.#request(async ({ client }, requestSignal) => runInputRequiredRequest<GetPromptResult>({
            server: this.#definition.name,
            operation: "prompts/get",
            originalParams: { name, ...(args === undefined ? {} : { arguments: args }) },
            signal: requestSignal,
            interact,
            timeout: requestTimeoutMs(this.#environ),
            requestLeg: (params, options) => client.getPrompt(
                GET_PROMPT_PARAMS.parse(params),
                options,
            ),
        }), signal);
    }

    async complete(
        params: CompleteRequest["params"],
        signal?: AbortSignal,
    ): Promise<CompleteResult> {
        return this.#request(async ({ client }, requestSignal) => client.complete(
            params,
            this.#requestOptions(requestSignal),
        ), signal);
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

    close(): Promise<void> {
        this.#closure ??= this.#close();
        return this.#closure;
    }

    async #close(): Promise<void> {
        this.#closed = true;
        this.#abort.abort(new Error(`MCP server '${this.#definition.name}' connection is closed.`));
        const client = this.#client;
        this.#client = undefined;
        const openingTransport = this.#openingTransport;
        this.#openingTransport = undefined;
        const pending = this.#pendingAuthorization;
        this.#pendingAuthorization = undefined;
        const closures: Promise<void>[] = [];
        if (openingTransport !== undefined) closures.push(openingTransport.close());
        if (client !== undefined) {
            closures.push(client.then(
                async ({ client: connected, extensions, subscriptions }) => {
                    // {§mcp-connection-shutdown} — active Task cleanup still needs the transport.
                    await Promise.all([...this.#requests, subscriptions.retire()]);
                    extensions?.close();
                    await connected.close();
                },
                () => undefined,
            ));
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
