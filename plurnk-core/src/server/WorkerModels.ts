// The worker's model: which provider, model and effort a worker or loop runs on — the durable selection and its
// spawn override, their client get/set surface, the loop's immutable snapshot and the conflicts an injection may
// not introduce, and the catalog a client lists. Split out of Daemon, which keeps the delegating entry points.
import type { Db } from "../core/Db.ts";
import type { Provider, ProviderSpec } from "@plurnk/plurnk-providers";
import { projectModelRoute, routeForSpec, specForRoute } from "./model-route.ts";
import { Validator, type Effort, type ModelCatalogPage, type ModelCatalogQuery, type ModelRoute } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { parseAliasesFromEnv, resolveActiveRoute, resolveChildRoute, UnsupportedEffortError } from "@plurnk/plurnk-providers";
import ConfigurationError from "@plurnk/plurnk-meta/configuration-error";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopRoute } from "./loop-model.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import { daemonFailure, modelRouteLabel } from "./daemon-results.ts";
import ClientInput from "./client-input.ts";
import { listModelCatalog } from "./model-catalog.ts";
import type DrainSupervisor from "./DrainSupervisor.ts";

export type EffortSource = "default" | "explicit";
export type WorkerGenerationPolicyRow = {
    model_route_id: number | null;
    spawn_model_route_id: number | null;
    effort: Effort | null;
    // {§worker-effort-source} — `explicit` only through worker.effort.set.
    effort_source: EffortSource;
};
type LoopGenerationPolicy = {
    providerSpec: ProviderSpec;
    childProviderSpec: ProviderSpec | null;
    effort: Effort;
};
// What an injection asks of a loop, by the supervisor's own declaration.
type InjectionCompatibilityArgs = Parameters<ConstructorParameters<typeof DrainSupervisor>[0]["assertInjectionCompatibility"]>[0];

export default class WorkerModels {
    readonly #db: Db;
    // The boot provider, whose input capacity the active alias reports ({§agui-provider-routes}).
    readonly #provider: Provider | null;

    constructor({ db, provider }: {
        db: Db;
        provider: Provider | null;
    }) {
        this.#db = db;
        this.#provider = provider;
    }

    async persistGenerationPolicy(workerId: number, policy: WorkerGenerationPolicyRow): Promise<readonly Effort[]> {
        const params = { id: workerId, ...policy };
        // {§worker-effort-source} — the source is provenance, not generation policy: it takes no
        // part in the mid-loop change check, so the selectable probe sees only the policy columns.
        const { effort_source: _source, ...generation } = params;
        if (await this.#db.worker_generation_policy_selectable.get(generation) === undefined) {
            return this.#refuseGenerationChange(workerId, policy);
        }
        const supportedEfforts = await this.supportedEfforts(policy);
        if (await this.#db.worker_generation_policy_update.get(params) === undefined) {
            return this.#refuseGenerationChange(workerId, policy);
        }
        return supportedEfforts;
    }

