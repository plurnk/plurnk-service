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
    type McpConfigurationOverlay,
    type McpServerDefinition,
    type McpServerOptions,
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
import McpExecutor, { runtimeDecl, serverSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";

const OWNER = "@plurnk/plurnk-mcp";
const STATE_VERSION = 1;

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
    | { readonly scope: "workspace"; readonly workspaceId: number };

interface ModuleSetupSeam {
    registerModuleAction(registration: {
        readonly name: string;
        readonly scope: "worldless" | "workspace";
        readonly handler: (
            params: Readonly<Record<string, unknown>>,
            context: ModuleActionContext,
        ) => unknown | Promise<unknown>;
    }): void;
    registerWorkspaceCapabilityProvider(
        namespaceOwner: string,
        provider: {
            activate(
                workspaceId: number,
                context: { retain(): () => void },
            ): void | Promise<void>;
            deactivate(workspaceId: number): void | Promise<void>;
        },
    ): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkspaceCapabilities(replacement: {
        readonly workspaceId: number;
        readonly namespaceOwner: string;
        readonly state: unknown | null;
        readonly runtimes: readonly RuntimeRegistration[];
    }): Promise<void>;
}

interface ServiceState {
    readonly kind: "service";
    readonly enabled: boolean;
}

interface WorkspaceServerState {
    readonly kind: "workspace";
    readonly definition: McpServerDefinition;
    readonly enabled: boolean;
}

type ServerState = ServiceState | WorkspaceServerState;

interface WorkspaceState {
    readonly version: typeof STATE_VERSION;
    readonly servers: Readonly<Record<string, ServerState>>;
}

type DefinitionSource = "service" | "workspace";

interface AvailableDefinition {
    readonly definition: McpServerDefinition;
    readonly source: DefinitionSource;
    readonly enabled: boolean;
}

interface ActiveAttachment extends Omit<AvailableDefinition, "enabled"> {
    readonly kind: "active";
    readonly connection: ServerConnection;
    readonly executor: McpExecutor;
    readonly runtime: RuntimeRegistration;
}

interface AuthorizationAttachment extends Omit<AvailableDefinition, "enabled"> {
    readonly kind: "authorization-required";
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
}

interface UnavailableAttachment extends Omit<AvailableDefinition, "enabled"> {
    readonly kind: "unavailable";
    readonly problem: ProblemDetails;
}

type ConnectedAttachment = ActiveAttachment | AuthorizationAttachment;
type Attachment = ConnectedAttachment | UnavailableAttachment;

const attachmentConnection = (attachment: Attachment): ServerConnection | undefined =>
    attachment.kind === "unavailable" ? undefined : attachment.connection;

interface WorkspaceSnapshot {
    readonly state: WorkspaceState;
    readonly attachments: ReadonlyMap<string, Attachment>;
}

interface PendingMutation {
    readonly operation: "add" | "enable";
    readonly expectedState: ServerState | null;
    readonly expectedDefinition: McpServerDefinition | null;
    readonly expectedEnabled: boolean;
    readonly definition: Omit<AvailableDefinition, "enabled">;
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
    readonly releaseWorkspace: () => void;
    prepared?: ActiveAttachment;
}

type PendingMutationCandidate = Omit<PendingMutation, "releaseWorkspace">;

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
        retryable: status === 409 || status >= 500,
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

const assertExactKeys = (
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    owner: string,
): void => {
    const extras = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extras.length > 0) throw new Error(`${owner} contains unsupported field(s): ${extras.join(", ")}.`);
};

const emptyState = (): WorkspaceState => ({ version: STATE_VERSION, servers: {} });

const parseState = (source: unknown | null): WorkspaceState => {
    if (source === null) return emptyState();
    const state = objectOf(source);
    if (state === null) throw new Error("MCP workspace state must be an object.");
    assertExactKeys(state, ["version", "servers"], "MCP workspace state");
    if (state.version !== STATE_VERSION) {
        throw new Error(`MCP workspace state version must be ${STATE_VERSION}.`);
    }
    const servers = objectOf(state.servers);
    if (servers === null) throw new Error("MCP workspace state servers must be an object.");
    const parsed: Record<string, ServerState> = {};
    for (const [name, raw] of Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right))) {
        const value = objectOf(raw);
        if (value === null || (value.kind !== "service" && value.kind !== "workspace")) {
            throw new Error(`MCP workspace server '${name}' has an invalid state.`);
        }
        if (typeof value.enabled !== "boolean") {
            throw new Error(`MCP workspace server '${name}' must declare boolean enabledness.`);
        }
        if (value.kind === "service") {
            assertExactKeys(value, ["kind", "enabled"], `MCP workspace server '${name}'`);
            parsed[name] = { kind: "service", enabled: value.enabled };
            continue;
        }
        assertExactKeys(value, ["kind", "definition", "enabled"], `MCP workspace server '${name}'`);
        const definition = structuredClone(
            Validator.assertMcpServerDefinition(value.definition as McpServerDefinition),
        );
        if (definition.name !== name) {
            throw new Error(`MCP workspace server key '${name}' does not match definition '${definition.name}'.`);
        }
        parsed[name] = { kind: "workspace", definition, enabled: value.enabled };
    }
    return { version: STATE_VERSION, servers: parsed };
};

