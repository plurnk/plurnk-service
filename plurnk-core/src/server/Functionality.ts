// {§functionality-coordinator} — the one owner of the workspace Functionality
// lifecycle above the family adapters (Agent Skills, MCP). It owns
// durable workspace state, lifecycle ordering, serialization, atomic
// publication, and both projections: workspace-scoped client actions and a
// generated runtime whose host verbs propose. An explicit
// client mutation and an accepted model proposal converge on `invoke`.
import { Validator, isRecord } from "@plurnk/plurnk-contracts";
import discoverySchema from "@plurnk/plurnk-contracts/schema/FunctionalityDiscoverQuery.json" with { type: "json" };
import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";
import { DocFile } from "@plurnk/plurnk-execs";
import type {
    FunctionalityDefinitionState,
    FunctionalityDiscoverInput,
    FunctionalityDiscoverResult,
    FunctionalityListResult,
    FunctionalityPreparationActivity,
    FunctionalityProvenance,
    JsonSchema,
    Notice,
    FunctionalityAdmission,
    FunctionalityCaller,
    FunctionalityFamilyHandle,
    FunctionalityIdentity,
    FunctionalityOutcome,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityPreparedDefinition,
    WorkspaceCapabilityIdentity,
    WorkspaceCapabilityGate
} from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { FunctionalityDiscovery, ModuleActionRegistration } from "@plurnk/plurnk-modules";
import type {
    HostFunctionalityAdapter,
    WorkspaceCapabilityProvider,
    WorkspaceCapabilityReplacement,
    WorkspaceCapabilityPublication,
} from "./ModuleHost.ts";
import {
    FUNCTIONALITY_VERBS,
    type FunctionalityFamilyEntry,
    type FunctionalityVerb,
} from "./FunctionalityManager.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import { generatedPathname } from "../core/plurnk-uri.ts";

export interface FunctionalityHost {
    readonly signal: AbortSignal;
    registerModuleAction(registration: ModuleActionRegistration): void;
    registerWorkspaceCapabilityProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown>;
    replaceWorkspaceCapabilities(
        replacement: WorkspaceCapabilityReplacement,
        options?: WorkspaceCapabilityPublication,
    ): Promise<void>;
    // {§functionality-coordinator} — a session-scoped family's durable value: the same shape, keyed by the
    // Session, replaced without runtimes and without workspace exclusivity.
    readSessionModuleState(sessionId: number, namespaceOwner: string): Promise<unknown>;
    replaceSessionModuleState(sessionId: number, namespaceOwner: string, state: unknown): Promise<void>;
    withWorkspaceGate<T>(workspaceId: number, namespaceOwner: string, gate: WorkspaceCapabilityGate, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    atWorkspaceBoundary<T>(workspaceId: number, run: () => Promise<T>): Promise<T>;
    retainWorkspace(workspaceId: number): () => void;
    preparationChanged(workspaceId: number, preparation: readonly FunctionalityPreparationActivity[]): void;
}

// "action": an explicit client action under user authority — publishes now,
// rejects a failed preparation, 409 when the workspace is held. "operation": an
// ordered command inside a turn — publication yields that turn's shared lease.
// Replacement preserves the preceding publication
// on refusal for both callers ({§functionality-replacement}).
export type { FunctionalityCaller };

export interface FunctionalityInvocation {
    readonly status: number;
    readonly body: unknown;
}

export interface FunctionalityInvocationOptions {
    readonly onAuthorizationRequired?: (aliases: readonly string[]) => void;
}

// Who OWNS a definition, not where it is scoped. A family declares the scope its definitions
// belong to ({§functionality-coordinator}); the locally-owned origin follows from it, so a session-scoped
// family's own entries say "session" rather than claiming the workspace set them.
type Origin = "service" | "workspace" | "session";

interface DefinitionRecord {
    readonly origin: Origin;
    readonly definition?: object;
    readonly enabled: boolean;
    // {§functionality-coordinator} — the Session a copied entry came from at this Session's creation. Written
    // by the copy, never by a verb: a mutation makes the entry the Session's own and drops it.
    readonly inherited?: string;
}

// {§functionality-coordinator} — one durable value per (workspace, family) in
// `workspace_module_state` under the adapter's namespace owner, or per (session, family) in
// `session_module_state` for a session-scoped family ({§functionality-coordinator}). Service-origin
// aliases persist only enabledness; locally-owned aliases persist the exact definition.
// Sessions reference workspace state without copying it.
interface FamilyState {
    readonly version: 1;
    readonly definitions: Readonly<Record<string, DefinitionRecord>>;
}

interface EffectiveDefinition {
    readonly alias: string;
    readonly origin: Origin;
    readonly definition: object;
    readonly enabled: boolean;
    readonly inherited?: string;
    readonly provenance?: FunctionalityProvenance;
    readonly context?: object;
}

// What one mutation decided: the next state, the aliases it concerned (one, or every definition an
// addressing family's add admitted), its committed status, and the admissions preparation receives.
interface Transition {
    readonly definitions: Record<string, DefinitionRecord>;
    readonly aliases: readonly string[];
    readonly status: 200 | 201;
    readonly removed: boolean;
    readonly admissions: readonly FunctionalityAdmission[];
}

interface AuthorizationWaiter {
    readonly adapter: HostFunctionalityAdapter;
    readonly verb: FunctionalityVerb;
    readonly identity: FunctionalityIdentity;
    readonly transition: Transition;
    readonly resolve: (invocation: FunctionalityInvocation) => void;
    readonly reject: (reason: unknown) => void;
}

export interface FunctionalityConfigurationFailure {
    readonly phase: "resolution" | "preparation";
    readonly error: ConfigurationError;
}

interface WorkspaceFamily {
    state: FamilyState;
    prepared: FunctionalityPrepared<RuntimeRegistration> | null;
    // The enabled definitions that publication prepared ({§functionality-inspection}).
    enabled: ReadonlyMap<string, FunctionalityPreparedDefinition>;
    configurationFailure: FunctionalityConfigurationFailure | null;
    documentBody: string;
}

const STATE_VERSION = 1;
const FAMILY = /^[a-z][a-z0-9]*$/u;
const ALIAS = /^[a-z][a-z0-9-]*$/u;
// A family may declare its own alias grammar ({§functionality-adapter}); the coordinator enforces it
// wherever an alias enters: admission, the service projection, and persisted state.
const aliasPattern = (adapter: HostFunctionalityAdapter): RegExp => adapter.aliasPattern ?? ALIAS;
const scopesOf = (adapter: HostFunctionalityAdapter): readonly ("workspace" | "session")[] => adapter.scopes ?? ["workspace"];
const EMPTY_STATE: FamilyState = Object.freeze({ version: STATE_VERSION, definitions: Object.freeze({}) });
// One object per verb result: every family action, in every daemon, shares its compiled validator.
const LIST_RESULT: JsonSchema = Object.freeze({ $ref: "https://schemas.plurnk.xyz/v0/FunctionalityListResult.json" });
const DISCOVER_RESULT: JsonSchema = Object.freeze({ $ref: "https://schemas.plurnk.xyz/v0/FunctionalityDiscoverResult.json" });
const MUTATION_RESULT: JsonSchema = Object.freeze({ $ref: "https://schemas.plurnk.xyz/v0/FunctionalityMutationResult.json" });
const ALIAS_INPUT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["alias"],
    properties: { alias: { type: "string", minLength: 1 } },
});
const EMPTY_INPUT: JsonSchema = Object.freeze({ type: "object", additionalProperties: false, properties: {} });
// {§functionality-replacement} — the shared definition of every input a family may serve.
const DISCOVER_INPUTS: Readonly<Record<FunctionalityDiscoverInput, JsonSchema>> = discoverySchema.properties;
const discoverInput = ({ inputs, emptyListsAll }: FunctionalityDiscovery): JsonSchema => ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(inputs.map((input) => [input, DISCOVER_INPUTS[input]])),
    ...(emptyListsAll === true ? {}
        : inputs.length === 1 ? { required: [...inputs] }
            : { anyOf: inputs.map((input) => ({ required: [input] })) }),
});

