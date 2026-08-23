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
import McpExecutor, { runtimeDecl, serverSummary } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";

const OWNER = "@plurnk/plurnk-mcp";
const STATE_VERSION = 1;
const NONEMPTY_STRING = { type: "string", minLength: 1 } as const;
const OPEN_OBJECT = { type: "object", additionalProperties: true } as const;
const MCP_OPTIONS = { $ref: "https://schemas.plurnk.dev/v0/McpServerOptions.json" } as const;
const MCP_OVERLAY = { $ref: "https://schemas.plurnk.dev/v0/McpConfigurationOverlay.json" } as const;
const actionInput = (
    properties: Readonly<Record<string, JsonSchema>>,
    required: readonly string[] = [],
): JsonSchema => ({
    type: "object",
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
    properties,
});
const actionOutput = (properties: Readonly<Record<string, JsonSchema>>): JsonSchema => ({
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        ...properties,
    },
});
const SERVER_OUTPUT = actionOutput({
    server: OPEN_OBJECT,
    authorization: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: { url: NONEMPTY_STRING },
    },
});

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
    registerWorkerCapabilityProvider(
        namespaceOwner: string,
        provider: {
            activate(context: {
                readonly workspaceId: number;
                readonly workerId: number;
                retain(): () => void;
            }): void | Promise<void>;
            deactivate(identity: {
                readonly workspaceId: number;
                readonly workerId: number;
            }): void | Promise<void>;
        },
    ): void;
    readWorkerModuleState(workerId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkerCapabilities(replacement: {
        readonly workspaceId: number;
        readonly workerId: number;
        readonly namespaceOwner: string;
        readonly state: unknown | null;
        readonly runtimes: readonly RuntimeRegistration[];
    }): Promise<void>;
}

interface ServiceState {
    readonly kind: "service";
    readonly enabled: boolean;
}

interface WorkerServerState {
    readonly kind: "worker";
    readonly definition: McpServerDefinition;
    readonly enabled: boolean;
}

type ServerState = ServiceState | WorkerServerState;

interface WorkerState {
    readonly version: typeof STATE_VERSION;
    readonly servers: Readonly<Record<string, ServerState>>;
}

type DefinitionSource = "service" | "worker";

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

interface WorkerSnapshot {
    readonly state: WorkerState;
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
    readonly releaseWorker: () => void;
    prepared?: ActiveAttachment;
}

type PendingMutationCandidate = Omit<PendingMutation, "releaseWorker">;

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

const emptyState = (): WorkerState => ({ version: STATE_VERSION, servers: {} });

const parseState = (source: unknown | null): WorkerState => {
    if (source === null) return emptyState();
    const state = objectOf(source);
    if (state === null) throw new Error("MCP worker state must be an object.");
    assertExactKeys(state, ["version", "servers"], "MCP worker state");
    if (state.version !== STATE_VERSION) {
        throw new Error(`MCP worker state version must be ${STATE_VERSION}.`);
    }
    const servers = objectOf(state.servers);
    if (servers === null) throw new Error("MCP worker state servers must be an object.");
    const parsed: Record<string, ServerState> = {};
    for (const [name, raw] of Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right))) {
        const value = objectOf(raw);
        if (value === null || (value.kind !== "service" && value.kind !== "worker")) {
            throw new Error(`MCP worker server '${name}' has an invalid state.`);
        }
        if (typeof value.enabled !== "boolean") {
            throw new Error(`MCP worker server '${name}' must declare boolean enabledness.`);
        }
        if (value.kind === "service") {
            assertExactKeys(value, ["kind", "enabled"], `MCP worker server '${name}'`);
            parsed[name] = { kind: "service", enabled: value.enabled };
            continue;
        }
        assertExactKeys(value, ["kind", "definition", "enabled"], `MCP worker server '${name}'`);
        const definition = structuredClone(
            Validator.assertMcpServerDefinition(value.definition as McpServerDefinition),
        );
        if (definition.name !== name) {
            throw new Error(`MCP worker server key '${name}' does not match definition '${definition.name}'.`);
        }
        parsed[name] = { kind: "worker", definition, enabled: value.enabled };
    }
    return { version: STATE_VERSION, servers: parsed };
};

const persistedState = (state: WorkerState): WorkerState | null =>
    Object.keys(state.servers).length === 0 ? null : state;

const cloneState = (state: WorkerState): WorkerState => parseState(structuredClone(state));

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

