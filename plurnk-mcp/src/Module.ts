// {§mcp-module} — the MCP family beneath the shared workspace Functionality
// coordinator ({§functionality-adapter}). This module owns MCP protocol truth:
// complete connection definitions, preparation with OAuth
// continuation, tool/resource publication, catalog refresh, and teardown. The coordinator owns the lifecycle, durable workspace state, atomic
// publication, and both the client and model projections.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDefinition } from "./definition.ts";
import { type Notice,
    type FunctionalityCandidate,
    type FunctionalityDefinitionSource,
    type FunctionalityDiscoverQuery,
    type FunctionalityFamilyHandle,
    type FunctionalityOutcome,
    type FunctionalityPreparation,
    type FunctionalityPrepared,
    type McpServerDefinition,
    type JsonSchema,
    type WorkspaceCapabilityIdentity } from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import type { ContainedConfiguration, DaemonModule, FunctionalitySeam, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import { ConfigurationError } from "@plurnk/plurnk-meta";

import ServerConnection, {
    AuthorizationRequiredError,
    isClientCredentialsRejection,
} from "./client.ts";
import { SkillVerificationError } from "@modelcontextprotocol/client/ext/skills";
import { computeSkillCommit, fetchVerifiedSkillFiles } from "./skills.ts";
import {
    configuredDefinitions,
    connectTimeoutMs,
    expandedServerNames,
    retryDelayMs,
    retryPacing,
    registrySettings,
    serverSettings,
    serviceDefinitions,
    type ToolPolicy,
} from "./config.ts";
import {
    OpenWorkCoordinator,
    assertWorkspaceDefinitionScope,
    matchesWorkspaceBinding,
    rawSessionBinding,
    rawWorkspaceBinding,
    resolveServerBinding,
    withSyntheticEnv,
    type ServerBinding,
    type StartSeam,
} from "./openWork.ts";
import { RegistryError, registryEntries, searchRegistry, type RegistryServer } from "./registry.ts";
import McpExecutor, { runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import type { OAuthGrant } from "./oauth.ts";
import {
    FAMILY,
    OWNER,
    ModuleActionError,
    actionError,
    activeDetail,
    attachmentConnection,
    bindingOf,
    errorsOf,
    objectOf,
    preparationError,
    requiredString,
    sameBinding,
    statusOf,
    unavailableRuntime,
    workspaceIdentityOf,
    type Attachment,
    type ConnectedAttachment,
    type McpBinding,
    type PendingAuthorization,
    type Snapshot,
} from "./attachment.ts";
import {
    beginOAuth,
    completeOAuth,
    completePromptOrResource,
    type ContinuationHost,
} from "./continuation.ts";

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

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

// {§mcp-module} — the registry `discover` searches.
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
    // {§mcp-module} The registry `discover` searches, read at construction; without one the
    // family serves no discovery. An invalid setting withholds discovery alone
    // ({§module-contract}).
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
    // {§mcp-host-composition} The aliases whose server refused a call for want of a sign-in, by pending key.
    readonly #challenged = new Set<string>();
    // {§oauth-continuation} Each alias's accepted sign-in, by pending key, with the definition it was accepted for; cooling
    // keeps it.
    readonly #grants = new Map<string, McpBinding & { readonly grant: OAuthGrant }>();
    readonly #connections = new Set<ServerConnection>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
    readonly #retainWorkspace = new Map<number, () => () => void>();
    readonly #residentLeases = new Map<number, () => void>();
    readonly #operatorAliases = new Map<number, ReadonlySet<string>>();
    readonly #openWork = new OpenWorkCoordinator();
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
            summary: "Manage MCP servers; active servers run as <alias> (<tool>) and publish workspace:///_plurnk/tools/<alias>.md",
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
            admit: (input, identity) => this.#admit(input, identity),
            prepare: (preparation) => this.#prepare(preparation),
            teardown: (snapshot, identity) => this.#teardown(snapshot, identity),
            refreshIfChanged: (identity) => this.#refreshIfChanged(identity),
        });
        // Protocol continuations beneath the common grammar.
        const continuation = this.#continuationHost();
        seam.registerModuleAction({
            name: "workspace.mcp.oauth.begin",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, redirectUrl: NONEMPTY_STRING }, ["alias", "redirectUrl"]),
            outputSchema: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthBeginResult.json" },
            handler: (params, context) => beginOAuth(continuation, workspaceIdentityOf(context), params),
        });
        seam.registerModuleAction({
            name: "workspace.mcp.oauth.complete",
            scope: "workspace",
            residency: "required",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, callbackUrl: NONEMPTY_STRING }, ["alias", "callbackUrl"]),
            outputSchema: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthCompletionResult.json" },
            handler: (params, context) => completeOAuth(continuation, workspaceIdentityOf(context), params),
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
            handler: (params, context) => completePromptOrResource(continuation, workspaceIdentityOf(context).workspaceId, params),
        });
        seam.registerModuleAction({
            name: "workspace.mcp.skills",
            scope: "workspace",
            residency: "none",
            inputSchema: actionInput({
                server: NONEMPTY_STRING,
                skill: NONEMPTY_STRING,
                includeFiles: { type: "boolean" },
                verify: { type: "boolean" },
            }, ["server"]),
            outputSchema: OPEN_OBJECT,
            handler: (params, context) => this.#skillsAction(workspaceIdentityOf(context).workspaceId, params),
        });
    }

    async start(seam: StartSeam): Promise<void> {
        this.#openWork.attachSeam(seam);
        await this.#startResidentWorkspaces(seam);
    }

    async #startResidentWorkspaces(seam: StartSeam): Promise<void> {
        let envDefs: ReturnType<typeof serviceDefinitions>;
        try {
            envDefs = serviceDefinitions(this.#env).filter((entry) => entry.enabled);
        } catch {
            return;
        }
        let workspaces = await seam.listWorkspaces({ hidden: false });
        const needsBootstrapWorkspace = envDefs.some((entry) => {
            try {
                return rawWorkspaceBinding(entry.definition, this.#env) !== undefined
                    || rawSessionBinding(entry.definition, this.#env) !== undefined;
            } catch {
                return false;
            }
        });
        if (workspaces.length === 0 && needsBootstrapWorkspace) {
            await this.#openWork.ensureWorkspace("default");
            workspaces = await seam.listWorkspaces({ hidden: false });
        }
        let operatorDefs = envDefs;
        if (workspaces.length > 0) {
            try {
                const firstId = workspaces[0].id;
                const { configurationRoots } = await this.#paths(firstId);
                const nonProjectDirs = configurationRoots
                    .filter(({ scope }) => scope !== "project")
                    .map(({ directory }) => directory);
                const plugins = await this.#plugins(firstId);
                const nonProjectPlugins = {
                    ...plugins,
                    plugins: plugins.plugins.filter(({ scope }) => scope !== "project"),
                    report: () => {},
                };
                operatorDefs = (await configuredDefinitions(nonProjectDirs, this.#env, nonProjectPlugins))
                    .filter((entry) => entry.enabled);
            } catch {
                // Invalid optional configuration is reported lazily during workspace sync ({§configuration-repair-path}).
            }
        }
        const activateIds = new Set<number>();
        for (const entry of operatorDefs) {
            let rawWs: string | readonly string[] | undefined;
            let rawSess: string | undefined;
            try {
                rawWs = rawWorkspaceBinding(entry.definition, this.#env);
                rawSess = rawSessionBinding(entry.definition, this.#env);
            } catch {
                continue;
            }
            if (rawWs === undefined && rawSess === undefined) continue;
            const targetWorkspaces: Array<{ readonly id: number; readonly name: string }> = [];
            if (rawWs === undefined || rawWs === "*" || (Array.isArray(rawWs) && rawWs.includes("*"))) {
                if (workspaces.length === 0) {
                    const created = await this.#openWork.ensureWorkspace("default");
                    workspaces = await seam.listWorkspaces({ hidden: false });
                    targetWorkspaces.push(created);
                } else {
                    for (const ws of workspaces) targetWorkspaces.push({ id: ws.id, name: ws.name });
                }
            } else {
                const names = typeof rawWs === "string" ? [rawWs] : [...rawWs];
                for (const name of names) {
                    targetWorkspaces.push(await this.#openWork.ensureWorkspace(name));
                }
            }
            for (const ws of targetWorkspaces) {
                if (rawSess !== undefined && rawSess.length > 0 && !rawSess.includes("${")) {
                    await this.#openWork.ensureSession(ws.id, rawSess);
                }
                activateIds.add(ws.id);
            }
        }
        for (const workspaceId of activateIds) {
            await seam.activateWorkspace({ workspaceId });
        }
    }

    async #available(identity: WorkspaceCapabilityIdentity): ReturnType<typeof configuredDefinitions> {
        expandedServerNames(this.#env);
        const { workspaceId } = identity;
        const notices: Notice[] = [];
        this.#configurationNotices.set(workspaceId, notices);
        const { configurationRoots, workspaceName } = await this.#paths(workspaceId);
        const pluginSet = await this.#plugins(workspaceId);
        const definitions = await configuredDefinitions(configurationRoots.map(({ directory }) => directory), this.#env, {
            ...pluginSet, report: (notice) => notices.push(notice),
        });
        const projectFiles = new Set([
            ...configurationRoots.filter(({ scope }) => scope === "project").map(({ directory }) => join(directory, "mcp.json")),
            ...pluginSet.plugins.filter(({ scope }) => scope === "project").map(({ root }) => join(root, "mcp.json")),
        ]);
        const operatorAliases = new Set(
            definitions
                .filter((entry) => entry.provenance === undefined || !projectFiles.has(entry.provenance.source))
                .map((entry) => entry.alias),
        );
        this.#operatorAliases.set(workspaceId, operatorAliases);
        return definitions.map((entry) => {
            if (operatorAliases.has(entry.alias) && !matchesWorkspaceBinding(entry.definition, this.#env, workspaceName)) {
                return { ...entry, enabled: false };
            }
            return entry;
        });
    }

    // {§functionality-inspection} — a server's definition is complete, so the coordinator's
    // comparison of what it would prepare with what it published is the change test.
    async #refreshIfChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#handleOrThrow().refresh(identity, { gate: "none", ifChanged: true });
    }

    // {§mcp-module} Candidates are complete definitions, never installations.
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
    async #admit(input: unknown, identity?: WorkspaceCapabilityIdentity): Promise<FunctionalityDefinitionSource<McpServerDefinition>> {
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
        if (identity !== undefined && definition.plurnkWorkspace !== undefined) {
            const [{ workspaceName }, environment] = await Promise.all([
                this.#paths(identity.workspaceId),
                this.#workspaceEnvironment(identity.workspaceId),
            ]);
            assertWorkspaceDefinitionScope(definition, workspaceName, environment(this.#env));
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
        // {§mcp-configuration} — the operator's settings for this alias; a bad one isolates this server.
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
            // {§mcp-module} — a configured server inherits the operator's environment beneath the
            // workspace layer, as every MCP client launches one; the model's command ceiling is not its base.
            const needsDefaultCwd = candidate === undefined && definition.type === "stdio" && definition.cwd === undefined && context === undefined;
            const needsStateDir = needsDefaultCwd || (candidate === undefined && JSON.stringify(definition).includes("${PLURNK_STATE_DIR}"));
            const stateDir = needsStateDir ? await this.#stateDirectory(workspaceId, `${OWNER}/${definition.name}`) : undefined;
            const cwd = needsDefaultCwd ? stateDir : undefined;
            signal?.throwIfAborted();
            this.#assertOpen();
            const { projectRoot, workspaceName = "default" } = await this.#paths(workspaceId);
            signal?.throwIfAborted();
            this.#assertOpen();
            const workspaceEnv = environment(this.#env);
            let workspaceSettings: ToolPolicy;
            try {
                workspaceSettings = serverSettings(definition.name, workspaceEnv);
            } catch (cause) {
                throw actionError("server-settings-invalid", 422, `MCP server '${definition.name}' has invalid settings: ${cause instanceof Error ? cause.message : String(cause)}`, {
                    server: definition.name, retryable: false,
                }, cause);
            }
            let serverBinding: ServerBinding;
            try {
                serverBinding = resolveServerBinding({
                    definition,
                    workspaceSettings,
                    operatorSettings: settings,
                    operatorScoped: this.#operatorAliases.get(workspaceId)?.has(definition.name) ?? false,
                    workspaceName,
                    expansionEnv: workspaceEnv,
                });
            } catch (cause) {
                if (cause instanceof ModuleActionError) throw cause;
                throw actionError("server-settings-invalid", 422, `MCP server '${definition.name}' has invalid binding settings: ${cause instanceof Error ? cause.message : String(cause)}`, {
                    server: definition.name, retryable: false,
                }, cause);
            }
            const syntheticContext = {
                workspaceName,
                sessionName: serverBinding.defaultSession,
                projectRoot,
                stateDir,
            };
            let schemeRef: McpResources | undefined;
            const grant = oauthRedirectUrl === undefined ? this.#grantFor(workspaceId, binding) : undefined;
            candidate ??= new ServerConnection(definition, withSyntheticEnv(workspaceEnv, syntheticContext), {
                ...(oauthRedirectUrl === undefined ? {} : { oauthRedirectUrl }),
                ...(grant === undefined ? {} : { oauthGrant: grant }),
                ...(cwd === undefined ? {} : { cwd }),
                ...(context === undefined ? {} : { plugin: context }),
                resident: serverBinding.resident,
                sample: (params, reqSignal) => this.#openWork.sample({
                    server: definition.name,
                    binding: serverBinding,
                    params,
                    signal: reqSignal,
                }),
                onResourceUpdated: (uri) => {
                    void schemeRef?.notifyResourceUpdated(uri);
                },
                environment: withSyntheticEnv(environment(this.#operatorEnvironment()), syntheticContext),
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
            const callerMeta = (wsId: number, sessId: number) =>
                this.#openWork.resolveCallerMeta(wsId, sessId, workspaceName);
            const executor = new McpExecutor(
                { runtime: definition.name, glyph: "🔌" },
                candidate,
                () => this.#retain(workspaceId),
                { tools: workspaceSettings.tools ?? settings.tools },
                callerMeta,
            );
            const availability = await executor.requireAvailable(signal);
            signal?.throwIfAborted();
            const scheme = new McpResources(
                definition.name,
                candidate,
                executor.catalog,
                callerMeta,
                serverBinding.resident,
            );
            schemeRef = scheme;
            return {
                ...(context === undefined ? {} : { context }),
                kind: "active",
                definition,
                connection: candidate,
                executor,
                resident: serverBinding.resident,
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
                    scheme,
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
            if (cause instanceof ModuleActionError && closeCause === undefined) throw cause;
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
        // {§mcp-host-composition} The aliases this preparation connects afresh or signs in, which answer any refusal.
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
                // {§mcp-host-composition} A server that refused a call for want of a sign-in awaits one on the connection
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
                        // {§mcp-setup} — only the catalog is dirty: the executor is
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
            // {§functionality-coordinator} The connected set and the pending register go live together,
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
                // {§oauth-continuation} A client's challenge is independent of the published connection.
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
                const wantsResidentLease = [...next.values()].some(
                    (attachment) => attachment.kind === "active" && attachment.resident === true,
                );
                let acquiredResidentLease: (() => void) | undefined;
                if (wantsResidentLease && !this.#residentLeases.has(workspaceId)) {
                    acquiredResidentLease = this.#retain(workspaceId);
                    this.#residentLeases.set(workspaceId, acquiredResidentLease);
                }
                return () => {
                    if (acquiredResidentLease !== undefined) {
                        if (this.#residentLeases.get(workspaceId) === acquiredResidentLease) {
                            this.#residentLeases.delete(workspaceId);
                        }
                        acquiredResidentLease();
                    }
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
                const wantsResidentLease = [...next.values()].some(
                    (attachment) => attachment.kind === "active" && attachment.resident === true,
                );
                if (!wantsResidentLease) {
                    const release = this.#residentLeases.get(workspaceId);
                    if (release !== undefined) {
                        this.#residentLeases.delete(workspaceId);
                        release();
                    }
                }
                // {§mcp-setup} A published snapshot acknowledges only
                // its captured invalidation, never a newer notification or an aborted candidate.
                for (const [key, invalidation] of refreshed) {
                    if (this.#dirty.get(key) === invalidation) this.#clearCatalogRefresh(key);
                }
                for (const key of this.#dirty.keys()) {
                    if (key.startsWith(`${workspaceId}:`) && !next.has(key.slice(`${workspaceId}:`.length))) {
                        this.#clearCatalogRefresh(key);
                    }
                }
                // {§mcp-host-composition} A fresh connection or an accepted sign-in answers a refusal; withdrawal forgets it.
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
        const residentRelease = this.#residentLeases.get(workspaceId);
        if (residentRelease !== undefined) {
            this.#residentLeases.delete(workspaceId);
            residentRelease();
        }
        this.#attachments.delete(workspaceId);
        this.#retainWorkspace.delete(workspaceId);
        this.#identities.delete(workspaceId);
        this.#operatorAliases.delete(workspaceId);
        await this.#closeOwned(connections);
    }

    #continuationHost(): ContinuationHost {
        return {
            isClosed: () => this.#closed,
            attachments: this.#attachments,
            pending: this.#pending,
            authorizing: this.#authorizing,
            challenged: this.#challenged,
            dirty: this.#dirty,
            grants: this.#grants,
            pendingKey: (workspaceId, name) => this.#pendingKey(workspaceId, name),
            retain: (workspaceId) => this.#retain(workspaceId),
            closeOwned: (connections) => this.#closeOwned(connections),
            prepareAttachment: (workspaceId, binding, connection, oauthRedirectUrl, signal) =>
                this.#prepareAttachment(workspaceId, binding, connection, oauthRedirectUrl, signal),
            refreshCatalog: (workspaceId, name, attempt) => this.#refreshCatalog(workspaceId, name, attempt),
        };
    }

    async #withServerConnection<T>(
        workspaceId: number,
        server: string,
        fn: (connection: ServerConnection) => Promise<T>,
    ): Promise<T> {
        this.#assertOpen();
        const snapshot = this.#attachments.get(workspaceId);
        if (snapshot !== undefined) {
            const attachment = snapshot.get(server);
            if (attachment === undefined) {
                throw actionError(
                    "server-not-connected",
                    404,
                    `MCP server '${server}' is not connected in workspace ${workspaceId}.`,
                    { server, retryable: false },
                );
            }
            if (attachment.kind === "authorization-required") {
                throw actionError(
                    "authorization-required",
                    401,
                    `MCP server '${server}' requires operator authorization.`,
                    { server, retryable: false },
                );
            }
            if (attachment.kind === "unavailable") {
                throw new ModuleActionError(attachment.problem);
            }
            return await fn(attachment.connection);
        }
        const definitions = await this.#available({ workspaceId });
        const entry = definitions.find((item) => item.alias === server && item.enabled);
        if (entry === undefined) {
            throw actionError(
                "server-not-connected",
                404,
                `MCP server '${server}' is not connected in workspace ${workspaceId}.`,
                { server, retryable: false },
            );
        }
        const attachment = await this.#prepareAttachment(workspaceId, bindingOf(entry));
        try {
            if (attachment.kind === "authorization-required") {
                throw actionError(
                    "authorization-required",
                    401,
                    `MCP server '${server}' requires operator authorization.`,
                    { server, retryable: false },
                );
            }
            if (attachment.kind === "unavailable") {
                throw new ModuleActionError(attachment.problem);
            }
            return await fn(attachment.connection);
        } finally {
            const conn = attachmentConnection(attachment);
            if (conn !== undefined) await this.#closeOwned([conn]);
        }
    }

    // {§mcp-skills} — SEP-2640 skill listing, verification, and file retrieval for `<server>:///skills`.
    async #skillsAction(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
        const server = requiredString(params, "server");
        const skillName = typeof params.skill === "string" && params.skill.length > 0 ? params.skill : undefined;
        const includeFiles = params.includeFiles === true;
        const verify = params.verify === true;
        return await this.#withServerConnection(workspaceId, server, async (connection) => {
            try {
                const skills = await connection.skills();
                if (skillName === undefined) {
                    const out = [];
                    for (const s of skills) {
                        const main = verify ? await connection.readSkill(s) : undefined;
                        out.push({
                            name: s.frontmatter.name,
                            description: s.frontmatter.description,
                            uri: s.uri,
                            commit: computeSkillCommit(s, main?.bytes),
                            dynamic: s.resources === "dynamic",
                        });
                    }
                    return { skills: out };
                }
                const matched = skills.find((s) => s.frontmatter.name === skillName);
                if (matched === undefined) return { found: false };
                if (includeFiles) {
                    const verified = await fetchVerifiedSkillFiles(connection, matched);
                    return {
                        found: true,
                        skill: {
                            name: matched.frontmatter.name,
                            description: matched.frontmatter.description,
                            uri: matched.uri,
                            commit: verified.commit,
                            dynamic: matched.resources === "dynamic",
                            files: verified.files,
                        },
                    };
                }
                const main = await connection.readSkill(matched);
                return {
                    found: true,
                    skill: {
                        name: matched.frontmatter.name,
                        description: matched.frontmatter.description,
                        uri: matched.uri,
                        commit: computeSkillCommit(matched, main.bytes),
                        dynamic: matched.resources === "dynamic",
                    },
                };
            } catch (cause) {
                if (cause instanceof SkillVerificationError) {
                    throw actionError(
                        "skill-verification-failed",
                        502,
                        cause.message,
                        { server, ...(skillName === undefined ? {} : { skill: skillName }), retryable: false },
                        cause,
                    );
                }
                throw cause;
            }
        });
    }

    // {§oauth-continuation} The alias's grant, for a connection with the definition it was accepted for, while it holds tokens.
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
        this.#openWork.close();
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#dirty.clear();
        this.#challenged.clear();
        this.#grants.clear();
        const closing = this.#closeOwned([...this.#connections]);
        this.#attachments.clear();
        for (const release of this.#residentLeases.values()) release();
        this.#residentLeases.clear();
        for (const pending of this.#pending.values()) pending.releaseWorkspace();
        this.#pending.clear();
        this.#retainWorkspace.clear();
        this.#identities.clear();
        this.#operatorAliases.clear();
        await closing;
    }
}
