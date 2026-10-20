// {§mcp-module} — the MCP family beneath the shared workspace Functionality
// coordinator ({§functionality-adapter}). This module owns MCP protocol truth:
// complete connection definitions, preparation with OAuth
// continuation, tool/resource publication, catalog refresh, and teardown. The coordinator owns the lifecycle, durable workspace state, atomic
// publication, and both the client and model projections.
import { fileURLToPath } from "node:url";
import { readDefinition } from "./definition.ts";
import { isDeepStrictEqual } from "node:util";
import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { CompleteRequestParamsSchema } from "@modelcontextprotocol/core";
import type { PluginContext } from "./PluginConfiguration.ts";
import { type Notice,
    Problems,
    Validator,
    isRecord,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPreparedDefinition,
    type FunctionalityPrepared,
    type McpServerDefinition,
    type McpOAuthCompletionResult,
    type McpOAuthBeginResult,
    type JsonSchema,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity } from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import type { ContainedConfiguration, DaemonModule, FunctionalitySeam, ModuleActionContext, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import { ConfigurationError } from "@plurnk/plurnk-meta";

import ServerConnection, {
    AuthorizationRequiredError,
    awaitsSignIn,
    causeOf,
    isClientCredentialsRejection,
    McpRedirectError,
} from "./client.ts";
import {
    configuredDefinitions,
    connectTimeoutMs,
    expandedServerNames,
    retryDelayMs,
    retryPacing,
    registrySettings,
    serverSettings,
    type McpAuthorization,
    type ToolPolicy,
} from "./config.ts";
import { RegistryError, registryEntries, searchRegistry, type RegistryServer } from "./registry.ts";
import McpExecutor, { UnavailableServerExecutor, runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import { type OAuthGrant, OAuthSetupError } from "./oauth.ts";

const OWNER = "@plurnk/plurnk-mcp";
const FAMILY = "mcp";
const NONEMPTY_STRING = { type: "string", minLength: 1 } as const;
const OPEN_OBJECT = { type: "object", additionalProperties: true } as const;
const MCP_DEFINITION = { $ref: "https://schemas.plurnk.xyz/v0/McpServerDefinition.json" } as const;
const actionInput = (
    properties: Readonly<Record<string, JsonSchema>>,
    required: readonly string[] = [],
): JsonSchema => ({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
});

interface McpBinding extends FunctionalityPreparedDefinition {
    readonly definition: McpServerDefinition;
    readonly context?: PluginContext;
}

interface ActiveAttachment extends McpBinding {
    readonly kind: "active";
    readonly connection: ServerConnection;
    readonly executor: McpExecutor;
    readonly runtime: RuntimeRegistration;
}

interface AuthorizationAttachment extends McpBinding {
    readonly kind: "authorization-required";
    readonly connection: ServerConnection;
    readonly authorizationUrl: string | undefined;
}

interface UnavailableAttachment extends McpBinding {
    readonly kind: "unavailable";
    readonly problem: ProblemDetails;
}

type ConnectedAttachment = ActiveAttachment | AuthorizationAttachment;
type Attachment = ConnectedAttachment | UnavailableAttachment;
// The committed attachments a preparation hands the coordinator, by server name.
type Snapshot = ReadonlyMap<string, Attachment>;

const attachmentConnection = (attachment: Attachment): ServerConnection | undefined =>
    attachment.kind === "unavailable" ? undefined : attachment.connection;

// {§mcp-unavailable-runtime} An enabled server that cannot run still answers to its alias: a call to it is refused with
// the state that keeps it from running, never as a name nothing registered.
const unavailableRuntime = (attachment: AuthorizationAttachment | UnavailableAttachment): RuntimeRegistration => {
    const { name } = attachment.definition;
    const detail = attachment.kind === "authorization-required"
        ? "it awaits the operator's sign-in"
        : typeof attachment.problem.diagnostic === "string" ? attachment.problem.diagnostic : attachment.problem.detail;
    return {
        namespaceOwner: OWNER,
        decl: runtimeDecl(name, runtimeServerSummary(name, undefined), false),
        executor: new UnavailableServerExecutor(name, detail),
        availability: { available: false, detail },
    };
};

// {§oauth-lifetime} — a pending authorization is process memory per
// (workspace, alias): the challenged connection, its URL, the workspace residency it
// holds, and the accepted grant awaiting capability publication.
interface PendingAuthorization extends McpBinding {
    readonly connection: ServerConnection;
    readonly releaseWorkspace: () => void;
    prepared?: ActiveAttachment;
    authorized?: boolean;
    completion?: { readonly callbackUrl: string; readonly result: Promise<McpOAuthCompletionResult> };
}

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

interface ClosableConnection {
    close(): Promise<void>;
}

class ModuleActionError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, { cause });
        this.name = "ModuleActionError";
        this.problem = problem;
    }
}

const actionError = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): ModuleActionError => new ModuleActionError(
    Problems.create("mcp:management", code, status, detail, {
        stage: "mcp-management",
        ...extensions,
    }),
    cause,
);

const errorsOf = (error: unknown): unknown[] =>
    error instanceof AggregateError ? [...error.errors] : [error];