const persistedState = (state: WorkspaceState): WorkspaceState | null =>
    Object.keys(state.servers).length === 0 ? null : state;

const cloneState = (state: WorkspaceState): WorkspaceState => parseState(structuredClone(state));

const sameDefinition = (left: McpServerDefinition, right: McpServerDefinition): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

const sameServerState = (left: ServerState | null, right: ServerState | null): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

const requiredString = (
    params: Readonly<Record<string, unknown>>,
    field: string,
): string => {
    const value = params[field];
    if (typeof value !== "string" || value.length === 0) {
        throw actionError(
            "parameter-required",
            400,
            `MCP action requires a non-empty '${field}' string.`,
            { field, retryable: false },
        );
    }
    return value;
};

const assertActionKeys = (
    params: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
): void => {
    const extras = Object.keys(params).filter((key) => !allowed.includes(key));
    if (extras.length === 0) return;
    throw actionError(
        "parameters-invalid",
        400,
        `MCP action contains unsupported parameter(s): ${extras.join(", ")}.`,
        { fields: extras, retryable: false },
    );
};

const workspaceIdOf = (context: ModuleActionContext): number => {
    if (context.scope !== "workspace") {
        throw actionError("workspace-context-required", 500, "MCP action received no workspace context.");
    }
    return context.workspaceId;
};

const statusOf = (error: unknown): number | null => {
    const candidate = objectOf(error);
    const direct = objectOf(candidate?.problem);
    if (typeof direct?.status === "number") return direct.status;
    const result = objectOf(candidate?.result);
    const problem = objectOf(result?.problem);
    return typeof problem?.status === "number" ? problem.status : null;
};

