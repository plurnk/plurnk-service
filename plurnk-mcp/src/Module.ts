// {§mcp-module} — the MCP family beneath the shared Worker Functionality
// coordinator ({§functionality-adapter}). This module owns MCP protocol truth:
// definitions from the POSIX cascade, inert discovery, connection preparation
// with OAuth continuation, tool/resource publication, catalog refresh, and
// teardown. The coordinator owns the lifecycle, durable Worker state, atomic
// publication, and both the client and model projections.
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
    type FunctionalityDiscoverQuery,
    type McpConfigurationOverlay,
    type McpServerDefinition,
    type JsonSchema,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";

import ServerConnection, {
    AuthorizationRequiredError,
    isClientCredentialsRejection,
} from "./client.ts";
import {
    expandedServerNames,
    overlayServerDefinitions,
    serviceDefinitions,
    serviceEnabledNames,
    summaryOverrides,
} from "./config.ts";
import McpExecutor, { runtimeDecl, runtimeServerSummary, serverSummary } from "./McpExecutor.ts";
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

interface WorkerIdentity {
    readonly workspaceId: number;
    readonly workerId: number;
}

type Outcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url: string } };

interface Preparation extends WorkerIdentity {
    readonly enabled: ReadonlyMap<string, object>;
    readonly previous: unknown | null;
    readonly failure: "publish-unavailable" | "reject";
    readonly force?: string;
    retain(): () => void;
}

interface Prepared {
    readonly runtimes: readonly RuntimeRegistration[];
    readonly documents: readonly { readonly pathname: string; readonly content: string }[];
    readonly outcomes: ReadonlyMap<string, Outcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

interface FunctionalityAdapter {
    readonly family: string;
    readonly namespaceOwner: string;
    readonly summary: string;
    readonly definitionSchema: JsonSchema;
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: { readonly signature: string; readonly details: string };
    available(identity: WorkerIdentity): Promise<readonly { alias: string; definition: object; enabled: boolean }[]>;
    discover(query: FunctionalityDiscoverQuery, identity: WorkerIdentity): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: WorkerIdentity): Promise<{ alias: string; definition: object }>;
    prepare(preparation: Preparation): Promise<Prepared>;
    teardown(snapshot: unknown, identity: WorkerIdentity): Promise<void>;
}

interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "enable" | "disable" | "remove",
        params: unknown,
        identity: WorkerIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    refresh(identity: WorkerIdentity): Promise<void>;
}