const preparationError = (
    definition: McpServerDefinition,
    authorization: McpAuthorization | undefined,
    cause: unknown,
    closeCause?: unknown,
    observation: Readonly<Record<string, unknown>> = {},
): ModuleActionError => {
    const completeCause = closeCause === undefined
        ? cause
        : new AggregateError(
            [cause, closeCause],
            `MCP server '${definition.name}' preparation and cleanup failed.`,
        );
    const setup = causeOf(cause, OAuthSetupError);
    if (setup !== undefined) return actionError(setup.code, 502, setup.message,
        { server: definition.name, ...(setup.recovery === undefined ? {} : { recovery: setup.recovery }), retryable: false }, completeCause);
    // {§oauth-client-credentials} — a rejected grant is an authorization fact,
    // never a generic unavailability.
    if (authorization?.type === "client-credentials" && isClientCredentialsRejection(cause)) {
        return actionError(
            "oauth-client-credentials-failed",
            502,
            `MCP server '${definition.name}' rejected the client-credentials grant.`,
            {
                server: definition.name,
                type: definition.type,
                clientId: authorization.clientId,
                ...(authorization.issuer === undefined
                    ? {}
                    : { issuer: authorization.issuer }),
                retryable: false,
            },
            completeCause,
        );
    }
    // {§mcp-redirect-refused} — the operator corrects the endpoint; retrying cannot.
    const redirect = causeOf(cause, McpRedirectError);
    if (redirect !== undefined) {
        return actionError(
            "server-redirected",
            502,
            redirect.message,
            { server: definition.name, url: redirect.url, ...(redirect.location === null ? {} : { location: redirect.location }), retryable: false },
            completeCause,
        );
    }
    const http = causeOf(cause, SdkHttpError);
    if (http?.status === 401 || causeOf(cause, UnauthorizedError) !== undefined) {
        return actionError("server-authentication-failed", 502,
            `MCP server '${definition.name}' rejected authentication (HTTP 401).`,
            { server: definition.name, upstreamStatus: 401, retryable: false }, completeCause);
    }
    return actionError(
        "server-unavailable",
        502,
        `Configured MCP server '${definition.name}' is unavailable.`,
        {
            server: definition.name,
            type: definition.type,
            retryable: true,
            ...observation,
        },
        completeCause,
    );
};

export const closeConnections = async (
    connections: readonly ClosableConnection[],
): Promise<void> => {
    const results = await Promise.allSettled(
        [...new Set(connections)].map((connection) => connection.close()),
    );
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .flatMap((result) => errorsOf(result.reason));
    if (errors.length > 0) {
        throw new AggregateError(errors, "MCP connection shutdown failed");
    }
};

const objectOf = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null;

const assertActionKeys = (
    params: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
): void => {
    const extras = Object.keys(params).filter((key) => !allowed.includes(key));
    if (extras.length > 0) {
        throw actionError(
            "parameters-invalid",
            400,
            `Unsupported parameter(s): ${extras.join(", ")}.`,
            { retryable: false },
        );
    }
};

const requiredString = (
    params: Readonly<Record<string, unknown>>,
    key: string,
): string => {
    const value = params[key];
    if (typeof value !== "string" || value.length === 0) {
        throw actionError(
            "parameters-invalid",
            400,
            `'${key}' must be a non-empty string.`,
            { field: key, retryable: false },
        );
    }
    return value;
};

const workspaceIdentityOf = (context: ModuleActionContext): WorkspaceCapabilityIdentity => {
    if (context.scope !== "workspace") throw new Error("MCP actions require a workspace-scoped context.");
    return { workspaceId: context.workspaceId };
};

const sameBinding = (left: McpBinding, right: McpBinding): boolean =>
    isDeepStrictEqual([left.definition, left.context], [right.definition, right.context]);

// The coordinator hands this module its own admitted definitions back as the contract's objects: the
// definition is read through its schema, the plugin context through the two paths it names.
const isPluginContext = (value: object): value is PluginContext =>
    "root" in value && typeof value.root === "string" && "data" in value && typeof value.data === "string";
const pluginContextOf = (value: object): PluginContext => {
    if (!isPluginContext(value)) throw new TypeError("An MCP binding's plugin context names its root and data paths.");
    return value;
};
const bindingOf = (value: FunctionalityPreparedDefinition): McpBinding => ({
    definition: Validator.assertMcpServerDefinition(value.definition),
    ...(value.context === undefined ? {} : { context: pluginContextOf(value.context) }),
});

const statusOf = (error: unknown): number | null => {
    if (typeof error !== "object" || error === null) return null;
    const problem = (error as { problem?: { status?: unknown } }).problem
        ?? (error as { result?: { problem?: { status?: unknown } } }).result?.problem;
    return typeof problem?.status === "number" ? problem.status : null;
};

// An active alias's detail: its server's catalog, and the summary of a grant its connection presents ({§oauth-grant}).
const activeDetail = ({ executor: { catalog }, connection }: ActiveAttachment): object => {
    const grant = connection.oauthGrant?.summary;
    return {
        protocolVersion: catalog.protocolVersion,
        server: catalog.server ?? null,
        capabilities: catalog.capabilities,
        tools: catalog.tools.map(({ name }) => name).toSorted(),
        resources: catalog.resources.length,
        resourceTemplates: catalog.resourceTemplates.length,
        prompts: catalog.prompts.length,
        ...(grant === undefined ? {} : { grant }),
    };
};

// {§mcp-registry-discovery} — the registry `discover` searches.
interface Registry {
    readonly url: string;
    readonly limit: number;
}

// {§module-seam-slices} — the slices this module uses.
type SetupSeam = Pick<ModuleSetupSeam,
    "workspacePaths" | "operatorEnvironment" | "readWorkspaceEnvironment" | "workspaceStateDirectory" | "registerModuleAction">
    & FunctionalitySeam<RuntimeRegistration> & WorkspacePluginsSeam;