    async supportedEfforts(policy: WorkerGenerationPolicyRow): Promise<readonly Effort[]> {
        let supportedEfforts: readonly Effort[] | undefined;
        for (const routeId of [policy.model_route_id, policy.spawn_model_route_id]) {
            if (routeId === null) continue;
            const spec = await specForRoute(this.#db, routeId);
            if (spec === null) throw new Error(`model route ${routeId} is missing`);
            const provider = await this.providerForPolicy(spec, policy.effort ?? undefined);
            supportedEfforts = supportedEfforts === undefined
                ? provider.supportedEfforts
                : supportedEfforts.filter((candidate) => provider.supportedEfforts.includes(candidate));
        }
        return supportedEfforts ?? [];
    }

    async #refuseGenerationChange(workerId: number, requested: WorkerGenerationPolicyRow): Promise<never> {
        const selected = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (selected === undefined) throw new Error(`worker ${workerId}: generation policy row missing`);
        const selectedModel = await specForRoute(this.#db, selected.model_route_id);
        const requestedModel = await specForRoute(this.#db, requested.model_route_id);
        throw daemonFailure(
            "daemon:worker", "worker-loop-active", 409,
            `Worker ${workerId} has unfinished tasks; its model and reasoning settings cannot change yet.`,
            {
                workerId,
                ...(selectedModel?.alias === undefined ? {} : { selectedAlias: selectedModel.alias }),
                ...(requestedModel?.alias === undefined ? {} : { requestedAlias: requestedModel.alias }),
                stage: "model-selection",
                recovery: "Conclude or cancel its unfinished tasks before changing these settings.",
                retryable: false,
            },
        );
    }

    // {§worker-model-selection} — a model worker owns one durable model. An explicit
    // selector persists onto the worker; an omitted selector resolves the worker's
    // durable model, seeded once from the daemon default. A deliberately modelless
    // daemon leaves the worker unset until an explicit selection arrives.
    async resolveWorkerModel(
        workerId: number,
        selector: string | undefined,
        chosen?: Effort,
    ): Promise<{ providerSpec: ProviderSpec; effort: Effort; effortSource: EffortSource } | null> {
        const worker = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        if (selector !== undefined) {
            const spec = this.#resolveLoopProvider(selector);
            if (spec === null) return null;
            // {§worker-effort-source} — a chosen effort follows the worker across models; a seeded one
            // re-derives from the new alias, so a default never outlives its alias. An effort chosen with the
            // model replaces the carried one, and the pair is validated as one.
            const explicit = chosen !== undefined || worker.effort_source === "explicit" && worker.effort !== null;
            const effort = chosen ?? (explicit
                ? worker.effort!
                : ProviderInstantiate.configuredEffort(spec));
            const effortSource: EffortSource = explicit ? "explicit" : "default";
            await this.persistGenerationPolicy(workerId, {
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
                effort,
                effort_source: effortSource });
            return { providerSpec: spec, effort, effortSource };
        }
        if (worker.model_route_id !== null) {
            if (worker.effort === null) {
                throw new Error(`worker ${workerId}: durable model has no effort`);
            }
            const spec = await specForRoute(this.#db, worker.model_route_id);
            if (spec === null) throw new Error(`worker ${workerId}: model route is missing`);
            await this.providerForPolicy(spec, worker.effort);
            return { providerSpec: spec, effort: worker.effort, effortSource: worker.effort_source };
        }
        const spec = this.#configured(() => resolveActiveRoute());
        if (spec !== null) {
            const effort = ProviderInstantiate.configuredEffort(spec);
            await this.persistGenerationPolicy(workerId, {
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
                effort,
                effort_source: "default" });
            return { providerSpec: spec, effort, effortSource: "default" };
        }
        return null;
    }


    // {§worker-model-selection} — the persistent spawn override. An explicit child
    // selector persists onto the worker (null clears it back to inherit); an omitted
    // selector resolves the persisted override, seeded once from the operator's
    // PLURNK_MODEL_CHILD default.
    async resolveWorkerSpawnModel(workerId: number, childSelector: string | null | undefined): Promise<ProviderSpec | null> {
        const worker = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        if (childSelector !== undefined) {
            const spec = childSelector === null
                ? null
                : this.#resolveLoopProvider(childSelector);
            await this.persistGenerationPolicy(workerId, {
                model_route_id: worker.model_route_id,
                spawn_model_route_id: spec === null ? null : await routeForSpec(this.#db, spec),
                effort: worker.effort,
                effort_source: worker.effort_source });
            return spec;
        }
        if (worker.spawn_model_route_id !== null) {
            const spec = await specForRoute(this.#db, worker.spawn_model_route_id);
            if (spec === null) throw new Error(`worker ${workerId}: spawn model route is missing`);
            if (worker.effort !== null) {
                await this.providerForPolicy(spec, worker.effort);
            }
            return spec;
        }
        const spec = this.#configured(() => resolveChildRoute());
        if (spec !== null) {
            await this.persistGenerationPolicy(workerId, {
                model_route_id: worker.model_route_id,
                spawn_model_route_id: await routeForSpec(this.#db, spec),
                effort: worker.effort,
                effort_source: worker.effort_source });
        }
        return spec;
    }


    // Resolve eagerly so runLoop fails before enqueue when the selected route
    // and durable effort cannot compose. The drain later retrieves
    // this cached handle from the loop's immutable snapshot.
    async providerForPolicy(
        spec: ProviderSpec,
        effort?: Effort,
    ): Promise<Provider> {
        try {
            const provider = await ProviderInstantiate.instantiateProvider(
                spec,
                process.env,
                effort,
            );
            ProviderInstantiate.validateGrammarConfiguration(provider, process.env);
            return provider;
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            if (cause instanceof ConfigurationError) throw new OperationFailureError(Results.configurationFailure(cause), { cause });
            if (cause instanceof UnsupportedEffortError) {
                throw daemonFailure(
                    "daemon:provider",
                    "effort-unsupported",
                    409,
                    `${modelRouteLabel(spec)} does not support effort '${cause.policy}'.`,
                    {
                        ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                        provider: spec.provider,
                        model: spec.model,
                        effort: cause.policy,
                        supportedEfforts: cause.supported,
                        stage: "provider-selection",
                        recovery: "Select one of the provider's supported efforts.",
                        retryable: false },
                );
            }
            console.error(`${modelRouteLabel(spec)} could not be instantiated:`, cause);
            throw daemonFailure(
                "daemon:provider",
                "provider-unavailable",
                503,
                `${modelRouteLabel(spec)} is unavailable.`,
                {
                    ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                    provider: spec.provider,
                    model: spec.model,
                    stage: "provider-selection",
                    retryable: false },
            );
        }
    }


    // {§methods-loop-run-model}: resolve identity without provider setup.
    #resolveLoopProvider(selector: string): ProviderSpec | null {
        return this.#configured(() => resolveLoopRoute(selector, selector.includes("/") ? [] : parseAliasesFromEnv()));
    }

    #configured<T>(read: () => T): T {
        try { return read(); }
        catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }

    // {§machine-processes} — provider inference is an exclusive capability of a
    // model worker. The same assertion is used by early client admissions, the final
    // drain callback, and the model, reasoning, and spawn-model controls
    // ({§worker-model-selection}), so recovery and internal callers cannot bypass it.
    async assertModelWorker(workspaceId: number, workerId: number): Promise<void> {
        const worker = await this.#db.envelope_get_worker_by_id.get<{
            workspace_id: number;
            origin: string;
        }>({ id: workerId });
        if (worker === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (worker.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: worker.workspace_id,
                    retryable: false },
            );
        }
        if (worker.origin !== "model") {
            throw daemonFailure(
                "daemon:worker",
                "model-worker-required",
                409,
                `Worker ${workerId} is not a model worker.`,
                {
                    workerId,
                    actualOrigin: worker.origin,
                    recovery: "Select or create a model worker.",
                    retryable: false },
            );
        }
    }

    // {§worker-model-selection} — the loop's durable snapshot is the immutable route ids,
    // resolved through model_routes at the claim boundary; never re-resolved through the
    // alias cascade (a changed alias declaration must not rewrite history).
    async loopPolicy(loopId: number): Promise<LoopGenerationPolicy> {
        const row = await this.#db.drain_loop_generation_policy.get<WorkerGenerationPolicyRow>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId}: provider selection row is missing`);
        const providerSpec = await specForRoute(this.#db, row.model_route_id);
        if (providerSpec === null) {
            throw new Error(`loop ${loopId}: persisted provider selection is missing — refusing boot-default substitution`);
        }
        if (row.effort === null) {
            throw new Error(`loop ${loopId}: persisted effort is missing`);
        }
        return {
            providerSpec,
            childProviderSpec: await specForRoute(this.#db, row.spawn_model_route_id),
            effort: row.effort };
    }

    async #specForLoop(loopId: number): Promise<ProviderSpec> {
        return (await this.loopPolicy(loopId)).providerSpec;
    }

    // The providers a claimed loop runs on, instantiated from its snapshot: the loop's own, and its spawn
    // model's or the same one.
    async providersForLoop(loopId: number): Promise<{ provider: Provider; childProvider: Provider }> {
        const policy = await this.loopPolicy(loopId);
        const provider = await this.providerForPolicy(policy.providerSpec, policy.effort);
        const childProvider = policy.childProviderSpec === null
            ? provider
            : await this.providerForPolicy(policy.childProviderSpec, policy.effort);
        return { provider, childProvider };
    }

    async #assertLoopProvider(loopId: number, requested: ProviderSpec): Promise<void> {
        const selected = await this.#specForLoop(loopId);
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-provider-conflict",
                409,
                `Loop ${loopId} uses ${modelRouteLabel(selected)}, not ${modelRouteLabel(requested)}.`,
                {
                    loopId,
                    ...(selected.alias === undefined ? {} : { selectedAlias: selected.alias }),
                    selectedModel: `${selected.provider}/${selected.model}`,
                    ...(requested.alias === undefined ? {} : { requestedAlias: requested.alias }),
                    requestedModel: `${requested.provider}/${requested.model}`,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another provider.",
                    retryable: false },
            );
        }
    }