interface ModuleSetupSeam {
    registerModuleAction(registration: {
        readonly name: string;
        readonly scope: "worldless" | "workspace" | "worker";
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
// (worker, alias): the challenged connection, its URL, the Worker residency it
// holds, and, once the callback lands, the prepared active attachment.
interface PendingAuthorization {
    readonly definition: McpServerDefinition;
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
    readonly releaseWorker: () => void;
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

const preparationError = (
    definition: McpServerDefinition,
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
    if (definition.authorization?.type === "client-credentials" && isClientCredentialsRejection(cause)) {
        return actionError(
            "oauth-client-credentials-failed",
            502,
            `MCP server '${definition.name}' rejected the client-credentials grant; check the configured client credentials and issuer.`,
            {
                server: definition.name,
                transport: definition.transport,
                clientId: definition.authorization.clientId,
                ...(definition.authorization.issuer === undefined
                    ? {}
                    : { issuer: definition.authorization.issuer }),
                retryable: false,
            },
            completeCause,
        );
    }
    return actionError(
        "server-unavailable",
        502,
        `Configured MCP server '${definition.name}' is unavailable.`,
        {
            server: definition.name,
            transport: definition.transport,
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

const workerIdentityOf = (context: ModuleActionContext): WorkerIdentity => {
    if (context.scope !== "worker") throw new Error("MCP actions require a worker-scoped context.");
    return { workspaceId: context.workspaceId, workerId: context.workerId };
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
    readonly #summaries: { servers: Map<string, string>; tools: Map<string, string> };
    readonly #expanded: Set<string>;
    readonly #defaults: ReadonlyMap<string, McpServerDefinition>;
    readonly #defaultEnabled: ReadonlySet<string>;
    // The committed attachments per Worker: the adapter's mirror of the snapshot
    // the coordinator holds, for continuations and refresh.
    readonly #attachments = new Map<number, ReadonlyMap<string, Attachment>>();
    readonly #identities = new Map<number, WorkerIdentity>();
    readonly #pending = new Map<string, PendingAuthorization>();
    readonly #dirty = new Set<string>();
    readonly #connections = new Set<ServerConnection>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
    readonly #retainWorker = new Map<number, () => () => void>();
    #handle: FunctionalityFamilyHandle | undefined;
    #closed = false;

    static init(options: ModuleOptions = {}): Module {
        return new Module(options.env ?? process.env);
    }

    private constructor(environ: NodeJS.ProcessEnv) {
        this.#env = environ;
        this.#defaults = new Map(
            serviceDefinitions(environ).map((definition) => [definition.name, definition]),
        );
        this.#defaultEnabled = new Set(serviceEnabledNames(environ));
        this.#summaries = summaryOverrides(environ);
        this.#expanded = new Set(expandedServerNames(environ));
    }

    async setup(seam: ModuleSetupSeam): Promise<void> {
        this.#handle = seam.registerFunctionalityAdapter({
            family: FAMILY,
            namespaceOwner: OWNER,
            summary: "Manage this Worker's MCP server attachments: list, discover, add, enable, disable, remove.",
            definitionSchema: MCP_DEFINITION,
            example: { alias: "files", definition: { name: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
            discovery: {
                signature: '{"source": string}',
                details: "`source` is one MCP server URL or command line; the server is inspected without being attached, and the candidate carries the exact definition to add.",
            },
            available: async () => [...this.#defaults].map(([name, definition]) => ({
                alias: name,
                definition: structuredClone(definition),
                enabled: this.#defaultEnabled.has(name),
            })),
            discover: (query) => this.#discover(query),
            admit: async (input) => this.#admit(input),
            prepare: (preparation) => this.#prepare(preparation),
            teardown: (snapshot, identity) => this.#teardown(snapshot, identity),
        });
        // Protocol continuations beneath the common grammar.
        seam.registerModuleAction({
            name: "worker.mcp.oauth.complete",
            scope: "worker",
            inputSchema: actionInput({ alias: NONEMPTY_STRING, callbackUrl: NONEMPTY_STRING }, ["alias", "callbackUrl"]),
            outputSchema: MUTATION_RESULT,
            handler: (params, context) => this.#completeOAuth(workerIdentityOf(context), params),
        });
        seam.registerModuleAction({
            name: "worker.mcp.complete",
            scope: "worker",
            inputSchema: actionInput({
                server: NONEMPTY_STRING,
                ref: OPEN_OBJECT,
                argument: OPEN_OBJECT,
                context: OPEN_OBJECT,
            }, ["server", "ref", "argument"]),
            outputSchema: OPEN_OBJECT,
            handler: (params, context) => this.#complete(workerIdentityOf(context).workerId, params),
        });
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("MCP module is closed.");
    }

    #handleOrThrow(): FunctionalityFamilyHandle {
        if (this.#handle === undefined) throw new Error("MCP module is not set up.");
        return this.#handle;
    }

    #pendingKey(workerId: number, name: string): string {
        return `${workerId}:${name}`;
    }

    #retain(workerId: number): () => void {
        const retain = this.#retainWorker.get(workerId);
        if (retain === undefined) {
            throw new Error(`MCP worker ${workerId} has no Functionality residency context.`);
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

    // {§mcp-discovery} — inert: a direct target is probed and disconnected;
    // caller configuration is parsed into candidates; registry search waits for
    // a configured downstream registry.
    async #discover(query: FunctionalityDiscoverQuery): Promise<FunctionalityCandidate[]> {
        this.#assertOpen();
        const candidates: FunctionalityCandidate[] = [];
        if (query.configuration !== undefined) {
            let definitions: Map<string, McpServerDefinition>;
            try {
                definitions = overlayServerDefinitions(
                    structuredClone(query.configuration) as McpConfigurationOverlay,
                    this.#defaults,
                );
            } catch (cause) {
                throw actionError("configuration-invalid", 400, "The supplied MCP configuration is invalid.", { retryable: false }, cause);
            }
            for (const [name, definition] of definitions) {
                candidates.push({
                    alias: name,
                    definition,
                    provenance: { kind: "client-configuration", source: `PLURNK_MCP_${name.toUpperCase().replaceAll("-", "_")}` },
                    summary: `${definition.transport} ${definition.transport === "http" ? definition.url : definition.command}`,
                });
            }
        }
        if (query.source !== undefined) {
            // A URL is a Streamable HTTP target; anything else is a command line
            // split on whitespace (exact paths with spaces are added, not probed).
            const source = query.source;
            const [command = "", ...args] = source.trim().split(/\s+/u);
            const definition: McpServerDefinition = /^https?:\/\//u.test(source)
                ? { name: "discovered", transport: "http", url: source }
                : { name: "discovered", transport: "stdio", command, args };
            Validator.assertMcpServerDefinition(definition);
            const connection = new ServerConnection(definition, this.#env, {
                onCatalogChanged: () => undefined,
                onInfrastructureError: () => undefined,
            });
            this.#connections.add(connection);
            const executor = new McpExecutor({ runtime: "discovered", glyph: "🔌" }, connection, () => () => undefined);
            try {
                await executor.requireAvailable();
                const catalog = executor.catalog;
                const name = catalog.server?.name?.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "discovered";
                candidates.push({
                    alias: name,
                    definition: { ...definition, name },
                    provenance: { kind: "direct-target", source },
                    summary: serverSummary(name, catalog, undefined),
                });
            } catch (cause) {
                if (cause instanceof AuthorizationRequiredError) {
                    candidates.push({
                        alias: "discovered",
                        definition,
                        provenance: { kind: "direct-target", source },
                        summary: "The server requires authorization before it can be inspected; add it and complete the authorization.",
                    });
                } else {
                    throw actionError("discover-failed", 502, `MCP target '${source}' could not be inspected.`, { source, retryable: true }, cause);
                }
            } finally {
                await this.#closeOwned([connection]);
            }
        }
        if (query.query !== undefined && query.source === undefined && query.configuration === undefined) {
            throw actionError(
                "registry-not-configured",
                501,
                "MCP registry search requires a configured downstream registry; none is configured.",
                { query: query.query, recovery: "Discover an explicit source (URL or command) or configure a registry.", retryable: false },
            );
        }
        return candidates;
    }

    #admit(input: unknown): { alias: string; definition: McpServerDefinition } {
        const params = objectOf(input) ?? {};
        let definition: McpServerDefinition;
        try {
            definition = structuredClone(Validator.assertMcpServerDefinition(structuredClone(params.definition) as McpServerDefinition));
        } catch (cause) {
            throw actionError("definition-invalid", 400, "The MCP server definition is invalid.", { retryable: false }, cause);
        }
        const alias = typeof params.alias === "string" ? params.alias : definition.name;
        if (alias !== definition.name) {
            throw actionError(
                "alias-mismatch",
                400,
                `Alias '${alias}' must equal the definition's name '${definition.name}'.`,
                { alias, name: definition.name, retryable: false },
            );
        }
        return { alias, definition };
    }

    async #prepareAttachment(
        workerId: number,
        definition: McpServerDefinition,
        connection?: ServerConnection,
    ): Promise<Attachment> {
        this.#assertOpen();
        const candidate = connection ?? new ServerConnection(definition, this.#env, {
            onCatalogChanged: (error) => {
                if (error !== null) {
                    console.error(`MCP server '${definition.name}' catalog refresh failed:`, error);
                    return;
                }
                this.#scheduleCatalogRefresh(workerId, definition.name);
            },
            onInfrastructureError: (error) => {
                console.error(`MCP server '${definition.name}' infrastructure failure:`, error);
            },
        });
        this.#connections.add(candidate);
        const executor = new McpExecutor(
            { runtime: definition.name, glyph: "🔌" },
            candidate,
            () => this.#retain(workerId),
            { tools: definition.tools ?? null, read: definition.read ?? [] },
            this.#summaries.tools,
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
                    decl: runtimeDecl(definition.name, runtimeServerSummary(definition.name, executor.catalog, this.#summaries.servers.get(definition.name)), this.#expanded.has(definition.name)),
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
            throw preparationError(definition, cause, closeCause);
        }
    }

    // {§functionality-adapter} two-phase preparation: reuse unchanged live
    // attachments, prepare the rest, and hand the coordinator runtimes and
    // outcomes; commit adopts the set and closes what it no longer uses, abort
    // closes only what this attempt opened.
    async #prepare(preparation: Preparation): Promise<Prepared> {
        this.#assertOpen();
        const { workspaceId, workerId, enabled, failure, force } = preparation;
        this.#identities.set(workerId, { workspaceId, workerId });
        this.#retainWorker.set(workerId, preparation.retain);
        const previous = (preparation.previous as ReadonlyMap<string, Attachment> | null) ?? new Map<string, Attachment>();
        for (const [name, attachment] of previous) {
            const nextDefinition = enabled.get(name) as McpServerDefinition | undefined;
            if (nextDefinition === undefined || force === name || !sameDefinition(attachment.definition, nextDefinition)) {
                attachmentConnection(attachment)?.assertReplaceable();
            }
        }
        const next = new Map<string, Attachment>();
        const outcomes = new Map<string, Outcome>();
        const fresh: ConnectedAttachment[] = [];
        const consumedPending = new Map<string, PendingAuthorization>();
        try {
            for (const [name, value] of enabled) {
                const definition = value as McpServerDefinition;
                const existing = previous.get(name);
                const pending = this.#pending.get(this.#pendingKey(workerId, name));
                if (
                    existing !== undefined
                    && force !== name
                    && !this.#dirty.has(this.#pendingKey(workerId, name))
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
                    // (#429: the committed server was being closed beneath an aborted attempt).
                    try {
                        attachment = await this.#prepareAttachment(workerId, definition, heldConnection);
                    } catch (cause) {
                        this.#assertOpen();
                        console.error(`MCP server '${name}' catalog refresh failed; the current catalog stays in service:`, cause);
                        attachment = existing;
                    }
                } else {
                    try {
                        attachment = await this.#prepareAttachment(workerId, definition);
                    } catch (cause) {
                        this.#assertOpen();
                        if (failure === "reject") throw cause;
                        const refusal = cause instanceof ModuleActionError ? cause : preparationError(definition, cause);
                        attachment = { kind: "unavailable", definition, problem: structuredClone(refusal.problem) };
                        console.error(`MCP server '${name}' unavailable: ${refusal.problem.detail}`, refusal.cause ?? refusal);
                    }
                    // Only a connection this attempt opened is the attempt's to close on abort.
                    if (attachment.kind !== "unavailable") fresh.push(attachment);
                }
                next.set(name, attachment);
                this.#dirty.delete(this.#pendingKey(workerId, name));
            }
        } catch (cause) {
            const cleanup = await Promise.allSettled(fresh.map(({ connection }) => this.#closeOwned([connection])));
            const failures = cleanup.flatMap((result) => result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) throw new AggregateError([cause, ...failures], "MCP worker preparation and cleanup failed.");
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
                this.#attachments.set(workerId, next);
                const retained = new Set([...next.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []));
                const pendingConnections = new Set([...this.#pending.values()].map(({ connection }) => connection));
                const obsolete = [...previous.values()]
                    .flatMap((attachment) => attachmentConnection(attachment) ?? [])
                    .filter((connection) => !retained.has(connection) && !pendingConnections.has(connection));
                for (const [name, pending] of consumedPending) {
                    this.#pending.delete(this.#pendingKey(workerId, name));
                    pending.releaseWorker();
                }
                for (const [name, attachment] of next) {
                    if (attachment.kind !== "authorization-required") continue;
                    const key = this.#pendingKey(workerId, name);
                    const current = this.#pending.get(key);
                    if (current?.connection === attachment.connection) continue;
                    this.#pending.set(key, {
                        definition: attachment.definition,
                        connection: attachment.connection,
                        authorizationUrl: attachment.authorizationUrl,
                        releaseWorker: this.#retain(workerId),
                    });
                    if (current !== undefined) {
                        current.releaseWorker();
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
                            { workerId, committed: true, retryable: false },
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

    async #teardown(snapshot: unknown, identity: WorkerIdentity): Promise<void> {
        const { workerId } = identity;
        const pending = [...this.#pending.keys()].filter((key) => key.startsWith(`${workerId}:`));
        if (pending.length > 0) {
            throw new Error(`MCP worker ${workerId} cannot cool with pending OAuth residency.`);
        }
        for (const [key, timer] of this.#refreshTimers) {
            if (!key.startsWith(`${workerId}:`)) continue;
            clearTimeout(timer);
            this.#refreshTimers.delete(key);
        }
        const attachments = (snapshot as ReadonlyMap<string, Attachment> | null) ?? new Map<string, Attachment>();
        const connections = [...attachments.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []);
        this.#attachments.delete(workerId);
        this.#retainWorker.delete(workerId);
        this.#identities.delete(workerId);
        await this.#closeOwned(connections);
    }

    // {§oauth-continuation} — the callback finishes the pending connection's
    // authorization, prepares its attachment, and re-enables the alias through
    // the coordinator, which consumes the prepared attachment on publication.
    async #completeOAuth(identity: WorkerIdentity, params: Readonly<Record<string, unknown>>): Promise<unknown> {
        assertActionKeys(params, ["alias", "callbackUrl"]);
        const alias = requiredString(params, "alias");
        const callbackUrl = requiredString(params, "callbackUrl");
        const key = this.#pendingKey(identity.workerId, alias);
        const pending = this.#pending.get(key);
        if (pending === undefined) {
            // {§oauth-lifetime} — restart during pending authorization surfaces
            // as a factual not-pending state, never a secret replay.
            throw actionError(
                "oauth-not-pending",
                404,
                `MCP server '${alias}' has no pending OAuth authorization.`,
                { workerId: identity.workerId, alias, retryable: false },
            );
        }
        const current = this.#attachments.get(identity.workerId)?.get(alias);
        if (current === undefined || current.kind !== "authorization-required" || !sameDefinition(current.definition, pending.definition)) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { workerId: identity.workerId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
            );
        }
        if (pending.prepared === undefined) {
            try {
                await pending.connection.finishAuthorization(callbackUrl);
                const prepared = await this.#prepareAttachment(identity.workerId, pending.definition, pending.connection);
                if (prepared.kind !== "active") throw new Error("OAuth completion returned another authorization challenge.");
                pending.prepared = prepared;
            } catch (cause) {
                throw actionError(
                    "oauth-callback-invalid",
                    400,
                    `OAuth authorization for MCP server '${alias}' could not be completed.`,
                    { workerId: identity.workerId, alias, retryable: false },
                    cause,
                );
            }
        }
        const result = await this.#handleOrThrow().invoke("enable", { alias }, identity);
        return result.body;
    }

    async #complete(workerId: number, params: Readonly<Record<string, unknown>>): Promise<unknown> {
        assertActionKeys(params, ["server", "ref", "argument", "context"]);
        const server = requiredString(params, "server");
        const attachment = this.#attachments.get(workerId)?.get(server);
        if (attachment === undefined || attachment.kind !== "active") {
            throw actionError(
                "server-not-connected",
                409,
                `MCP server '${server}' is not connected for this worker.`,
                { workerId, name: server, retryable: false },
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
    #scheduleCatalogRefresh(workerId: number, name: string, attempt = 0): void {
        if (this.#closed) return;
        const key = this.#pendingKey(workerId, name);
        if (this.#refreshTimers.has(key)) return;
        const delay = Math.min(250 * (2 ** attempt), 5000);
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(key);
            const identity = this.#identities.get(workerId);
            if (identity === undefined || this.#closed) return;
            this.#dirty.add(key);
            void this.#handleOrThrow().refresh(identity).catch((error: unknown) => {
                if (statusOf(error) === 409) {
                    this.#scheduleCatalogRefresh(workerId, name, attempt + 1);
                    return;
                }
                console.error(`MCP server '${name}' capability refresh failed:`, error);
            });
        }, delay);
        timer.unref();
        this.#refreshTimers.set(key, timer);
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        const closing = this.#closeOwned([...this.#connections]);
        this.#attachments.clear();
        for (const pending of this.#pending.values()) pending.releaseWorker();
        this.#pending.clear();
        this.#retainWorker.clear();
        this.#identities.clear();
        await closing;
    }
}
