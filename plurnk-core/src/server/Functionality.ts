// {§functionality-coordinator} — the one owner of the workspace Functionality
// lifecycle above the family adapters (Agent Skills, MCP, outbound A2A). It owns
// durable workspace state, lifecycle ordering, serialization, atomic
// publication, and both projections: workspace-scoped client actions and a
// generated executor family whose host verbs propose. An explicit
// client mutation and an accepted model proposal converge on `invoke`.
import { Validator } from "@plurnk/plurnk-contracts";
import discoverySchema from "@plurnk/plurnk-contracts/schema/FunctionalityDiscoverQuery.json" with { type: "json" };
import { isDeepStrictEqual } from "node:util";
import { DocFile } from "@plurnk/plurnk-execs";
import type {
    FunctionalityDefinitionState,
    FunctionalityDiscoverResult,
    FunctionalityListResult,
    JsonSchema,
} from "@plurnk/plurnk-contracts";
import type {
    FunctionalityAdapter,
    FunctionalityCaller,
    FunctionalityFamilyHandle,
    FunctionalityIdentity,
    FunctionalityOptions,
    FunctionalityOutcome,
    FunctionalityPrepared,
    ModuleActionRegistration,
    RuntimeRegistration,
    WorkspaceCapabilityIdentity,
    WorkspaceCapabilityGate,
    WorkspaceCapabilityProvider,
    WorkspaceCapabilityReplacement,
    WorkspaceCapabilityPublication,
} from "./DaemonModule.ts";
import FunctionalityManager, {
    FUNCTIONALITY_VERBS,
    functionalityRuntimeDecl,
    type FunctionalityVerb,
} from "./FunctionalityManager.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import { generatedPathname } from "../core/plurnk-uri.ts";

export interface FunctionalityHost {
    registerModuleAction(registration: ModuleActionRegistration): void;
    registerWorkspaceCapabilityProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkspaceCapabilities(
        replacement: WorkspaceCapabilityReplacement,
        options?: WorkspaceCapabilityPublication,
    ): Promise<void>;
    // {§functionality-scope} — a worker-scoped family's durable value: the same shape, keyed by the
    // Worker, replaced without runtimes and without workspace exclusivity.
    readWorkerModuleState(workerId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkerModuleState(workerId: number, namespaceOwner: string, state: unknown | null): Promise<void>;
    mutateWorkspace<T>(workspaceId: number, namespaceOwner: string, caller: FunctionalityCaller, run: () => Promise<T>): Promise<T>;
    retainWorkspace(workspaceId: number): () => void;
}

// "action": an explicit client action under user authority — publishes now,
// rejects a failed preparation, 409 when the workspace is held. "operation": an
// execution verb inside a turn that holds the workspace — its ordinary execution
// stream waits for publication and carries enabled-but-unavailable outcomes.
export type { FunctionalityCaller };

export interface FunctionalityInvocation {
    readonly status: number;
    readonly body: unknown;
}

// Who OWNS a definition, not where it is scoped. A family declares the scope its definitions
// belong to ({§functionality-scope}); the locally-owned origin follows from it, so a worker-scoped
// family's own entries say "worker" rather than claiming the workspace set them.
type Origin = "service" | "workspace" | "worker";

interface DefinitionRecord {
    readonly origin: Origin;
    readonly definition?: object;
    readonly enabled: boolean;
    // {§functionality-scope} — the Worker a copied entry came from at this Worker's creation. Written
    // by the copy, never by a verb: a mutation makes the entry the Worker's own and drops it.
    readonly inherited?: string;
}

// {§functionality-state} — one durable value per (workspace, family) in
// `workspace_module_state` under the adapter's namespace owner, or per (worker, family) in
// `worker_module_state` for a worker-scoped family ({§functionality-scope}). Service-origin
// aliases persist only enabledness; locally-owned aliases persist the exact definition.
// Workers reference workspace state without copying it.
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
}

interface WorkspaceFamily {
    state: FamilyState;
    prepared: FunctionalityPrepared | null;
}