    async #assertLoopEffort(loopId: number, requested: Effort): Promise<void> {
        const selected = (await this.loopPolicy(loopId)).effort;
        if (selected !== requested) {
            throw daemonFailure(
                "daemon:provider",
                "loop-effort-conflict",
                409,
                `Loop ${loopId} uses effort '${selected}', not '${requested}'.`,
                {
                    loopId,
                    selectedEffort: selected,
                    requestedEffort: requested,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another effort.",
                    retryable: false },
            );
        }
    }

    async #assertLoopChildProvider(loopId: number, requested: ProviderSpec | null): Promise<void> {
        const selected = (await this.loopPolicy(loopId)).childProviderSpec;
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-child-provider-conflict",
                409,
                `Loop ${loopId} already has a different child provider policy.`,
                {
                    loopId,
                    selectedChildAlias: selected?.alias ?? null,
                    selectedChildModel: selected === null ? null : `${selected.provider}/${selected.model}`,
                    requestedChildAlias: requested?.alias ?? null,
                    requestedChildModel: requested === null ? null : `${requested.provider}/${requested.model}`,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before changing its child provider policy.",
                    retryable: false },
            );
        }
    }

    async #assertLoopMaxTurns(loopId: number, requested: number | undefined): Promise<void> {
        if (requested === undefined) return;
        const durable = await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId });
        if (durable === undefined) throw new Error(`inject: loop ${loopId} has no durable turn ceiling`);
        if (durable.max_turns !== requested) {
            throw daemonFailure(
                "daemon:loop",
                "turn-ceiling-conflict",
                409,
                `Loop ${loopId} has turn ceiling ${durable.max_turns}, not ${requested}.`,
                {
                    loopId,
                    selectedMaximumTurns: durable.max_turns,
                    requestedMaximumTurns: requested,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another turn ceiling.",
                    retryable: false },
            );
        }
    }

    // {§worker-model-selection} An omitted selector keeps the loop's durable provider; only an explicit selection is
    // checked against it (a deliberate switch). Effort, the spawn model and an explicit turn ceiling are checked alike.
    async assertInjectionCompatibility({ loopId, providerSpec, providerSpecExplicit, effort, childProviderSpec, turnCeiling }: InjectionCompatibilityArgs): Promise<void> {
        // An omitted selector keeps the loop's durable provider; only an
        // explicit selection is checked against it (a deliberate switch).
        if (providerSpecExplicit !== false) {
            await this.#assertLoopProvider(loopId, providerSpec);
        }
        await this.#assertLoopEffort(loopId, effort);
        if (childProviderSpec !== undefined) {
            await this.#assertLoopChildProvider(loopId, childProviderSpec);
        }
        await this.#assertLoopMaxTurns(
            loopId,
            turnCeiling?.source === "explicit" ? turnCeiling.effective : undefined,
        );
    }

    // {§worker-model-selection} — project a worker's durable model and spawn override
    // for a client-interface get/set surface. Ownership is checked at this boundary.
    async readWorkerModel(args: { workspaceId: number; workerId: number }): Promise<{ model: ModelRoute | null; spawnModel: ModelRoute | null }> {
        const workspaceId = ClientInput.assertId("worker.model.get", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.model.get", "workerId", args.workerId);
        await this.assertModelWorker(workspaceId, workerId);
        const row = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (row === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        const modelSpec = await specForRoute(this.#db, row.model_route_id);
        const spawnModelSpec = await specForRoute(this.#db, row.spawn_model_route_id);
        return {
            model: modelSpec === null ? null : projectModelRoute(modelSpec, row.effort, row.effort_source),
            spawnModel: spawnModelSpec === null ? null : projectModelRoute(spawnModelSpec, row.effort, row.effort_source) };
    }

    // {§worker-model-selection} — persist an explicit model selection onto the worker
    // and return the resolved spec. An unresolvable selector fails loud here.
    async setWorkerModel(args: { workspaceId: number; workerId: number; selector: string; effort?: unknown }): Promise<ModelRoute> {
        const workspaceId = ClientInput.assertId("worker.model.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.model.set", "workerId", args.workerId);
        await this.assertModelWorker(workspaceId, workerId);
        const selector = ClientInput.assertSelector("worker.model.set", "selector", args.selector);
        let chosen: Effort | undefined;
        if (args.effort !== undefined) {
            try {
                chosen = Validator.assertEffort(args.effort);
            } catch (cause) {
                throw daemonFailure("daemon:input", "effort-invalid", 400,
                    cause instanceof Error ? cause.message : "The effort is invalid.", { field: "effort", retryable: false });
            }
        }
        const policy = await this.resolveWorkerModel(workerId, selector, chosen);
        if (policy === null) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "not-configured",
                501,
                "No provider is configured for this worker.",
                {},
                { stage: "provider-selection", recovery: "Select a configured model provider.", retryable: false },
            ));
        }
        return projectModelRoute(policy.providerSpec, policy.effort, policy.effortSource);
    }

    // {§worker-effort} — the worker's effort is durable and
    // provider-relative. A model-less worker remains explicitly uninitialized.
    async readWorkerEffort(args: {
        workspaceId: number;
        workerId: number;
    }): Promise<{ effort: Effort | null; source: EffortSource; supportedEfforts: readonly Effort[] }> {
        const workspaceId = ClientInput.assertId("worker.effort.get", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.effort.get", "workerId", args.workerId);
        await this.assertModelWorker(workspaceId, workerId);
        await this.resolveWorkerModel(workerId, undefined);
        const row = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (row === undefined) throw new Error(`worker ${workerId}: generation policy row missing`);
        if (row.model_route_id === null) {
            if (row.effort !== null) {
                throw new Error(`worker ${workerId}: effort exists without a model route`);
            }
            return { effort: null, source: "default", supportedEfforts: [] };
        }
        if (row.effort === null) {
            throw new Error(`worker ${workerId}: durable model has no effort`);
        }
        return {
            effort: row.effort,
            source: row.effort_source,
            supportedEfforts: await this.supportedEfforts(row) };
    }

    // {§worker-effort} — mutate between loops, validate against both
    // the worker model and its optional spawn model, then persist atomically.
    async setWorkerEffort(args: {
        workspaceId: number;
        workerId: number;
        effort: unknown;
    }): Promise<{ effort: Effort; source: "explicit"; supportedEfforts: readonly Effort[] }> {
        const workspaceId = ClientInput.assertId("worker.effort.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.effort.set", "workerId", args.workerId);
        let effort: Effort;
        try {
            effort = Validator.assertEffort(args.effort);
        } catch (cause) {
            throw daemonFailure(
                "daemon:input",
                "effort-invalid",
                400,
                cause instanceof Error ? cause.message : "The effort is invalid.",
                { field: "effort", retryable: false },
            );
        }
        await this.assertModelWorker(workspaceId, workerId);
        // A model-less worker takes the default first; an existing pair is replaced, not re-validated, so an
        // effort its model no longer supports can be corrected ({§worker-effort}).
        const current = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (current?.model_route_id === null) await this.resolveWorkerModel(workerId, undefined);
        const row = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (row === undefined) throw new Error(`worker ${workerId}: generation policy row missing`);
        const spec = await specForRoute(this.#db, row.model_route_id);
        if (spec === null) {
            throw daemonFailure(
                "daemon:provider",
                "worker-model-unset",
                409,
                `Worker ${workerId} has no model against which to validate an effort.`,
                {
                    workerId,
                    stage: "provider-selection",
                    recovery: "Select a model before selecting its effort.",
                    retryable: false },
            );
        }
        const supportedEfforts = await this.persistGenerationPolicy(workerId, {
            model_route_id: row.model_route_id,
            spawn_model_route_id: row.spawn_model_route_id,
            effort,
            effort_source: "explicit" });
        return { effort, source: "explicit", supportedEfforts };
    }

    // {§worker-model-selection} — persist the worker's spawn override; a null
    // selector means inherit (clears the override).
    async setWorkerSpawnModel(args: { workspaceId: number; workerId: number; selector: string | null }): Promise<ModelRoute | null> {
        const workspaceId = ClientInput.assertId("worker.child.set", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.child.set", "workerId", args.workerId);
        await this.assertModelWorker(workspaceId, workerId);
        const selector = ClientInput.assertChildSelector("worker.child.set", args.selector);
        const spec = await this.resolveWorkerSpawnModel(workerId, selector);
        if (spec === null) return null;
        const row = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        return projectModelRoute(spec, row?.effort ?? null, row?.effort_source ?? "default");
    }

    listProviders(): ReturnType<ApplicationPort["listProviders"]> {
        const active = process.env.PLURNK_MODEL?.toLowerCase();
        let aliases;
        try { aliases = parseAliasesFromEnv(); }
        catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
        return {
            aliases: aliases.map((a) => {
                const isActive = active === a.alias;
                // {§agui-provider-routes} — the route a worker seeded from this alias gets: what it would read back.
                let effort;
                try { effort = ProviderInstantiate.configuredEffort(a); }
                catch (cause) {
                    const invalid = new ConfigurationError("PLURNK_PROVIDERS_EFFORT", cause instanceof Error ? cause.message : String(cause), { cause });
                    throw new OperationFailureError(Results.configurationFailure(invalid), { cause });
                }
                return {
                    ...projectModelRoute(a, effort, "default"), alias: a.alias, active: isActive,
                    inputCapacity: isActive && this.#provider !== null ? this.#provider.inputCapacity : null };
            }) };
    }

    // {§model-catalog} The catalog is a bounded, daemon-local projection.
    // It performs no provider I/O and never changes the worker's selection.
    listModels(query: ModelCatalogQuery): ModelCatalogPage {
        return listModelCatalog(query);
    }
}
