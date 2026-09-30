// {§mcp-module} — the MCP family beneath the shared workspace Functionality
// coordinator ({§functionality-adapter}). This module owns MCP protocol truth:
// definitions from installed Agent Plugins, connection preparation with OAuth
// continuation, tool/resource publication, catalog refresh, and teardown. The coordinator owns the lifecycle, durable workspace state, atomic
// publication, and both the client and model projections.
import { fileURLToPath } from "node:url";
import { MCP_SCHEMA, validateMcpConfiguration, type McpServerEntry } from "@plurnk/plurnk-agent-plugins";
import type {
    RuntimeAvailability,
    RuntimeDecl,
} from "@plurnk/plurnk-execs";
import type {
    FindStatement,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import {
    Problems,
    Validator,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type McpServerDefinition,
    type McpServerScope,
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
    assertNoRetiredVariables,
    connectTimeoutMs,
    expandedServerNames,
    isServerName,
    retryDelayMs,
    retryPacing,
    registrySettings,
    serverSettings,
    type McpAuthorization,
    type RegistrySettings,
    type ServerSettings,
} from "./config.ts";
import { RegistryError, registryEntries, searchRegistry, type RegistryServer } from "./registry.ts";
import McpExecutor, { runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";

const OWNER = "@plurnk/plurnk-mcp";
const FAMILY = "mcp";
const NONEMPTY_STRING = { type: "string", minLength: 1 } as const;
const OPEN_OBJECT = { type: "object", additionalProperties: true } as const;
const MCP_DEFINITION = { $ref: "https://schemas.plurnk.xyz/v0/McpServerDefinition.json" } as const;
const MUTATION_RESULT = { $ref: "https://schemas.plurnk.xyz/v0/FunctionalityMutationResult.json" } as const;
const actionInput = (
    properties: Readonly<Record<string, JsonSchema>>,
    required: readonly string[] = [],
): JsonSchema => ({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
});

// Structural copies of the core seam types: this package never imports core.
interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: McpExecutor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

type ModuleActionContext =
    | { readonly scope: "worldless" }
    | { readonly scope: "workspace"; readonly workspaceId: number }
    | { readonly scope: "worker"; readonly workspaceId: number; readonly workerId: number };

interface FunctionalityAdapter {
    readonly family: string;
    readonly namespaceOwner: string;
    readonly summary: string;
    readonly definitionSchema: JsonSchema;
    readonly docsDir?: string;
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: { readonly details: string };
    available(identity: WorkspaceCapabilityIdentity): Promise<readonly { alias: string; definition: object; enabled: boolean }[]>;
    discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource>;
    prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared<RuntimeRegistration>>;
    teardown(snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void>;
    forget(definition: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void>;
    refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void>;
}

type ServerPluginWrite =
    | { readonly kind: "written"; readonly root: string; readonly data: string; readonly created: boolean }
    | { readonly kind: "occupied"; readonly directory: string }
    | { readonly kind: "unrooted" };

interface ModuleSetupSeam {
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§mcp-launch-environment} The operator's environment without plurnk's own secrets.
    pluginEnvironment(): NodeJS.ProcessEnv;
    // {§agent-plugins-hosting} The workspace's installed Agent Plugins, in root precedence order.
    readWorkspacePlugins(workspaceId: number): Promise<{
        readonly plugins: ReadonlyArray<{
            readonly scope: string;
            readonly root: string;
            readonly data: string;
            readonly manifest: { readonly name: string };
            readonly mcpServers: ReadonlyMap<string, McpServerEntry> | null;
        }>;
        readonly signature: string;
        readonly roots: Readonly<Record<McpServerScope, string | null>>;
    }>;
    // {§mcp-plugin-servers} The one-server plugin an added server is, written at its scope's root.
    writeServerPlugin(workspaceId: number, request: { readonly scope: McpServerScope; readonly name: string; readonly entry: McpServerEntry }): Promise<ServerPluginWrite>;
    deleteServerPlugin(workspaceId: number, request: { readonly scope: McpServerScope; readonly name: string }): Promise<void>;
    registerModuleAction(registration: {
        readonly name: string;
        readonly scope: "worldless" | "workspace" | "worker";
        readonly residency: "required" | "none";
        readonly inputSchema: JsonSchema;
        readonly outputSchema: JsonSchema;
        readonly handler: (
            params: Readonly<Record<string, unknown>>,
            context: ModuleActionContext,
        ) => unknown | Promise<unknown>;
    }): void;
    registerFunctionalityAdapter(adapter: FunctionalityAdapter): FunctionalityFamilyHandle;
}

interface ActiveAttachment {
    readonly kind: "active";
    readonly definition: McpServerDefinition;
    readonly connection: ServerConnection;
    readonly executor: McpExecutor;
    readonly runtime: RuntimeRegistration;
}

interface AuthorizationAttachment {
    readonly kind: "authorization-required";
    readonly definition: McpServerDefinition;
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
}

interface UnavailableAttachment {
    readonly kind: "unavailable";
    readonly definition: McpServerDefinition;
    readonly problem: ProblemDetails;
}

type ConnectedAttachment = ActiveAttachment | AuthorizationAttachment;
type Attachment = ConnectedAttachment | UnavailableAttachment;

const attachmentConnection = (attachment: Attachment): ServerConnection | undefined =>
    attachment.kind === "unavailable" ? undefined : attachment.connection;

// {§oauth-lifetime} — a pending authorization is process memory per
// (workspace, alias): the challenged connection, its URL, the workspace residency it
// holds, and, once the callback lands, the prepared active attachment.
interface PendingAuthorization {
    readonly definition: McpServerDefinition;
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
    readonly releaseWorkspace: () => void;
    prepared?: ActiveAttachment;
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

const SCOPES: readonly McpServerScope[] = ["project", "plurnk", "global"];

// The standard mcp.json entry a definition carries, without plurnk's alias, scope, and provenance.
const entryOf = (definition: McpServerDefinition): McpServerEntry => definition.type === "stdio"
    ? {
        type: "stdio", command: definition.command,
        ...(definition.args === undefined ? {} : { args: [...definition.args] }),
        ...(definition.env === undefined ? {} : { env: { ...definition.env } }),
        ...(definition.cwd === undefined ? {} : { cwd: definition.cwd }),
    }
    : { type: "streamable-http", url: definition.url, ...(definition.headers === undefined ? {} : { headers: { ...definition.headers } }) };

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

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

const sameDefinition = (left: McpServerDefinition, right: McpServerDefinition): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

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

export default class Module {
    readonly #env: NodeJS.ProcessEnv;
    #workspaceEnvironment!: ModuleSetupSeam["readWorkspaceEnvironment"];
    #workspacePlugins!: ModuleSetupSeam["readWorkspacePlugins"];
    #writeServerPlugin!: ModuleSetupSeam["writeServerPlugin"];
    #deleteServerPlugin!: ModuleSetupSeam["deleteServerPlugin"];
    #pluginEnvironment!: ModuleSetupSeam["pluginEnvironment"];
    readonly #expanded: Set<string>;
    // {§mcp-plugin-servers} — the plugin signature each workspace's skipped entries were last reported for.
    readonly #reported = new Map<number, string>();
    // The committed attachments per workspace: the adapter's mirror of the snapshot
    // the coordinator holds, for continuations and refresh.
    readonly #attachments = new Map<number, ReadonlyMap<string, Attachment>>();
    readonly #identities = new Map<number, WorkspaceCapabilityIdentity>();
    readonly #pending = new Map<string, PendingAuthorization>();
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
        assertNoRetiredVariables(environ);
        this.#env = environ;
        this.#expanded = new Set(expandedServerNames(environ));
    }

    async setup(seam: ModuleSetupSeam): Promise<void> {
        this.#workspaceEnvironment = (workspaceId) => seam.readWorkspaceEnvironment(workspaceId);
        this.#workspacePlugins = (workspaceId) => seam.readWorkspacePlugins(workspaceId);
        this.#writeServerPlugin = (workspaceId, request) => seam.writeServerPlugin(workspaceId, request);
        this.#deleteServerPlugin = (workspaceId, request) => seam.deleteServerPlugin(workspaceId, request);
        this.#pluginEnvironment = () => seam.pluginEnvironment();
        this.#handle = seam.registerFunctionalityAdapter({
            family: FAMILY,
            namespaceOwner: OWNER,
            summary: "Manage MCP servers",
            definitionSchema: MCP_DEFINITION,
            example: { alias: "example-server", definition: { name: "example-server", scope: "project", type: "stdio", command: "npx", args: ["-y", "example-mcp-server@1.0.0"] } },
            docsDir: fileURLToPath(new URL("..", import.meta.url)),
            discovery: {
                details: "`query` searches the MCP Registry by server name; each candidate carries the exact definition to add.",
            },
            available: (identity) => this.#available(identity),
            discover: (query, identity) => this.#discover(query, identity),
            admit: (input, identity) => this.#admit(input, identity),
            prepare: (preparation) => this.#prepare(preparation),
            teardown: (snapshot, identity) => this.#teardown(snapshot, identity),
            forget: (source, identity) => this.#forget(source, identity),
            refreshIfChanged: (identity) => this.#refreshIfChanged(identity),
        });
        // Protocol continuations beneath the common grammar.
        seam.registerModuleAction({
            name: "workspace.mcp.oauth.complete",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, callbackUrl: NONEMPTY_STRING }, ["alias", "callbackUrl"]),
            outputSchema: MUTATION_RESULT,
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

    // {§mcp-plugin-servers} — every server an installed plugin declares, in root precedence, enabled:
    // installing a plugin is consent. An unsupported transport, a name plurnk cannot represent, and an
    // alias an earlier plugin already declares are skipped with a report.
    async #available(identity: WorkspaceCapabilityIdentity): Promise<Array<{ alias: string; definition: McpServerDefinition; enabled: boolean }>> {
        const { plugins, signature } = await this.#workspacePlugins(identity.workspaceId);
        const reported = this.#reported.get(identity.workspaceId) === signature;
        this.#reported.set(identity.workspaceId, signature);
        const definitions: Array<{ alias: string; definition: McpServerDefinition; enabled: boolean }> = [];
        const owners = new Map<string, string>();
        const skip = (plugin: string, server: string, reason: string): void => {
            if (!reported) console.error(`MCP server '${server}' of plugin '${plugin}' is skipped: ${reason}`);
        };
        for (const plugin of plugins) {
            for (const [name, entry] of plugin.mcpServers ?? []) {
                if (!isServerName(name)) {
                    skip(plugin.manifest.name, name, "plurnk names a server [a-z][a-z0-9-]*, the fence and scheme it becomes.");
                    continue;
                }
                const owner = owners.get(name);
                if (owner !== undefined) {
                    skip(plugin.manifest.name, name, `plugin '${owner}' declares it first.`);
                    continue;
                }
                const pluginIdentity = { name: plugin.manifest.name, root: plugin.root, data: plugin.data };
                const scope = plugin.scope as McpServerScope;
                let definition: McpServerDefinition;
                if (entry.type === "stdio") {
                    definition = {
                        name, scope, plugin: pluginIdentity, type: "stdio", command: entry.command,
                        ...(entry.args === undefined ? {} : { args: [...entry.args] }),
                        ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
                        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
                    };
                } else if (entry.type === "streamable-http") {
                    definition = { name, scope, plugin: pluginIdentity, type: "streamable-http", url: entry.url, ...(entry.headers === undefined ? {} : { headers: structuredClone(entry.headers) }) };
                } else {
                    skip(plugin.manifest.name, name, "the deprecated HTTP+SSE transport is not supported.");
                    continue;
                }
                owners.set(name, plugin.manifest.name);
                definitions.push({ alias: name, definition: Validator.assertMcpServerDefinition(definition), enabled: true });
            }
        }
        return definitions;
    }

    // {§functionality-hotload} — a server's definition is its whole plugin entry, so the coordinator's
    // comparison of what it would prepare with what it published is the change test.
    async #refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#handleOrThrow().refresh(identity, { gate: "none", ifChanged: true });
    }

    // {§mcp-registry-discovery} — candidates from the MCP Registry, each an exact definition to add at the
    // nearest plugin root the workspace has.
    async #discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityCandidate[]> {
        if (query.configuration !== undefined) {
            throw actionError("configuration-unsupported", 400, "MCP discovery searches the MCP Registry by query; client configuration contributes nothing.", { retryable: false });
        }
        if (query.source !== undefined) {
            throw actionError("source-unsupported", 400, "MCP discovery searches the MCP Registry by query; a server inside an Agent Plugin arrives with its plugin.", {
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
        const { roots } = await this.#workspacePlugins(identity.workspaceId);
        const scope = SCOPES.find((candidate) => roots[candidate] !== null) ?? "project";
        return servers.flatMap(registryEntries).map((found): FunctionalityCandidate => ({
            alias: found.alias,
            summary: found.summary,
            definition: Validator.assertMcpServerDefinition({ name: found.alias, scope, ...structuredClone(found.entry) } as McpServerDefinition),
            provenance: { kind: "registry", source: url, reference: found.reference },
        }));
    }

    // {§mcp-plugin-servers} — an added server becomes a standard one-server plugin: its entry must pass
    // the loader every Agent Plugins host uses, at a root the workspace has.
    async #admit(input: unknown, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource> {
        const params = objectOf(input) ?? {};
        let definition: McpServerDefinition;
        try {
            definition = structuredClone(Validator.assertMcpServerDefinition(structuredClone(params.definition) as McpServerDefinition));
        } catch (cause) {
            throw actionError("definition-invalid", 400, "The MCP server definition is invalid.", { retryable: false }, cause);
        }
        const alias = typeof params.alias === "string" ? params.alias : definition.name;
        if (alias !== definition.name) {
            throw actionError("alias-mismatch", 400, `Alias '${alias}' must equal the definition's name '${definition.name}'.`, { alias, name: definition.name, retryable: false });
        }
        if (definition.plugin !== undefined) {
            throw actionError("definition-invalid", 400, "The service records the plugin that carries a server; name the scope of the root to add it at instead.", { alias, retryable: false });
        }
        if (definition.type === "stdio" && definition.command.startsWith("./")) {
            throw actionError("definition-invalid", 400, "An added server's plugin holds only its declaration, so its command is a bare name found on the executable search path.", {
                alias, command: definition.command, retryable: false,
            });
        }
        const checked = validateMcpConfiguration({ $schema: MCP_SCHEMA, mcpServers: { [alias]: entryOf(definition) } });
        const finding = "disabled" in checked ? checked.disabled : checked.skipped.find(({ server }) => server === alias);
        if (finding !== undefined) {
            throw actionError("definition-invalid", 400, `The server entry is not a standard mcp.json entry: ${finding.message}`, { alias, section: finding.section, retryable: false });
        }
        const { roots } = await this.#workspacePlugins(identity.workspaceId);
        if (roots[definition.scope] === null) {
            const usable = SCOPES.filter((scope) => roots[scope] !== null);
            throw actionError("scope-unavailable", 400, `'${alias}' targets the ${definition.scope} plugin root, which this workspace does not have.`, {
                alias, scope: definition.scope,
                recovery: usable.length === 0 ? "This workspace has no plugin root to add a server at." : `Add it with scope ${usable.map((scope) => `"${scope}"`).join(" or ")}.`,
                retryable: false,
            });
        }
        return { alias, definition };
    }

    // {§mcp-plugin-servers} — `remove` deletes the plugin `add` wrote, before the coordinator forgets it.
    async #forget(source: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void> {
        const definition = source.definition as McpServerDefinition;
        try {
            await this.#deleteServerPlugin(identity.workspaceId, { scope: definition.scope, name: definition.name });
        } catch (cause) {
            throw actionError("uninstall-failed", 500, `MCP server '${definition.name}' could not be removed from its ${definition.scope} plugin root: ${messageOf(cause)}`, {
                server: definition.name, scope: definition.scope, retryable: true,
            }, cause);
        }
    }

    // {§mcp-plugin-servers} — an added server launches from the one-server plugin written for it at its
    // scope's root; the same plugin already there is reused, and one this attempt wrote is recorded so
    // an abandoned attempt can delete it.
    async #launchable(workspaceId: number, definition: McpServerDefinition, written: Array<{ scope: McpServerScope; name: string }>): Promise<McpServerDefinition> {
        if (definition.plugin !== undefined) return definition;
        let result: ServerPluginWrite;
        try {
            result = await this.#writeServerPlugin(workspaceId, { scope: definition.scope, name: definition.name, entry: entryOf(definition) });
        } catch (cause) {
            throw actionError("install-failed", 500, `MCP server '${definition.name}' could not be written as a plugin at its ${definition.scope} root: ${messageOf(cause)}`, {
                server: definition.name, scope: definition.scope, retryable: false,
            }, cause);
        }
        if (result.kind === "unrooted") {
            throw actionError("scope-unavailable", 409, `MCP server '${definition.name}' targets the ${definition.scope} plugin root, which this workspace does not have.`, {
                server: definition.name, scope: definition.scope, retryable: false,
            });
        }
        if (result.kind === "occupied") {
            throw actionError("plugin-occupied", 409, `A different plugin already occupies ${result.directory}.`, {
                server: definition.name, recovery: "Remove that plugin, or add the server under another name.", retryable: false,
            });
        }
        if (result.created) written.push({ scope: definition.scope, name: definition.name });
        return { ...definition, plugin: { name: definition.name, root: result.root, data: result.data } };
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

    // The attachment keeps the enabled definition it was prepared from; a new connection launches from
    // `launch`, the same definition with its plugin.
    async #prepareAttachment(
        workspaceId: number,
        definition: McpServerDefinition,
        connection?: ServerConnection,
        launch: McpServerDefinition = definition,
    ): Promise<Attachment> {
        this.#assertOpen();
        // {§mcp-server-settings} — the operator's settings for this alias; a bad one isolates this server.
        let settings: ServerSettings;
        try {
            settings = serverSettings(definition.name, this.#env);
        } catch (cause) {
            throw actionError("server-settings-invalid", 422, `MCP server '${definition.name}' has invalid operator settings: ${cause instanceof Error ? cause.message : String(cause)}`, {
                server: definition.name, retryable: false,
            }, cause);
        }
        const environment = await this.#workspaceEnvironment(workspaceId);
        this.#assertOpen();
        // {§mcp-launch-environment} — an installed server inherits the operator's environment beneath the
        // workspace layer, as every MCP client launches one; the model's command ceiling is not its base.
        const candidate = connection ?? new ServerConnection(launch, environment(this.#env), {
            environment: environment(this.#pluginEnvironment()),
            ...(settings.authorization === undefined ? {} : { authorization: settings.authorization }),
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
        try {
            const availability = await executor.requireAvailable();
            return {
                kind: "active",
                definition,
                connection: candidate,
                executor,
                runtime: {
                    namespaceOwner: OWNER,
                    decl: runtimeDecl(
                        definition.name,
                        runtimeServerSummary(definition.name, executor.catalog),
                        this.#expanded.has(definition.name),
                        executor.catalog.instructions,
                    ),
                    executor,
                    availability,
                    scheme: new McpResources(definition.name, candidate, executor.catalog),
                },
            };
        } catch (cause) {
            if (cause instanceof AuthorizationRequiredError) {
                return {
                    kind: "authorization-required",
                    definition,
                    connection: candidate,
                    authorizationUrl: cause.authorizationUrl,
                };
            }
            let closeCause: unknown;
            if (connection === undefined) {
                try {
                    await this.#closeOwned([candidate]);
                } catch (error) {
                    closeCause = error;
                }
            }
            throw preparationError(definition, settings.authorization, cause, closeCause);
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
            const nextDefinition = enabled.get(name) as McpServerDefinition | undefined;
            if (nextDefinition === undefined || force === name || !sameDefinition(attachment.definition, nextDefinition)) {
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
        const written: Array<{ scope: McpServerScope; name: string }> = [];
        const unwrite = (): Promise<PromiseSettledResult<void>[]> =>
            Promise.allSettled(written.map((plugin) => this.#deleteServerPlugin(workspaceId, plugin)));
        const consumedPending = new Map<string, PendingAuthorization>();
        const refreshed = new Map<string, symbol | undefined>();
        try {
            for (const [name, value] of enabled) {
                preparation.progress(name);
                const key = this.#pendingKey(workspaceId, name);
                const invalidation = this.#dirty.get(key);
                const definition = value as McpServerDefinition;
                const existing = previous.get(name);
                const pending = this.#pending.get(this.#pendingKey(workspaceId, name));
                if (
                    existing !== undefined
                    && force !== name
                    && !this.#dirty.has(this.#pendingKey(workspaceId, name))
                    && sameDefinition(existing.definition, definition)
                    && !(pending?.prepared !== undefined)
                ) {
                    next.set(name, existing);
                    continue;
                }
                let attachment: Attachment;
                const heldConnection = existing === undefined ? undefined : attachmentConnection(existing);
                const catalogOnly = existing !== undefined
                    && force !== name
                    && sameDefinition(existing.definition, definition)
                    && !(pending?.prepared !== undefined)
                    && heldConnection !== undefined;
                if (pending?.prepared !== undefined && sameDefinition(pending.definition, definition)) {
                    attachment = pending.prepared;
                    consumedPending.set(name, pending);
                } else if (catalogOnly) {
                    // {§mcp-catalog-refresh-in-place} — only the catalog is dirty: the executor is
                    // rebuilt on the connection the alias already holds. No second process is
                    // spawned, so neither abort nor commit has anything of this alias to close
                    // (#429).
                    try {
                        attachment = await this.#prepareAttachment(workspaceId, definition, heldConnection);
                    } catch (cause) {
                        this.#assertOpen();
                        console.error(`MCP server '${name}' catalog refresh failed; the current catalog stays in service:`, cause);
                        attachment = existing;
                    }
                } else {
                    try {
                        attachment = await this.#prepareAttachment(workspaceId, definition, undefined, await this.#launchable(workspaceId, definition, written));
                    } catch (cause) {
                        this.#assertOpen();
                        if (failure === "reject") throw cause;
                        const refusal = cause instanceof ModuleActionError ? cause : preparationError(definition, undefined, cause);
                        attachment = { kind: "unavailable", definition, problem: structuredClone(refusal.problem) };
                        console.error(`MCP server '${name}' unavailable: ${refusal.problem.detail}`, refusal.cause ?? refusal);
                    }
                    // Only a connection this attempt opened is the attempt's to close on abort.
                    if (attachment.kind !== "unavailable") fresh.push(attachment);
                }
                next.set(name, attachment);
                if (attachment !== existing) refreshed.set(key, invalidation);
            }
        } catch (cause) {
            const cleanup = [...await Promise.allSettled(fresh.map(({ connection }) => this.#closeOwned([connection]))), ...await unwrite()];
            const failures = cleanup.flatMap((result) => result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) throw new AggregateError([cause, ...failures], "MCP workspace preparation and cleanup failed.");
            throw cause;
        }
        for (const [name, attachment] of next) {
            switch (attachment.kind) {
                case "active": outcomes.set(name, { state: "active", detail: catalogDetail(attachment.executor) }); break;
                case "unavailable": outcomes.set(name, { state: "unavailable", problem: attachment.problem }); break;
                case "authorization-required": outcomes.set(name, { state: "authorization-required", authorization: { url: attachment.authorizationUrl } }); break;
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
                    this.#pending.delete(this.#pendingKey(workspaceId, name));
                    pending.releaseWorkspace();
                }
                // {§oauth-lifetime} — a withdrawn alias, disabled or gone with its plugin, clears its pending candidate.
                for (const [key, pending] of this.#pending) {
                    if (!key.startsWith(`${workspaceId}:`) || next.has(key.slice(`${workspaceId}:`.length))) continue;
                    this.#pending.delete(key);
                    pending.releaseWorkspace();
                    if (!retained.has(pending.connection)) obsolete.push(pending.connection);
                }
                for (const [name, attachment] of next) {
                    if (attachment.kind !== "authorization-required") continue;
                    const key = this.#pendingKey(workspaceId, name);
                    const current = this.#pending.get(key);
                    if (current?.connection === attachment.connection) continue;
                    this.#pending.set(key, {
                        definition: attachment.definition,
                        connection: attachment.connection,
                        authorizationUrl: attachment.authorizationUrl,
                        releaseWorkspace: this.#retain(workspaceId),
                    });
                    if (current !== undefined) {
                        current.releaseWorkspace();
                        if (!retained.has(current.connection)) obsolete.push(current.connection);
                    }
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
                const failures = (await unwrite()).flatMap((result) => result.status === "rejected" ? errorsOf(result.reason) : []);
                if (failures.length > 0) throw new AggregateError(failures, "An abandoned MCP preparation could not delete the plugins it wrote.");
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

    // {§oauth-continuation} — the callback finishes the pending connection's
    // authorization, prepares its attachment, and re-enables the alias through
    // the coordinator, which consumes the prepared attachment on publication.
    async #completeOAuth(identity: WorkspaceCapabilityIdentity, params: Readonly<Record<string, unknown>>): Promise<unknown> {
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
        if (current === undefined || current.kind !== "authorization-required" || !sameDefinition(current.definition, pending.definition)) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { workspaceId: identity.workspaceId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
            );
        }
        if (pending.prepared === undefined) {
            try {
                await pending.connection.finishAuthorization(callbackUrl);
                const prepared = await this.#prepareAttachment(identity.workspaceId, pending.definition, pending.connection);
                if (prepared.kind !== "active") throw new Error("OAuth completion returned another authorization challenge.");
                pending.prepared = prepared;
            } catch (cause) {
                throw actionError(
                    "oauth-callback-invalid",
                    400,
                    `OAuth authorization for MCP server '${alias}' could not be completed.`,
                    { workspaceId: identity.workspaceId, alias, retryable: false },
                    cause,
                );
            }
        }
        const result = await this.#handleOrThrow().invoke("enable", { alias }, identity);
        return result.body;
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
        }, delay);
        timer.unref();
        this.#refreshTimers.set(key, timer);
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