const STATE_VERSION = 1;
const FAMILY = /^[a-z][a-z0-9]*$/u;
const ALIAS = /^[a-z][a-z0-9-]*$/u;
// A family may declare its own alias grammar ({§functionality-adapter}); the coordinator enforces it
// wherever an alias enters: admission, the service projection, and persisted state.
const aliasPattern = (adapter: FunctionalityAdapter): RegExp => adapter.aliasPattern ?? ALIAS;
const scopesOf = (adapter: FunctionalityAdapter): readonly ("workspace" | "worker")[] => adapter.scopes ?? ["workspace"];
const EMPTY_STATE: FamilyState = Object.freeze({ version: STATE_VERSION, definitions: Object.freeze({}) });
const SCHEMA = (name: string): JsonSchema => ({ $ref: `https://schemas.plurnk.xyz/v0/${name}.json` });
const ALIAS_INPUT: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["alias"],
    properties: { alias: { type: "string", minLength: 1 } },
});
const EMPTY_INPUT: JsonSchema = Object.freeze({ type: "object", additionalProperties: false, properties: {} });

const failure = (
    family: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("functionality", code, status, detail, {}, { family, ...extensions }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export default class Functionality {
    readonly #host: FunctionalityHost;
    readonly #adapters = new Map<string, FunctionalityAdapter>();
    readonly #owners = new Set<string>();
    readonly #schemas = new Map<string, Readonly<Record<FunctionalityVerb, JsonSchema>>>();
    readonly #families = new Map<string, WorkspaceFamily>();
    readonly #queues = new Map<string, Promise<unknown>>();

    constructor(host: FunctionalityHost) {
        this.#host = host;
    }

    // {§functionality-adapter} — registration publishes the family's client
    // actions and its workspace capability provider at once.
    register(adapter: FunctionalityAdapter): FunctionalityFamilyHandle {
        const { family, namespaceOwner } = adapter;
        if (!FAMILY.test(family)) throw new Error(`Functionality family '${family}' must match ${FAMILY}.`);
        if (this.#adapters.has(family)) throw new Error(`Functionality family '${family}' is already registered.`);
        if (namespaceOwner.trim().length === 0) throw new Error(`Functionality family '${family}' requires a namespace owner.`);
        if (this.#owners.has(namespaceOwner)) throw new Error(`Functionality namespace owner '${namespaceOwner}' is already registered.`);
        if (!isRecord(adapter.definitionSchema)) throw new Error(`Functionality family '${family}' requires a definition schema.`);
        const scopes = scopesOf(adapter);
        if (scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some((scope) => scope !== "workspace" && scope !== "worker")) {
            throw new Error(`Functionality family '${family}' declares invalid scopes.`);
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
        const schemas: Readonly<Record<FunctionalityVerb, JsonSchema>> = Object.freeze({
            list: scopedInput(EMPTY_INPUT),
            discover: scopes.length === 1 ? SCHEMA("FunctionalityDiscoverQuery") : scopedInput(discoverySchema),
            add: Object.freeze({
                type: "object",
                additionalProperties: false,
                required: ["definition"],
                properties: {
                    ...scopeProperties,
                    alias: { type: "string", minLength: 1 },
                    definition: adapter.definitionSchema,
                },
            }),
            enable: scopedInput(ALIAS_INPUT),
            disable: scopedInput(ALIAS_INPUT),
            remove: scopedInput(ALIAS_INPUT),
        });
        // {§functionality-model-projection} — the taught `add` example must satisfy the schema it teaches.
        if (adapter.example !== undefined) {
            const example = Validator.validateJsonSchemaInstance(schemas.add, adapter.example);
            if (!example.valid) {
                throw new Error(`Functionality family '${family}' teaches an add example that violates its own definition schema: ${JSON.stringify(example.errors)}`);
            }
        }
        this.#adapters.set(family, adapter);
        this.#owners.add(namespaceOwner);
        this.#schemas.set(family, schemas);
        this.#host.registerWorkspaceCapabilityProvider(namespaceOwner, {
            activate: (context) => this.#activate(adapter, context),
            deactivate: (identity) => this.#deactivate(adapter, identity),
        });
        // {§functionality-scope} The action context binds one of the family's supported scopes.
        for (const scope of scopes) {
            for (const verb of FUNCTIONALITY_VERBS) {
                this.#host.registerModuleAction({
                    name: `${scope}.${family}.${verb}`,
                    scope,
                    inputSchema: schemas[verb],
                    outputSchema: SCHEMA(verb === "list"
                        ? "FunctionalityListResult"
                        : verb === "discover"
                            ? "FunctionalityDiscoverResult"
                            : "FunctionalityMutationResult"),
                    handler: async (params, context) => {
                        if (context.scope === "worldless" || context.scope !== scope) throw new Error(`${scope}.${family}.${verb} requires a ${scope}-scoped context.`);
                        const identity: FunctionalityIdentity = context.scope === "worker"
                            ? { workspaceId: context.workspaceId, workerId: context.workerId, scope }
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
    async refresh(family: string, identity: WorkspaceCapabilityIdentity, options: { readonly gate?: WorkspaceCapabilityGate } = {}): Promise<void> {
        const adapter = this.#adapter(family);
        await this.#serialize(this.#key(identity.workspaceId, family), async () => {
            const current = this.#families.get(this.#key(identity.workspaceId, family));
            if (current === undefined) return;
            await this.#publish(adapter, identity, current.state, {
                failure: "publish-unavailable",
                retain: () => this.#host.retainWorkspace(identity.workspaceId),
                gate: options.gate ?? "wait",
            });
        });
    }

    families(): string[] {
        return [...this.#adapters.keys()].toSorted();
    }

    // Join outstanding invocations before inspecting or closing durable state.
    // Rejections have already been delivered to their action or execution stream.
    async settle(workspaceId?: number): Promise<void> {
        const pending = [...this.#queues]
            .filter(([key]) => workspaceId === undefined || key.startsWith(`${workspaceId}:`))
            .map(([, queue]) => queue.catch(() => undefined));
        await Promise.all(pending);
    }

    // {§functionality-documents} — the family-generated documents of every
    // published family for one workspace, projected under each reader's generated subtree.
    // {§functionality-document-body} — read once per family from the adapter's package, the same
    // `docs/<tag>.md` rule runtimes use. A family that ships no file has a header-only document.
    #documentBodies = new Map<string, Promise<string>>();

    #documentBody(adapter: FunctionalityAdapter): Promise<string> {
        let body = this.#documentBodies.get(adapter.family);
        if (body === undefined) {
            body = adapter.docsDir === undefined
                ? Promise.resolve("")
                : DocFile.read(adapter.docsDir, adapter.family).then((text) => text ?? "");
            this.#documentBodies.set(adapter.family, body);
        }
        return body;
    }

    documents(workspaceId: number): Array<{ pathname: string; content: string }> {
        const out: Array<{ pathname: string; content: string }> = [];
        for (const [key, family] of this.#families) {
            if (!key.startsWith(`${workspaceId}:`) || family.prepared === null) continue;
            for (const document of family.prepared.documents) {
                out.push({ pathname: generatedPathname(document.pathname), content: document.content });
            }
        }
        return out;
    }

    // The one lifecycle entry for both projections ({§functionality-model-mutation}).
    async invoke(
        family: string,
        verb: FunctionalityVerb,
        params: unknown,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        options: FunctionalityOptions = {},
    ): Promise<FunctionalityInvocation> {
        const adapter = this.#adapter(family);
        const schema = this.#schemas.get(family)![verb];
        const validation = Validator.validateJsonSchemaInstance(schema, params);
        if (!validation.valid) {
            throw failure(family, "arguments-invalid", 400, `${family} ${verb} arguments do not match their schema.`, {
                errors: validation.errors,
                recovery: `Conform the ${verb} arguments to the ${family} ${verb} input schema.`,
                retryable: false,
            });
        }
        const input = params as Record<string, unknown>;
        const scope = (input.scope ?? identity.scope ?? scopesOf(adapter)[0]) as "workspace" | "worker";
        if (!scopesOf(adapter).includes(scope) || (identity.scope !== undefined && identity.scope !== scope)) {
            throw failure(family, "scope-mismatch", 400, `The ${family} operation's scope does not match its bound context.`, { retryable: false });
        }
        identity = { ...identity, scope };
        if (verb === "discover") {
            const { scope: _scope, ...query } = input;
            return { status: 200, body: await this.#discover(adapter, query, identity, options) };
        }
        // {§functionality-scope} — a worker-scoped family's list and mutations act for the invoking
        // Worker. The state is that Worker's and nothing resident changes, so they serialize on the
        // Worker's own lane and take no workspace exclusivity: a Worker shapes its environment while
        // its siblings run.
        if (scope === "worker") {
            const workerId = Functionality.#workerOf(adapter, identity);
            return this.#serialize(`${this.#key(identity.workspaceId, family)}:${workerId}`, () => this.#invokeForWorker(adapter, verb, input, identity, workerId, caller, options));
        }
        if (verb === "list") return { status: 200, body: await this.#list(adapter, identity) };
        return this.#host.mutateWorkspace(
            identity.workspaceId, adapter.namespaceOwner, caller,
            () => this.#serialize(this.#key(identity.workspaceId, family), () => this.#mutate(adapter, verb, input, identity, caller, options)),
        );
    }

    // A worker-scoped verb that names no Worker is a defect at the projection, never a client
    // failure: both projections name the Worker ({§functionality-model-projection}).
    static #workerOf(adapter: FunctionalityAdapter, identity: FunctionalityIdentity): number {
        if (identity.workerId === undefined) throw new Error(`${adapter.family} is worker-scoped; the invocation names no Worker.`);
        return identity.workerId;
    }

    // The origin a definition carries when this family owns it locally. Service definitions
    // always come from the adapter's own `available()`; everything else is the family's own.
    static #localOrigin(identity: FunctionalityIdentity): "worker" | "workspace" {
        return identity.scope ?? "workspace";
    }

    #adapter(family: string): FunctionalityAdapter {
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

    async #activate(adapter: FunctionalityAdapter, context: WorkspaceCapabilityIdentity & { retain(): () => void }): Promise<void> {
        const identity = { workspaceId: context.workspaceId };
        await this.#serialize(this.#key(identity.workspaceId, adapter.family), async () => {
            const state = await this.#loadState(adapter, identity.workspaceId);
            await this.#publish(adapter, identity, state, { failure: "publish-unavailable", retain: context.retain, gate: "none" });
        });
    }

    async #deactivate(adapter: FunctionalityAdapter, identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#serialize(this.#key(identity.workspaceId, adapter.family), async () => {
            const key = this.#key(identity.workspaceId, adapter.family);
            const family = this.#families.get(key);
            this.#families.delete(key);
            if (family?.prepared !== null && family?.prepared !== undefined) {
                await adapter.teardown(family.prepared.snapshot, identity);
            }
        });
    }

    async #loadState(adapter: FunctionalityAdapter, workspaceId: number): Promise<FamilyState> {
        return Functionality.#parseState(adapter, await this.#host.readWorkspaceModuleState(workspaceId, adapter.namespaceOwner), `workspace ${workspaceId}`, "workspace");
    }

    async #loadWorkerState(adapter: FunctionalityAdapter, workerId: number): Promise<FamilyState> {
        return Functionality.#parseState(adapter, await this.#host.readWorkerModuleState(workerId, adapter.namespaceOwner), `worker ${workerId}`, "worker");
    }

    static #parseState(adapter: FunctionalityAdapter, raw: unknown | null, where: string, scope: "workspace" | "worker"): FamilyState {
        if (raw === null) return EMPTY_STATE;
        if (!isRecord(raw) || raw.version !== STATE_VERSION || !isRecord(raw.definitions)) {
            throw new Error(`Functionality state for ${adapter.family} in ${where} is not a version ${STATE_VERSION} record.`);
        }
        const definitions: Record<string, DefinitionRecord> = {};
        for (const [alias, value] of Object.entries(raw.definitions)) {
            if (!aliasPattern(adapter).test(alias) || !isRecord(value)) throw new Error(`Functionality state for ${adapter.family} has an invalid alias '${alias}'.`);
            const { origin, enabled, definition, inherited } = value;
            if ((origin !== "service" && origin !== "workspace" && origin !== "worker") || typeof enabled !== "boolean") {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' is malformed.`);
            }
            if (origin !== "service" && origin !== scope && !(scope === "worker" && origin === "workspace" && scopesOf(adapter).includes("workspace"))) {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' has an invalid origin for ${scope} scope.`);
            }
            if (inherited !== undefined && (typeof inherited !== "string" || inherited.length === 0 || scope !== "worker")) {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' carries an invalid inheritance.`);
            }
            const provenance = inherited === undefined ? {} : { inherited };
            if (origin === scope) {
                const result = Validator.validateJsonSchemaInstance(adapter.definitionSchema, definition);
                if (!result.valid) throw new Error(`Functionality state for ${adapter.family} alias '${alias}' holds an invalid definition.`);
                definitions[alias] = { origin, enabled, definition: definition as object, ...provenance };
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

    async #effective(adapter: FunctionalityAdapter, identity: FunctionalityIdentity, state: FamilyState): Promise<Map<string, EffectiveDefinition>> {
        const effective = new Map<string, EffectiveDefinition>();
        const local = Functionality.#localOrigin(identity);
        const inheritsWorkspace = identity.scope === "worker" && scopesOf(adapter).includes("workspace");
        const lower = inheritsWorkspace
            ? [...(await this.#effective(adapter, { workspaceId: identity.workspaceId, scope: "workspace" }, await this.#loadState(adapter, identity.workspaceId))).values()]
            : (await adapter.available(identity)).map((entry) => ({ ...entry, origin: "service" as const }));
        for (const service of lower) {
            if (!aliasPattern(adapter).test(service.alias)) throw new Error(`${adapter.family} service alias '${service.alias}' must match ${aliasPattern(adapter)}.`);
            const record = state.definitions[service.alias];
            const overlay = record !== undefined && record.origin !== local ? record : undefined;
            const enabled = overlay === undefined ? service.enabled : overlay.enabled && (!inheritsWorkspace || service.enabled);
            const inherited = overlay?.inherited === undefined ? {} : { inherited: overlay.inherited };
            effective.set(service.alias, { alias: service.alias, origin: service.origin, definition: service.definition, enabled, ...inherited });
        }
        for (const [alias, record] of Object.entries(state.definitions)) {
            if (record.origin !== local) continue;
            const inherited = record.inherited === undefined ? {} : { inherited: record.inherited };
            effective.set(alias, { alias, origin: local, definition: record.definition!, enabled: record.enabled, ...inherited });
        }
        return new Map([...effective].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    #projection(definition: EffectiveDefinition, outcome: FunctionalityOutcome | undefined): FunctionalityDefinitionState {
        const base = {
            alias: definition.alias, origin: definition.origin, definition: definition.definition,
            ...(definition.inherited === undefined ? {} : { inherited: definition.inherited }),
        };
        if (!definition.enabled) return { ...base, state: "disabled" };
        if (outcome === undefined) throw new Error(`enabled ${definition.alias} has no preparation outcome`);
        switch (outcome.state) {
            case "active": return { ...base, state: "active", ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
            case "unavailable": return { ...base, state: "unavailable", problem: outcome.problem };
            case "authorization-required": return { ...base, state: "authorization-required", authorization: outcome.authorization };
        }
    }

    async #list(adapter: FunctionalityAdapter, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityListResult> {
        const family = this.#families.get(this.#key(identity.workspaceId, adapter.family));
        if (family === undefined) throw failure(adapter.family, "workspace-not-resident", 409, `Workspace ${identity.workspaceId} has no resident ${adapter.family} Functionality.`, { recovery: "Retry through a workspace operation, then retry.", retryable: false });
        const effective = await this.#effective(adapter, identity, family.state);
        const outcomes = family.prepared?.outcomes ?? new Map<string, FunctionalityOutcome>();
        return Validator.assertFunctionalityListResult({
            family: adapter.family,
            definitions: [...effective.values()].map((definition) => this.#projection(definition, outcomes.get(definition.alias))),
        });
    }

    async #discover(adapter: FunctionalityAdapter, query: Record<string, unknown>, identity: WorkspaceCapabilityIdentity, options: FunctionalityOptions): Promise<FunctionalityDiscoverResult> {
        const candidates = await adapter.discover(query, identity, options);
        return Validator.assertFunctionalityDiscoverResult({ family: adapter.family, candidates: [...candidates] });
    }

    // The verb semantics, one implementation for every family ({§functionality-scope}): the next
    // state, the alias it concerns, and how the mutation reports. Only publication differs by scope.
    async #transition(
        adapter: FunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        state: FamilyState,
        effective: ReadonlyMap<string, EffectiveDefinition>,
        options: FunctionalityOptions,
    ): Promise<{ definitions: Record<string, DefinitionRecord>; alias: string; status: 200 | 201; removed: boolean }> {
        const local = Functionality.#localOrigin(identity);
        const here = local === "worker" ? "this worker" : "this workspace";
        const definitions: Record<string, DefinitionRecord> = { ...state.definitions };
        let alias: string;
        let status: 200 | 201 = 200;
        let removed = false;
        switch (verb) {
            case "add": {
                const admitted = await adapter.admit(input, identity, caller, options);
                alias = admitted.alias;
                if (!aliasPattern(adapter).test(alias)) throw failure(adapter.family, "alias-invalid", 400, `Alias '${alias}' must match ${aliasPattern(adapter)}.`, { alias, retryable: false });
                // A local definition may shadow a service definition of the same
                // alias; removing it reveals the service baseline again, disabled.
                const current = effective.get(alias);
                if (current?.origin === local && !isDeepStrictEqual(current.definition, admitted.definition)) {
                    throw failure(adapter.family, "alias-exists", 409, `'${alias}' already has a different ${local} definition.`, { alias, recovery: "Use the existing definition, or remove it before adding its replacement.", retryable: false });
                }
                definitions[alias] = { origin: local, definition: admitted.definition, enabled: true };
                status = current?.origin === local ? 200 : 201;
                break;
            }
            case "enable":
            case "disable": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to ${here}.`, { alias, retryable: false });
                definitions[alias] = current.origin === local
                    ? { origin: local, definition: current.definition, enabled: verb === "enable" }
                    : { origin: current.origin, enabled: verb === "enable" };
                break;
            }
            case "remove": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to ${here}.`, { alias, retryable: false });
                if (current.origin === "service") throw failure(adapter.family, "alias-service-owned", 409, `'${alias}' is a service definition and cannot be removed here.`, { alias, recovery: `Disable it, or change the service configuration that contributes it.`, retryable: false });
                if (current.origin !== local) throw failure(adapter.family, "alias-workspace-owned", 409, `'${alias}' is a workspace definition; remove it in workspace scope or disable it here.`, { alias, retryable: false });
                await adapter.forget?.({ alias, definition: current.definition }, identity);
                delete definitions[alias];
                const revealed = (await this.#effective(adapter, identity, EMPTY_STATE)).get(alias);
                if (revealed) definitions[alias] = { origin: revealed.origin, enabled: false };
                removed = true;
                break;
            }
            default: throw new Error(`unreachable verb ${verb}`);
        }
        return { definitions, alias, status, removed };
    }

    #mutationResult(
        adapter: FunctionalityAdapter,
        { alias, status, removed }: { alias: string; status: 200 | 201; removed: boolean },
        effectiveAfter: ReadonlyMap<string, EffectiveDefinition>,
        outcomes: ReadonlyMap<string, FunctionalityOutcome>,
    ): FunctionalityInvocation {
        const definition = effectiveAfter.get(alias);
        const projection = definition === undefined ? undefined : this.#projection(definition, outcomes.get(alias));
        const body = Validator.assertFunctionalityMutationResult({
            status: projection?.state === "authorization-required" ? 202 : status,
            family: adapter.family,
            alias,
            ...(projection === undefined ? {} : { definition: projection }),
            ...(removed ? { removed: true } : {}),
        });
        return { status: body.status, body };
    }

    async #mutate(
        adapter: FunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        options: FunctionalityOptions,
    ): Promise<FunctionalityInvocation> {
        const key = this.#key(identity.workspaceId, adapter.family);
        const family = this.#families.get(key);
        if (family === undefined) throw failure(adapter.family, "workspace-not-resident", 409, `Workspace ${identity.workspaceId} has no resident ${adapter.family} Functionality.`, { recovery: "Retry through a workspace operation, then retry.", retryable: false });
        const effective = await this.#effective(adapter, identity, family.state);
        const transition = await this.#transition(adapter, verb, input, identity, caller, family.state, effective, options);
        const nextState: FamilyState = { version: STATE_VERSION, definitions: transition.definitions };
        // Re-enabling an alias that is not active retries its preparation; an
        // already-active alias keeps its live attachment.
        const retry = verb === "enable" && family.prepared?.outcomes.get(transition.alias)?.state !== "active";
        const publication = await this.#publish(adapter, identity, nextState, {
            failure: caller === "action" ? "reject" : "publish-unavailable",
            retain: () => this.#host.retainWorkspace(identity.workspaceId),
            gate: "none",
            forceAlias: retry ? transition.alias : null,
        });
        const effectiveAfter = await this.#effective(adapter, identity, nextState);
        return this.#mutationResult(adapter, transition, effectiveAfter, publication.outcomes);
    }

    // {§functionality-scope} — the Worker's own lane. State is read at each verb rather than held: the
    // spawn reads the same row, and a Worker's row is written at its creation, so nothing in memory
    // could be more current than the table.
    async #invokeForWorker(
        adapter: FunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        workerId: number,
        caller: FunctionalityCaller,
        options: FunctionalityOptions,
    ): Promise<FunctionalityInvocation> {
        if (!this.#families.has(this.#key(identity.workspaceId, adapter.family))) throw failure(adapter.family, "workspace-not-resident", 409, `Workspace ${identity.workspaceId} has no resident ${adapter.family} Functionality.`, { recovery: "Retry through a workspace operation, then retry.", retryable: false });
        const state = await this.#loadWorkerState(adapter, workerId);
        const effective = await this.#effective(adapter, identity, state);
        if (verb === "list") {
            const prepared = await this.#prepareForWorker(adapter, identity, effective, "publish-unavailable");
            await prepared.commit();
            return { status: 200, body: Validator.assertFunctionalityListResult({
                family: adapter.family,
                definitions: [...effective.values()].map((definition) => this.#projection(definition, prepared.outcomes.get(definition.alias))),
            }) };
        }
        const transition = await this.#transition(adapter, verb, input, identity, caller, state, effective, options);
        const nextState: FamilyState = { version: STATE_VERSION, definitions: transition.definitions };
        const effectiveAfter = await this.#effective(adapter, identity, nextState);
        const prepared = await this.#prepareForWorker(adapter, identity, effectiveAfter, caller === "action" ? "reject" : "publish-unavailable");
        try {
            await this.#host.replaceWorkerModuleState(workerId, adapter.namespaceOwner, Functionality.#persisted(nextState));
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        await prepared.commit();
        return this.#mutationResult(adapter, transition, effectiveAfter, prepared.outcomes);
    }

    // A worker-scoped family's preparation yields outcomes only. It holds no residency — no runtimes,
    // documents or snapshot ({§module-workspace-residency}) — because its definitions are read at the
    // spawn that uses them rather than leased and cooled; the coordinator enforces that here.
    async #prepareForWorker(
        adapter: FunctionalityAdapter,
        identity: FunctionalityIdentity,
        effective: ReadonlyMap<string, EffectiveDefinition>,
        failureMode: "publish-unavailable" | "reject",
    ): Promise<FunctionalityPrepared> {
        const enabled = Functionality.#enabled(effective);
        const prepared = await adapter.prepare({
            workspaceId: identity.workspaceId, enabled, previous: null, failure: failureMode,
            retain: () => this.#host.retainWorkspace(identity.workspaceId),
        });
        try {
            Functionality.#checkOutcomes(adapter, enabled, prepared);
            if ((prepared.runtimes?.length ?? 0) > 0 || prepared.documents.length > 0 || prepared.snapshot !== null) {
                throw new Error(`${adapter.family} is worker-scoped and holds no residency, yet its preparation published runtimes, documents or a snapshot.`);
            }
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        return prepared;
    }

    static #enabled(effective: ReadonlyMap<string, EffectiveDefinition>): Map<string, object> {
        const enabled = new Map<string, object>();
        for (const definition of effective.values()) {
            if (definition.enabled) enabled.set(definition.alias, definition.definition);
        }
        return enabled;
    }

    static #checkOutcomes(adapter: FunctionalityAdapter, enabled: ReadonlyMap<string, object>, prepared: FunctionalityPrepared): void {
        for (const alias of enabled.keys()) {
            if (!prepared.outcomes.has(alias)) throw new Error(`${adapter.family} preparation reported no outcome for enabled alias '${alias}'.`);
        }
    }

    // {§functionality-publication} — prepare, publish runtimes and state in one
    // host replacement, then commit; on any failure abort and keep the previous
    // snapshot authoritative. An execution stream stays pending until its
    // workspace publication completes; it never acknowledges a future commit.
    async #publish(
        adapter: FunctionalityAdapter,
        identity: WorkspaceCapabilityIdentity,
        nextState: FamilyState,
        options: {
            readonly failure: "publish-unavailable" | "reject";
            readonly retain: () => () => void;
            readonly gate: WorkspaceCapabilityGate;
            readonly forceAlias?: string | null;
        },
    ): Promise<{ outcomes: ReadonlyMap<string, FunctionalityOutcome> }> {
        const key = this.#key(identity.workspaceId, adapter.family);
        const previous = this.#families.get(key)?.prepared ?? null;
        // A worker-scoped family's workspace publication carries only its manager: what is enabled
        // is decided per Worker, at each verb and each spawn ({§functionality-scope}).
        const effective = !scopesOf(adapter).includes("workspace") ? new Map<string, EffectiveDefinition>() : await this.#effective(adapter, { ...identity, scope: "workspace" }, nextState);
        const enabled = Functionality.#enabled(effective);
        const prepared = await adapter.prepare({
            workspaceId: identity.workspaceId,
            enabled,
            previous: previous?.snapshot ?? null,
            failure: options.failure,
            retain: options.retain,
            ...(options.forceAlias ? { force: options.forceAlias } : {}),
        });
        let runtimes: RuntimeRegistration[];
        try {
            Functionality.#checkOutcomes(adapter, enabled, prepared);
            for (const runtime of prepared.runtimes ?? []) {
                if (runtime.namespaceOwner !== adapter.namespaceOwner) {
                    throw new Error(`${adapter.family} prepared a runtime owned by '${runtime.namespaceOwner}' instead of '${adapter.namespaceOwner}'.`);
                }
            }
            const manager: RuntimeRegistration = {
                namespaceOwner: adapter.namespaceOwner,
                decl: functionalityRuntimeDecl(adapter.family, adapter.summary, await this.#documentBody(adapter)),
                executor: new FunctionalityManager({
                    family: adapter.family, workspaceId: identity.workspaceId, coordinator: this,
                    inputSchemas: this.#schemas.get(adapter.family)!, example: adapter.example, discovery: adapter.discovery,
                }),
                availability: { available: true, detail: "workspace Functionality manager" },
                ...(adapter.scheme === undefined ? {} : { scheme: adapter.scheme }),
            };
            runtimes = [manager, ...(prepared.runtimes ?? [])];
        } catch (cause) {
            return Functionality.#abort(prepared, cause);
        }
        const commit = async (): Promise<void> => {
            const before = this.#families.get(key);
            try {
                await this.#host.replaceWorkspaceCapabilities({
                    workspaceId: identity.workspaceId,
                    namespaceOwner: adapter.namespaceOwner,
                    state: Functionality.#persisted(nextState),
                    runtimes,
                }, {
                    gate: options.gate,
                    publish: () => {
                        this.#families.set(key, { state: nextState, prepared });
                        return () => {
                            if (before === undefined) this.#families.delete(key);
                            else this.#families.set(key, before);
                        };
                    },
                });
            } catch (cause) {
                return Functionality.#abort(prepared, cause);
            }
            await prepared.commit();
        };
        await commit();
        return { outcomes: prepared.outcomes };
    }

    static async #abort(prepared: FunctionalityPrepared, cause: unknown): Promise<never> {
        try { await prepared.abort(); }
        catch (abortCause) { throw new AggregateError([cause, abortCause], "Functionality publication and candidate cleanup failed"); }
        throw cause;
    }
}
