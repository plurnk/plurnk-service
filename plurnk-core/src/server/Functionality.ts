// {§functionality-coordinator} — the one owner of the workspace Functionality
// lifecycle above the family adapters (Agent Skills, MCP, outbound A2A). It owns
// durable workspace state, lifecycle ordering, serialization, atomic
// publication, and both projections: workspace-scoped client actions and a
// generated executor family whose host verbs propose. An explicit
// client mutation and an accepted model proposal converge on `invoke`.
import { Validator } from "@plurnk/plurnk-contracts";
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
    mutateWorkspace<T>(workspaceId: number, namespaceOwner: string, caller: FunctionalityCaller, run: () => Promise<T>): Promise<T>;
    retainWorkspace(workspaceId: number): () => void;
}

// "action": an explicit client action under user authority — publishes now,
// rejects a failed preparation, 409 when the workspace is held. "operation": an
// EXEC verb inside a turn that holds the workspace — its ordinary execution
// stream waits for publication and carries enabled-but-unavailable outcomes.
export type { FunctionalityCaller };

export interface FunctionalityInvocation {
    readonly status: number;
    readonly body: unknown;
}

type Origin = "service" | "workspace";

interface DefinitionRecord {
    readonly origin: Origin;
    readonly definition?: object;
    readonly enabled: boolean;
}

// {§functionality-state} — one durable value per (workspace, family) in
// `workspace_module_state` under the adapter's namespace owner. Service-origin
// aliases persist only enabledness; workspace-origin aliases persist the exact
// definition. Workers reference this state without copying it.
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