const workerIdentityOf = (
    context: ModuleActionContext,
): { workspaceId: number; workerId: number } => {
    if (context.scope !== "worker") {
        throw actionError("worker-context-required", 500, "MCP action received no worker context.");
    }
    return { workspaceId: context.workspaceId, workerId: context.workerId };
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
    readonly #workers = new Map<number, WorkerSnapshot>();
    readonly #workspaceByWorker = new Map<number, number>();
    // {§oauth-lifetime} — pending candidates are process-memory per
    // (worker, alias); a restart loses them by design.
    readonly #pending = new Map<string, PendingMutation>();
    readonly #locks = new Map<number, Promise<void>>();
    readonly #connections = new Set<ServerConnection>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
    readonly #retainWorker = new Map<number, () => () => void>();
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
        seam.registerWorkerCapabilityProvider(OWNER, {
            activate: async (context) => {
                const { workspaceId, workerId } = context;
                this.#workspaceByWorker.set(workerId, workspaceId);
                this.#retainWorker.set(workerId, () => context.retain());
                try {
                    await this.#serialize(workerId, async () => {
                        const state = parseState(await seam.readWorkerModuleState(workerId, OWNER));
                        await this.#applyState(workerId, state, {
                            authorizationDisposition: "publish-required",
                            preparationFailureDisposition: "publish-unavailable",
                        });
                    });
                } catch (cause) {
                    this.#retainWorker.delete(workerId);
                    this.#workspaceByWorker.delete(workerId);
                    throw cause;
                }
            },
            deactivate: async ({ workerId }) => this.#deactivate(workerId),
        });
        const action = (
            name: string,
            inputSchema: JsonSchema,
            outputSchema: JsonSchema,
            handler: (
                params: Readonly<Record<string, unknown>>,
                context: ModuleActionContext,
            ) => unknown | Promise<unknown>,
        ): void => seam.registerModuleAction({
            name,
            scope: "worker",
            inputSchema,
            outputSchema,
            handler,
        });
        action("worker.mcp.list", actionInput({ overlay: MCP_OVERLAY }), {
            type: "object",
            required: ["servers"],
            additionalProperties: false,
            properties: { servers: { type: "array", items: OPEN_OBJECT } },
        }, async (params, context) => {
            assertActionKeys(params, ["overlay"]);
            return this.#list(workerIdentityOf(context).workerId, params.overlay);
        });
        action("worker.mcp.add", actionInput({
            alias: NONEMPTY_STRING,
            target: NONEMPTY_STRING,
            options: MCP_OPTIONS,
        }, ["alias", "target"]), SERVER_OUTPUT, async (params, context) =>
            this.#add(workerIdentityOf(context).workerId, params));
        action("worker.mcp.enable", actionInput({
            alias: NONEMPTY_STRING,
            overlay: MCP_OVERLAY,
            options: MCP_OPTIONS,
        }, ["alias"]), SERVER_OUTPUT, async (params, context) =>
            this.#setEnabled(workerIdentityOf(context).workerId, params, true));
        action("worker.mcp.disable", actionInput({ alias: NONEMPTY_STRING }, ["alias"]), SERVER_OUTPUT, async (params, context) =>
            this.#setEnabled(workerIdentityOf(context).workerId, params, false));
        action("worker.mcp.remove", actionInput({ alias: NONEMPTY_STRING }, ["alias"]), actionOutput({
            alias: NONEMPTY_STRING,
            removed: { const: true },
        }), async (params, context) =>
            this.#remove(workerIdentityOf(context).workerId, params));
        action("worker.mcp.oauth.complete", actionInput({
            alias: NONEMPTY_STRING,
            callbackUrl: NONEMPTY_STRING,
        }, ["alias", "callbackUrl"]), SERVER_OUTPUT, async (params, context) =>
            this.#completeOAuth(workerIdentityOf(context).workerId, params));
        action("worker.mcp.complete", actionInput({
            server: NONEMPTY_STRING,
            ref: OPEN_OBJECT,
            argument: OPEN_OBJECT,
            context: OPEN_OBJECT,
        }, ["server", "ref", "argument"]), OPEN_OBJECT, async (params, context) =>
            this.#complete(workerIdentityOf(context).workerId, params));
    }

    #pendingKey(workerId: number, name: string): string {
        return `${workerId}:${name}`;
    }

    async #serialize<T>(workerId: number, run: () => Promise<T>): Promise<T> {
        this.#assertOpen();
        const prior = this.#locks.get(workerId) ?? Promise.resolve();
        let release = (): void => undefined;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const queued = prior.then(() => barrier, () => barrier);
        this.#locks.set(workerId, queued);
        await prior.catch(() => undefined);
        try {
            this.#assertOpen();
            return await run();
        } finally {
            release();
            if (this.#locks.get(workerId) === queued) this.#locks.delete(workerId);
        }
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("MCP module is closed.");
    }

    #retain(workerId: number): () => void {
        const retain = this.#retainWorker.get(workerId);
        if (retain === undefined) {
            throw new Error(`MCP worker ${workerId} has no Functionality residency context.`);
        }
        return retain();
    }

    #workspaceId(workerId: number): number {
        const workspaceId = this.#workspaceByWorker.get(workerId);
        if (workspaceId === undefined) {
            throw new Error(`MCP worker ${workerId} has no workspace identity.`);
        }
        return workspaceId;
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

    async #deactivate(workerId: number): Promise<void> {
        await this.#serialize(workerId, async () => {
            const pending = [...this.#pending.keys()]
                .filter((key) => key.startsWith(`${workerId}:`));
            if (pending.length > 0) {
                throw new Error(
                    `MCP worker ${workerId} cannot cool with pending OAuth residency.`,
                );
            }
            for (const [key, timer] of this.#refreshTimers) {
                if (!key.startsWith(`${workerId}:`)) continue;
                clearTimeout(timer);
                this.#refreshTimers.delete(key);
            }
            const snapshot = this.#workers.get(workerId);
            const connections = [...snapshot?.attachments.values() ?? []]
                .flatMap((attachment) => attachmentConnection(attachment) ?? []);
            this.#workers.delete(workerId);
            this.#retainWorker.delete(workerId);
            await this.#closeOwned(connections);
            this.#workspaceByWorker.delete(workerId);
        });
    }

    #available(state: WorkerState): Map<string, AvailableDefinition> {
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
                source: "worker",
                enabled: value.enabled,
            });
        }
        return new Map([...available].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    #enabled(state: WorkerState): Map<string, Omit<AvailableDefinition, "enabled">> {
        return new Map(
            [...this.#available(state)]
                .filter(([, value]) => value.enabled)
                .map(([name, { definition, source }]) => [name, { definition, source }]),
        );
    }

    async #prepareAttachment(
        workerId: number,
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
        workerId: number,
        state: WorkerState,
        options: {
            readonly force?: ReadonlySet<string>;
            readonly prepared?: ReadonlyMap<string, ActiveAttachment>;
            readonly authorizationDisposition: "defer-mutation" | "publish-required";
            readonly preparationFailureDisposition: "reject" | "publish-unavailable";
        },
    ): Promise<{ authorization?: AuthorizationAttachment }> {
        const seam = this.#seam;
        if (seam === undefined) throw new Error("MCP module is not set up.");
        const current = this.#workers.get(workerId);
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
                    attachment = supplied ?? await this.#prepareAttachment(workerId, definition);
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
                        `MCP server '${name}' unavailable during worker activation: ${failure.problem.detail}`,
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
                throw new AggregateError([cause, ...failures], "MCP worker preparation and cleanup failed.");
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
            await seam.replaceWorkerCapabilities({
                workspaceId: this.#workspaceId(workerId),
                workerId,
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
                throw new AggregateError([cause, ...failures], "MCP worker commit and cleanup failed.");
            }
            throw cause;
        }

        this.#workers.set(workerId, { state: cloneState(state), attachments: next });
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
                    { workerId, committed: true },
                    cause,
                );
            }
        }

        if (options.authorizationDisposition === "publish-required") {
            for (const [name, attachment] of next) {
                if (attachment.kind !== "authorization-required") continue;
                await this.#setPending(workerId, name, {
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
        workerId: number,
        name: string,
        pending: PendingMutationCandidate,
        closeExisting = true,
    ): Promise<void> {
        const key = this.#pendingKey(workerId, name);
        const existing = this.#pending.get(key);
        const next: PendingMutation = {
            ...pending,
            releaseWorker: this.#retain(workerId),
        };
        this.#pending.set(key, next);
        try {
            if (closeExisting && existing !== undefined && existing.connection !== next.connection) {
                await this.#closeOwned([existing.connection]);
            }
        } finally {
            existing?.releaseWorker();
        }
    }

    async #clearPending(
        workerId: number,
        name: string,
        retained?: ServerConnection,
    ): Promise<void> {
        const key = this.#pendingKey(workerId, name);
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        if (pending === undefined) return;
        if (pending.connection === retained) {
            pending.releaseWorker();
            return;
        }
        try {
            await this.#closeOwned([pending.connection]);
        } catch (cause) {
            throw actionError(
                "pending-authorization-close-failed",
                500,
                "The MCP capability change committed, but its superseded authorization request did not close cleanly.",
                { workerId, name, committed: true },
                cause,
            );
        } finally {
            pending.releaseWorker();
        }
    }

    #snapshot(workerId: number): WorkerSnapshot {
        const snapshot = this.#workers.get(workerId);
        if (snapshot === undefined) {
            throw actionError(
                "worker-not-active",
                409,
                "MCP capabilities have not been activated for this worker.",
                { workerId, recovery: "Retry after worker activation completes." },
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
        state: WorkerState,
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
        workerId: number,
        overlay: unknown,
    ): { servers: Record<string, unknown>[] } {
        const snapshot = this.#snapshot(workerId);
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
        workerId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workerId, async () => {
            const definition = this.#definition(params);
            const alias = definition.name;
            const snapshot = this.#snapshot(workerId);
            if (this.#available(snapshot.state).has(alias)) {
                throw actionError(
                    "server-exists",
                    409,
                    `MCP server alias '${alias}' is already available to this worker.`,
                    { workerId, alias, retryable: false },
                );
            }
            const state = cloneState(snapshot.state);
            (state.servers as Record<string, ServerState>)[alias] = {
                kind: "worker",
                definition,
                enabled: true,
            };
            const result = await this.#applyState(workerId, state, {
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workerId, alias, {
                    operation: "add",
                    expectedState: structuredClone(snapshot.state.servers[alias] ?? null),
                    expectedDefinition: null,
                    expectedEnabled: false,
                    definition: { definition, source: "worker" },
                    connection: result.authorization.connection,
                    authorizationUrl: result.authorization.authorizationUrl,
                });
                return {
                    status: 202,
                    authorization: { url: result.authorization.authorizationUrl },
                };
            }
            const committed = this.#snapshot(workerId);
            const attached = committed.attachments.get(alias);
            if (attached === undefined || attached.kind === "unavailable") {
                throw new Error("Committed MCP attachment is absent.");
            }
            await this.#clearPending(workerId, alias, attached.connection);
            const available = this.#available(committed.state).get(alias);
            if (available === undefined) throw new Error("Committed MCP definition is absent.");
            return { status: 201, server: this.#summary(alias, available, attached) };
        });
    }

    #stateWithEnabled(
        state: WorkerState,
        alias: string,
        available: AvailableDefinition,
        enabled: boolean,
    ): WorkerState {
        const next = cloneState(state);
        if (available.source === "service") {
            (next.servers as Record<string, ServerState>)[alias] = { kind: "service", enabled };
            return next;
        }
        const current = next.servers[alias];
        if (current?.kind !== "worker") {
            throw new Error(`Worker MCP server '${alias}' has no owned definition.`);
        }
        (next.servers as Record<string, ServerState>)[alias] = { ...current, enabled };
        return next;
    }

    #stateWithDefinition(
        state: WorkerState,
        alias: string,
        definition: McpServerDefinition,
        enabled: boolean,
    ): WorkerState {
        const next = cloneState(state);
        (next.servers as Record<string, ServerState>)[alias] = this.#definitionSource(
            alias,
            definition,
        ) === "service"
            ? { kind: "service", enabled }
            : {
                kind: "worker",
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
            : "worker";
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
        workerId: number,
        params: Readonly<Record<string, unknown>>,
        enabled: boolean,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workerId, async () => {
            assertActionKeys(params, enabled ? ["alias", "overlay", "options"] : ["alias"]);
            const alias = requiredString(params, "alias");
            const snapshot = this.#snapshot(workerId);
            const current = this.#available(snapshot.state).get(alias);
            const configured = enabled
                ? this.#overlayDefinitions(snapshot.state, params.overlay).get(alias)
                : undefined;
            if (current === undefined && configured === undefined) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server alias '${alias}' is not available to this worker.`,
                    { workerId, alias, retryable: false },
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
            const result = await this.#applyState(workerId, state, {
                ...(retryUnavailable ? { force: new Set([alias]) } : {}),
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workerId, alias, {
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
            await this.#clearPending(workerId, alias);
            const committed = this.#snapshot(workerId);
            const committedDefinition = this.#available(committed.state).get(alias);
            if (committedDefinition === undefined) throw new Error("Committed MCP definition is absent.");
            return {
                status: 200,
                server: this.#summary(alias, committedDefinition, committed.attachments.get(alias)),
            };
        });
    }

    async #remove(
        workerId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workerId, async () => {
            assertActionKeys(params, ["alias"]);
            const alias = requiredString(params, "alias");
            const snapshot = this.#snapshot(workerId);
            const available = this.#available(snapshot.state).get(alias);
            if (available === undefined) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server alias '${alias}' is not available to this worker.`,
                    { workerId, alias, retryable: false },
                );
            }
            if (available.source === "service") {
                throw actionError(
                    "server-service-owned",
                    409,
                    `MCP server alias '${alias}' is service-owned and can be disabled, not removed.`,
                    { workerId, alias, recovery: `Use worker.mcp.disable for '${alias}'.`, retryable: false },
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
            await this.#applyState(workerId, state, {
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            await this.#clearPending(workerId, alias);
            return { status: 200, alias, removed: true };
        });
    }

    #oauthCompletionState(
        workerId: number,
        alias: string,
        pending: PendingMutation,
    ): WorkerState {
        const snapshot = this.#snapshot(workerId);
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
                    workerId,
                    alias,
                    recovery: "Start authorization again from the server's current definition.",
                    retryable: false,
                },
            );
        }
        if (pending.operation === "add") {
            const state = cloneState(snapshot.state);
            (state.servers as Record<string, ServerState>)[alias] = {
                kind: "worker",
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
        workerId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workerId, async () => {
            assertActionKeys(params, ["alias", "callbackUrl"]);
            const alias = requiredString(params, "alias");
            const callbackUrl = requiredString(params, "callbackUrl");
            const key = this.#pendingKey(workerId, alias);
            const pending = this.#pending.get(key);
            if (pending === undefined) {
                // {§oauth-lifetime} — restart during pending authorization
                // surfaces as a factual not-pending state, never a secret replay.
                throw actionError(
                    "oauth-not-pending",
                    404,
                    `MCP server '${alias}' has no pending OAuth authorization.`,
                    { workerId, alias, retryable: false },
                );
            }
            if (pending.prepared === undefined) {
                try {
                    await pending.connection.finishAuthorization(callbackUrl);
                    const prepared = await this.#prepareAttachment(
                        workerId,
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
                        { workerId, alias, retryable: false },
                        cause,
                    );
                }
            }
            const state = this.#oauthCompletionState(workerId, alias, pending);
            await this.#applyState(workerId, state, {
                force: new Set([alias]),
                prepared: new Map([[alias, pending.prepared]]),
                authorizationDisposition: "defer-mutation",
                preparationFailureDisposition: "reject",
            });
            this.#pending.delete(key);
            pending.releaseWorker();
            const committed = this.#snapshot(workerId);
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
        workerId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
        assertActionKeys(params, ["server", "ref", "argument", "context"]);
        const server = requiredString(params, "server");
        const attachment = this.#snapshot(workerId).attachments.get(server);
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

    async #refreshCatalog(workerId: number, name: string): Promise<void> {
        const seam = this.#seam;
        if (seam === undefined) throw new Error("MCP module is not set up.");
        const snapshot = this.#workers.get(workerId);
        const attachment = snapshot?.attachments.get(name);
        if (snapshot === undefined || attachment === undefined || attachment.kind !== "active") return;

        const executor = new McpExecutor(
            { runtime: name, glyph: "🔌" },
            attachment.connection,
            () => this.#retain(workerId),
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
        await seam.replaceWorkerCapabilities({
            workspaceId: this.#workspaceId(workerId),
            workerId,
            namespaceOwner: OWNER,
            state: persistedState(snapshot.state),
            runtimes: [...attachments.values()].flatMap((candidate) =>
                candidate.kind === "active" ? [candidate.runtime] : []),
        });
        this.#workers.set(workerId, {
            state: cloneState(snapshot.state),
            attachments,
        });
    }

    #scheduleCatalogRefresh(workerId: number, name: string, attempt = 0): void {
        if (this.#closed) return;
        const key = this.#pendingKey(workerId, name);
        if (this.#refreshTimers.has(key)) return;
        const delay = Math.min(250 * (2 ** attempt), 5000);
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(key);
            void this.#serialize(workerId, async () => {
                await this.#refreshCatalog(workerId, name);
            }).catch((error: unknown) => {
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
        await Promise.all([...this.#locks.values()]);
        this.#workers.clear();
        for (const pending of this.#pending.values()) pending.releaseWorker();
        this.#pending.clear();
        this.#retainWorker.clear();
        this.#workspaceByWorker.clear();
        await closing;
    }
}