export default class Module {
    readonly #env: NodeJS.ProcessEnv;
    readonly #summaries: { servers: Map<string, string>; tools: Map<string, string> };
    readonly #expanded: Set<string>;
    readonly #defaults: ReadonlyMap<string, McpServerDefinition>;
    readonly #defaultEnabled: ReadonlySet<string>;
    readonly #workspaces = new Map<number, WorkspaceSnapshot>();
    // {§oauth-lifetime} — pending candidates are process-memory per
    // (workspace, alias); a restart loses them by design.
    readonly #pending = new Map<string, PendingMutation>();
    readonly #locks = new Map<number, Promise<void>>();
    readonly #connections = new Set<ServerConnection>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
    readonly #retainWorkspace = new Map<number, () => () => void>();
    #seam: ModuleSetupSeam | undefined;
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
        this.#seam = seam;
        seam.registerWorkspaceCapabilityProvider(OWNER, {
            activate: async (workspaceId, context) => {
                this.#retainWorkspace.set(workspaceId, () => context.retain());
                try {
                    await this.#serialize(workspaceId, async () => {
                        const state = parseState(await seam.readWorkspaceModuleState(workspaceId, OWNER));
                        await this.#applyState(workspaceId, state, {
                            authorizationDisposition: "publish-required",
                            preparationFailureDisposition: "publish-unavailable",
                        });
                    });
                } catch (cause) {
                    this.#retainWorkspace.delete(workspaceId);
                    throw cause;
                }
            },
            deactivate: async (workspaceId) => this.#deactivate(workspaceId),
        });
        const action = (
            name: string,
            handler: (
                params: Readonly<Record<string, unknown>>,
                context: ModuleActionContext,
            ) => unknown | Promise<unknown>,
        ): void => seam.registerModuleAction({ name, scope: "workspace", handler });
        action("workspace.mcp.list", async (params, context) => {
            assertActionKeys(params, ["overlay"]);
            return this.#list(workspaceIdOf(context), params.overlay);
        });
        action("workspace.mcp.add", async (params, context) =>
            this.#add(workspaceIdOf(context), params));
        action("workspace.mcp.enable", async (params, context) =>
            this.#setEnabled(workspaceIdOf(context), params, true));
        action("workspace.mcp.disable", async (params, context) =>
            this.#setEnabled(workspaceIdOf(context), params, false));
        action("workspace.mcp.remove", async (params, context) =>
            this.#remove(workspaceIdOf(context), params));
        action("workspace.mcp.oauth.complete", async (params, context) =>
            this.#completeOAuth(workspaceIdOf(context), params));
        action("workspace.mcp.complete", async (params, context) =>
            this.#complete(workspaceIdOf(context), params));
    }

    #pendingKey(workspaceId: number, name: string): string {
        return `${workspaceId}:${name}`;
    }

    async #serialize<T>(workspaceId: number, run: () => Promise<T>): Promise<T> {
        this.#assertOpen();
        const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
        let release = (): void => undefined;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const queued = prior.then(() => barrier, () => barrier);
        this.#locks.set(workspaceId, queued);
        await prior.catch(() => undefined);
        try {
            this.#assertOpen();
            return await run();
        } finally {
            release();
            if (this.#locks.get(workspaceId) === queued) this.#locks.delete(workspaceId);
        }
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("MCP module is closed.");
    }

    #retain(workspaceId: number): () => void {
        const retain = this.#retainWorkspace.get(workspaceId);
        if (retain === undefined) {
            throw new Error(`MCP workspace ${workspaceId} has no capability residency context.`);
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

    async #deactivate(workspaceId: number): Promise<void> {
        await this.#serialize(workspaceId, async () => {
            const pending = [...this.#pending.keys()]
                .filter((key) => key.startsWith(`${workspaceId}:`));
            if (pending.length > 0) {
                throw new Error(
                    `MCP workspace ${workspaceId} cannot cool with pending OAuth residency.`,
                );
            }
            for (const [key, timer] of this.#refreshTimers) {
                if (!key.startsWith(`${workspaceId}:`)) continue;
                clearTimeout(timer);
                this.#refreshTimers.delete(key);
            }
            const snapshot = this.#workspaces.get(workspaceId);
            const connections = [...snapshot?.attachments.values() ?? []]
                .flatMap((attachment) => attachmentConnection(attachment) ?? []);
            this.#workspaces.delete(workspaceId);
            this.#retainWorkspace.delete(workspaceId);
            await this.#closeOwned(connections);
        });
    }

    #available(state: WorkspaceState): Map<string, AvailableDefinition> {
        const available = new Map<string, AvailableDefinition>(
            [...this.#defaults].map(([name, definition]) => [
                name,
                {
                    definition: structuredClone(definition),
                    source: "service" as const,
                    enabled: this.#defaultEnabled.has(name),
                },
            ]),
        );
        for (const [name, value] of Object.entries(state.servers)) {
            if (value.kind === "service") {
                const configured = available.get(name);
                if (configured !== undefined) available.set(name, { ...configured, enabled: value.enabled });
                continue;
            }
            available.set(name, {
                definition: structuredClone(value.definition),
                source: "workspace",
                enabled: value.enabled,
            });
        }
        return new Map([...available].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    #enabled(state: WorkspaceState): Map<string, Omit<AvailableDefinition, "enabled">> {
        return new Map(
            [...this.#available(state)]
                .filter(([, value]) => value.enabled)
                .map(([name, { definition, source }]) => [name, { definition, source }]),
        );
    }

    async #prepareAttachment(
        workspaceId: number,
        effective: Omit<AvailableDefinition, "enabled">,
        connection?: ServerConnection,
    ): Promise<Attachment> {
        this.#assertOpen();
        const definition = effective.definition;
        const candidate = connection ?? new ServerConnection(definition, this.#env, {
            onCatalogChanged: (error) => {
                if (error !== null) {
                    console.error(`MCP server '${definition.name}' catalog refresh failed:`, error);
                    return;
                }
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
            { tools: definition.tools ?? null, read: definition.read ?? [] },
            this.#summaries.tools,
        );
        try {
            const availability = await executor.requireAvailable();
            return {
                kind: "active",
                ...effective,
                connection: candidate,
                executor,
                runtime: {
                    namespaceOwner: OWNER,
                    decl: runtimeDecl(definition.name, serverSummary(definition.name, executor.catalog, this.#summaries.servers.get(definition.name)), this.#expanded.has(definition.name)),
                    executor,
                    availability,
                    scheme: new McpResources(definition.name, candidate, executor.catalog),
                },
            };
        } catch (cause) {
            if (cause instanceof AuthorizationRequiredError) {
                return {
                    kind: "authorization-required",
                    ...effective,
                    connection: candidate,
                    authorizationUrl: cause.authorizationUrl,
                };
            }
            let closeCause: unknown;
            try {
                await this.#closeOwned([candidate]);
            } catch (error) {
                closeCause = error;
            }
            throw preparationError(definition, cause, closeCause);
        }
    }

    async #applyState(
        workspaceId: number,
        state: WorkspaceState,
        options: {
            readonly force?: ReadonlySet<string>;
            readonly prepared?: ReadonlyMap<string, ActiveAttachment>;
            readonly authorizationDisposition: "defer-mutation" | "publish-required";
            readonly preparationFailureDisposition: "reject" | "publish-unavailable";
        },
    ): Promise<{ authorization?: AuthorizationAttachment }> {
        const seam = this.#seam;
        if (seam === undefined) throw new Error("MCP module is not set up.");
        const current = this.#workspaces.get(workspaceId);
        const effective = this.#enabled(state);
        const force = options.force ?? new Set<string>();
        for (const [name, attachment] of current?.attachments ?? []) {
            const next = effective.get(name);
            if (
                next === undefined
                || force.has(name)
                || !sameDefinition(attachment.definition, next.definition)
            ) attachmentConnection(attachment)?.assertReplaceable();
        }

        const next = new Map<string, Attachment>();
        const fresh: ConnectedAttachment[] = [];
        try {
            for (const [name, definition] of effective) {
                const existing = current?.attachments.get(name);
                if (
                    existing !== undefined
                    && !force.has(name)
                    && sameDefinition(existing.definition, definition.definition)
                ) {
                    next.set(name, existing);
                    continue;
                }
                const supplied = options.prepared?.get(name);
                let attachment: Attachment;
                try {
                    attachment = supplied ?? await this.#prepareAttachment(workspaceId, definition);
                } catch (cause) {
                    this.#assertOpen();
                    if (options.preparationFailureDisposition === "reject") throw cause;
                    const failure = cause instanceof ModuleActionError
                        ? cause
                        : preparationError(definition.definition, cause);
                    attachment = {
                        kind: "unavailable",
                        ...definition,
                        problem: structuredClone(failure.problem),
                    };
                    console.error(
                        `MCP server '${name}' unavailable during workspace activation: ${failure.problem.detail}`,
                        failure.cause ?? failure,
                    );
                }
                next.set(name, attachment);
                if (attachment.kind !== "unavailable") fresh.push(attachment);
            }
        } catch (cause) {
            const cleanup = await Promise.allSettled(fresh.map(({ connection }) =>
                this.#closeOwned([connection])));
            const failures = cleanup.flatMap((result) =>
                result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) {
                throw new AggregateError([cause, ...failures], "MCP workspace preparation and cleanup failed.");
            }
            throw cause;
        }

        const authorization = [...fresh].find(
            (attachment): attachment is AuthorizationAttachment =>
                attachment.kind === "authorization-required",
        );
        if (authorization !== undefined && options.authorizationDisposition === "defer-mutation") {
            const discard = fresh.filter((attachment) => attachment !== authorization);
            await this.#closeOwned(discard.map(({ connection }) => connection));
            return { authorization };
        }

        this.#assertOpen();
        const runtimes = [...next.values()].flatMap((attachment) =>
            attachment.kind === "active" ? [attachment.runtime] : []);
        try {
            await seam.replaceWorkspaceCapabilities({
                workspaceId,
                namespaceOwner: OWNER,
                state: persistedState(state),
                runtimes,
            });
        } catch (cause) {
            const cleanup = await Promise.allSettled(fresh.map(({ connection }) =>
                this.#closeOwned([connection])));
            const failures = cleanup.flatMap((result) =>
                result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) {
                throw new AggregateError([cause, ...failures], "MCP workspace commit and cleanup failed.");
            }
            throw cause;
        }

        this.#workspaces.set(workspaceId, { state: cloneState(state), attachments: next });
        const retained = new Set(
            [...next.values()].flatMap((attachment) => attachmentConnection(attachment) ?? []),
        );
        const obsolete = [...current?.attachments.values() ?? []]
            .flatMap((attachment) => attachmentConnection(attachment) ?? [])
            .filter((connection) => !retained.has(connection));
        if (obsolete.length > 0) {
            try {
                await this.#closeOwned(obsolete);
            } catch (cause) {
                throw actionError(
                    "obsolete-connection-close-failed",
                    500,
                    "The MCP capability change committed, but an obsolete connection did not close cleanly.",
                    { workspaceId, committed: true },
                    cause,
                );
            }
        }

        if (options.authorizationDisposition === "publish-required") {
            for (const [name, attachment] of next) {
                if (attachment.kind !== "authorization-required") continue;
                await this.#setPending(workspaceId, name, {
                    operation: "enable",
                    expectedState: structuredClone(state.servers[name] ?? null),
                    expectedDefinition: structuredClone(attachment.definition),
                    expectedEnabled: true,
                    definition: {
                        definition: structuredClone(attachment.definition),
                        source: attachment.source,
                    },
                    connection: attachment.connection,
                    authorizationUrl: attachment.authorizationUrl,
                }, false);
            }
        }
        return authorization === undefined ? {} : { authorization };
    }

    async #setPending(
        workspaceId: number,
        name: string,
        pending: PendingMutationCandidate,
        closeExisting = true,
    ): Promise<void> {
        const key = this.#pendingKey(workspaceId, name);
        const existing = this.#pending.get(key);
        const next: PendingMutation = {
            ...pending,
            releaseWorkspace: this.#retain(workspaceId),
        };
        this.#pending.set(key, next);
        try {
            if (closeExisting && existing !== undefined && existing.connection !== next.connection) {
                await this.#closeOwned([existing.connection]);
            }
        } finally {
            existing?.releaseWorkspace();
        }
    }

    async #clearPending(
        workspaceId: number,
        name: string,
        retained?: ServerConnection,
    ): Promise<void> {
        const key = this.#pendingKey(workspaceId, name);
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        if (pending === undefined) return;
        if (pending.connection === retained) {
            pending.releaseWorkspace();
            return;
        }
        try {
            await this.#closeOwned([pending.connection]);
        } catch (cause) {
            throw actionError(
                "pending-authorization-close-failed",
                500,
                "The MCP capability change committed, but its superseded authorization request did not close cleanly.",
                { workspaceId, name, committed: true },
                cause,
            );
        } finally {
            pending.releaseWorkspace();
        }
    }

    #snapshot(workspaceId: number): WorkspaceSnapshot {
        const snapshot = this.#workspaces.get(workspaceId);
        if (snapshot === undefined) {
            throw actionError(
                "workspace-not-active",
                409,
                "MCP capabilities have not been activated for this workspace.",
                { workspaceId, recovery: "Retry after workspace activation completes." },
            );
        }
        return snapshot;
    }

    #summary(
        alias: string,
        available: AvailableDefinition | {
            readonly definition: McpServerDefinition;
            readonly source: "client";
            readonly enabled: false;
        },
        attachment?: Attachment,
    ): Record<string, unknown> {
        const definition = available.definition;
        const base = {
            alias,
            source: available.source,
            transport: definition.transport,
            target: definition.transport === "http" ? definition.url : definition.command,
            enabled: available.enabled,
            state: available.enabled
                ? attachment?.kind === "active"
                    ? "connected"
                    : attachment?.kind === "authorization-required"
                        ? "authorization-required"
                        : "unavailable"
                : "disabled",
            enabledTools: definition.tools ?? null,
            read: definition.read ?? [],
        };
        if (attachment?.kind === "authorization-required") {
            return { ...base, authorization: { url: attachment.authorizationUrl } };
        }
        if (attachment?.kind === "unavailable") {
            return { ...base, problem: structuredClone(attachment.problem) };
        }
        if (attachment?.kind !== "active") return base;
        const catalog = attachment.executor.catalog;
        return {
            ...base,
            protocolVersion: catalog.protocolVersion,
            server: catalog.server ?? null,
            capabilities: catalog.capabilities,
            tools: catalog.tools.map(({ name: toolName }) => toolName).toSorted(),
            resources: catalog.resources.length,
            resourceTemplates: catalog.resourceTemplates.length,
            prompts: catalog.prompts.length,
        };
    }

    #overlayDefinitions(
        state: WorkspaceState,
        value: unknown,
    ): Map<string, McpServerDefinition> {
        if (value === undefined) return new Map();
        try {
            const bases = new Map(
                [...this.#available(state)]
                    .map(([alias, { definition }]) => [alias, definition]),
            );
            return overlayServerDefinitions(
                structuredClone(value) as McpConfigurationOverlay,
                bases,
            );
        } catch (cause) {
            throw actionError(
                "configuration-invalid",
                400,
                "Client MCP configuration is invalid.",
                { retryable: false },
                cause,
            );
        }
    }

    #list(
        workspaceId: number,
        overlay: unknown,
    ): { servers: Record<string, unknown>[] } {
        const snapshot = this.#snapshot(workspaceId);
        const available = this.#available(snapshot.state);
        const configured = this.#overlayDefinitions(snapshot.state, overlay);
        const summaries = new Map<string, Record<string, unknown>>(
            [...available].map(([alias, definition]) => [
                alias,
                this.#summary(alias, definition, snapshot.attachments.get(alias)),
            ]),
        );
        for (const [alias, definition] of configured) {
            if (available.has(alias)) continue;
            summaries.set(alias, this.#summary(alias, {
                definition,
                source: "client",
                enabled: false,
            }));
        }
        return {
            servers: [...summaries]
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([, summary]) => summary),
        };
    }

    #definition(params: Readonly<Record<string, unknown>>): McpServerDefinition {
        assertActionKeys(params, ["alias", "target", "options"]);
        const alias = requiredString(params, "alias");
        const target = requiredString(params, "target");
        try {
            const options = structuredClone(
                Validator.assertMcpServerOptions(
                    (params.options ?? {}) as McpServerOptions,
                ),
            );
            const definition: McpServerDefinition = /^https?:\/\//u.test(target)
                ? { name: alias, transport: "http", url: target, ...options }
                : {
                    name: alias,
                    transport: "stdio",
                    command: target,
                    ...options,
                    args: options.args ?? [],
                };
            return structuredClone(Validator.assertMcpServerDefinition(definition));
        } catch (cause) {
            throw actionError(
                "definition-invalid",
                400,
                `MCP server '${alias}' has an invalid target or options.`,
                { alias, retryable: false },
                cause,
            );
        }
    }

    async #add(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            const definition = this.#definition(params);
            const alias = definition.name;
            const snapshot = this.#snapshot(workspaceId);
            if (this.#available(snapshot.state).has(alias)) {
                throw actionError(
                    "server-exists",
                    409,
                    `MCP server alias '${alias}' is already available in this workspace.`,
                    { workspaceId, alias, retryable: false },
                );
            }
            const state = cloneState(snapshot.state);
            (state.servers as Record<string, ServerState>)[alias] = {
                kind: "workspace",
                definition,
                enabled: true,
            };
            const result = await this.#applyState(workspaceId, state, {
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workspaceId, alias, {
                    operation: "add",
                    expectedState: structuredClone(snapshot.state.servers[alias] ?? null),
                    expectedDefinition: null,
                    expectedEnabled: false,
                    definition: { definition, source: "workspace" },
                    connection: result.authorization.connection,
                    authorizationUrl: result.authorization.authorizationUrl,
                });
                return {
                    status: 202,
                    authorization: { url: result.authorization.authorizationUrl },
                };
            }
            const committed = this.#snapshot(workspaceId);
            const attached = committed.attachments.get(alias);
            if (attached === undefined || attached.kind === "unavailable") {
                throw new Error("Committed MCP attachment is absent.");
            }
            await this.#clearPending(workspaceId, alias, attached.connection);
            const available = this.#available(committed.state).get(alias);
            if (available === undefined) throw new Error("Committed MCP definition is absent.");
            return { status: 201, server: this.#summary(alias, available, attached) };
        });
    }

    #stateWithEnabled(
        state: WorkspaceState,
        alias: string,
        available: AvailableDefinition,
        enabled: boolean,
    ): WorkspaceState {
        const next = cloneState(state);
        if (available.source === "service") {
            (next.servers as Record<string, ServerState>)[alias] = { kind: "service", enabled };
            return next;
        }
        const current = next.servers[alias];
        if (current?.kind !== "workspace") {
            throw new Error(`Workspace MCP server '${alias}' has no owned definition.`);
        }
        (next.servers as Record<string, ServerState>)[alias] = { ...current, enabled };
        return next;
    }

    #stateWithDefinition(
        state: WorkspaceState,
        alias: string,
        definition: McpServerDefinition,
        enabled: boolean,
    ): WorkspaceState {
        const next = cloneState(state);
        (next.servers as Record<string, ServerState>)[alias] = this.#definitionSource(
            alias,
            definition,
        ) === "service"
            ? { kind: "service", enabled }
            : {
                kind: "workspace",
                definition: structuredClone(definition),
                enabled,
            };
        return next;
    }

    #definitionSource(
        alias: string,
        definition: McpServerDefinition,
    ): DefinitionSource {
        const service = this.#defaults.get(alias);
        return service !== undefined && sameDefinition(service, definition)
            ? "service"
            : "workspace";
    }

    #definitionWithOptions(
        definition: McpServerDefinition,
        value: unknown,
    ): McpServerDefinition {
        if (value === undefined) return structuredClone(definition);
        try {
            const options = structuredClone(
                Validator.assertMcpServerOptions(value as McpServerOptions),
            );
            return structuredClone(Validator.assertMcpServerDefinition({
                ...definition,
                ...options,
            } as McpServerDefinition));
        } catch (cause) {
            throw actionError(
                "definition-invalid",
                400,
                `MCP server '${definition.name}' has invalid enable options.`,
                { alias: definition.name, retryable: false },
                cause,
            );
        }
    }

    async #setEnabled(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
        enabled: boolean,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            assertActionKeys(params, enabled ? ["alias", "overlay", "options"] : ["alias"]);
            const alias = requiredString(params, "alias");
            const snapshot = this.#snapshot(workspaceId);
            const current = this.#available(snapshot.state).get(alias);
            const configured = enabled
                ? this.#overlayDefinitions(snapshot.state, params.overlay).get(alias)
                : undefined;
            if (current === undefined && configured === undefined) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server alias '${alias}' is not available in this workspace.`,
                    { workspaceId, alias, retryable: false },
                );
            }
            if (current === undefined && !enabled) throw new Error("Disabled MCP target is absent.");
            const candidate = configured ?? current?.definition;
            if (candidate === undefined) throw new Error("Enabled MCP target is absent.");
            const definition = enabled
                ? this.#definitionWithOptions(candidate, params.options)
                : structuredClone(candidate);
            const attachment = snapshot.attachments.get(alias);
            const retryUnavailable = enabled
                && current?.enabled === true
                && sameDefinition(current.definition, definition)
                && attachment?.kind === "unavailable";
            const definitionChanged = current === undefined
                || !sameDefinition(current.definition, definition);
            if (current?.enabled === enabled && !definitionChanged && !retryUnavailable) {
                if (attachment?.kind === "authorization-required") {
                    return {
                        status: 202,
                        authorization: { url: attachment.authorizationUrl },
                    };
                }
                return { status: 200, server: this.#summary(alias, current, attachment) };
            }
            const state = retryUnavailable
                ? cloneState(snapshot.state)
                : enabled
                    ? this.#stateWithDefinition(snapshot.state, alias, definition, true)
                    : this.#stateWithEnabled(
                        snapshot.state,
                        alias,
                        current as AvailableDefinition,
                        false,
                    );
            const result = await this.#applyState(workspaceId, state, {
                ...(retryUnavailable ? { force: new Set([alias]) } : {}),
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workspaceId, alias, {
                    operation: "enable",
                    expectedState: structuredClone(snapshot.state.servers[alias] ?? null),
                    expectedDefinition: structuredClone(current?.definition ?? null),
                    expectedEnabled: current?.enabled ?? false,
                    definition: {
                        definition: structuredClone(definition),
                        source: this.#definitionSource(alias, definition),
                    },
                    connection: result.authorization.connection,
                    authorizationUrl: result.authorization.authorizationUrl,
                });
                return {
                    status: 202,
                    authorization: { url: result.authorization.authorizationUrl },
                };
            }
            await this.#clearPending(workspaceId, alias);
            const committed = this.#snapshot(workspaceId);
            const committedDefinition = this.#available(committed.state).get(alias);
            if (committedDefinition === undefined) throw new Error("Committed MCP definition is absent.");
            return {
                status: 200,
                server: this.#summary(alias, committedDefinition, committed.attachments.get(alias)),
            };
        });
    }

    async #remove(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            assertActionKeys(params, ["alias"]);
            const alias = requiredString(params, "alias");
            const snapshot = this.#snapshot(workspaceId);
            const available = this.#available(snapshot.state).get(alias);
            if (available === undefined) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server alias '${alias}' is not available in this workspace.`,
                    { workspaceId, alias, retryable: false },
                );
            }
            if (available.source === "service") {
                throw actionError(
                    "server-service-owned",
                    409,
                    `MCP server alias '${alias}' is service-owned and can be disabled, not removed.`,
                    { workspaceId, alias, recovery: `Use workspace.mcp.disable for '${alias}'.`, retryable: false },
                );
            }
            const state = cloneState(snapshot.state);
            const service = this.#defaults.get(alias);
            if (service === undefined) {
                delete (state.servers as Record<string, ServerState>)[alias];
            } else {
                (state.servers as Record<string, ServerState>)[alias] = {
                    kind: "service",
                    enabled: false,
                };
            }
            await this.#applyState(workspaceId, state, {
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            await this.#clearPending(workspaceId, alias);
            return { status: 200, alias, removed: true };
        });
    }

    #oauthCompletionState(
        workspaceId: number,
        alias: string,
        pending: PendingMutation,
    ): WorkspaceState {
        const snapshot = this.#snapshot(workspaceId);
        const available = this.#available(snapshot.state).get(alias);
        const current = available?.definition ?? null;
        const expected = pending.expectedDefinition;
        if (
            !sameServerState(snapshot.state.servers[alias] ?? null, pending.expectedState)
            || (expected === null && current !== null)
            || (expected !== null && (current === null || !sameDefinition(expected, current)))
            || (available?.enabled ?? false) !== pending.expectedEnabled
        ) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                {
                    workspaceId,
                    alias,
                    recovery: "Start authorization again from the server's current definition.",
                    retryable: false,
                },
            );
        }
        if (pending.operation === "add") {
            const state = cloneState(snapshot.state);
            (state.servers as Record<string, ServerState>)[alias] = {
                kind: "workspace",
                definition: structuredClone(pending.definition.definition),
                enabled: true,
            };
            return state;
        }
        return this.#stateWithDefinition(
            snapshot.state,
            alias,
            pending.definition.definition,
            true,
        );
    }

    async #completeOAuth(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            assertActionKeys(params, ["alias", "callbackUrl"]);
            const alias = requiredString(params, "alias");
            const callbackUrl = requiredString(params, "callbackUrl");
            const key = this.#pendingKey(workspaceId, alias);
            const pending = this.#pending.get(key);
            if (pending === undefined) {
                // {§oauth-lifetime} — restart during pending authorization
                // surfaces as a factual not-pending state, never a secret replay.
                throw actionError(
                    "oauth-not-pending",
                    404,
                    `MCP server '${alias}' has no pending OAuth authorization.`,
                    { workspaceId, alias, retryable: false },
                );
            }
            if (pending.prepared === undefined) {
                try {
                    await pending.connection.finishAuthorization(callbackUrl);
                    const prepared = await this.#prepareAttachment(
                        workspaceId,
                        pending.definition,
                        pending.connection,
                    );
                    if (prepared.kind !== "active") {
                        throw new Error("OAuth completion returned another authorization challenge.");
                    }
                    pending.prepared = prepared;
                } catch (cause) {
                    throw actionError(
                        "oauth-callback-invalid",
                        400,
                        `OAuth authorization for MCP server '${alias}' could not be completed.`,
                        { workspaceId, alias, retryable: false },
                        cause,
                    );
                }
            }
            const state = this.#oauthCompletionState(workspaceId, alias, pending);
            await this.#applyState(workspaceId, state, {
                force: new Set([alias]),
                prepared: new Map([[alias, pending.prepared]]),
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            this.#pending.delete(key);
            pending.releaseWorkspace();
            const committed = this.#snapshot(workspaceId);
            const attached = committed.attachments.get(alias);
            if (attached === undefined || attached.kind !== "active") {
                throw new Error("Authorized MCP attachment is absent.");
            }
            const available = this.#available(committed.state).get(alias);
            if (available === undefined) throw new Error("Authorized MCP definition is absent.");
            return { status: 200, server: this.#summary(alias, available, attached) };
        });
    }

    async #complete(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
        assertActionKeys(params, ["server", "ref", "argument", "context"]);
        const server = requiredString(params, "server");
        const attachment = this.#snapshot(workspaceId).attachments.get(server);
        if (attachment === undefined || attachment.kind !== "active") {
            throw actionError(
                "server-not-connected",
                409,
                `MCP server '${server}' is not connected in this workspace.`,
                { workspaceId, name: server, retryable: false },
            );
        }
        const ref = objectOf(params.ref);
        const argument = objectOf(params.argument);
        if (ref === null || argument === null) {
            throw actionError(
                "completion-parameters-invalid",
                400,
                "MCP completion requires 'ref' and 'argument' objects.",
                { retryable: false },
            );
        }
        return attachment.connection.complete({
            ref: ref as never,
            argument: argument as never,
            ...(objectOf(params.context) === null ? {} : { context: params.context as never }),
        });
    }

    async #refreshCatalog(workspaceId: number, name: string): Promise<void> {
        const seam = this.#seam;
        if (seam === undefined) throw new Error("MCP module is not set up.");
        const snapshot = this.#workspaces.get(workspaceId);
        const attachment = snapshot?.attachments.get(name);
        if (snapshot === undefined || attachment === undefined || attachment.kind !== "active") return;

        const executor = new McpExecutor(
            { runtime: name, glyph: "🔌" },
            attachment.connection,
            () => this.#retain(workspaceId),
            {
                tools: attachment.definition.tools ?? null,
                read: attachment.definition.read ?? [],
            },
            this.#summaries.tools,
        );
        const availability = await executor.requireAvailable();
        const refreshed: ActiveAttachment = {
            ...attachment,
            executor,
            runtime: {
                namespaceOwner: OWNER,
                decl: runtimeDecl(name, serverSummary(name, executor.catalog, this.#summaries.servers.get(name)), this.#expanded.has(name)),
                executor,
                availability,
                scheme: new McpResources(name, attachment.connection, executor.catalog),
            },
        };
        const attachments = new Map(snapshot.attachments);
        attachments.set(name, refreshed);
        await seam.replaceWorkspaceCapabilities({
            workspaceId,
            namespaceOwner: OWNER,
            state: persistedState(snapshot.state),
            runtimes: [...attachments.values()].flatMap((candidate) =>
                candidate.kind === "active" ? [candidate.runtime] : []),
        });
        this.#workspaces.set(workspaceId, {
            state: cloneState(snapshot.state),
            attachments,
        });
    }

    #scheduleCatalogRefresh(workspaceId: number, name: string, attempt = 0): void {
        if (this.#closed) return;
        const key = this.#pendingKey(workspaceId, name);
        if (this.#refreshTimers.has(key)) return;
        const delay = Math.min(250 * (2 ** attempt), 5000);
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(key);
            void this.#serialize(workspaceId, async () => {
                await this.#refreshCatalog(workspaceId, name);
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

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        const closing = this.#closeOwned([...this.#connections]);
        await Promise.all([...this.#locks.values()]);
        this.#workspaces.clear();
        for (const pending of this.#pending.values()) pending.releaseWorkspace();
        this.#pending.clear();
        this.#retainWorkspace.clear();
        await closing;
    }
}