export default class Module implements DaemonModule<SetupSeam> {
    readonly #env: NodeJS.ProcessEnv;
    // {§mcp-registry-discovery} The registry `discover` searches, read at construction; without one the
    // family serves no discovery. An invalid setting withholds discovery alone
    // ({§module-contained-configuration}).
    readonly #registry: Registry | null;
    readonly contained: readonly ContainedConfiguration[];
    #workspaceEnvironment!: SetupSeam["readWorkspaceEnvironment"];
    #plugins!: SetupSeam["readWorkspacePlugins"];
    readonly #configurationNotices = new Map<number, readonly Notice[]>();
    #operatorEnvironment!: SetupSeam["operatorEnvironment"];
    #stateDirectory!: SetupSeam["workspaceStateDirectory"];
    #paths!: SetupSeam["workspacePaths"];
    // The committed attachments per workspace: the adapter's mirror of the snapshot
    // the coordinator holds, for continuations and refresh.
    readonly #attachments = new Map<number, ReadonlyMap<string, Attachment>>();
    readonly #identities = new Map<number, WorkspaceCapabilityIdentity>();
    readonly #pending = new Map<string, PendingAuthorization>();
    readonly #authorizing = new Set<string>();
    readonly #dirty = new Map<string, symbol>();
    // {§mcp-request-unauthorized} The aliases whose server refused a call for want of a sign-in, by pending key.
    readonly #challenged = new Set<string>();
    // {§oauth-grant} Each alias's accepted sign-in, by pending key, with the definition it was accepted for; cooling
    // keeps it.
    readonly #grants = new Map<string, McpBinding & { readonly grant: OAuthGrant }>();
    readonly #connections = new Set<ServerConnection>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
    readonly #retainWorkspace = new Map<number, () => () => void>();
    #handle: FunctionalityFamilyHandle | undefined;
    #closed = false;
    #stopping: Promise<void> | null = null;

    static init(options: ModuleOptions = {}): Module {
        return new Module(options.env ?? process.env);
    }

    private constructor(environ: NodeJS.ProcessEnv) {
        this.#env = environ;
        let registry: Registry | null = null;
        let contained: ContainedConfiguration[] = [];
        try {
            const { url, limit } = registrySettings(environ);
            if (url !== null) registry = { url, limit };
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            contained = [{ key: cause.key, message: cause.message }];
        }
        this.#registry = registry;
        this.contained = contained;
    }

