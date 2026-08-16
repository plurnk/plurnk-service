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
    type McpServerDefinition,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import {
    SdkError,
    SdkErrorCode,
} from "@modelcontextprotocol/client";
import ServerConnection, { AuthorizationRequiredError } from "./client.ts";
import { serviceDefinitions } from "./config.ts";
import McpExecutor, { runtimeDecl } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

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
        provider: { hydrate(workspaceId: number): void | Promise<void> },
    ): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkspaceCapabilities(replacement: {
        readonly workspaceId: number;
        readonly namespaceOwner: string;
        readonly state: unknown | null;
        readonly runtimes: readonly RuntimeRegistration[];
    }): Promise<void>;
}

interface AttachedState {
    readonly kind: "attached";
    readonly definition: McpServerDefinition;
}

interface DetachedState {
    readonly kind: "detached";
}

type ServerState = AttachedState | DetachedState;

interface WorkspaceState {
    readonly version: typeof STATE_VERSION;
    readonly servers: Readonly<Record<string, ServerState>>;
}

type DefinitionSource = "service" | "workspace";

interface EffectiveDefinition {
    readonly definition: McpServerDefinition;
    readonly source: DefinitionSource;
}

interface ActiveAttachment extends EffectiveDefinition {
    readonly kind: "active";
    readonly connection: ServerConnection;
    readonly executor: McpExecutor;
    readonly runtime: RuntimeRegistration;
}

interface AuthorizationAttachment extends EffectiveDefinition {
    readonly kind: "authorization-required";
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
}

type Attachment = ActiveAttachment | AuthorizationAttachment;

interface WorkspaceSnapshot {
    readonly state: WorkspaceState;
    readonly attachments: ReadonlyMap<string, Attachment>;
}

interface PendingMutation {
    readonly operation: "attach" | "replace" | "reconnect";
    readonly expectedDefinition: McpServerDefinition | null;
    readonly definition: EffectiveDefinition;
    readonly connection: ServerConnection;
    readonly authorizationUrl: string;
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
        retryable: status === 409 || status >= 500,
        ...extensions,
    }),
    cause,
);

const errorsOf = (error: unknown): unknown[] =>
    error instanceof AggregateError ? [...error.errors] : [error];

const errorTreeSome = (
    error: unknown,
    predicate: (candidate: unknown) => boolean,
    seen = new Set<unknown>(),
): boolean => {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
        return predicate(error);
    }
    if (seen.has(error)) return false;
    seen.add(error);
    if (predicate(error)) return true;
    if (error instanceof AggregateError) {
        return [...error.errors].some((candidate) => errorTreeSome(candidate, predicate, seen));
    }
    return error instanceof Error && error.cause !== undefined
        ? errorTreeSome(error.cause, predicate, seen)
        : false;
};

