// Which provider and model a worker or loop runs on: the alias, policy, and spawn resolution, split out of Daemon.
import type { Db } from "../core/Db.ts";
import type { Provider, ProviderSpec } from "@plurnk/plurnk-providers";
import { routeForSpec, specForRoute } from "./model-route.ts";
import { type Effort } from "@plurnk/plurnk-contracts";
import { parseAliasesFromEnv, resolveActiveRoute, resolveChildRoute, UnsupportedEffortError } from "@plurnk/plurnk-providers";
import ConfigurationError from "@plurnk/plurnk-meta/configuration-error";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopRoute } from "./loop-model.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import { daemonFailure, modelRouteLabel } from "./daemon-results.ts";
import type { EffortSource, WorkerGenerationPolicyRow } from "./Daemon.ts";

export default class WorkerModelResolver {
    readonly #db: Db;

    constructor({ db }: {
        db: Db;
    }) {
        this.#db = db;
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

}
