// {§mcp-module} — the MCP family beneath the shared workspace Functionality
// coordinator ({§functionality-adapter}). This module owns MCP protocol truth:
// complete connection definitions, preparation with OAuth
// continuation, tool/resource publication, catalog refresh, and teardown. The coordinator owns the lifecycle, durable workspace state, atomic
// publication, and both the client and model projections.
import { fileURLToPath } from "node:url";
import { readDefinition } from "./definition.ts";
import { isDeepStrictEqual } from "node:util";
import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import type { PluginContext } from "./PluginConfiguration.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import type { DaemonModule, FunctionalitySeam, ModuleActionContext, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import {
    Problems,
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
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";

import ServerConnection, {
    AuthorizationRequiredError,
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
    type RegistrySettings,
    type ToolPolicy,
} from "./config.ts";
import { RegistryError, registryEntries, searchRegistry, type RegistryServer } from "./registry.ts";
import McpExecutor, { runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import { OAuthSetupError } from "./oauth.ts";

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

const attachmentConnection = (attachment: Attachment): ServerConnection | undefined =>
    attachment.kind === "unavailable" ? undefined : attachment.connection;

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

// The first error of a type anywhere in a cause chain, aggregates included.
const causeOf = <T>(error: unknown, type: abstract new (...args: never[]) => T, seen = new Set<unknown>()): T | undefined => {
    if (error === null || typeof error !== "object" || seen.has(error)) return undefined;
    seen.add(error);
    if (error instanceof type) return error;
    for (const inner of error instanceof AggregateError ? error.errors : []) {
        const found = causeOf(inner, type, seen);
        if (found !== undefined) return found;
    }
    return causeOf((error as { cause?: unknown }).cause, type, seen);
};

const preparationError = (
    definition: McpServerDefinition,
    authorization: McpAuthorization | undefined,
    cause: unknown,
    closeCause?: unknown,
): ModuleActionError => {
    const completeCause = closeCause === undefined
        ? cause
        : new AggregateError(
            [cause, closeCause],
            `MCP server '${definition.name}' preparation and cleanup failed.`,
        );
    const setup = causeOf(cause, OAuthSetupError);
    if (setup !== undefined) return actionError(setup.code, 502, setup.message,
        { server: definition.name, retryable: false }, completeCause);
    // {§oauth-client-credentials} — a rejected grant is an authorization fact,
    // never a generic unavailability.
    if (authorization?.type === "client-credentials" && isClientCredentialsRejection(cause)) {
        return actionError(
            "oauth-client-credentials-failed",
            502,
            `MCP server '${definition.name}' rejected the client-credentials grant; check the configured client credentials and issuer.`,
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

const objectOf = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

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

const statusOf = (error: unknown): number | null => {
    if (typeof error !== "object" || error === null) return null;
    const problem = (error as { problem?: { status?: unknown } }).problem
        ?? (error as { result?: { problem?: { status?: unknown } } }).result?.problem;
    return typeof problem?.status === "number" ? problem.status : null;
};

const catalogDetail = (executor: McpExecutor): object => {
    const catalog = executor.catalog;
    return {
        protocolVersion: catalog.protocolVersion,
        server: catalog.server ?? null,
        capabilities: catalog.capabilities,
        tools: catalog.tools.map(({ name }) => name).toSorted(),
        resources: catalog.resources.length,
        resourceTemplates: catalog.resourceTemplates.length,
        prompts: catalog.prompts.length,
    };
};

// {§module-seam-slices} — the slices this module uses.
type SetupSeam = Pick<ModuleSetupSeam,
    "workspacePaths" | "operatorEnvironment" | "readWorkspaceEnvironment" | "workspaceStateDirectory" | "registerModuleAction">
    & FunctionalitySeam<RuntimeRegistration> & WorkspacePluginsSeam;

export default class Module implements DaemonModule<SetupSeam> {
    readonly #env: NodeJS.ProcessEnv;
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
    }

    async setup(seam: SetupSeam): Promise<void> {
        this.#plugins = (workspaceId) => seam.readWorkspacePlugins(workspaceId);
        this.#workspaceEnvironment = (workspaceId) => seam.readWorkspaceEnvironment(workspaceId);
        this.#operatorEnvironment = () => seam.operatorEnvironment();
        this.#stateDirectory = (workspaceId, owner) => seam.workspaceStateDirectory(workspaceId, owner);
        this.#paths = (workspaceId) => seam.workspacePaths(workspaceId);
        this.#handle = seam.registerFunctionalityAdapter({
            family: FAMILY,
            namespaceOwner: OWNER,
            summary: "Manage MCP servers",
            definitionSchema: MCP_DEFINITION,
            example: { alias: "example-server", definition: { name: "example-server", type: "stdio", command: "npx", args: ["-y", "example-mcp-server@1.0.0"] } },
            docsDir: fileURLToPath(new URL("..", import.meta.url)),
            discovery: {
                details: "`query` searches the MCP Registry by server name; each candidate carries the exact definition to add.",
            },
            available: (identity) => this.#available(identity),
            configurationNotices: ({ workspaceId }) => this.#configurationNotices.get(workspaceId) ?? [],
            discover: (query) => this.#discover(query),
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
    async #discover(query: FunctionalityDiscoverQuery): Promise<FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            throw actionError("configuration-unsupported", 400, "MCP discovery searches the MCP Registry by query; client configuration contributes nothing.", { retryable: false });
        }
        if (query.source !== undefined) {
            throw actionError("source-unsupported", 400, "MCP discovery searches the MCP Registry by query; it does not install from a source URL.", {
                source: query.source, retryable: false,
            });
        }
        if (query.query === undefined) return [];
        const { url, limit }: RegistrySettings = registrySettings(this.#env);
        if (url === null) {
            throw actionError("registry-not-configured", 501, "MCP registry search is off: the operator names no registry.", { query: query.query, retryable: false });
        }
        let servers: RegistryServer[];
        try {
            servers = await searchRegistry({ url, query: query.query, limit, timeoutMs: connectTimeoutMs(this.#env) });
        } catch (cause) {
            throw actionError("discover-failed", 502, cause instanceof RegistryError ? cause.message : `The MCP Registry search for '${query.query}' failed.`, {
                query: query.query, retryable: true,
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
    async #admit(input: unknown): Promise<FunctionalityDefinitionSource> {
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
    ): Promise<Attachment> {
        const { definition, context } = binding;
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
        try {
            const environment = await this.#workspaceEnvironment(workspaceId);
            this.#assertOpen();
            // {§mcp-launch-environment} — a configured server inherits the operator's environment beneath the
            // workspace layer, as every MCP client launches one; the model's command ceiling is not its base.
            candidate ??= new ServerConnection(definition, environment(this.#env), {
                ...(oauthRedirectUrl === undefined ? {} : { oauthRedirectUrl }),
                ...(definition.type === "stdio" && definition.cwd === undefined && context === undefined ? { cwd: await this.#stateDirectory(workspaceId, `${OWNER}/${definition.name}`) } : {}),
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
            });
            this.#connections.add(candidate);
            const executor = new McpExecutor(
                { runtime: definition.name, glyph: "🔌" },
                candidate,
                () => this.#retain(workspaceId),
                { tools: settings.tools },
            );
            const availability = await executor.requireAvailable();
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
            if (cause instanceof AuthorizationRequiredError && candidate !== undefined) {
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
            throw preparationError(definition, definition.type === "streamable-http" ? definition.authorization : undefined, cause, closeCause);
        }
    }

    // {§functionality-adapter} two-phase preparation: reuse unchanged live
    // attachments, prepare the rest, and hand the coordinator runtimes and
    // outcomes; commit adopts the set and closes what it no longer uses, abort
    // closes only what this attempt opened.
    async #prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared<RuntimeRegistration>> {
        this.#assertOpen();
        const { workspaceId, enabled, failure, force } = preparation;
        this.#identities.set(workspaceId, { workspaceId });
        this.#retainWorkspace.set(workspaceId, preparation.retain);
        const previous = (preparation.previous as ReadonlyMap<string, Attachment> | null) ?? new Map<string, Attachment>();
        for (const [name, attachment] of previous) {
            const nextDefinition = enabled.get(name) as McpBinding | undefined;
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
        try {
            for (const [name, value] of enabled) {
                preparation.progress(name);
                const key = this.#pendingKey(workspaceId, name);
                const invalidation = this.#dirty.get(key);
                const binding = value as McpBinding;
                const { definition } = binding;
                const existing = previous.get(name);
                const pending = this.#pending.get(this.#pendingKey(workspaceId, name));
                if (
                    existing !== undefined
                    && force !== name
                    && !this.#dirty.has(this.#pendingKey(workspaceId, name))
                    && sameBinding(existing, binding)
                    && pending?.prepared === undefined && pending?.authorized !== true
                ) {
                    next.set(name, existing);
                    continue;
                }
                let attachment: Attachment;
                const heldConnection = existing === undefined ? undefined : attachmentConnection(existing);
                const catalogOnly = existing !== undefined
                    && force !== name
                    && sameBinding(existing, binding)
                    && pending?.prepared === undefined && pending?.authorized !== true
                    && heldConnection !== undefined;
                if (pending?.prepared !== undefined && sameBinding(pending, binding)) {
                    attachment = pending.prepared;
                    consumedPending.set(name, pending);
                } else if (catalogOnly) {
                    // {§mcp-catalog-refresh-in-place} — only the catalog is dirty: the executor is
                    // rebuilt on the connection the alias already holds. No second process is
                    // spawned, so neither abort nor commit has anything of this alias to close
                    // (#429).
                    try {
                        attachment = await this.#prepareAttachment(workspaceId, binding, heldConnection);
                    } catch (cause) {
                        this.#assertOpen();
                        console.error(`MCP server '${name}' catalog refresh failed; the current catalog stays in service:`, cause);
                        attachment = existing;
                    }
                } else {
                    const authorized = pending?.authorized === true && sameBinding(pending, binding);
                    try {
                        attachment = await this.#prepareAttachment(workspaceId, binding, authorized ? pending.connection : undefined);
                    } catch (cause) {
                        this.#assertOpen();
                        if (failure === "reject") throw cause;
                        const refusal = cause instanceof ModuleActionError ? cause : preparationError(definition, undefined, cause);
                        attachment = { ...binding, kind: "unavailable", problem: structuredClone(refusal.problem) };
                        console.error(`MCP server '${name}' unavailable: ${refusal.problem.detail}`, refusal.cause ?? refusal);
                    }
                    // Only a connection this attempt opened is the attempt's to close on abort.
                    if (authorized) consumedPending.set(name, pending);
                    else if (attachment.kind !== "unavailable") fresh.push(attachment);
                }
                next.set(name, attachment);
                if (attachment !== existing) refreshed.set(key, invalidation);
            }
        } catch (cause) {
            const cleanup = [...await Promise.allSettled(fresh.map(({ connection }) => this.#closeOwned([connection])))];
            const failures = cleanup.flatMap((result) => result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) throw new AggregateError([cause, ...failures], "MCP workspace preparation and cleanup failed.");
            throw cause;
        }
        for (const [name, attachment] of next) {
            switch (attachment.kind) {
                case "active": outcomes.set(name, { state: "active", detail: catalogDetail(attachment.executor) }); break;
                case "unavailable": outcomes.set(name, { state: "unavailable", problem: attachment.problem }); break;
                case "authorization-required": outcomes.set(name, {
                    state: "authorization-required",
                    authorization: attachment.authorizationUrl === undefined ? {} : { url: attachment.authorizationUrl },
                }); break;
            }
        }
        const runtimes = [...next.values()].flatMap((attachment) => attachment.kind === "active" ? [attachment.runtime] : []);
        return {
            runtimes,
            documents: [],
            outcomes,
            snapshot: next,
            commit: async () => {
                this.#attachments.set(workspaceId, next);
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
                const retained = new Set([...next.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []));
                const pendingConnections = new Set([...this.#pending.values()].map(({ connection }) => connection));
                const obsolete = [...previous.values()]
                    .flatMap((attachment) => attachmentConnection(attachment) ?? [])
                    .filter((connection) => !retained.has(connection) && !pendingConnections.has(connection));
                for (const [name, pending] of consumedPending) {
                    const key = this.#pendingKey(workspaceId, name);
                    if (this.#pending.get(key) === pending) this.#pending.delete(key);
                    pending.releaseWorkspace();
                    if (!retained.has(pending.connection)) obsolete.push(pending.connection);
                }
                // {§oauth-lifetime} A client's challenge is independent of the published connection.
                for (const [key, pending] of this.#pending) {
                    if (!key.startsWith(`${workspaceId}:`)) continue;
                    const name = key.slice(`${workspaceId}:`.length);
                    const current = next.get(name);
                    if (current !== undefined && current.kind !== "active" && sameBinding(current, pending)
                        && force !== name) continue;
                    this.#pending.delete(key);
                    pending.releaseWorkspace();
                    if (!retained.has(pending.connection)) obsolete.push(pending.connection);
                }
                for (const [name, attachment] of next) {
                    if (attachment.kind !== "authorization-required" || attachment.authorizationUrl === undefined) continue;
                    const key = this.#pendingKey(workspaceId, name);
                    const current = this.#pending.get(key);
                    if (current !== undefined) continue;
                    this.#pending.set(key, {
                        definition: attachment.definition,
                        ...(attachment.context === undefined ? {} : { context: attachment.context }),
                        connection: attachment.connection,
                        releaseWorkspace: this.#retain(workspaceId),
                    });
                }
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

    async #teardown(snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void> {
        const { workspaceId } = identity;
        const pending = [...this.#pending.keys()].filter((key) => key.startsWith(`${workspaceId}:`));
        if (pending.length > 0) {
            throw new Error(`MCP workspace ${workspaceId} cannot cool with pending OAuth residency.`);
        }
        for (const key of this.#dirty.keys()) {
            if (key.startsWith(`${workspaceId}:`)) this.#clearCatalogRefresh(key);
        }
        const attachments = (snapshot as ReadonlyMap<string, Attachment> | null) ?? new Map<string, Attachment>();
        const connections = [...attachments.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []);
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
            const prepared = await this.#prepareAttachment(identity.workspaceId, current, undefined, redirectUrl);
            if (prepared.kind === "unavailable") throw new Error("OAuth preparation returned an unavailable attachment.");
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
        const ref = objectOf(params.ref);
        const argument = objectOf(params.argument);
        if (ref === null || argument === null) {
            throw actionError("completion-parameters-invalid", 400, "MCP completion requires 'ref' and 'argument' objects.", { retryable: false });
        }
        return attachment.connection.complete({
            ref: ref as never,
            argument: argument as never,
            ...(objectOf(params.context) === null ? {} : { context: params.context as never }),
        });
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
        const closing = this.#closeOwned([...this.#connections]);
        this.#attachments.clear();
        for (const pending of this.#pending.values()) pending.releaseWorkspace();
        this.#pending.clear();
        this.#retainWorkspace.clear();
        this.#identities.clear();
        await closing;
    }
}