const lacksRequiredProtocolRevision = (error: unknown): boolean => errorTreeSome(
    error,
    (candidate) => SdkError.isInstance(candidate)
        && candidate.code === SdkErrorCode.EraNegotiationFailed
        && candidate.message.includes("the server did not offer pinned protocol version")
        && candidate.message.includes("via server/discover"),
);

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
    if (lacksRequiredProtocolRevision(cause)) {
        return actionError(
            "protocol-revision-unsupported",
            502,
            `MCP server '${definition.name}' did not offer required revision ${MCP_PROTOCOL_VERSION} through server/discover; upgrade or replace the legacy endpoint.`,
            {
                server: definition.name,
                transport: definition.transport,
                requiredRevision: MCP_PROTOCOL_VERSION,
                requiredMethod: "server/discover",
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
        if (value === null || (value.kind !== "attached" && value.kind !== "detached")) {
            throw new Error(`MCP workspace server '${name}' has an invalid state.`);
        }
        if (value.kind === "detached") {
            assertExactKeys(value, ["kind"], `MCP workspace server '${name}'`);
            parsed[name] = { kind: "detached" };
            continue;
        }
        assertExactKeys(value, ["kind", "definition"], `MCP workspace server '${name}'`);
        const definition = structuredClone(
            Validator.assertMcpServerDefinition(value.definition as McpServerDefinition),
        );
        if (definition.name !== name) {
            throw new Error(`MCP workspace server key '${name}' does not match definition '${definition.name}'.`);
        }
        parsed[name] = { kind: "attached", definition };
    }
    return { version: STATE_VERSION, servers: parsed };
};

const persistedState = (state: WorkspaceState): WorkspaceState | null =>
    Object.keys(state.servers).length === 0 ? null : state;

const cloneState = (state: WorkspaceState): WorkspaceState => parseState(structuredClone(state));

const sameDefinition = (left: McpServerDefinition, right: McpServerDefinition): boolean =>
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
    readonly #defaults: ReadonlyMap<string, McpServerDefinition>;
    readonly #workspaces = new Map<number, WorkspaceSnapshot>();
    readonly #pending = new Map<string, PendingMutation>();
    readonly #locks = new Map<number, Promise<void>>();
    readonly #refreshTimers = new Map<string, NodeJS.Timeout>();
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
    }

    async setup(seam: ModuleSetupSeam): Promise<void> {
        this.#seam = seam;
        seam.registerWorkspaceCapabilityProvider(OWNER, {
            hydrate: async (workspaceId) => this.#serialize(workspaceId, async () => {
                const state = parseState(await seam.readWorkspaceModuleState(workspaceId, OWNER));
                await this.#applyState(workspaceId, state, {
                    authorizationDisposition: "publish-required",
                });
            }),
        });
        const action = (
            name: string,
            handler: (
                params: Readonly<Record<string, unknown>>,
                context: ModuleActionContext,
            ) => unknown | Promise<unknown>,
        ): void => seam.registerModuleAction({ name, scope: "workspace", handler });
        action("workspace.mcp.list", async (_params, context) =>
            this.#list(workspaceIdOf(context)));
        action("workspace.mcp.attach", async (params, context) =>
            this.#change("attach", workspaceIdOf(context), params));
        action("workspace.mcp.replace", async (params, context) =>
            this.#change("replace", workspaceIdOf(context), params));
        action("workspace.mcp.detach", async (params, context) =>
            this.#detach(workspaceIdOf(context), params));
        action("workspace.mcp.reconnect", async (params, context) =>
            this.#reconnect(workspaceIdOf(context), params));
        action("workspace.mcp.oauth.complete", async (params, context) =>
            this.#completeOAuth(workspaceIdOf(context), params));
        action("workspace.mcp.complete", async (params, context) =>
            this.#complete(workspaceIdOf(context), params));
    }

    #pendingKey(workspaceId: number, name: string): string {
        return `${workspaceId}:${name}`;
    }

    async #serialize<T>(workspaceId: number, run: () => Promise<T>): Promise<T> {
        const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
        let release = (): void => undefined;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const queued = prior.then(() => barrier, () => barrier);
        this.#locks.set(workspaceId, queued);
        await prior.catch(() => undefined);
        try {
            return await run();
        } finally {
            release();
            if (this.#locks.get(workspaceId) === queued) this.#locks.delete(workspaceId);
        }
    }

    #effective(state: WorkspaceState): Map<string, EffectiveDefinition> {
        const effective = new Map<string, EffectiveDefinition>(
            [...this.#defaults].map(([name, definition]) => [
                name,
                { definition: structuredClone(definition), source: "service" as const },
            ]),
        );
        for (const [name, value] of Object.entries(state.servers)) {
            if (value.kind === "detached") effective.delete(name);
            else effective.set(name, {
                definition: structuredClone(value.definition),
                source: "workspace",
            });
        }
        return new Map([...effective].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    async #prepareAttachment(
        workspaceId: number,
        effective: EffectiveDefinition,
        connection?: ServerConnection,
    ): Promise<Attachment> {
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
        const executor = new McpExecutor(
            { runtime: definition.name, glyph: "🔌" },
            candidate,
            { tools: definition.tools ?? null, read: definition.read ?? [] },
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
                    decl: runtimeDecl(definition.name),
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
                await candidate.close();
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
        },
    ): Promise<{ authorization?: AuthorizationAttachment }> {
        const seam = this.#seam;
        if (seam === undefined) throw new Error("MCP module is not set up.");
        const current = this.#workspaces.get(workspaceId);
        const effective = this.#effective(state);
        const force = options.force ?? new Set<string>();
        for (const [name, attachment] of current?.attachments ?? []) {
            const next = effective.get(name);
            if (
                next === undefined
                || force.has(name)
                || !sameDefinition(attachment.definition, next.definition)
            ) attachment.connection.assertReplaceable();
        }

        const next = new Map<string, Attachment>();
        const fresh: Attachment[] = [];
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
                const attachment = supplied ?? await this.#prepareAttachment(workspaceId, definition);
                next.set(name, attachment);
                fresh.push(attachment);
            }
        } catch (cause) {
            const cleanup = await Promise.allSettled(fresh.map(({ connection }) => connection.close()));
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
            await closeConnections(discard.map(({ connection }) => connection));
            return { authorization };
        }

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
            const cleanup = await Promise.allSettled(fresh.map(({ connection }) => connection.close()));
            const failures = cleanup.flatMap((result) =>
                result.status === "rejected" ? errorsOf(result.reason) : []);
            if (failures.length > 0) {
                throw new AggregateError([cause, ...failures], "MCP workspace commit and cleanup failed.");
            }
            throw cause;
        }

        this.#workspaces.set(workspaceId, { state: cloneState(state), attachments: next });
        const retained = new Set([...next.values()].map(({ connection }) => connection));
        const obsolete = [...current?.attachments.values() ?? []]
            .map(({ connection }) => connection)
            .filter((connection) => !retained.has(connection));
        if (obsolete.length > 0) {
            try {
                await closeConnections(obsolete);
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
                    operation: "reconnect",
                    expectedDefinition: structuredClone(attachment.definition),
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
        pending: PendingMutation,
        closeExisting = true,
    ): Promise<void> {
        const key = this.#pendingKey(workspaceId, name);
        const existing = this.#pending.get(key);
        this.#pending.set(key, pending);
        if (closeExisting && existing !== undefined && existing.connection !== pending.connection) {
            await existing.connection.close();
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
        if (pending === undefined || pending.connection === retained) return;
        try {
            await pending.connection.close();
        } catch (cause) {
            throw actionError(
                "pending-authorization-close-failed",
                500,
                "The MCP capability change committed, but its superseded authorization request did not close cleanly.",
                { workspaceId, name, committed: true },
                cause,
            );
        }
    }

    #snapshot(workspaceId: number): WorkspaceSnapshot {
        const snapshot = this.#workspaces.get(workspaceId);
        if (snapshot === undefined) {
            throw actionError(
                "workspace-not-hydrated",
                409,
                "MCP capabilities have not been hydrated for this workspace.",
                { workspaceId, recovery: "Retry after workspace initialization completes." },
            );
        }
        return snapshot;
    }

    #summary(name: string, attachment: Attachment): Record<string, unknown> {
        const definition = attachment.definition;
        const base = {
            name,
            source: attachment.source,
            transport: definition.transport,
            state: attachment.kind === "active" ? "connected" : "authorization-required",
            enabledTools: definition.tools ?? null,
            read: definition.read ?? [],
        };
        if (attachment.kind !== "active") return base;
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

    #list(workspaceId: number): { servers: Record<string, unknown>[] } {
        const snapshot = this.#snapshot(workspaceId);
        return {
            servers: [...snapshot.attachments]
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([name, attachment]) => this.#summary(name, attachment)),
        };
    }

    #definition(params: Readonly<Record<string, unknown>>): McpServerDefinition {
        try {
            return structuredClone(
                Validator.assertMcpServerDefinition(params.server as McpServerDefinition),
            );
        } catch (cause) {
            throw actionError(
                "definition-invalid",
                400,
                "The MCP server definition is invalid.",
                { field: "server", retryable: false },
                cause,
            );
        }
    }

    async #change(
        operation: "attach" | "replace",
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            const definition = this.#definition(params);
            const snapshot = this.#snapshot(workspaceId);
            const effective = this.#effective(snapshot.state);
            const exists = effective.has(definition.name);
            if (operation === "attach" ? exists : !exists) {
                throw actionError(
                    operation === "attach" ? "server-exists" : "server-not-found",
                    operation === "attach" ? 409 : 404,
                    operation === "attach"
                        ? `MCP server '${definition.name}' is already attached to this workspace.`
                        : `MCP server '${definition.name}' is not attached to this workspace.`,
                    { workspaceId, name: definition.name, retryable: false },
                );
            }
            const state = cloneState(snapshot.state);
            (state.servers as Record<string, ServerState>)[definition.name] = {
                kind: "attached",
                definition,
            };
            const result = await this.#applyState(workspaceId, state, {
                force: new Set([definition.name]),
                authorizationDisposition: "defer-mutation",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workspaceId, definition.name, {
                    operation,
                    expectedDefinition: exists
                        ? structuredClone(effective.get(definition.name)?.definition ?? null)
                        : null,
                    definition: { definition, source: "workspace" },
                    connection: result.authorization.connection,
                    authorizationUrl: result.authorization.authorizationUrl,
                });
                return {
                    status: 202,
                    authorization: { url: result.authorization.authorizationUrl },
                };
            }
            const attached = this.#snapshot(workspaceId).attachments.get(definition.name);
            if (attached === undefined) throw new Error("Committed MCP attachment is absent.");
            await this.#clearPending(workspaceId, definition.name, attached.connection);
            return { status: operation === "attach" ? 201 : 200, server: this.#summary(definition.name, attached) };
        });
    }

    async #detach(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            const name = requiredString(params, "name");
            const snapshot = this.#snapshot(workspaceId);
            if (!this.#effective(snapshot.state).has(name)) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server '${name}' is not attached to this workspace.`,
                    { workspaceId, name, retryable: false },
                );
            }
            const state = cloneState(snapshot.state);
            if (this.#defaults.has(name)) {
                (state.servers as Record<string, ServerState>)[name] = { kind: "detached" };
            } else {
                delete (state.servers as Record<string, ServerState>)[name];
            }
            await this.#applyState(workspaceId, state, {
                force: new Set([name]),
                authorizationDisposition: "defer-mutation",
            });
            await this.#clearPending(workspaceId, name);
            return { status: 200, name, detached: true };
        });
    }

    async #reconnect(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            const name = requiredString(params, "name");
            const snapshot = this.#snapshot(workspaceId);
            const definition = this.#effective(snapshot.state).get(name);
            if (definition === undefined) {
                throw actionError(
                    "server-not-found",
                    404,
                    `MCP server '${name}' is not attached to this workspace.`,
                    { workspaceId, name, retryable: false },
                );
            }
            const result = await this.#applyState(workspaceId, snapshot.state, {
                force: new Set([name]),
                authorizationDisposition: "defer-mutation",
            });
            if (result.authorization !== undefined) {
                await this.#setPending(workspaceId, name, {
                    operation: "reconnect",
                    expectedDefinition: structuredClone(definition.definition),
                    definition,
                    connection: result.authorization.connection,
                    authorizationUrl: result.authorization.authorizationUrl,
                });
                return {
                    status: 202,
                    authorization: { url: result.authorization.authorizationUrl },
                };
            }
            const attached = this.#snapshot(workspaceId).attachments.get(name);
            if (attached === undefined) throw new Error("Reconnected MCP attachment is absent.");
            await this.#clearPending(workspaceId, name, attached.connection);
            return { status: 200, server: this.#summary(name, attached) };
        });
    }

    #oauthCompletionState(
        workspaceId: number,
        name: string,
        pending: PendingMutation,
    ): WorkspaceState {
        const snapshot = this.#snapshot(workspaceId);
        const current = this.#effective(snapshot.state).get(name)?.definition ?? null;
        const expected = pending.expectedDefinition;
        if (
            (expected === null && current !== null)
            || (expected !== null && (current === null || !sameDefinition(expected, current)))
        ) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${name}' changed while its OAuth authorization was pending.`,
                {
                    workspaceId,
                    name,
                    recovery: "Start authorization again from the server's current definition.",
                    retryable: false,
                },
            );
        }
        const state = cloneState(snapshot.state);
        if (pending.operation === "attach" || pending.operation === "replace") {
            (state.servers as Record<string, ServerState>)[name] = {
                kind: "attached",
                definition: structuredClone(pending.definition.definition),
            };
        }
        return state;
    }

    async #completeOAuth(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
        return this.#serialize(workspaceId, async () => {
            const name = requiredString(params, "name");
            const callbackUrl = requiredString(params, "callbackUrl");
            const key = this.#pendingKey(workspaceId, name);
            const pending = this.#pending.get(key);
            if (pending === undefined) {
                throw actionError(
                    "oauth-not-pending",
                    404,
                    `MCP server '${name}' has no pending OAuth authorization.`,
                    { workspaceId, name, retryable: false },
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
                        `OAuth authorization for MCP server '${name}' could not be completed.`,
                        { workspaceId, name, retryable: false },
                        cause,
                    );
                }
            }
            const state = this.#oauthCompletionState(workspaceId, name, pending);
            await this.#applyState(workspaceId, state, {
                force: new Set([name]),
                prepared: new Map([[name, pending.prepared]]),
                authorizationDisposition: "defer-mutation",
            });
            this.#pending.delete(key);
            const attached = this.#snapshot(workspaceId).attachments.get(name);
            if (attached === undefined) throw new Error("Authorized MCP attachment is absent.");
            return { status: 200, server: this.#summary(name, attached) };
        });
    }

    async #complete(
        workspaceId: number,
        params: Readonly<Record<string, unknown>>,
    ): Promise<unknown> {
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
            {
                tools: attachment.definition.tools ?? null,
                read: attachment.definition.read ?? [],
            },
        );
        const availability = await executor.requireAvailable();
        const refreshed: ActiveAttachment = {
            ...attachment,
            executor,
            runtime: {
                namespaceOwner: OWNER,
                decl: runtimeDecl(name),
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
        const connections = new Set<ServerConnection>();
        for (const snapshot of this.#workspaces.values()) {
            for (const attachment of snapshot.attachments.values()) {
                connections.add(attachment.connection);
            }
        }
        for (const pending of this.#pending.values()) connections.add(pending.connection);
        this.#workspaces.clear();
        this.#pending.clear();
        await closeConnections([...connections]);
    }
}
