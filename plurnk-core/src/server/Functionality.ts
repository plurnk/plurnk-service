// {§functionality-coordinator} — the one owner of the Worker Functionality
// lifecycle above the family adapters (Agent Skills, MCP, outbound A2A). It owns
// durable per-Worker state, lifecycle ordering, serialization, atomic
// publication, and both projections: worker-scoped client actions and a
// per-Worker generated executor family whose host verbs propose. An explicit
// client mutation and an accepted model proposal converge on `invoke`.
import { Validator } from "@plurnk/plurnk-contracts";
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
    FunctionalityOutcome,
    FunctionalityPrepared,
    ModuleActionRegistration,
    RuntimeRegistration,
    WorkerCapabilityIdentity,
    WorkerCapabilityGate,
    WorkerCapabilityProvider,
    WorkerCapabilityReplacement,
} from "./DaemonModule.ts";
import FunctionalityManager, {
    FUNCTIONALITY_VERBS,
    functionalityRuntimeDecl,
    type FunctionalityVerb,
} from "./FunctionalityManager.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import { generatedPathname } from "../core/plurnk-uri.ts";

export interface FunctionalityHost {
    registerModuleAction(registration: ModuleActionRegistration): void;
    registerWorkerCapabilityProvider(namespaceOwner: string, provider: WorkerCapabilityProvider): void;
    readWorkerModuleState(workerId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkerCapabilities(
        replacement: WorkerCapabilityReplacement,
        options?: { readonly gate?: WorkerCapabilityGate },
    ): Promise<void>;
    retainWorker(workerId: number): () => void;
}

// "action": an explicit client action under user authority — publishes now,
// rejects a failed preparation, 409 when the workspace is held. "operation": an
// EXEC verb inside a turn that holds the workspace — publishes
// enabled-but-unavailable outcomes and defers publication to the turn boundary.
export type { FunctionalityCaller };

export interface FunctionalityInvocation {
    readonly status: number;
    readonly body: unknown;
}

type Origin = "service" | "worker";

interface DefinitionRecord {
    readonly origin: Origin;
    readonly definition?: object;
    readonly enabled: boolean;
}

// {§functionality-state} — one durable value per (Worker, family) in
// `worker_module_state` under the adapter's namespace owner. Service-origin
// aliases persist only enabledness; worker-origin aliases persist the exact
// definition. Inheritance by value is the table's own birth-snapshot rule.
interface FamilyState {
    readonly version: 1;
    readonly definitions: Readonly<Record<string, DefinitionRecord>>;
}

interface EffectiveDefinition {
    readonly alias: string;
    readonly origin: Origin;
    readonly definition: object;
    readonly enabled: boolean;
}

interface WorkerFamily {
    state: FamilyState;
    prepared: FunctionalityPrepared | null;
}

const STATE_VERSION = 1;
const FAMILY = /^[a-z][a-z0-9]*$/u;
const ALIAS = /^[a-z][a-z0-9-]*$/u;
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
    Results.failure("functionality", code, status, detail, {}, { family, retryable: status === 409 || status >= 500, ...extensions }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export default class Functionality {
    readonly #host: FunctionalityHost;
    readonly #adapters = new Map<string, FunctionalityAdapter>();
    readonly #owners = new Set<string>();
    readonly #schemas = new Map<string, Readonly<Record<FunctionalityVerb, JsonSchema>>>();
    readonly #families = new Map<string, WorkerFamily>();
    readonly #queues = new Map<string, Promise<unknown>>();

    constructor(host: FunctionalityHost) {
        this.#host = host;
    }

    // {§functionality-adapter} — registration publishes the family's client
    // actions and its Worker capability provider at once.
    register(adapter: FunctionalityAdapter): FunctionalityFamilyHandle {
        const { family, namespaceOwner } = adapter;
        if (!FAMILY.test(family)) throw new Error(`Functionality family '${family}' must match ${FAMILY}.`);
        if (this.#adapters.has(family)) throw new Error(`Functionality family '${family}' is already registered.`);
        if (namespaceOwner.trim().length === 0) throw new Error(`Functionality family '${family}' requires a namespace owner.`);
        if (this.#owners.has(namespaceOwner)) throw new Error(`Functionality namespace owner '${namespaceOwner}' is already registered.`);
        if (!isRecord(adapter.definitionSchema)) throw new Error(`Functionality family '${family}' requires a definition schema.`);
        const schemas: Readonly<Record<FunctionalityVerb, JsonSchema>> = Object.freeze({
            list: EMPTY_INPUT,
            discover: SCHEMA("FunctionalityDiscoverQuery"),
            add: Object.freeze({
                type: "object",
                additionalProperties: false,
                required: ["definition"],
                properties: {
                    alias: { type: "string", minLength: 1 },
                    definition: adapter.definitionSchema,
                },
            }),
            enable: ALIAS_INPUT,
            disable: ALIAS_INPUT,
            remove: ALIAS_INPUT,
        });
        this.#adapters.set(family, adapter);
        this.#owners.add(namespaceOwner);
        this.#schemas.set(family, schemas);
        this.#host.registerWorkerCapabilityProvider(namespaceOwner, {
            activate: (context) => this.#activate(adapter, context),
            deactivate: (identity) => this.#deactivate(adapter, identity),
        });
        for (const verb of FUNCTIONALITY_VERBS) {
            this.#host.registerModuleAction({
                name: `worker.${family}.${verb}`,
                scope: "worker",
                inputSchema: schemas[verb],
                outputSchema: SCHEMA(verb === "list"
                    ? "FunctionalityListResult"
                    : verb === "discover"
                        ? "FunctionalityDiscoverResult"
                        : "FunctionalityMutationResult"),
                handler: async (params, context) => {
                    if (context.scope !== "worker") throw new Error(`worker.${family}.${verb} requires a worker-scoped context.`);
                    const { workspaceId, workerId } = context;
                    return (await this.invoke(family, verb, params, { workspaceId, workerId }, "action")).body;
                },
            });
        }
        return {
            invoke: (verb, params, identity) => this.invoke(family, verb, params, identity, "action"),
            refresh: (identity, options) => this.refresh(family, identity, options),
        };
    }