const failure = (
    family: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("functionality", code, status, detail, {}, { family, ...extensions }),
);

export default class Functionality {
    readonly #host: FunctionalityHost;
    readonly #adapters = new Map<string, HostFunctionalityAdapter>();
    readonly #owners = new Set<string>();
    readonly #schemas = new Map<string, Readonly<Partial<Record<FunctionalityVerb, JsonSchema>>>>();
    readonly #families = new Map<string, WorkspaceFamily>();
    readonly #queues = new Map<string, Promise<unknown>>();
    readonly #admissions = new Map<Promise<unknown>, number>();
    readonly #preparations = new Map<number, Map<string, FunctionalityPreparationActivity>>();
    readonly #authorizationWaiters = new Map<string, Set<AuthorizationWaiter>>();

    constructor(host: FunctionalityHost) {
        this.#host = host;
    }

    // {§functionality-adapter} — registration publishes the family's client
    // actions and its workspace capability provider at once.
    register(adapter: HostFunctionalityAdapter): FunctionalityFamilyHandle {
        const { family, namespaceOwner } = adapter;
        if (!FAMILY.test(family)) throw new Error(`Functionality family '${family}' must match ${FAMILY}.`);
        if (this.#adapters.has(family)) throw new Error(`Functionality family '${family}' is already registered.`);
        if (namespaceOwner.trim().length === 0) throw new Error(`Functionality family '${family}' requires a namespace owner.`);
        if (this.#owners.has(namespaceOwner)) throw new Error(`Functionality namespace owner '${namespaceOwner}' is already registered.`);
        if (!isRecord(adapter.definitionSchema)) throw new Error(`Functionality family '${family}' requires a definition schema.`);
        const scopes = scopesOf(adapter);
        if (scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some((scope) => scope !== "workspace" && scope !== "session")) {
            throw new Error(`Functionality family '${family}' declares invalid scopes.`);
        }
        // {§functionality-discovery-inputs}
        const { discovery } = adapter;
        if ((discovery === undefined) !== (adapter.discover === undefined)) {
            throw new Error(`Functionality family '${family}' must declare discovery exactly when it implements discover.`);
        }
        if (discovery !== undefined && (!Array.isArray(discovery.inputs) || discovery.inputs.length === 0
            || new Set(discovery.inputs).size !== discovery.inputs.length
            || discovery.inputs.some((input) => !Object.hasOwn(DISCOVER_INPUTS, input)))) {
            throw new Error(`Functionality family '${family}' declares invalid discovery inputs.`);
        }
        const scopeProperties = scopes.length > 1
            ? { scope: { enum: [...scopes], description: `Definition scope; model calls default to ${scopes[0]}.` } }
            : {};
        const scopedInput = (schema: JsonSchema): JsonSchema => {
            if (scopes.length === 1) return schema;
            const { $id: _id, ...source } = schema;
            if (!isRecord(source.properties)) throw new Error(`Functionality ${family} input has no property map.`);
            return { ...source, properties: { ...source.properties, ...scopeProperties } };
        };
        // {§functionality-replacement} — a family that names definitions by their content supplies the
        // inputs of add and of the select verbs itself, and serves no replace.
        const { addressing } = adapter;
        if (addressing !== undefined && [addressing.add, addressing.select].some((schema) => !isRecord(schema) || !isRecord(schema.properties))) {
            throw new Error(`Functionality family '${family}' declares addressing without object input schemas.`);
        }
        const addInput: JsonSchema = addressing === undefined
            ? Object.freeze({
                type: "object",
                additionalProperties: false,
                required: ["definition"],
                properties: {
                    ...scopeProperties,
                    alias: { type: "string", minLength: 1 },
                    definition: adapter.definitionSchema,
                },
            })
            : scopedInput(addressing.add);
        const selectInput = scopedInput(addressing?.select ?? ALIAS_INPUT);
        // {§functionality-replacement} A family without discovery has no discover verb.
        const schemas: Readonly<Partial<Record<FunctionalityVerb, JsonSchema>>> = Object.freeze({
            list: scopedInput(EMPTY_INPUT),
            ...(discovery === undefined ? {} : { discover: scopedInput(discoverInput(discovery)) }),
            add: addInput,
            ...(addressing === undefined ? { replace: { ...addInput, required: ["alias", "definition"] } } : {}),
            enable: selectInput,
            disable: selectInput,
            remove: selectInput,
        });
        // {§functionality-model-projection} — the taught `add` example must satisfy the schema it teaches.
        if (adapter.example !== undefined) {
            const example = Validator.validateJsonSchemaInstance(addInput, adapter.example);
            if (!example.valid) {
                throw new Error(`Functionality family '${family}' teaches an add example that violates its own add input: ${JSON.stringify(example.errors)}`);
            }
        }
        this.#adapters.set(family, adapter);
        this.#owners.add(namespaceOwner);
        this.#schemas.set(family, schemas);
        void this.#documentBody(adapter);
        this.#host.registerWorkspaceCapabilityProvider(namespaceOwner, {
            activate: (context) => this.#activate(adapter, context),
            deactivate: (identity) => this.#deactivate(adapter, identity),
        });
        // {§functionality-coordinator} The action context binds one of the family's supported scopes.
        for (const scope of scopes) {
            for (const verb of FUNCTIONALITY_VERBS) {
                const inputSchema = schemas[verb];
                if (inputSchema === undefined) continue;
                this.#host.registerModuleAction({
                    name: `${scope}.${family}.${verb}`,
                    scope,
                    residency: verb === "list" || verb === "discover" ? "none" : "required",
                    inputSchema,
                    outputSchema: verb === "list" ? LIST_RESULT : verb === "discover" ? DISCOVER_RESULT : MUTATION_RESULT,
                    handler: async (params, context) => {
                        if (context.scope === "daemon" || context.scope !== scope) throw new Error(`${scope}.${family}.${verb} requires a ${scope}-scoped context.`);
                        const identity: FunctionalityIdentity = context.scope === "session"
                            ? { workspaceId: context.workspaceId, sessionId: context.sessionId, scope }
                            : { workspaceId: context.workspaceId, scope };
                        return (await this.invoke(family, verb, params, identity, "action")).body;
                    },
                });
            }
        }
        return {
            invoke: (verb, params, identity) => this.invoke(family, verb, params, identity, "action"),
            refresh: (identity, options) => this.refresh(family, identity, options),
        };
    }

    // Republish a family's unchanged state for one workspace — a live catalog
    // change, not a lifecycle mutation. Serialized like every publication.
    // `gate: "none"` publishes inside the caller's own held turn (turn admission
    // refreshing a family before packet assembly) instead of contending for
    // workspace exclusivity it could never win.
    // `ifChanged` republishes only when the enabled definitions differ from the ones the resident
    // publication prepared ({§functionality-inspection}).
    async refresh(
        family: string,
        identity: WorkspaceCapabilityIdentity,
        options: { readonly gate?: WorkspaceCapabilityGate; readonly ifChanged?: boolean } = {},
    ): Promise<void> {
        this.#host.signal.throwIfAborted();
        const adapter = this.#adapter(family);
        await this.#withWorkspaceGate(
            identity.workspaceId, adapter.namespaceOwner, options.gate ?? "wait",
            () => this.#serialize(this.#key(identity.workspaceId, family), async () => {
                this.#host.signal.throwIfAborted();
                const current = this.#families.get(this.#key(identity.workspaceId, family));
                if (current === undefined) return;
                if (options.ifChanged === true && current.configurationFailure === null) {
                    try {
                        if (Functionality.#sameDefinitions(await this.#publishable(adapter, identity, current.state), current.enabled)) return;
                    } catch (cause) {
                        if (!(cause instanceof ConfigurationError)) throw cause;
                        // The normal publication below withdraws the invalid family's capabilities.
                    }
                }
                await this.#publish(adapter, identity, current.state, {
                    failure: "publish-unavailable",
                    configurationFailure: "contain",
                    retain: () => this.#host.retainWorkspace(identity.workspaceId),
                });
            }),
        );
    }

    families(): string[] {
        return [...this.#adapters.keys()].toSorted();
    }

    familyEntries(workspaceId?: number): readonly FunctionalityFamilyEntry[] {
        return this.families().map((family) => {
            const adapter = this.#adapters.get(family)!;
            const slot = workspaceId === undefined ? undefined : this.#families.get(this.#key(workspaceId, family));
            return {
                family,
                summary: adapter.summary,
                ...(adapter.traits === undefined ? {} : { traits: adapter.traits }),
                inputSchemas: this.#schemas.get(family)!,
                ...(adapter.example === undefined ? {} : { example: adapter.example }),
                ...(adapter.discovery === undefined ? {} : { discovery: adapter.discovery }),
                documentBody: slot?.documentBody ?? this.#resolvedDocumentBodies.get(family) ?? "",
                configurationFailure: slot?.configurationFailure ?? null,
            };
        });
    }

    // {§functionality-inspection} — every family that reads out-of-band state republishes it if it changed.
    async refreshChanged(identity: WorkspaceCapabilityIdentity): Promise<void> {
        for (const adapter of this.#adapters.values()) {
            if (this.#families.get(this.#key(identity.workspaceId, adapter.family))?.configurationFailure != null) {
                await this.refresh(adapter.family, identity, { gate: "none" });
                continue;
            }
            try {
                await adapter.refreshIfChanged?.(identity);
            } catch (cause) {
                if (!(cause instanceof ConfigurationError)) throw cause;
                await this.refresh(adapter.family, identity, { gate: "none" });
            }
        }
    }

    configurationNotices(workspaceId: number): readonly Notice[] {
        return [...this.#adapters].flatMap(([family, adapter]) => {
            const cause = this.#families.get(this.#key(workspaceId, family))?.configurationFailure?.error;
            return [
                ...(cause == null ? [] : [ConfigurationDiagnostics.notice(family, cause)]),
                ...(adapter.configurationNotices?.({ workspaceId }) ?? []),
            ];
        });
    }

    // Join outstanding invocations before inspecting or closing durable state.
    // Rejections have already been delivered to their action or execution stream.
    async settle(workspaceId?: number): Promise<void> {
        await Promise.allSettled([
            ...[...this.#queues]
                .filter(([key]) => workspaceId === undefined || key.startsWith(`${workspaceId}:`))
                .map(([, queue]) => queue),
            ...[...this.#admissions]
                .filter(([, id]) => workspaceId === undefined || id === workspaceId)
                .map(([pending]) => pending),
        ]);
    }

    // {§functionality-model-projection} — the family-generated documents of every
    // published family for one workspace, projected under each reader's generated subtree.
    // {§functionality-model-projection} — read once per family from the adapter's package, the same
    // `docs/<tag>.md` rule runtimes use. A family that ships no file has a header-only document.
    #documentBodies = new Map<string, Promise<string>>();
    #resolvedDocumentBodies = new Map<string, string>();

    #documentBody(adapter: HostFunctionalityAdapter): Promise<string> {
        let body = this.#documentBodies.get(adapter.family);
        if (body === undefined) {
            body = (adapter.docsDir === undefined
                ? Promise.resolve("")
                : DocFile.read(adapter.docsDir, adapter.family).then((text) => text ?? ""))
                .then((resolved) => {
                    this.#resolvedDocumentBodies.set(adapter.family, resolved);
                    return resolved;
                });
            this.#documentBodies.set(adapter.family, body);
        }
        return body;
    }

    // Each document carries its family so the projection can follow the family's admission ({§schemes-directory}).
    documents(workspaceId: number): Array<{ family: string; pathname: string; content: string }> {
        const out: Array<{ family: string; pathname: string; content: string }> = [];
        const prefix = `${workspaceId}:`;
        for (const [key, entry] of this.#families) {
            if (!key.startsWith(prefix) || entry.prepared === null) continue;
            const family = key.slice(prefix.length);
            for (const document of entry.prepared.documents) {
                out.push({ family, pathname: generatedPathname(document.pathname), content: document.content });
            }
        }
        return out;
    }

    // The one lifecycle entry for both projections ({§functionality-model-projection}).
    async invoke(
        family: string,
        verb: FunctionalityVerb,
        params: unknown,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        options: FunctionalityInvocationOptions = {},
        signal = this.#host.signal,
    ): Promise<FunctionalityInvocation> {
        const lifetime = signal === this.#host.signal ? signal : AbortSignal.any([this.#host.signal, signal]);
        lifetime.throwIfAborted();
        try {
            return await this.#invoke(family, verb, params, identity, caller, options, lifetime);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw Functionality.#configurationFailure(family, cause);
        }
    }

    static #configurationFailure(family: string, cause: ConfigurationError): OperationFailureError {
        return new OperationFailureError(Results.failure("functionality", "configuration-invalid", 503, cause.message, {}, {
            family,
            key: cause.key,
            retryable: false,
            recovery: "Correct the named configuration input. Other capabilities remain available.",
        }), { cause });
    }

    async #trackAdmission<T>(workspaceId: number, pending: Promise<T>): Promise<T> {
        this.#admissions.set(pending, workspaceId);
        try {
            return await pending;
        } finally {
            this.#admissions.delete(pending);
        }
    }

    async #invoke(
        family: string,
        verb: FunctionalityVerb,
        params: unknown,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        options: FunctionalityInvocationOptions,
        signal: AbortSignal,
    ): Promise<FunctionalityInvocation> {
        const adapter = this.#adapter(family);
        const schema = this.#schemas.get(family)![verb];
        // Neither projection offers a verb the family does not serve ({§functionality-replacement}).
        if (schema === undefined) throw new Error(`Functionality family '${family}' serves no ${verb}.`);
        const validation = Validator.validateJsonSchemaInstance(schema, params);
        if (!validation.valid) {
            throw failure(family, "arguments-invalid", 400, `${family} ${verb} arguments do not match their schema.`, {
                errors: validation.errors,
                recovery: `Conform the ${verb} arguments to the ${family} ${verb} input schema.`,
                retryable: false,
            });
        }
        const input = isRecord(params) ? params : {};
        const requested = input.scope ?? identity.scope ?? scopesOf(adapter)[0];
        const scope = scopesOf(adapter).find((candidate) => candidate === requested);
        if (scope === undefined || (identity.scope !== undefined && identity.scope !== scope)) {
            throw failure(family, "scope-mismatch", 400, `The ${family} operation's scope does not match its bound context.`, { retryable: false });
        }
        identity = { ...identity, scope };
        if (verb === "discover") {
            const { scope: _scope, ...query } = input;
            return { status: 200, body: await this.#trackAdmission(identity.workspaceId, this.#discover(adapter, query, identity)) };
        }
        // {§functionality-coordinator} — a session-scoped family's list and mutations act for the invoking
        // Session. The state is that Session's and nothing resident changes, so they serialize on the
        // Session's own lane and take no workspace exclusivity: a Session shapes its environment while
        // its siblings run.
        if (scope === "session") {
            const sessionId = Functionality.#sessionOf(adapter, identity);
            return this.#trackAdmission(
                identity.workspaceId,
                this.#serialize(`${this.#key(identity.workspaceId, family)}:${sessionId}`, () => this.#invokeForSession(adapter, verb, input, identity, sessionId, caller, signal)),
            );
        }
        if (verb === "list") return { status: 200, body: await this.#trackAdmission(identity.workspaceId, this.#list(adapter, identity)) };
        const mutate = () => this.#serialize(this.#key(identity.workspaceId, family), () => this.#mutate(adapter, verb, input, identity, caller, signal));
        // A context family (one that declares the session scope) is read where it is used, so its workspace
        // defaults change nothing resident either: they serialize on the family's lane, as a Session's own do,
        // and an operation inside its own held turn never waits on itself.
        if (scopesOf(adapter).includes("session")) {
            const outcome = await this.#trackAdmission(identity.workspaceId, mutate());
            if (outcome.settled === undefined) return outcome.invocation;
            options?.onAuthorizationRequired?.(outcome.aliases);
            return await outcome.settled;
        }
        const publish = () => this.#withWorkspaceGate(identity.workspaceId, adapter.namespaceOwner, caller === "operation" ? "wait" : "try", mutate, signal);
        return caller === "operation"
            ? this.#host.atWorkspaceBoundary(identity.workspaceId, async () => {
                const outcome = await publish();
                if (outcome.settled === undefined) return outcome.invocation;
                options?.onAuthorizationRequired?.(outcome.aliases);
                return await outcome.settled;
            })
            : (await publish()).invocation;
    }

    // A session-scoped verb that names no Session is a defect at the projection, never a client
    // failure: both projections name the Session ({§functionality-model-projection}).
    static #sessionOf(adapter: HostFunctionalityAdapter, identity: FunctionalityIdentity): number {
        if (identity.sessionId === undefined) throw new Error(`${adapter.family} is session-scoped; the invocation names no Session.`);
        return identity.sessionId;
    }

    // The origin a definition carries when this family owns it locally. Service definitions
    // always come from the adapter's own `available()`; everything else is the family's own.
    static #localOrigin(identity: FunctionalityIdentity): "session" | "workspace" {
        return identity.scope ?? "workspace";
    }

    #adapter(family: string): HostFunctionalityAdapter {
        const adapter = this.#adapters.get(family);
        if (adapter === undefined) throw failure(family, "family-unknown", 404, `No Functionality family '${family}' is registered.`, { retryable: false });
        return adapter;
    }

    #key(workspaceId: number, family: string): string {
        return `${workspaceId}:${family}`;
    }

    #serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        this.#queues.set(key, next);
        return next;
    }

    async #withWorkspaceGate<T>(workspaceId: number, owner: string, gate: WorkspaceCapabilityGate, run: () => Promise<T>, signal = this.#host.signal): Promise<T> {
        const pending = this.#host.withWorkspaceGate(workspaceId, owner, gate, run, signal);
        this.#admissions.set(pending, workspaceId);
        try { return await pending; }
        finally { this.#admissions.delete(pending); }
    }

    async #activate(adapter: HostFunctionalityAdapter, context: WorkspaceCapabilityIdentity & { readonly retain: () => () => void }): Promise<void> {
        const identity = { workspaceId: context.workspaceId };
        await this.#serialize(this.#key(identity.workspaceId, adapter.family), async () => {
            this.#host.signal.throwIfAborted();
            const state = await this.#loadState(adapter, identity.workspaceId);
            await this.#publish(adapter, identity, state, { failure: "publish-unavailable", configurationFailure: "contain", retain: context.retain });
        });
    }

    async #deactivate(adapter: HostFunctionalityAdapter, identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#serialize(this.#key(identity.workspaceId, adapter.family), async () => {
            const key = this.#key(identity.workspaceId, adapter.family);
            const family = this.#families.get(key);
            this.#families.delete(key);
            if (family?.prepared !== null && family?.prepared !== undefined) {
                await adapter.teardown(family.prepared.snapshot, identity);
            }
        });
    }

    async #loadState(adapter: HostFunctionalityAdapter, workspaceId: number): Promise<FamilyState> {
        return Functionality.#parseState(adapter, await this.#host.readWorkspaceModuleState(workspaceId, adapter.namespaceOwner), `workspace ${workspaceId}`, "workspace");
    }

    async #loadSessionState(adapter: HostFunctionalityAdapter, sessionId: number): Promise<FamilyState> {
        return Functionality.#parseState(adapter, await this.#host.readSessionModuleState(sessionId, adapter.namespaceOwner), `session ${sessionId}`, "session");
    }

    static #parseState(adapter: HostFunctionalityAdapter, raw: unknown, where: string, scope: "workspace" | "session"): FamilyState {
        if (raw === null) return EMPTY_STATE;
        if (!isRecord(raw) || raw.version !== STATE_VERSION || !isRecord(raw.definitions)) {
            throw new Error(`Functionality state for ${adapter.family} in ${where} is not a version ${STATE_VERSION} record.`);
        }
        const definitions: Record<string, DefinitionRecord> = {};
        for (const [alias, value] of Object.entries(raw.definitions)) {
            if (!aliasPattern(adapter).test(alias) || !isRecord(value)) throw new Error(`Functionality state for ${adapter.family} has an invalid alias '${alias}'.`);
            const { origin, enabled, definition, inherited } = value;
            if ((origin !== "service" && origin !== "workspace" && origin !== "session") || typeof enabled !== "boolean") {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' is malformed.`);
            }
            if (origin !== "service" && origin !== scope && !(scope === "session" && origin === "workspace" && scopesOf(adapter).includes("workspace"))) {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' has an invalid origin for ${scope} scope.`);
            }
            if (inherited !== undefined && (typeof inherited !== "string" || inherited.length === 0 || scope !== "session")) {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' carries an invalid inheritance.`);
            }
            const provenance = inherited === undefined ? {} : { inherited };
            if (origin === scope) {
                const result = Validator.validateJsonSchemaInstance(adapter.definitionSchema, definition);
                if (!result.valid || !isRecord(definition)) throw new Error(`Functionality state for ${adapter.family} alias '${alias}' holds an invalid definition.`);
                definitions[alias] = { origin, enabled, definition, ...provenance };
            } else {
                if (definition !== undefined) throw new Error(`Functionality state for ${adapter.family} alias '${alias}' persists a lower-layer definition.`);
                definitions[alias] = { origin, enabled, ...provenance };
            }
        }
        return { version: STATE_VERSION, definitions };
    }

    static #persisted(state: FamilyState): FamilyState | null {
        return Object.keys(state.definitions).length === 0 ? null : state;
    }

    async #effective(adapter: HostFunctionalityAdapter, identity: FunctionalityIdentity, state: FamilyState): Promise<Map<string, EffectiveDefinition>> {
        const effective = new Map<string, EffectiveDefinition>();
        const local = Functionality.#localOrigin(identity);
        const inheritsWorkspace = identity.scope === "session" && scopesOf(adapter).includes("workspace");
        const lower = inheritsWorkspace
            ? [...(await this.#effective(adapter, { workspaceId: identity.workspaceId, scope: "workspace" }, await this.#loadState(adapter, identity.workspaceId))).values()]
            : (await adapter.available(identity)).map((entry) => ({ ...entry, origin: "service" as const }));
        for (const service of lower) {
            if (!aliasPattern(adapter).test(service.alias)) throw new Error(`${adapter.family} service alias '${service.alias}' must match ${aliasPattern(adapter)}.`);
            const record = state.definitions[service.alias];
            const overlay = record !== undefined && record.origin !== local ? record : undefined;
            const enabled = overlay === undefined ? service.enabled : overlay.enabled && (!inheritsWorkspace || service.enabled);
            const inherited = overlay?.inherited === undefined ? {} : { inherited: overlay.inherited };
            effective.set(service.alias, {
                alias: service.alias, origin: service.origin, definition: service.definition, enabled, ...inherited,
                ...(service.provenance === undefined ? {} : { provenance: service.provenance }),
                ...(service.context === undefined ? {} : { context: service.context }),
            });
        }
        for (const [alias, record] of Object.entries(state.definitions)) {
            if (record.origin !== local) continue;
            const inherited = record.inherited === undefined ? {} : { inherited: record.inherited };
            effective.set(alias, { alias, origin: local, definition: record.definition!, enabled: record.enabled, ...inherited });
        }
        return new Map([...effective].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    #projection(definition: EffectiveDefinition, outcome: FunctionalityOutcome | { readonly state: "dormant" } | undefined): FunctionalityDefinitionState {
        const base = {
            alias: definition.alias, origin: definition.origin, definition: definition.definition,
            ...(definition.inherited === undefined ? {} : { inherited: definition.inherited }),
            ...(definition.provenance === undefined ? {} : { provenance: definition.provenance }),
        };
        if (!definition.enabled) return { ...base, state: "disabled" };
        if (outcome === undefined) throw new Error(`enabled ${definition.alias} has no preparation outcome`);
        switch (outcome.state) {
            case "dormant": return { ...base, state: "dormant" };
            case "active": return { ...base, state: "active", ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
            case "unavailable": return { ...base, state: "unavailable", problem: outcome.problem };
            case "authorization-required": return { ...base, state: "authorization-required", authorization: outcome.authorization };
        }
    }

    async #list(adapter: HostFunctionalityAdapter, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityListResult> {
        const family = this.#families.get(this.#key(identity.workspaceId, adapter.family));
        const state = family?.state ?? await this.#loadState(adapter, identity.workspaceId);
        const effective = await this.#effective(adapter, identity, state);
        // Fresh resolution supersedes a failed source read, not a failed preparation.
        if (family?.configurationFailure?.phase === "preparation") throw family.configurationFailure.error;
        const outcomes = family?.prepared?.outcomes;
        // {§functionality-inspection} — an enabled definition no resident publication has prepared, whether
        // the family is cold or the definition arrived out of band since, is dormant.
        return Validator.assertFunctionalityListResult({
            family: adapter.family,
            definitions: [...effective.values()].map((definition) => {
                const outcome = isDeepStrictEqual(family?.enabled.get(definition.alias), Functionality.#binding(definition))
                    ? outcomes?.get(definition.alias)
                    : undefined;
                return this.#projection(definition, outcome ?? { state: "dormant" });
            }),
        });
    }

    async #discover(adapter: HostFunctionalityAdapter, query: Record<string, unknown>, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDiscoverResult> {
        // Registration pairs a declared discovery with its implementation ({§functionality-discovery-inputs}).
        const candidates = await adapter.discover!(query, identity);
        return Validator.assertFunctionalityDiscoverResult({ family: adapter.family, candidates: [...candidates] });
    }

    // The alias a select verb names: the input's `alias`, or what an addressing family reads from its
    // own select input ({§functionality-replacement}).
    static #selected(adapter: HostFunctionalityAdapter, input: Record<string, unknown>): string {
        if (adapter.addressing !== undefined) return adapter.addressing.alias(input);
        if (typeof input.alias !== "string") throw new TypeError(`A ${adapter.family} select names its alias.`);
        return input.alias;
    }

    // The verb semantics, one implementation for every family ({§functionality-coordinator}): the next
    // state, the aliases it concerns, and how the mutation reports. Only publication differs by scope.
    async #transition(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        state: FamilyState,
        effective: ReadonlyMap<string, EffectiveDefinition>,
    ): Promise<Transition> {
        const local = Functionality.#localOrigin(identity);
        const here = local === "session" ? "this session" : "this workspace";
        const definitions: Record<string, DefinitionRecord> = { ...state.definitions };
        const aliases: string[] = [];
        let status: 200 | 201 = 200;
        let removed = false;
        let admissions: FunctionalityAdmission[] = [];
        switch (verb) {
            case "add":
            case "replace": {
                const admitted = await adapter.admit(input, identity, caller);
                const listed: FunctionalityAdmission[] = [];
                admissions = listed.concat(admitted);
                // {§functionality-replacement} — an alias family admits exactly one definition; an addressing
                // family's add admits each the body names, and all of them or none.
                if (adapter.addressing === undefined ? admissions.length !== 1 : admissions.length === 0) {
                    throw new Error(`${adapter.family} admitted ${admissions.length} definitions for one ${verb}.`);
                }
                for (const admission of admissions) {
                    const { alias } = admission;
                    if (!aliasPattern(adapter).test(alias)) throw failure(adapter.family, "alias-invalid", 400, `Alias '${alias}' must match ${aliasPattern(adapter)}.`, { alias, retryable: false });
                    if (aliases.includes(alias)) throw new Error(`${adapter.family} admitted '${alias}' twice in one ${verb}.`);
                    const current = effective.get(alias);
                    if (verb === "add" && current?.origin === local && !isDeepStrictEqual(current.definition, admission.definition)) {
                        throw failure(adapter.family, "alias-exists", 409, `'${alias}' already has a different ${local} definition.`, {
                            alias,
                            recovery: adapter.addressing === undefined ? "Use replace with the complete definition to change it." : "Remove it, then add it again.",
                            retryable: false,
                        });
                    }
                    definitions[alias] = { origin: local, definition: admission.definition, enabled: verb === "replace" ? current?.enabled ?? true : true };
                    if (current?.origin !== local) status = 201;
                    aliases.push(alias);
                }
                break;
            }
            case "enable":
            case "disable": {
                const alias = Functionality.#selected(adapter, input);
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to ${here}.`, { alias, retryable: false });
                definitions[alias] = current.origin === local
                    ? { origin: local, definition: current.definition, enabled: verb === "enable" }
                    : { origin: current.origin, enabled: verb === "enable" };
                aliases.push(alias);
                break;
            }
            case "remove": {
                const alias = Functionality.#selected(adapter, input);
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to ${here}.`, { alias, retryable: false });
                if (current.origin === "service") throw failure(adapter.family, "alias-service-owned", 409, `'${alias}' is provided to ${here}, not added by it, so it cannot be removed here.`, { alias, recovery: "Disable it here; it leaves when what provides it does: an installed plugin or skill, or the operator's configuration.", retryable: false });
                if (current.origin !== local) throw failure(adapter.family, "alias-workspace-owned", 409, `'${alias}' is a workspace definition; remove it in workspace scope or disable it here.`, { alias, retryable: false });
                await adapter.forget?.({ alias, definition: current.definition }, identity);
                delete definitions[alias];
                removed = true;
                aliases.push(alias);
                break;
            }
            default: throw new Error(`unreachable verb ${verb}`);
        }
        return { definitions, aliases, status, removed, admissions };
    }

    // {§functionality-replacement} — the receipt: the one alias a mutation concerned, or every
    // definition an addressing family's add admitted ({§functionality-replacement}).
    #mutationResult(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        { aliases, status, removed }: Transition,
        effectiveAfter: ReadonlyMap<string, EffectiveDefinition>,
        outcomes: ReadonlyMap<string, FunctionalityOutcome>,
    ): FunctionalityInvocation {
        const projections = aliases.map((alias) => {
            const definition = effectiveAfter.get(alias);
            return definition === undefined ? undefined : this.#projection(definition, outcomes.get(alias));
        });
        const authorization = projections.some((projection) => projection?.state === "authorization-required");
        const isRemoved = removed || projections.every((projection) => projection === undefined);
        const settledStatus = authorization ? 202 : isRemoved ? 200 : status;
        const body = Validator.assertFunctionalityMutationResult(adapter.addressing !== undefined && verb === "add"
            ? { status: settledStatus, family: adapter.family, definitions: projections.map((projection) => projection!) }
            : {
                status: settledStatus,
                family: adapter.family,
                alias: aliases[0],
                ...(projections[0] === undefined ? {} : { definition: projections[0] }),
                ...(isRemoved ? { removed: true } : {}),
            });
        return { status: body.status, body };
    }

    async #mutate(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        signal: AbortSignal,
    ): Promise<
        | { invocation: FunctionalityInvocation; settled?: undefined }
        | { invocation: FunctionalityInvocation; aliases: readonly string[]; settled: Promise<FunctionalityInvocation> }
    > {
        signal.throwIfAborted();
        const key = this.#key(identity.workspaceId, adapter.family);
        const family = this.#families.get(key);
        if (family === undefined) throw failure(adapter.family, "workspace-not-resident", 409, `Workspace ${identity.workspaceId} has no resident ${adapter.family} Functionality.`, { recovery: "Retry through a workspace operation, then retry.", retryable: false });
        const effective = await this.#effective(adapter, identity, family.state);
        const transition = await this.#transition(adapter, verb, input, identity, caller, family.state, effective);
        const nextState: FamilyState = { version: STATE_VERSION, definitions: transition.definitions };
        // Re-enabling an alias that is not active retries its preparation; an
        // already-active alias keeps its live attachment.
        const retry = verb === "enable" && family.prepared?.outcomes.get(transition.aliases[0])?.state !== "active";
        const publication = await this.#publish(adapter, identity, nextState, {
            failure: caller === "action" || verb === "replace" ? "reject" : "publish-unavailable",
            configurationFailure: "reject",
            retain: () => this.#host.retainWorkspace(identity.workspaceId),
            forceAlias: retry ? transition.aliases[0] : null,
            admissions: transition.admissions,
            signal,
        });
        const effectiveAfter = await this.#effective(adapter, identity, nextState);
        const invocation = this.#mutationResult(adapter, verb, transition, effectiveAfter, publication.outcomes);
        if (caller !== "operation" || invocation.status !== 202) return { invocation };
        const aliases = transition.aliases.filter((alias) => publication.outcomes.get(alias)?.state === "authorization-required");
        return {
            invocation,
            aliases,
            settled: this.#waitForAuthorization(key, { adapter, verb, identity, transition }, signal),
        };
    }

    #waitForAuthorization(
        key: string,
        args: Omit<AuthorizationWaiter, "resolve" | "reject">,
        signal: AbortSignal,
    ): Promise<FunctionalityInvocation> {
        signal.throwIfAborted();
        return new Promise<FunctionalityInvocation>((resolve, reject) => {
            let set = this.#authorizationWaiters.get(key);
            if (set === undefined) {
                set = new Set();
                this.#authorizationWaiters.set(key, set);
            }
            const remove = (): void => {
                signal.removeEventListener("abort", onAbort);
                set?.delete(waiter);
                if (set?.size === 0) this.#authorizationWaiters.delete(key);
            };
            const onAbort = (): void => {
                remove();
                reject(signal.reason);
            };
            const waiter: AuthorizationWaiter = {
                ...args,
                resolve: (invocation) => {
                    remove();
                    resolve(invocation);
                },
                reject: (reason) => {
                    remove();
                    reject(reason);
                },
            };
            signal.addEventListener("abort", onAbort, { once: true });
            set.add(waiter);
        });
    }

    async #resolveAuthorizationWaiters(
        key: string,
        adapter: HostFunctionalityAdapter,
        nextState: FamilyState,
        outcomes: ReadonlyMap<string, FunctionalityOutcome>,
    ): Promise<void> {
        const waiters = this.#authorizationWaiters.get(key);
        if (waiters === undefined || waiters.size === 0) return;
        for (const waiter of [...waiters]) {
            const effectiveAfter = await this.#effective(adapter, waiter.identity, nextState);
            const result = this.#mutationResult(adapter, waiter.verb, waiter.transition, effectiveAfter, outcomes);
            if (result.status !== 202) waiter.resolve(result);
        }
    }

    // {§functionality-coordinator} — the Session's own lane. State is read at each verb rather than held: the
    // spawn reads the same row, and a Session's row is written at its creation, so nothing in memory
    // could be more current than the table.
    async #invokeForSession(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        sessionId: number,
        caller: FunctionalityCaller,
        signal: AbortSignal,
    ): Promise<FunctionalityInvocation> {
        signal.throwIfAborted();
        const state = await this.#loadSessionState(adapter, sessionId);
        const effective = await this.#effective(adapter, identity, state);
        if (verb === "list") {
            const prepared = await this.#prepareForSession(adapter, identity, effective, "publish-unavailable", [], signal);
            try { signal.throwIfAborted(); }
            catch (cause) { return Functionality.#abort(prepared, cause); }
            prepared.publish();
            await prepared.commit();
            return { status: 200, body: Validator.assertFunctionalityListResult({
                family: adapter.family,
                definitions: [...effective.values()].map((definition) => this.#projection(definition, prepared.outcomes.get(definition.alias))),
            }) };
        }
        const transition = await this.#transition(adapter, verb, input, identity, caller, state, effective);
        const nextState: FamilyState = { version: STATE_VERSION, definitions: transition.definitions };
        const effectiveAfter = await this.#effective(adapter, identity, nextState);
        const prepared = await this.#prepareForSession(adapter, identity, effectiveAfter, caller === "action" || verb === "replace" ? "reject" : "publish-unavailable", transition.admissions, signal);
        try {
            signal.throwIfAborted();
            await this.#host.replaceSessionModuleState(sessionId, adapter.namespaceOwner, Functionality.#persisted(nextState));
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        prepared.publish();
        await prepared.commit();
        return this.#mutationResult(adapter, verb, transition, effectiveAfter, prepared.outcomes);
    }

    // A session-scoped family's preparation yields outcomes only. It holds no residency — no runtimes,
    // documents or snapshot ({§module-workspace-residency}) — because its definitions are read at the
    // spawn that uses them rather than leased and cooled; the coordinator enforces that here.
    async #prepareForSession(
        adapter: HostFunctionalityAdapter,
        identity: FunctionalityIdentity,
        effective: ReadonlyMap<string, EffectiveDefinition>,
        failureMode: "publish-unavailable" | "reject",
        admissions: readonly FunctionalityAdmission[] = [],
        signal = this.#host.signal,
    ): Promise<FunctionalityPrepared<RuntimeRegistration>> {
        const enabled = Functionality.#enabled(effective);
        const prepared = await this.#prepare(adapter, {
            workspaceId: identity.workspaceId, enabled, previous: null, failure: failureMode, admissions,
            progress: () => undefined,
            retain: () => this.#host.retainWorkspace(identity.workspaceId),
        }, signal);
        try {
            Functionality.#checkOutcomes(adapter, enabled, prepared);
            if ((prepared.runtimes?.length ?? 0) > 0 || prepared.documents.length > 0 || prepared.snapshot !== null) {
                throw new Error(`${adapter.family} is session-scoped and holds no residency, yet its preparation published runtimes, documents or a snapshot.`);
            }
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        return prepared;
    }

    // The enabled definitions a workspace publication of `state` prepares. A session-scoped family's
    // workspace publication carries only its manager: what is enabled is decided per Session, at each
    // verb and each spawn ({§functionality-coordinator}).
    async #publishable(adapter: HostFunctionalityAdapter, identity: WorkspaceCapabilityIdentity, state: FamilyState): Promise<Map<string, FunctionalityPreparedDefinition>> {
        if (!scopesOf(adapter).includes("workspace")) return new Map();
        return Functionality.#enabled(await this.#effective(adapter, { ...identity, scope: "workspace" }, state));
    }

    static #sameDefinitions(left: ReadonlyMap<string, FunctionalityPreparedDefinition>, right: ReadonlyMap<string, FunctionalityPreparedDefinition>): boolean {
        if (left.size !== right.size) return false;
        for (const [alias, definition] of left) {
            if (!right.has(alias) || !isDeepStrictEqual(definition, right.get(alias))) return false;
        }
        return true;
    }

    static #binding({ definition, context }: EffectiveDefinition): FunctionalityPreparedDefinition {
        return { definition, ...(context === undefined ? {} : { context }) };
    }

    static #enabled(effective: ReadonlyMap<string, EffectiveDefinition>): Map<string, FunctionalityPreparedDefinition> {
        const enabled = new Map<string, FunctionalityPreparedDefinition>();
        for (const definition of effective.values()) {
            if (definition.enabled) enabled.set(definition.alias, structuredClone(Functionality.#binding(definition)));
        }
        return enabled;
    }

    static #checkOutcomes(adapter: HostFunctionalityAdapter, enabled: ReadonlyMap<string, object>, prepared: FunctionalityPrepared<RuntimeRegistration>): void {
        for (const alias of enabled.keys()) {
            if (!prepared.outcomes.has(alias)) throw new Error(`${adapter.family} preparation reported no outcome for enabled alias '${alias}'.`);
        }
    }

    // {§functionality-coordinator} — prepare, publish runtimes and state in one
    // host replacement, then commit; on any failure abort and keep the previous
    // snapshot authoritative. An execution stream stays pending until its
    // workspace publication completes; it never acknowledges a future commit.
    preparationStatus(workspaceId: number): readonly FunctionalityPreparationActivity[] {
        return [...(this.#preparations.get(workspaceId)?.values() ?? [])].map((activity) => ({ ...activity }));
    }

    async #publish(
        adapter: HostFunctionalityAdapter,
        identity: WorkspaceCapabilityIdentity,
        nextState: FamilyState,
        options: {
            readonly failure: "publish-unavailable" | "reject";
            readonly configurationFailure: "contain" | "reject";
            readonly retain: () => () => void;
            readonly forceAlias?: string | null;
            readonly admissions?: readonly FunctionalityAdmission[];
            readonly signal?: AbortSignal;
        },
    ): Promise<{ outcomes: ReadonlyMap<string, FunctionalityOutcome> }> {
        (options.signal ?? this.#host.signal).throwIfAborted();
        const { workspaceId } = identity;
        const current = this.#preparations.get(workspaceId) ?? new Map<string, FunctionalityPreparationActivity>();
        this.#preparations.set(workspaceId, current);
        const forget = (): void => {
            for (const [key, activity] of current) if (activity.family === adapter.family) current.delete(key);
        };
        // {§functionality-inspection} — one activity for the family, or one per alias it reports
        // preparing, each keeping the time its alias began.
        const report = (aliases: readonly string[], phase: FunctionalityPreparationActivity["phase"]): void => {
            const now = new Date().toISOString();
            const began = new Map([...current.values()]
                .filter((activity) => activity.family === adapter.family && activity.alias !== null)
                .map((activity) => [activity.alias, activity.since]));
            forget();
            if (aliases.length === 0) current.set(adapter.family, { family: adapter.family, alias: null, phase, since: now });
            for (const alias of aliases) {
                current.set(`${adapter.family}/${alias}`, { family: adapter.family, alias, phase, since: began.get(alias) ?? now });
            }
            this.#host.preparationChanged(workspaceId, this.preparationStatus(workspaceId));
        };
        report([], "preparing");
        try {
            return await this.#publishPrepared(adapter, identity, nextState, options, report);
        } finally {
            forget();
            if (current.size === 0) this.#preparations.delete(workspaceId);
            this.#host.preparationChanged(workspaceId, this.preparationStatus(workspaceId));
        }
    }

    async #publishPrepared(
        adapter: HostFunctionalityAdapter,
        identity: WorkspaceCapabilityIdentity,
        nextState: FamilyState,
        options: {
            readonly failure: "publish-unavailable" | "reject";
            readonly configurationFailure: "contain" | "reject";
            readonly retain: () => () => void;
            readonly forceAlias?: string | null;
            readonly admissions?: readonly FunctionalityAdmission[];
            readonly signal?: AbortSignal;
        },
        report: (aliases: readonly string[], phase: FunctionalityPreparationActivity["phase"]) => void,
    ): Promise<{ outcomes: ReadonlyMap<string, FunctionalityOutcome> }> {
        const key = this.#key(identity.workspaceId, adapter.family);
        const signal = options.signal ?? this.#host.signal;
        const previous = this.#families.get(key)?.prepared ?? null;
        let enabled = new Map<string, FunctionalityPreparedDefinition>();
        let prepared: FunctionalityPrepared<RuntimeRegistration> | null = null;
        let configurationFailure: WorkspaceFamily["configurationFailure"] = null;
        let phase: "resolution" | "preparation" = "resolution";
        try {
            enabled = await this.#publishable(adapter, identity, nextState);
            phase = "preparation";
            prepared = await this.#prepare(adapter, {
                workspaceId: identity.workspaceId,
                enabled,
                previous: previous?.snapshot ?? null,
                failure: options.failure,
                admissions: options.admissions ?? [],
                progress: (aliases) => {
                    signal.throwIfAborted();
                    for (const alias of aliases) {
                        if (!enabled.has(alias)) throw new Error(`${adapter.family} reported preparation of unknown alias '${alias}'.`);
                    }
                    report(aliases, "preparing");
                },
                retain: options.retain,
                ...(options.forceAlias ? { force: options.forceAlias } : {}),
            }, signal);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError) || options.configurationFailure === "reject") throw cause;
            configurationFailure = { phase, error: cause };
            enabled = new Map();
        }
        let runtimes: RuntimeRegistration[];
        let schemes: NonNullable<WorkspaceCapabilityReplacement["schemes"]>;
        let documentBody: string;
        try {
            signal.throwIfAborted();
            report([], "publishing");
            if (prepared !== null) Functionality.#checkOutcomes(adapter, enabled, prepared);
            for (const runtime of prepared?.runtimes ?? []) {
                if (runtime.namespaceOwner !== adapter.namespaceOwner) {
                    throw new Error(`${adapter.family} prepared a runtime owned by '${runtime.namespaceOwner}' instead of '${adapter.namespaceOwner}'.`);
                }
            }
            documentBody = await this.#documentBody(adapter);
            runtimes = [...(prepared?.runtimes ?? [])];
            schemes = adapter.scheme === undefined || configurationFailure !== null
                ? []
                : [{ name: adapter.family, facet: adapter.scheme, ...(adapter.traits === undefined ? {} : { traits: adapter.traits }) }];
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        const commit = async (): Promise<void> => {
            const before = this.#families.get(key);
            try {
                signal.throwIfAborted();
                await this.#host.replaceWorkspaceCapabilities({
                    workspaceId: identity.workspaceId,
                    namespaceOwner: adapter.namespaceOwner,
                    state: Functionality.#persisted(nextState),
                    runtimes,
                    ...(schemes.length === 0 ? {} : { schemes }),
                }, {
                    gate: "none",
                    // {§functionality-coordinator} — the view and the adapter's candidate go live in one instant.
                    publish: () => {
                        this.#families.set(key, { state: nextState, prepared, enabled, configurationFailure, documentBody });
                        const undo = prepared?.publish();
                        return () => {
                            undo?.();
                            if (before === undefined) this.#families.delete(key);
                            else this.#families.set(key, before);
                        };
                    },
                });
            } catch (cause) {
                return Functionality.#abort(prepared, cause);
            }
            if (prepared !== null) await prepared.commit();
            else if (previous !== null) await adapter.teardown(previous.snapshot, identity);
        };
        await commit();
        const outcomes = prepared?.outcomes ?? new Map();
        await this.#resolveAuthorizationWaiters(key, adapter, nextState, outcomes);
        return { outcomes };
    }

    // {§functionality-preparation-cancellation} Join the adapter; abort a returned candidate before publication.
    async #prepare(adapter: HostFunctionalityAdapter, preparation: Omit<FunctionalityPreparation, "signal">, signal = this.#host.signal): Promise<FunctionalityPrepared<RuntimeRegistration>> {
        signal.throwIfAborted();
        const prepared = await adapter.prepare({ ...preparation, signal });
        try { signal.throwIfAborted(); }
        catch (cause) { return Functionality.#abort(prepared, cause); }
        return prepared;
    }

    static async #abort(prepared: FunctionalityPrepared<RuntimeRegistration> | null, cause: unknown): Promise<never> {
        try { await prepared?.abort(); }
        catch (abortCause) { throw new AggregateError([cause, abortCause], "Functionality publication and candidate cleanup failed"); }
        throw cause;
    }
}