interface WorkspaceFamily {
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
        for (const verb of FUNCTIONALITY_VERBS) {
            this.#host.registerModuleAction({
                name: `workspace.${family}.${verb}`,
                scope: "workspace",
                inputSchema: schemas[verb],
                outputSchema: SCHEMA(verb === "list"
                    ? "FunctionalityListResult"
                    : verb === "discover"
                        ? "FunctionalityDiscoverResult"
                        : "FunctionalityMutationResult"),
                handler: async (params, context) => {
                    if (context.scope !== "workspace") throw new Error(`workspace.${family}.${verb} requires a workspace-scoped context.`);
                    const { workspaceId } = context;
                    return (await this.invoke(family, verb, params, { workspaceId }, "action")).body;
                },
            });
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
        await this.#serialize(identity.workspaceId, family, async () => {
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
        identity: WorkspaceCapabilityIdentity,
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
            default: return this.#host.mutateWorkspace(
                identity.workspaceId, adapter.namespaceOwner, caller,
                () => this.#serialize(identity.workspaceId, family, () => this.#mutate(adapter, verb, input, identity, caller)),
            );
        }
    }

    #adapter(family: string): FunctionalityAdapter {
        const adapter = this.#adapters.get(family);
        if (adapter === undefined) throw failure(family, "family-unknown", 404, `No Functionality family '${family}' is registered.`, { retryable: false });
        return adapter;
    }

    #key(workspaceId: number, family: string): string {
        return `${workspaceId}:${family}`;
    }

    #serialize<T>(workspaceId: number, family: string, work: () => Promise<T>): Promise<T> {
        const key = this.#key(workspaceId, family);
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        this.#queues.set(key, next);
        return next;
    }

    async #activate(adapter: FunctionalityAdapter, context: WorkspaceCapabilityIdentity & { retain(): () => void }): Promise<void> {
        const identity = { workspaceId: context.workspaceId };
        await this.#serialize(identity.workspaceId, adapter.family, async () => {
            const state = await this.#loadState(adapter, identity.workspaceId);
            await this.#publish(adapter, identity, state, { failure: "publish-unavailable", retain: context.retain, gate: "none" });
        });
    }

    async #deactivate(adapter: FunctionalityAdapter, identity: WorkspaceCapabilityIdentity): Promise<void> {
        await this.#serialize(identity.workspaceId, adapter.family, async () => {
            const key = this.#key(identity.workspaceId, adapter.family);
            const family = this.#families.get(key);
            this.#families.delete(key);
            if (family?.prepared !== null && family?.prepared !== undefined) {
                await adapter.teardown(family.prepared.snapshot, identity);
            }
        });
    }

    async #loadState(adapter: FunctionalityAdapter, workspaceId: number): Promise<FamilyState> {
        const raw = await this.#host.readWorkspaceModuleState(workspaceId, adapter.namespaceOwner);
        if (raw === null) return EMPTY_STATE;
        if (!isRecord(raw) || raw.version !== STATE_VERSION || !isRecord(raw.definitions)) {
            throw new Error(`Functionality state for ${adapter.family} in workspace ${workspaceId} is not a version ${STATE_VERSION} record.`);
        }
        const definitions: Record<string, DefinitionRecord> = {};
        for (const [alias, value] of Object.entries(raw.definitions)) {
            if (!ALIAS.test(alias) || !isRecord(value)) throw new Error(`Functionality state for ${adapter.family} has an invalid alias '${alias}'.`);
            const { origin, enabled, definition } = value;
            if ((origin !== "service" && origin !== "workspace") || typeof enabled !== "boolean") {
                throw new Error(`Functionality state for ${adapter.family} alias '${alias}' is malformed.`);
            }
            if (origin === "workspace") {
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

    async #effective(adapter: FunctionalityAdapter, identity: WorkspaceCapabilityIdentity, state: FamilyState): Promise<Map<string, EffectiveDefinition>> {
        const effective = new Map<string, EffectiveDefinition>();
        for (const service of await adapter.available(identity)) {
            if (!ALIAS.test(service.alias)) throw new Error(`${adapter.family} service alias '${service.alias}' must match ${ALIAS}.`);
            const record = state.definitions[service.alias];
            const enabled = record?.origin === "service" ? record.enabled : service.enabled;
            effective.set(service.alias, { alias: service.alias, origin: "service", definition: service.definition, enabled });
        }
        for (const [alias, record] of Object.entries(state.definitions)) {
            if (record.origin !== "workspace") continue;
            effective.set(alias, { alias, origin: "workspace", definition: record.definition!, enabled: record.enabled });
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

    async #discover(adapter: FunctionalityAdapter, query: Record<string, unknown>, identity: WorkspaceCapabilityIdentity): Promise<FunctionalityDiscoverResult> {
        const candidates = await adapter.discover(query, identity);
        return Validator.assertFunctionalityDiscoverResult({ family: adapter.family, candidates: [...candidates] });
    }

    async #mutate(
        adapter: FunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: WorkspaceCapabilityIdentity,
        caller: FunctionalityCaller,
    ): Promise<FunctionalityInvocation> {
        const key = this.#key(identity.workspaceId, adapter.family);
        const family = this.#families.get(key);
        if (family === undefined) throw failure(adapter.family, "workspace-not-resident", 409, `Workspace ${identity.workspaceId} has no resident ${adapter.family} Functionality.`, { recovery: "Retry through a workspace operation, then retry.", retryable: false });
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
                // A workspace definition may shadow a service definition of the same
                // alias; removing it reveals the service baseline again, disabled.
                const current = effective.get(alias);
                if (current?.origin === "workspace" && !isDeepStrictEqual(current.definition, admitted.definition)) {
                    throw failure(adapter.family, "alias-exists", 409, `'${alias}' already has a different workspace definition.`, { alias, recovery: "Use the existing definition, or remove it before adding its replacement.", retryable: false });
                }
                definitions[alias] = { origin: "workspace", definition: admitted.definition, enabled: true };
                status = current?.origin === "workspace" ? 200 : 201;
                break;
            }
            case "enable":
            case "disable": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to this workspace.`, { alias, retryable: false });
                definitions[alias] = current.origin === "workspace"
                    ? { origin: "workspace", definition: current.definition, enabled: verb === "enable" }
                    : { origin: "service", enabled: verb === "enable" };
                break;
            }
            case "remove": {
                alias = input.alias as string;
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to this workspace.`, { alias, retryable: false });
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
            retain: () => this.#host.retainWorkspace(identity.workspaceId),
            gate: "none",
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
        const effective = await this.#effective(adapter, identity, nextState);
        const enabled = new Map<string, object>();
        for (const definition of effective.values()) {
            if (definition.enabled) enabled.set(definition.alias, definition.definition);
        }
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
            for (const alias of enabled.keys()) {
                if (!prepared.outcomes.has(alias)) throw new Error(`${adapter.family} preparation reported no outcome for enabled alias '${alias}'.`);
            }
            for (const runtime of prepared.runtimes) {
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
            };
            runtimes = [manager, ...prepared.runtimes];
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
