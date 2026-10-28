import { isDeepStrictEqual } from "node:util";
import {
    Validator,
    isRecord,
    type FunctionalityAdmission,
    type FunctionalityCaller,
    type FunctionalityDefinitionState,
    type FunctionalityIdentity,
    type FunctionalityOutcome,
    type FunctionalityPrepared,
    type FunctionalityPreparedDefinition,
    type FunctionalityProvenance,
} from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { HostFunctionalityAdapter } from "./ModuleHost.ts";
import type { FunctionalityVerb } from "./FunctionalityManager.ts";
import type { FunctionalityInvocation } from "./Functionality.ts";
import Results, { OperationFailureError } from "../core/results.ts";

// Who OWNS a definition, not where it is scoped. A family declares the scope its definitions
// belong to ({§functionality-coordinator}); the locally-owned origin follows from it, so a session-scoped
// family's own entries say "session" rather than claiming the workspace set them.
export type Origin = "service" | "workspace" | "session";

export interface DefinitionRecord {
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
export interface FamilyState {
    readonly version: 1;
    readonly definitions: Readonly<Record<string, DefinitionRecord>>;
}

export interface EffectiveDefinition {
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
export interface Transition {
    readonly definitions: Record<string, DefinitionRecord>;
    readonly aliases: readonly string[];
    readonly status: 200 | 201;
    readonly removed: boolean;
    readonly admissions: readonly FunctionalityAdmission[];
}

export const STATE_VERSION = 1;
const ALIAS = /^[a-z][a-z0-9-]*$/u;
// A family may declare its own alias grammar ({§functionality-adapter}); the coordinator enforces it
// wherever an alias enters: admission, the service projection, and persisted state.
export const aliasPattern = (adapter: HostFunctionalityAdapter): RegExp => adapter.aliasPattern ?? ALIAS;
export const scopesOf = (adapter: HostFunctionalityAdapter): readonly ("workspace" | "session")[] => adapter.scopes ?? ["workspace"];
export const EMPTY_STATE: FamilyState = Object.freeze({ version: STATE_VERSION, definitions: Object.freeze({}) });

export const failure = (
    family: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("functionality", code, status, detail, {}, { family, ...extensions }),
);

export default class FunctionalityState {
    // The origin a definition carries when this family owns it locally. Service definitions
    // always come from the adapter's own `available()`; everything else is the family's own.
    static localOrigin(identity: FunctionalityIdentity): "session" | "workspace" {
        return identity.scope ?? "workspace";
    }

    static parseState(adapter: HostFunctionalityAdapter, raw: unknown, where: string, scope: "workspace" | "session"): FamilyState {
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

    static persisted(state: FamilyState): FamilyState | null {
        return Object.keys(state.definitions).length === 0 ? null : state;
    }

    static async effective(
        adapter: HostFunctionalityAdapter,
        identity: FunctionalityIdentity,
        state: FamilyState,
        loadWorkspaceState: (workspaceId: number) => Promise<FamilyState>,
    ): Promise<Map<string, EffectiveDefinition>> {
        const effective = new Map<string, EffectiveDefinition>();
        const local = FunctionalityState.localOrigin(identity);
        const inheritsWorkspace = identity.scope === "session" && scopesOf(adapter).includes("workspace");
        const lower = inheritsWorkspace
            ? [...(await FunctionalityState.effective(
                adapter,
                { workspaceId: identity.workspaceId, scope: "workspace" },
                await loadWorkspaceState(identity.workspaceId),
                loadWorkspaceState,
            )).values()]
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

    static projection(definition: EffectiveDefinition, outcome: FunctionalityOutcome | { readonly state: "dormant" } | undefined): FunctionalityDefinitionState {
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

    // The alias a select verb names: the input's `alias`, or what an addressing family reads from its
    // own select input ({§functionality-replacement}).
    static selected(adapter: HostFunctionalityAdapter, input: Record<string, unknown>): string {
        if (adapter.addressing !== undefined) return adapter.addressing.alias(input);
        if (typeof input.alias !== "string") throw new TypeError(`A ${adapter.family} select names its alias.`);
        return input.alias;
    }

    // The verb semantics, one implementation for every family ({§functionality-coordinator}): the next
    // state, the aliases it concerns, and how the mutation reports. Only publication differs by scope.
    static async transition(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        input: Record<string, unknown>,
        identity: FunctionalityIdentity,
        caller: FunctionalityCaller,
        state: FamilyState,
        effective: ReadonlyMap<string, EffectiveDefinition>,
    ): Promise<Transition> {
        const local = FunctionalityState.localOrigin(identity);
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
                const alias = FunctionalityState.selected(adapter, input);
                const current = effective.get(alias);
                if (current === undefined) throw failure(adapter.family, "alias-unknown", 404, `'${alias}' is not available to ${here}.`, { alias, retryable: false });
                definitions[alias] = current.origin === local
                    ? { origin: local, definition: current.definition, enabled: verb === "enable" }
                    : { origin: current.origin, enabled: verb === "enable" };
                aliases.push(alias);
                break;
            }
            case "remove": {
                const alias = FunctionalityState.selected(adapter, input);
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
    static mutationResult(
        adapter: HostFunctionalityAdapter,
        verb: FunctionalityVerb,
        { aliases, status, removed }: Transition,
        effectiveAfter: ReadonlyMap<string, EffectiveDefinition>,
        outcomes: ReadonlyMap<string, FunctionalityOutcome>,
    ): FunctionalityInvocation {
        const projections = aliases.map((alias) => {
            const definition = effectiveAfter.get(alias);
            return definition === undefined ? undefined : FunctionalityState.projection(definition, outcomes.get(alias));
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

    static sameDefinitions(left: ReadonlyMap<string, FunctionalityPreparedDefinition>, right: ReadonlyMap<string, FunctionalityPreparedDefinition>): boolean {
        if (left.size !== right.size) return false;
        for (const [alias, definition] of left) {
            if (!right.has(alias) || !isDeepStrictEqual(definition, right.get(alias))) return false;
        }
        return true;
    }

    static binding({ definition, context }: EffectiveDefinition): FunctionalityPreparedDefinition {
        return { definition, ...(context === undefined ? {} : { context }) };
    }

    static enabled(effective: ReadonlyMap<string, EffectiveDefinition>): Map<string, FunctionalityPreparedDefinition> {
        const enabled = new Map<string, FunctionalityPreparedDefinition>();
        for (const definition of effective.values()) {
            if (definition.enabled) enabled.set(definition.alias, structuredClone(FunctionalityState.binding(definition)));
        }
        return enabled;
    }

    static checkOutcomes(adapter: HostFunctionalityAdapter, enabled: ReadonlyMap<string, object>, prepared: FunctionalityPrepared<RuntimeRegistration>): void {
        for (const alias of enabled.keys()) {
            if (!prepared.outcomes.has(alias)) throw new Error(`${adapter.family} preparation reported no outcome for enabled alias '${alias}'.`);
        }
    }
}
