// Which provider and model a worker or loop runs on: the alias, policy, and spawn resolution, split out of Daemon.
import type { Db } from "../core/Db.ts";
import type { Provider, ProviderSpec } from "@plurnk/plurnk-providers";
import { routeForSpec, specForRoute } from "./model-route.ts";
import { type ReasoningPolicy } from "@plurnk/plurnk-contracts";
import { parseAliasesFromEnv, resolveActiveRoute, UnsupportedReasoningPolicyError } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopRoute } from "./loop-model.ts";
import { OperationFailureError } from "../core/results.ts";
import { daemonFailure, modelRouteLabel } from "./daemon-results.ts";
import type { WorkerGenerationPolicyRow } from "./Daemon.ts";

export default class WorkerModelResolver {
    readonly #db: Db;
    readonly #provider: Provider | null;

    constructor({ db, provider }: {
        db: Db;
        provider: Provider | null;
    }) {
        this.#db = db;
        this.#provider = provider;
    }

    // {§worker-model-selection} — a model worker owns one durable model. An explicit
    // selector persists onto the worker; an omitted selector resolves the worker's
    // durable model, seeded once from the daemon default. A deliberately modelless
    // daemon leaves the worker unset until an explicit selection arrives.
    async resolveWorkerModel(
        workerId: number,
        selector: string | undefined,
    ): Promise<{ providerSpec: ProviderSpec; reasoningPolicy: ReasoningPolicy } | null> {
        const worker = await this.#db.worker_generation_policy_read.get<WorkerGenerationPolicyRow>({ id: workerId });
        if (worker === undefined) throw new Error(`worker ${workerId}: model route row missing`);
        if (selector !== undefined) {
            const spec = await this.#resolveLoopProvider(
                selector,
                worker.reasoning_policy ?? undefined,
            );
            if (spec === null) return null;
            const reasoningPolicy = worker.reasoning_policy
                ?? ProviderInstantiate.configuredReasoningPolicy(spec);
            if (worker.spawn_model_route_id !== null) {
                const spawnSpec = await specForRoute(this.#db, worker.spawn_model_route_id);
                if (spawnSpec === null) throw new Error(`worker ${workerId}: spawn model route is missing`);
                await this.providerForPolicy(spawnSpec, reasoningPolicy);
            }
            await this.#db.worker_generation_policy_update.run({
                id: workerId,
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
                reasoning_policy: reasoningPolicy });
            return { providerSpec: spec, reasoningPolicy };
        }
        if (worker.model_route_id !== null) {
            if (worker.reasoning_policy === null) {
                throw new Error(`worker ${workerId}: durable model has no reasoning policy`);
            }
            const spec = await specForRoute(this.#db, worker.model_route_id);
            if (spec === null) throw new Error(`worker ${workerId}: model route is missing`);
            await this.providerForPolicy(spec, worker.reasoning_policy);
            return { providerSpec: spec, reasoningPolicy: worker.reasoning_policy };
        }
        if (this.#provider === null) return null;
        const spec = resolveActiveRoute();
        if (spec !== null) {
            const reasoningPolicy = ProviderInstantiate.configuredReasoningPolicy(spec);
            await this.providerForPolicy(spec, reasoningPolicy);
            if (worker.spawn_model_route_id !== null) {
                const spawnSpec = await specForRoute(this.#db, worker.spawn_model_route_id);
                if (spawnSpec === null) throw new Error(`worker ${workerId}: spawn model route is missing`);
                await this.providerForPolicy(spawnSpec, reasoningPolicy);
            }
            await this.#db.worker_generation_policy_update.run({
                id: workerId,
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: worker.spawn_model_route_id,
                reasoning_policy: reasoningPolicy });
            return { providerSpec: spec, reasoningPolicy };
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
                : await this.#resolveLoopProvider(
                    childSelector,
                    worker.reasoning_policy ?? undefined,
                );
            await this.#db.worker_generation_policy_update.run({
                id: workerId,
                model_route_id: worker.model_route_id,
                spawn_model_route_id: spec === null ? null : await routeForSpec(this.#db, spec),
                reasoning_policy: worker.reasoning_policy });
            return spec;
        }
        if (worker.spawn_model_route_id !== null) {
            const spec = await specForRoute(this.#db, worker.spawn_model_route_id);
            if (spec === null) throw new Error(`worker ${workerId}: spawn model route is missing`);
            if (worker.reasoning_policy !== null) {
                await this.providerForPolicy(spec, worker.reasoning_policy);
            }
            return spec;
        }
        const configured = process.env.PLURNK_MODEL_CHILD;
        if (configured === undefined || configured.length === 0) return null;
        const spec = await this.#resolveLoopProvider(
            configured,
            worker.reasoning_policy ?? undefined,
        );
        if (spec !== null) {
            await this.#db.worker_generation_policy_update.run({
                id: workerId,
                model_route_id: worker.model_route_id,
                spawn_model_route_id: await routeForSpec(this.#db, spec),
                reasoning_policy: worker.reasoning_policy });
        }
        return spec;
    }


    // Resolve eagerly so runLoop fails before enqueue when the selected route
    // and durable reasoning policy cannot compose. The drain later retrieves
    // this cached handle from the loop's immutable snapshot.
    async providerForPolicy(
        spec: ProviderSpec,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        try {
            const provider = await ProviderInstantiate.instantiateProvider(
                spec,
                process.env,
                reasoningPolicy,
            );
            ProviderInstantiate.validateGrammarConfiguration(
                provider,
                process.env,
                reasoningPolicy,
            );
            return provider;
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            if (cause instanceof UnsupportedReasoningPolicyError) {
                throw daemonFailure(
                    "daemon:provider",
                    "reasoning-policy-unsupported",
                    409,
                    `${modelRouteLabel(spec)} does not support reasoning policy '${cause.policy}'.`,
                    {
                        ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                        provider: spec.provider,
                        model: spec.model,
                        reasoningPolicy: cause.policy,
                        supportedReasoningPolicies: cause.supported,
                        stage: "provider-selection",
                        recovery: "Select one of the provider's supported reasoning policies.",
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


    // {§methods-loop-run-model} — resolve one alias-or-route selector to a cached
    // Provider; absent uses the boot default. An unknown alias or malformed exact
    // route throws legibly rather than silently running the wrong model.
    async #resolveLoopProvider(
        selector: string | undefined,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<ProviderSpec | null> {
        const requested = resolveLoopRoute(selector, parseAliasesFromEnv());
        if (requested === null && this.#provider === null) return null;
        const spec = requested ?? resolveActiveRoute();
        if (spec === null) {
            throw daemonFailure(
                "daemon:provider",
                "active-model-unresolved",
                500,
                "The active provider has no resolvable model route.",
                { stage: "provider-selection", retryable: false },
            );
        }
        await this.providerForPolicy(spec, reasoningPolicy);
        return spec;
    }

}