    // Republish a family's unchanged state for one Worker — a live catalog
    // change, not a lifecycle mutation. Serialized like every publication.
    // `gate: "none"` publishes inside the caller's own held turn (turn admission
    // refreshing a family before packet assembly) instead of contending for
    // workspace exclusivity it could never win.
    async refresh(family: string, identity: WorkerCapabilityIdentity, options: { readonly gate?: WorkerCapabilityGate } = {}): Promise<void> {
        const adapter = this.#adapter(family);
        await this.#serialize(identity.workerId, family, async () => {
            const current = this.#families.get(this.#key(identity.workerId, family));
            if (current === undefined) return;
            await this.#publish(adapter, identity, current.state, {
                failure: "publish-unavailable",
                retain: () => this.#host.retainWorker(identity.workerId),
                gate: options.gate ?? "wait",
            });
        });
    }

    families(): string[] {
        return [...this.#adapters.keys()].toSorted();
    }

    // Await every queued publication (boundary publications included). Shutdown
    // and tests settle before inspecting or closing durable state.
    async settle(workerId?: number): Promise<void> {
        const pending = [...this.#queues]
            .filter(([key]) => workerId === undefined || key.startsWith(`${workerId}:`))
            .map(([, queue]) => queue.catch(() => undefined));
        await Promise.all(pending);
    }

    // {§functionality-documents} — the family-generated documents of every
    // published family for one Worker, addressed under its generated subtree.
    documents(workerId: number): Array<{ pathname: string; content: string }> {
        const out: Array<{ pathname: string; content: string }> = [];
        for (const [key, family] of this.#families) {
            if (!key.startsWith(`${workerId}:`) || family.prepared === null) continue;
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
        identity: WorkerCapabilityIdentity,
        caller: FunctionalityCaller,
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
        switch (verb) {
            case "list": return { status: 200, body: await this.#list(adapter, identity) };
            case "discover": return { status: 200, body: await this.#discover(adapter, input, identity) };
            default: return this.#serialize(identity.workerId, family, () => this.#mutate(adapter, verb, input, identity, caller));
        }
    }

    #adapter(family: string): FunctionalityAdapter {
        const adapter = this.#adapters.get(family);
        if (adapter === undefined) throw failure(family, "family-unknown", 404, `No Functionality family '${family}' is registered.`, { retryable: false });
        return adapter;
    }

    #key(workerId: number, family: string): string {
        return `${workerId}:${family}`;
    }

    #serialize<T>(workerId: number, family: string, work: () => Promise<T>): Promise<T> {
        const key = this.#key(workerId, family);
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        this.#queues.set(key, next);
        return next;
    }

    async #activate(adapter: FunctionalityAdapter, context: WorkerCapabilityIdentity & { retain(): () => void }): Promise<void> {
        const identity = { workspaceId: context.workspaceId, workerId: context.workerId };
        await this.#serialize(identity.workerId, adapter.family, async () => {
            const state = await this.#loadState(adapter, identity.workerId);
            await this.#publish(adapter, identity, state, { failure: "publish-unavailable", retain: context.retain, gate: "none" });
        });
    }

    async #deactivate(adapter: FunctionalityAdapter, identity: WorkerCapabilityIdentity): Promise<void> {
        await this.#serialize(identity.workerId, adapter.family, async () => {
            const key = this.#key(identity.workerId, adapter.family);
            const family = this.#families.get(key);
            this.#families.delete(key);
            if (family?.prepared !== null && family?.prepared !== undefined) {
                await adapter.teardown(family.prepared.snapshot, identity);
            }
        });
    }

    async #loadState(adapter: FunctionalityAdapter, workerId: number): Promise<FamilyState> {
        const raw = await this.#host.readWorkerModuleState(workerId, adapter.namespaceOwner);
        if (raw === null) return EMPTY_STATE;
        if (!isRecord(raw) || raw.version !== STATE_VERSION || !isRecord(raw.definitions)) {
            throw new Error(`Functionality state for ${adapter.family} on worker ${workerId} is not a version ${STATE_VERSION} record.`);
        }
        const definitions: Record<string, DefinitionRecord> = {};
        for (const [alias, value] of Object.entries(raw.definitions)) {
            if (!ALIAS.test(alias) || !isRecord(value)) throw new Error(`Functionality state for ${adapter.family} has an invalid alias '${alias}'.`);
            const { origin, enabled, definition } = value;
            if ((origin !== "service" && origin !== "worker") || typeof enabled !== "boolean") {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' is malformed.`);
            }
            if (origin === "worker") {
                const result = Validator.validateJsonSchemaInstance(adapter.definitionSchema, definition);
                if (!result.valid) throw new Error(`Functionality state for ${adapter.family} alias '${alias}' holds an invalid definition.`);
                definitions[alias] = { origin, enabled, definition: definition as object };
            } else {
                if (definition !== undefined) throw new Error(`Functionality state for ${adapter.family} alias '${alias}' persists a service definition.`);
                definitions[alias] = { origin, enabled };
            }
        }
        return { version: STATE_VERSION, definitions };
    }

    static #persisted(state: FamilyState): FamilyState | null {
        return Object.keys(state.definitions).length === 0 ? null : state;
    }

    async #effective(adapter: FunctionalityAdapter, identity: WorkerCapabilityIdentity, state: FamilyState): Promise<Map<string, EffectiveDefinition>> {
        const effective = new Map<string, EffectiveDefinition>();
        for (const service of await adapter.available(identity)) {
            if (!ALIAS.test(service.alias)) throw new Error(`${adapter.family} service alias '${service.alias}' must match ${ALIAS}.`);
            const record = state.definitions[service.alias];
            const enabled = record?.origin === "service" ? record.enabled : service.enabled;
            effective.set(service.alias, { alias: service.alias, origin: "service", definition: service.definition, enabled });
        }
        for (const [alias, record] of Object.entries(state.definitions)) {
            if (record.origin !== "worker") continue;
            effective.set(alias, { alias, origin: "worker", definition: record.definition!, enabled: record.enabled });
        }
        return new Map([...effective].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    #projection(definition: EffectiveDefinition, outcome: FunctionalityOutcome | undefined): FunctionalityDefinitionState {
        if (!definition.enabled) {
            return { alias: definition.alias, origin: definition.origin, state: "disabled", definition: definition.definition };
        }
        if (outcome === undefined) throw new Error(`enabled ${definition.alias} has no preparation outcome`);
        switch (outcome.state) {
            case "active": return {
                alias: definition.alias, origin: definition.origin, state: "active", definition: definition.definition,
                ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            };
            case "unavailable": return { alias: definition.alias, origin: definition.origin, state: "unavailable", definition: definition.definition, problem: outcome.problem };
            case "authorization-required": return { alias: definition.alias, origin: definition.origin, state: "authorization-required", definition: definition.definition, authorization: outcome.authorization };
        }
    }

    async #list(adapter: FunctionalityAdapter, identity: WorkerCapabilityIdentity): Promise<FunctionalityListResult> {
        const family = this.#families.get(this.#key(identity.workerId, adapter.family));
        if (family === undefined) throw failure(adapter.family, "worker-not-resident", 409, `Worker ${identity.workerId} has no resident ${adapter.family} Functionality.`, { recovery: "Activate the Worker through an ordinary operation, then retry.", retryable: true });
        const effective = await this.#effective(adapter, identity, family.state);
        const outcomes = family.prepared?.outcomes ?? new Map<string, FunctionalityOutcome>();
        return Validator.assertFunctionalityListResult({
            family: adapter.family,
            definitions: [...effective.values()].map((definition) => this.#projection(definition, outcomes.get(definition.alias))),
        });
    }

    async #discover(adapter: FunctionalityAdapter, query: Record<string, unknown>, identity: WorkerCapabilityIdentity): Promise<FunctionalityDiscoverResult> {
        const candidates = await adapter.discover(query, identity);
        return Validator.assertFunctionalityDiscoverResult({ family: adapter.family, candidates: [...candidates] });
    }

    async #mutate(
        adapter: FunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: WorkerCapabilityIdentity,
        caller: FunctionalityCaller,
    ): Promise<FunctionalityInvocation> {
        const key = this.#key(identity.workerId, adapter.family);
        const family = this.#families.get(key);
        if (family === undefined) throw failure(adapter.family, "worker-not-resident", 409, `Worker ${identity.workerId} has no resident ${adapter.family} Functionality.`, { recovery: "Activate the Worker through an ordinary operation, then retry.", retryable: true });
        const effective = await this.#effective(adapter, identity, family.state);
        const definitions: Record<string, DefinitionRecord> = { ...family.state.definitions };
        let alias: string;
        let status: 200 | 201 = 200;
        let removed = false;
        switch (verb) {
            case "add": {
                const admitted = await adapter.admit(input, identity, caller);
                alias = admitted.alias;
                if (!ALIAS.test(alias)) throw failure(adapter.family, "alias-invalid", 400, `Alias '${alias}' must match ${ALIAS}.`, { alias, retryable: false });
                // A worker definition may shadow a service definition of the same
                // alias; removing it reveals the service baseline again, disabled.
                if (effective.get(alias)?.origin === "worker") throw failure(adapter.family, "alias-exists", 409, `'${alias}' is already this Worker's own definition.`, { alias, recovery: "Enable, disable, or remove the existing definition, or add under another alias.", retryable: false });
                definitions[alias] = { origin: "worker", definition: admitted.definition, enabled: true };
                status = 201;
                break;
            }
            case "enable":
            case "disable": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to this Worker.`, { alias, retryable: false });
                definitions[alias] = current.origin === "worker"
                    ? { origin: "worker", definition: current.definition, enabled: verb === "enable" }
                    : { origin: "service", enabled: verb === "enable" };
                break;
            }
            case "remove": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to this Worker.`, { alias, retryable: false });
                if (current.origin === "service") throw failure(adapter.family, "alias-service-owned", 409, `'${alias}' is a service definition and cannot be removed here.`, { alias, recovery: `Disable it, or change the service configuration that contributes it.`, retryable: false });
                await adapter.forget?.({ alias, definition: current.definition }, identity);
                delete definitions[alias];
                const revealed = (await adapter.available(identity)).some((service) => service.alias === alias);
                if (revealed) definitions[alias] = { origin: "service", enabled: false };
                removed = true;
                break;
            }
            default: throw new Error(`unreachable verb ${verb}`);
        }
        const nextState: FamilyState = { version: STATE_VERSION, definitions };
        // Re-enabling an alias that is not active retries its preparation; an
        // already-active alias keeps its live attachment.
        const retry = verb === "enable" && family.prepared?.outcomes.get(alias)?.state !== "active";
        const publication = await this.#publish(adapter, identity, nextState, {
            failure: caller === "action" ? "reject" : "publish-unavailable",
            retain: () => this.#host.retainWorker(identity.workerId),
            gate: caller === "operation" ? "wait" : "try",
            forceAlias: retry ? alias : null,
        });
        const effectiveAfter = await this.#effective(adapter, identity, nextState);
        const definition = effectiveAfter.get(alias);
        const projection = definition === undefined ? undefined : this.#projection(definition, publication.outcomes.get(alias));
        const body = Validator.assertFunctionalityMutationResult({
            status: projection?.state === "authorization-required" ? 202 : status,
            family: adapter.family,
            alias,
            ...(projection === undefined ? {} : { definition: projection }),
            ...(removed ? { removed: true } : {}),
        });
        return { status: body.status, body };
    }

    // {§functionality-publication} — prepare, publish runtimes and state in one
    // host replacement, then commit; on any failure abort and keep the previous
    // snapshot authoritative. A model caller's publication waits for its own
    // turn boundary in the same serialized lane, so the next packet sees it.
    async #publish(
        adapter: FunctionalityAdapter,
        identity: WorkerCapabilityIdentity,
        nextState: FamilyState,
        options: {
            readonly failure: "publish-unavailable" | "reject";
            readonly retain: () => () => void;
            readonly gate: WorkerCapabilityGate;
            readonly forceAlias?: string | null;
        },
    ): Promise<{ outcomes: ReadonlyMap<string, FunctionalityOutcome> }> {
        const key = this.#key(identity.workerId, adapter.family);
        const previous = this.#families.get(key)?.prepared ?? null;
        const effective = await this.#effective(adapter, identity, nextState);
        const enabled = new Map<string, object>();
        for (const definition of effective.values()) {
            if (definition.enabled) enabled.set(definition.alias, definition.definition);
        }
        const prepared = await adapter.prepare({
            workspaceId: identity.workspaceId,
            workerId: identity.workerId,
            enabled,
            previous: previous?.snapshot ?? null,
            failure: options.failure,
            retain: options.retain,
            ...(options.forceAlias ? { force: options.forceAlias } : {}),
        });
        for (const alias of enabled.keys()) {
            if (!prepared.outcomes.has(alias)) throw new Error(`${adapter.family} preparation reported no outcome for enabled alias '${alias}'.`);
        }
        const manager: RuntimeRegistration = {
            namespaceOwner: adapter.namespaceOwner,
            decl: functionalityRuntimeDecl(adapter.family, adapter.summary),
            executor: new FunctionalityManager({
                family: adapter.family, workspaceId: identity.workspaceId, workerId: identity.workerId, coordinator: this,
                definitionSchema: adapter.definitionSchema, example: adapter.example, discovery: adapter.discovery,
            }),
            availability: { available: true, detail: "Worker Functionality manager" },
        };
        const runtimes = [manager, ...prepared.runtimes];
        for (const runtime of prepared.runtimes) {
            if (runtime.namespaceOwner !== adapter.namespaceOwner) {
                await prepared.abort();
                throw new Error(`${adapter.family} prepared a runtime owned by '${runtime.namespaceOwner}' instead of '${adapter.namespaceOwner}'.`);
            }
        }
        const commit = async (): Promise<void> => {
            // The host reconciles the Worker's documents inside the replacement,
            // so the snapshot it reads must already be the next one; a failed
            // replacement restores the previous snapshot before aborting.
            const before = this.#families.get(key);
            this.#families.set(key, { state: nextState, prepared });
            try {
                await this.#host.replaceWorkerCapabilities({
                    workspaceId: identity.workspaceId,
                    workerId: identity.workerId,
                    namespaceOwner: adapter.namespaceOwner,
                    state: Functionality.#persisted(nextState),
                    runtimes,
                }, { gate: options.gate });
            } catch (cause) {
                if (before === undefined) this.#families.delete(key);
                else this.#families.set(key, before);
                await prepared.abort();
                throw cause;
            }
            await prepared.commit();
        };
        if (options.gate !== "wait") {
            await commit();
            return { outcomes: prepared.outcomes };
        }
        // Inside the caller's own turn the workspace is held by that turn:
        // publication queues behind it in this family's lane and settles
        // before the next packet. The caller learns the preparation outcome now.
        const pending = (this.#queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(commit);
        this.#queues.set(key, pending.catch((cause) => {
            console.error(`[plurnk] ${adapter.family} publication for worker ${identity.workerId} failed at its turn boundary:`, cause);
        }));
        return { outcomes: prepared.outcomes };
    }
}

export type { FamilyState as FunctionalityFamilyState, SchemeResult as FunctionalityResult };