    async setup(seam: SetupSeam): Promise<void> {
        this.#plugins = (workspaceId) => seam.readWorkspacePlugins(workspaceId);
        this.#workspaceEnvironment = (workspaceId) => seam.readWorkspaceEnvironment(workspaceId);
        this.#operatorEnvironment = () => seam.operatorEnvironment();
        this.#stateDirectory = (workspaceId, owner) => seam.workspaceStateDirectory(workspaceId, owner);
        this.#paths = (workspaceId) => seam.workspacePaths(workspaceId);
        const registry = this.#registry;
        this.#handle = seam.registerFunctionalityAdapter<McpServerDefinition, Snapshot>({
            family: FAMILY,
            namespaceOwner: OWNER,
            summary: "Manage MCP servers",
            definitionSchema: MCP_DEFINITION,
            example: { alias: "example-server", definition: { name: "example-server", type: "stdio", command: "npx", args: ["-y", "example-mcp-server@1.0.0"] } },
            docsDir: fileURLToPath(new URL("..", import.meta.url)),
            ...(registry === null ? {} : {
                discovery: {
                    inputs: ["query"],
                    details: "`query` searches the MCP Registry by server name; each candidate carries the exact definition to add.",
                },
                discover: (query) => this.#discover(query, registry),
            }),
            available: (identity) => this.#available(identity),
            configurationNotices: ({ workspaceId }) => this.#configurationNotices.get(workspaceId) ?? [],
            admit: (input) => this.#admit(input),
            prepare: (preparation) => this.#prepare(preparation),
            teardown: (snapshot, identity) => this.#teardown(snapshot, identity),
            refreshIfChanged: (identity) => this.#refreshIfChanged(identity),
        });
        // Protocol continuations beneath the common grammar.
        seam.registerModuleAction({
            name: "workspace.mcp.oauth.begin",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, redirectUrl: NONEMPTY_STRING }, ["alias", "redirectUrl"]),
            outputSchema: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthBeginResult.json" },
            handler: (params, context) => this.#beginOAuth(workspaceIdentityOf(context), params),
        });
        seam.registerModuleAction({
            name: "workspace.mcp.oauth.complete",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, callbackUrl: NONEMPTY_STRING }, ["alias", "callbackUrl"]),
            outputSchema: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthCompletionResult.json" },
            handler: (params, context) => this.#completeOAuth(workspaceIdentityOf(context), params),
        });
        seam.registerModuleAction({
            name: "workspace.mcp.complete",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({
                server: NONEMPTY_STRING,
                ref: OPEN_OBJECT,
                argument: OPEN_OBJECT,
                context: OPEN_OBJECT,
            }, ["server", "ref", "argument"]),
            outputSchema: OPEN_OBJECT,
            handler: (params, context) => this.#complete(workspaceIdentityOf(context).workspaceId, params),
        });
    }

    async #available(identity: WorkspaceCapabilityIdentity): ReturnType<typeof configuredDefinitions> {
        expandedServerNames(this.#env);
        const { workspaceId } = identity;
        const notices: Notice[] = [];
        this.#configurationNotices.set(workspaceId, notices);
        const { configurationRoots } = await this.#paths(workspaceId);
        return configuredDefinitions(configurationRoots.map(({ directory }) => directory), this.#env, {
            ...await this.#plugins(workspaceId), report: (notice) => notices.push(notice),
        });
    }

    // {§functionality-hotload} — a server's definition is complete, so the coordinator's
    // comparison of what it would prepare with what it published is the change test.
    async #refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#handleOrThrow().refresh(identity, { gate: "none", ifChanged: true });
    }

    // {§mcp-registry-discovery} Candidates are complete definitions, never installations.
    async #discover(query: FunctionalityDiscoverQuery, { url, limit }: Registry): Promise<FunctionalityCandidate[]> {
        const term = query.query!;
        let servers: RegistryServer[];
        try {
            servers = await searchRegistry({ url, query: term, limit, timeoutMs: connectTimeoutMs(this.#env) });
        } catch (cause) {
            throw actionError("discover-failed", 502, cause instanceof RegistryError ? cause.message : `The MCP Registry search for '${term}' failed.`, {
                query: term, retryable: true,
            }, cause);
        }
        return servers.flatMap(registryEntries).map((found): FunctionalityCandidate => ({
            alias: found.alias,
            summary: found.summary,
            definition: readDefinition({ name: found.alias, ...structuredClone(found.entry) }),
            provenance: { kind: "registry", source: url, reference: found.reference },
        }));
    }

    // {§mcp-server-definition} Live additions use the same schema as configured definitions.
    async #admit(input: unknown): Promise<FunctionalityDefinitionSource<McpServerDefinition>> {
        const params = objectOf(input) ?? {};
        let definition: McpServerDefinition;
        try {
            definition = readDefinition(params.definition);
        } catch (cause) {
            throw actionError("definition-invalid", 400, "The MCP server definition is invalid.", { retryable: false }, cause);
        }
        const alias = typeof params.alias === "string" ? params.alias : definition.name;
        if (alias !== definition.name) {
            throw actionError("alias-mismatch", 400, `Alias '${alias}' must equal the definition's name '${definition.name}'.`, { alias, name: definition.name, retryable: false });
        }
        return { alias, definition };
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("MCP module is closed.");
    }

    #handleOrThrow(): FunctionalityFamilyHandle {
        if (this.#handle === undefined) throw new Error("MCP module is not set up.");
        return this.#handle;
    }

    #pendingKey(workspaceId: number, name: string): string {
        return `${workspaceId}:${name}`;
    }

    #retain(workspaceId: number): () => void {
        const retain = this.#retainWorkspace.get(workspaceId);
        if (retain === undefined) {
            throw new Error(`MCP workspace ${workspaceId} has no Functionality residency context.`);
        }
        return retain();
    }

    async #closeOwned(connections: readonly ServerConnection[]): Promise<void> {
        const owned = [...new Set(connections)];
        const results = await Promise.allSettled(
            owned.map((connection) => connection.close()),
        );
        const errors: unknown[] = [];
        for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled") {
                this.#connections.delete(owned[index]);
                continue;
            }
            errors.push(...errorsOf(result.reason));
        }
        if (errors.length > 0) throw new AggregateError(errors, "MCP connection shutdown failed");
    }

    // The attachment keeps the exact symbolic definition; resolved launch values never enter state.
    async #prepareAttachment(
        workspaceId: number,
        binding: McpBinding,
        connection?: ServerConnection,
        oauthRedirectUrl?: string,
        signal?: AbortSignal,
    ): Promise<Attachment> {
        const { definition, context } = binding;
        signal?.throwIfAborted();
        this.#assertOpen();
        // {§mcp-server-settings} — the operator's settings for this alias; a bad one isolates this server.
        let settings: ToolPolicy;
        try {
            settings = serverSettings(definition.name, this.#env);
        } catch (cause) {
            throw actionError("server-settings-invalid", 422, `MCP server '${definition.name}' has invalid operator settings: ${cause instanceof Error ? cause.message : String(cause)}`, {
                server: definition.name, retryable: false,
            }, cause);
        }
        let candidate = connection;
        const started = performance.now();
        try {
            const environment = await this.#workspaceEnvironment(workspaceId);
            signal?.throwIfAborted();
            this.#assertOpen();
            // {§mcp-launch-environment} — a configured server inherits the operator's environment beneath the
            // workspace layer, as every MCP client launches one; the model's command ceiling is not its base.
            const cwd = candidate === undefined && definition.type === "stdio" && definition.cwd === undefined && context === undefined
                ? await this.#stateDirectory(workspaceId, `${OWNER}/${definition.name}`) : undefined;
            signal?.throwIfAborted();
            this.#assertOpen();
            const grant = oauthRedirectUrl === undefined ? this.#grantFor(workspaceId, binding) : undefined;
            candidate ??= new ServerConnection(definition, environment(this.#env), {
                ...(oauthRedirectUrl === undefined ? {} : { oauthRedirectUrl }),
                ...(grant === undefined ? {} : { oauthGrant: grant }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(context === undefined ? {} : { plugin: context }),
                environment: environment(this.#operatorEnvironment()),
                onCatalogChanged: (error) => {
                    if (error !== null) {
                        console.error(`MCP server '${definition.name}' catalog refresh failed:`, error);
                        return;
                    }
                    if (this.#closed) return;
                    this.#dirty.set(this.#pendingKey(workspaceId, definition.name), Symbol());
                    this.#scheduleCatalogRefresh(workspaceId, definition.name);
                },
                onInfrastructureError: (error) => {
                    console.error(`MCP server '${definition.name}' infrastructure failure:`, error);
                },
                onAuthorizationRequired: () => {
                    const key = this.#pendingKey(workspaceId, definition.name);
                    if (this.#closed || this.#challenged.has(key)) return;
                    this.#challenged.add(key);
                    this.#dirty.set(key, Symbol());
                    this.#scheduleCatalogRefresh(workspaceId, definition.name);
                },
            });
            this.#connections.add(candidate);
            const executor = new McpExecutor(
                { runtime: definition.name, glyph: "🔌" },
                candidate,
                () => this.#retain(workspaceId),
                { tools: settings.tools },
            );
            const availability = await executor.requireAvailable(signal);
            signal?.throwIfAborted();
            return {
                ...(context === undefined ? {} : { context }),
                kind: "active",
                definition,
                connection: candidate,
                executor,
                runtime: {
                    namespaceOwner: OWNER,
                    decl: runtimeDecl(
                        definition.name,
                        runtimeServerSummary(definition.name, executor.catalog),
                        expandedServerNames(this.#env).includes(definition.name),
                        executor.catalog.instructions,
                    ),
                    executor,
                    availability,
                    scheme: new McpResources(definition.name, candidate, executor.catalog),
                },
            };
        } catch (cause) {
            const elapsedMs = Math.round(performance.now() - started);
            if (!signal?.aborted && cause instanceof AuthorizationRequiredError && candidate !== undefined) {
                return {
                    ...(context === undefined ? {} : { context }),
                    kind: "authorization-required",
                    definition,
                    connection: candidate,
                    authorizationUrl: cause.authorizationUrl,
                };
            }
            let closeCause: unknown;
            if (connection === undefined && candidate !== undefined) {
                try {
                    await this.#closeOwned([candidate]);
                } catch (error) {
                    closeCause = error;
                }
            }
            if (signal?.aborted) {
                if (closeCause !== undefined) throw new AggregateError([signal.reason, closeCause], "MCP preparation cancellation and cleanup failed.");
                throw signal.reason;
            }
            throw preparationError(definition, definition.type === "streamable-http" ? definition.authorization : undefined, cause, closeCause, {
                elapsedMs,
                timeoutMs: connectTimeoutMs(this.#env),
                ...(isClientCredentialsRejection(cause) ? {} : candidate?.preparationDiagnostic(cause)),
            });
        }
    }

    // {§functionality-adapter} two-phase preparation: reuse unchanged live
    // attachments, prepare the rest, and hand the coordinator runtimes and
    // outcomes; commit adopts the set and closes what it no longer uses, abort
    // closes only what this attempt opened.
    async #prepare(preparation: FunctionalityPreparation<McpServerDefinition, Snapshot>): Promise<FunctionalityPrepared<RuntimeRegistration, Snapshot>> {
        preparation.signal.throwIfAborted();
        this.#assertOpen();
        const { workspaceId, enabled, failure, force, signal } = preparation;
        this.#identities.set(workspaceId, { workspaceId });
        this.#retainWorkspace.set(workspaceId, preparation.retain);
        const previous = preparation.previous ?? new Map<string, Attachment>();
        for (const [name, attachment] of previous) {
            const next = enabled.get(name);
            const nextDefinition = next === undefined ? undefined : bindingOf(next);
            if (nextDefinition === undefined || force === name || !sameBinding(attachment, nextDefinition)) {
                const activeRequests = attachmentConnection(attachment)?.activeRequests ?? 0;
                if (activeRequests > 0) throw actionError(
                    "server-busy", 409,
                    `MCP server '${name}' has ${activeRequests} active request(s).`,
                    { server: name, activeRequests, retryable: true },
                );
            }
        }
        const next = new Map<string, Attachment>();
        const outcomes = new Map<string, FunctionalityOutcome>();
        const fresh: ConnectedAttachment[] = [];
        const consumedPending = new Map<string, PendingAuthorization>();
        const refreshed = new Map<string, symbol | undefined>();
        // {§mcp-request-unauthorized} The aliases this preparation connects afresh or signs in, which answer any refusal.
        const answered = new Set<string>();
        try {
            // {§mcp-setup} — every server that needs a connection or a catalog is prepared at once, so a
            // workspace waits for its slowest server, not for the sum of them.
            const plans = [...enabled].map(([name, value]) => {
                const key = this.#pendingKey(workspaceId, name);
                const binding = bindingOf(value);
                const existing = previous.get(name);
                const pending = this.#pending.get(key);
                const heldConnection = existing === undefined ? undefined : attachmentConnection(existing);
                const settledBinding = existing !== undefined && force !== name && sameBinding(existing, binding)
                    && pending?.prepared === undefined && pending?.authorized !== true;
                // {§mcp-request-unauthorized} A server that refused a call for want of a sign-in awaits one on the connection
                // it holds, whatever its catalog still lists.
                const mode = settledBinding && this.#challenged.has(key) && existing?.kind === "active" && heldConnection !== undefined ? "challenged"
                    : settledBinding && !this.#dirty.has(key) ? "reuse"
                        : pending?.prepared !== undefined && sameBinding(pending, binding) ? "pending"
                            : settledBinding && heldConnection !== undefined ? "catalog"
                                : "connect";
                if (mode === "pending" || mode === "connect") answered.add(key);
                const authorized = mode === "connect" && pending?.authorized === true && sameBinding(pending, binding);
                return { name, key, invalidation: this.#dirty.get(key), binding, existing, pending, heldConnection, mode, authorized };
            });
            const preparing = new Set(plans.filter(({ mode }) => mode === "catalog" || mode === "connect").map(({ name }) => name));
            const reportPreparing = (): void => preparation.progress(plans.map(({ name }) => name).filter((name) => preparing.has(name)));
            if (preparing.size > 0) reportPreparing();
            const settled = await Promise.allSettled(plans.map(async (plan): Promise<Attachment> => {
                signal.throwIfAborted();
                if (plan.mode === "reuse") return plan.existing!;
                if (plan.mode === "pending") return plan.pending!.prepared!;
                if (plan.mode === "challenged") {
                    return { ...plan.binding, kind: "authorization-required", connection: plan.heldConnection!, authorizationUrl: undefined };
                }
                try {
                    if (plan.mode === "catalog") {
                        // {§mcp-catalog-refresh-in-place} — only the catalog is dirty: the executor is
                        // rebuilt on the connection the alias already holds. No second process is
                        // spawned, so neither abort nor commit has anything of this alias to close
                        // (#429).
                        try {
                            return await this.#prepareAttachment(workspaceId, plan.binding, plan.heldConnection, undefined, signal);
                        } catch (cause) {
                            if (signal.aborted) throw cause;
                            this.#assertOpen();
                            console.error(`MCP server '${plan.name}' catalog refresh failed; the current catalog stays in service:`, cause);
                            return plan.existing!;
                        }
                    }
                    try {
                        return await this.#prepareAttachment(workspaceId, plan.binding, plan.authorized ? plan.pending!.connection : undefined, undefined, signal);
                    } catch (cause) {
                        if (signal.aborted) throw cause;
                        this.#assertOpen();
                        if (failure === "reject") throw cause;
                        const refusal = cause instanceof ModuleActionError ? cause : preparationError(plan.binding.definition, undefined, cause);
                        console.error(`MCP server '${plan.name}' unavailable: ${refusal.problem.detail}`, refusal.cause ?? refusal);
                        return { ...plan.binding, kind: "unavailable", problem: structuredClone(refusal.problem) };
                    }
                } finally {
                    preparing.delete(plan.name);
                    if (preparing.size > 0 && !signal.aborted) reportPreparing();
                }
            }));
            // Preserve each failure after joining all aliases; one cancellation must not hide another's cleanup failure.
            const rejections = new Set<unknown>();
            for (const [index, plan] of plans.entries()) {
                const result = settled[index];
                if (result.status === "rejected") {
                    rejections.add(result.reason);
                    continue;
                }
                const attachment = result.value;
                if (plan.mode === "pending") consumedPending.set(plan.name, plan.pending!);
                if (plan.mode === "connect") {
                    // Only a connection this attempt opened is the attempt's to close on abort.
                    if (plan.authorized) consumedPending.set(plan.name, plan.pending!);
                    else if (attachment.kind !== "unavailable") fresh.push(attachment);
                }
                next.set(plan.name, attachment);
                if (attachment !== plan.existing) refreshed.set(plan.key, plan.invalidation);
            }
            if (rejections.size === 1) throw rejections.values().next().value;
            if (rejections.size > 1) throw new AggregateError(rejections, "MCP workspace preparation failed.");
        } catch (cause) {
            const cleanup = [...await Promise.allSettled(fresh.map(({ connection }) => this.#closeOwned([connection])))];
            const failures = cleanup.flatMap((result) => result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) throw new AggregateError([cause, ...failures], "MCP workspace preparation and cleanup failed.");
            throw cause;
        }
        for (const [name, attachment] of next) {
            switch (attachment.kind) {
                case "active": outcomes.set(name, { state: "active", detail: activeDetail(attachment) }); break;
                case "unavailable": outcomes.set(name, { state: "unavailable", problem: attachment.problem }); break;
                case "authorization-required": outcomes.set(name, {
                    state: "authorization-required",
                    authorization: attachment.authorizationUrl === undefined ? {} : { url: attachment.authorizationUrl },
                }); break;
            }
        }
        const runtimes = [...next.values()].map((attachment) => attachment.kind === "active" ? attachment.runtime : unavailableRuntime(attachment));
        const published: {
            removed: Array<{ key: string; pending: PendingAuthorization; registered: boolean }>;
            added: Array<{ key: string; pending: PendingAuthorization }>;
        } = { removed: [], added: [] };
        return {
            runtimes,
            documents: [],
            outcomes,
            snapshot: next,
            // {§functionality-publication} The connected set and the pending register go live together,
            // synchronously; the undo restores both if the registry rolls back.
            publish: () => {
                const before = this.#attachments.get(workspaceId);
                this.#attachments.set(workspaceId, next);
                for (const [name, pending] of consumedPending) {
                    const key = this.#pendingKey(workspaceId, name);
                    const registered = this.#pending.get(key) === pending;
                    if (registered) this.#pending.delete(key);
                    published.removed.push({ key, pending, registered });
                }
                // {§oauth-lifetime} A client's challenge is independent of the published connection.
                for (const [key, pending] of this.#pending) {
                    if (!key.startsWith(`${workspaceId}:`)) continue;
                    const name = key.slice(`${workspaceId}:`.length);
                    const current = next.get(name);
                    if (current !== undefined && current.kind !== "active" && sameBinding(current, pending)
                        && force !== name) continue;
                    this.#pending.delete(key);
                    published.removed.push({ key, pending, registered: true });
                }
                for (const [name, attachment] of next) {
                    if (attachment.kind !== "authorization-required" || attachment.authorizationUrl === undefined) continue;
                    const key = this.#pendingKey(workspaceId, name);
                    if (this.#pending.has(key)) continue;
                    const pending: PendingAuthorization = {
                        definition: attachment.definition,
                        ...(attachment.context === undefined ? {} : { context: attachment.context }),
                        connection: attachment.connection,
                        releaseWorkspace: this.#retain(workspaceId),
                    };
                    this.#pending.set(key, pending);
                    published.added.push({ key, pending });
                }
                return () => {
                    for (const { key, pending } of published.added) {
                        if (this.#pending.get(key) === pending) this.#pending.delete(key);
                        pending.releaseWorkspace();
                    }
                    for (const { key, pending, registered } of published.removed) if (registered) this.#pending.set(key, pending);
                    published.added = [];
                    published.removed = [];
                    if (before === undefined) this.#attachments.delete(workspaceId);
                    else this.#attachments.set(workspaceId, before);
                };
            },
            commit: async () => {
                // {§mcp-catalog-refresh-in-place} A published snapshot acknowledges only
                // its captured invalidation, never a newer notification or an aborted candidate.
                for (const [key, invalidation] of refreshed) {
                    if (this.#dirty.get(key) === invalidation) this.#clearCatalogRefresh(key);
                }
                for (const key of this.#dirty.keys()) {
                    if (key.startsWith(`${workspaceId}:`) && !next.has(key.slice(`${workspaceId}:`.length))) {
                        this.#clearCatalogRefresh(key);
                    }
                }
                // {§mcp-request-unauthorized} A fresh connection or an accepted sign-in answers a refusal; withdrawal forgets it.
                for (const key of [...this.#challenged]) {
                    if (key.startsWith(`${workspaceId}:`) && (answered.has(key) || !next.has(key.slice(`${workspaceId}:`.length)))) {
                        this.#challenged.delete(key);
                    }
                }
                const retained = new Set([...next.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []));
                const pendingConnections = new Set([...this.#pending.values()].map(({ connection }) => connection));
                const obsolete = [...previous.values()]
                    .flatMap((attachment) => attachmentConnection(attachment) ?? [])
                    .filter((connection) => !retained.has(connection) && !pendingConnections.has(connection));
                for (const { pending } of published.removed) {
                    pending.releaseWorkspace();
                    if (!retained.has(pending.connection)) obsolete.push(pending.connection);
                }
                published.removed = [];
                if (obsolete.length > 0) {
                    try {
                        await this.#closeOwned(obsolete);
                    } catch (cause) {
                        throw actionError(
                            "obsolete-connection-close-failed",
                            500,
                            "The MCP capability change committed, but an obsolete connection did not close cleanly.",
                            { workspaceId, committed: true, retryable: false },
                            cause,
                        );
                    }
                }
            },
            abort: async () => {
                await this.#closeOwned(fresh.map(({ connection }) => connection));
            },
        };
    }

    async #teardown(snapshot: Snapshot, identity: WorkspaceCapabilityIdentity): Promise<void> {
        const { workspaceId } = identity;
        const pending = [...this.#pending.keys()].filter((key) => key.startsWith(`${workspaceId}:`));
        if (pending.length > 0) {
            throw new Error(`MCP workspace ${workspaceId} cannot cool with pending OAuth residency.`);
        }
        for (const key of this.#dirty.keys()) {
            if (key.startsWith(`${workspaceId}:`)) this.#clearCatalogRefresh(key);
        }
        for (const key of [...this.#challenged]) if (key.startsWith(`${workspaceId}:`)) this.#challenged.delete(key);
        const connections = [...snapshot.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []);
        this.#attachments.delete(workspaceId);
        this.#retainWorkspace.delete(workspaceId);
        this.#identities.delete(workspaceId);
        await this.#closeOwned(connections);
    }

    // {§oauth-continuation} Client callback state travels with the prepared connection, not its definition.
    async #beginOAuth(identity: WorkspaceCapabilityIdentity, params: Readonly<Record<string, unknown>>): Promise<McpOAuthBeginResult> {
        assertActionKeys(params, ["alias", "redirectUrl"]);
        const alias = requiredString(params, "alias");
        const redirectUrl = requiredString(params, "redirectUrl");
        const redirect = URL.parse(redirectUrl);
        if (redirect === null || redirect.username || redirect.password || redirect.hash || redirect.port === "0"
            || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname)))) {
            throw actionError("oauth-redirect-invalid", 400, "The OAuth callback must use HTTPS or HTTP loopback with a usable port.", { retryable: false });
        }
        const current = this.#attachments.get(identity.workspaceId)?.get(alias);
        if (current === undefined) throw actionError("server-not-connected", 409, `MCP server '${alias}' is not connected for this workspace.`, { retryable: false });
        if (current.kind === "active") return { status: 200, alias };
        const definition = current.definition;
        if (definition.type !== "streamable-http"
            || (definition.authorization !== undefined && definition.authorization.type !== "oauth")
            || Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
            || (definition.authorization?.redirectUrl !== undefined && definition.authorization.redirectUrl !== redirectUrl)) {
            throw actionError("oauth-configuration-conflict", 409,
                `MCP server '${alias}' is not configured for this interactive OAuth callback.`, { retryable: false });
        }
        const key = this.#pendingKey(identity.workspaceId, alias);
        if (this.#pending.get(key)?.authorized === true) return { status: 202, alias };
        if (this.#authorizing.has(key)) throw actionError("oauth-busy", 409, `MCP server '${alias}' is already starting authorization.`, { retryable: true });
        this.#authorizing.add(key);
        try {
            const connected = await this.#prepareAttachment(identity.workspaceId, current, undefined, redirectUrl);
            if (connected.kind === "unavailable") throw new Error("OAuth preparation returned an unavailable attachment.");
            // {§oauth-begin-unchallenged} An alias awaiting a sign-in for a refused request starts one on a connection its
            // server never challenges; one whose connection was challenged and is no longer is accepted as it is.
            const prepared = connected.kind === "active" && this.#challenged.has(key) ? await this.#beginUnchallenged(connected) : connected;
            if (this.#attachments.get(identity.workspaceId)?.get(alias) !== current) {
                await this.#closeOwned([prepared.connection]);
                throw actionError("oauth-target-conflict", 409, `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                    { workspaceId: identity.workspaceId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false });
            }
            const previous = this.#pending.get(key);
            const pending: PendingAuthorization = {
                ...prepared,
                releaseWorkspace: this.#retain(identity.workspaceId),
                ...(prepared.kind === "active" ? { prepared, authorized: true } : {}),
            };
            this.#pending.set(key, pending);
            if (previous !== undefined) {
                previous.releaseWorkspace();
                if (previous.connection !== attachmentConnection(current)) await this.#closeOwned([previous.connection]);
            }
            if (prepared.kind === "authorization-required") {
                if (prepared.authorizationUrl === undefined) throw new Error("OAuth preparation with a callback omitted its authorization URL.");
                return { status: 202, alias, authorization: { url: prepared.authorizationUrl } };
            }
            this.#dirty.set(key, Symbol());
            this.#refreshCatalog(identity.workspaceId, alias);
            return { status: 202, alias };
        } finally { this.#authorizing.delete(key); }
    }

    // {§oauth-begin-unchallenged} The SDK's authorization starts on the connection; one it finds authorized stays active.
    async #beginUnchallenged(connected: ActiveAttachment): Promise<ConnectedAttachment> {
        let authorizationUrl: string | undefined;
        try {
            authorizationUrl = await connected.connection.beginAuthorization();
        } catch (cause) {
            let closeCause: unknown;
            try {
                await this.#closeOwned([connected.connection]);
            } catch (error) {
                closeCause = error;
            }
            const { definition } = connected;
            throw preparationError(definition, definition.type === "streamable-http" ? definition.authorization : undefined, cause, closeCause);
        }
        if (authorizationUrl === undefined) return connected;
        return {
            definition: connected.definition,
            ...(connected.context === undefined ? {} : { context: connected.context }),
            kind: "authorization-required",
            connection: connected.connection,
            authorizationUrl,
        };
    }

    // {§oauth-continuation} — grant acceptance precedes ordinary catalog publication.
    async #completeOAuth(identity: WorkspaceCapabilityIdentity, params: Readonly<Record<string, unknown>>): Promise<McpOAuthCompletionResult> {
        assertActionKeys(params, ["alias", "callbackUrl"]);
        const alias = requiredString(params, "alias");
        const callbackUrl = requiredString(params, "callbackUrl");
        const key = this.#pendingKey(identity.workspaceId, alias);
        const pending = this.#pending.get(key);
        if (pending === undefined) {
            // {§oauth-lifetime} — restart during pending authorization surfaces
            // as a factual not-pending state, never a secret replay.
            throw actionError(
                "oauth-not-pending",
                404,
                `MCP server '${alias}' has no pending OAuth authorization.`,
                { workspaceId: identity.workspaceId, alias, retryable: false },
            );
        }
        const current = this.#attachments.get(identity.workspaceId)?.get(alias);
        if (current === undefined || !sameBinding(current, pending)) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { workspaceId: identity.workspaceId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
            );
        }
        if (pending.completion !== undefined) {
            if (pending.completion.callbackUrl !== callbackUrl) throw actionError(
                "oauth-callback-invalid", 400,
                `OAuth authorization for MCP server '${alias}' could not be completed.`,
                { workspaceId: identity.workspaceId, alias, retryable: false },
            );
            return pending.completion.result;
        }
        const result = (async (): Promise<McpOAuthCompletionResult> => {
            try {
                await pending.connection.finishAuthorization(callbackUrl);
            } catch (cause) {
                delete pending.completion;
                throw actionError(
                    "oauth-callback-invalid",
                    400,
                    `OAuth authorization for MCP server '${alias}' could not be completed.`,
                    { workspaceId: identity.workspaceId, alias, retryable: false },
                    cause,
                );
            }
            if (this.#pending.get(key) !== pending || this.#closed) throw actionError(
                "oauth-target-conflict", 409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { workspaceId: identity.workspaceId, alias, retryable: false },
            );
            pending.authorized = true;
            // {§oauth-grant} The accepted sign-in is the alias's grant, replacing any before it.
            const grant = pending.connection.oauthGrant;
            if (grant !== undefined) {
                this.#grants.set(key, { definition: pending.definition, ...(pending.context === undefined ? {} : { context: pending.context }), grant });
            }
            this.#dirty.set(key, Symbol());
            this.#refreshCatalog(identity.workspaceId, alias);
            return { status: 202, alias };
        })();
        pending.completion = { callbackUrl, result };
        return result;
    }

    async #complete(workspaceId: number, params: Readonly<Record<string, unknown>>): Promise<unknown> {
        assertActionKeys(params, ["server", "ref", "argument", "context"]);
        const server = requiredString(params, "server");
        const attachment = this.#attachments.get(workspaceId)?.get(server);
        if (attachment === undefined || attachment.kind !== "active") {
            throw actionError(
                "server-not-connected",
                409,
                `MCP server '${server}' is not connected for this workspace.`,
                { workspaceId, name: server, retryable: false },
            );
        }
        // The protocol's own schema proves the completion's parameters; a context that is not an object is not sent.
        const completion = CompleteRequestParamsSchema.safeParse({
            ref: params.ref,
            argument: params.argument,
            ...(objectOf(params.context) === null ? {} : { context: params.context }),
        });
        if (!completion.success) {
            const issues = completion.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
            throw actionError("completion-parameters-invalid", 400, `MCP completion parameters do not match the protocol: ${issues}.`, { retryable: false });
        }
        try {
            return await attachment.connection.complete(completion.data);
        } catch (cause) {
            if (cause instanceof AuthorizationRequiredError) {
                // {§mcp-request-unauthorized}
                throw actionError("authorization-required", 401, awaitsSignIn(server), { workspaceId, name: server, retryable: false }, cause);
            }
            throw cause;
        }
    }

    // {§oauth-grant} The alias's grant, for a connection with the definition it was accepted for, while it holds tokens.
    #grantFor(workspaceId: number, binding: McpBinding): OAuthGrant | undefined {
        const held = this.#grants.get(this.#pendingKey(workspaceId, binding.definition.name));
        return held !== undefined && held.grant.signedIn && sameBinding(held, binding) ? held.grant : undefined;
    }

    // A live catalog change republishes the unchanged state; the dirty alias
    // rebuilds its executor on the next preparation.
    #scheduleCatalogRefresh(workspaceId: number, name: string, attempt = 0): void {
        if (this.#closed) return;
        const key = this.#pendingKey(workspaceId, name);
        if (!this.#dirty.has(key) || this.#refreshTimers.has(key)) return;
        const delay = retryDelayMs(retryPacing(this.#env), attempt);
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(key);
            this.#refreshCatalog(workspaceId, name, attempt);
        }, delay);
        timer.unref();
        this.#refreshTimers.set(key, timer);
    }

    #refreshCatalog(workspaceId: number, name: string, attempt = 0): void {
        const key = this.#pendingKey(workspaceId, name);
        const identity = this.#identities.get(workspaceId);
        if (identity === undefined || this.#closed) {
            this.#dirty.delete(key);
            return;
        }
        void this.#handleOrThrow().refresh(identity).then(() => {
            if (this.#dirty.has(key)) this.#scheduleCatalogRefresh(workspaceId, name, attempt + 1);
        }).catch((error: unknown) => {
            if (statusOf(error) === 409) {
                this.#scheduleCatalogRefresh(workspaceId, name, attempt + 1);
                return;
            }
            console.error(`MCP server '${name}' capability refresh failed:`, error);
        });
    }

    #clearCatalogRefresh(key: string): void {
        this.#dirty.delete(key);
        clearTimeout(this.#refreshTimers.get(key));
        this.#refreshTimers.delete(key);
    }

    stop(): Promise<void> {
        this.#stopping ??= this.#stop();
        return this.#stopping;
    }

    async #stop(): Promise<void> {
        this.#closed = true;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#dirty.clear();
        this.#challenged.clear();
        this.#grants.clear();
        const closing = this.#closeOwned([...this.#connections]);
        this.#attachments.clear();
        for (const pending of this.#pending.values()) pending.releaseWorkspace();
        this.#pending.clear();
        this.#retainWorkspace.clear();
        this.#identities.clear();
        await closing;
    }
}
