// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure selector helpers live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { instantiateProvider as instantiateFrameworkProvider, parseReasoningPolicy, PROVIDERS_KNOBS, resolveActiveRoute, scopeEnvToAlias, UnsupportedReasoningPolicyError } from "@plurnk/plurnk-providers";
import type { Provider, ProviderSpec, ReasoningPolicy } from "@plurnk/plurnk-providers";

export default class ProviderInstantiate {
    // One provider per complete route+tuning projection for the process lifetime: a provider is
    // stateless per the contract, and runLoop instantiating fresh per aliased call re-probed
    // the backend (latency) and re-fired providers' construction warnings on every loop (the
    // owner's boot log: one heuristic warning per runLoop request). Cache identity includes every
    // provider-owned knob because operator tuning can change while a process remains alive.
    static #instances = new Map<string, Promise<Provider>>();
    static #registeredInstances = new Map<string, Provider>();
    // {§provider-instantiation-alias-resolution} — provider handle → the alias name that produced it,
    // so the service scopes its own
    // per-alias packet-policy knobs by the provider it's building a packet
    // for. Service-owned metadata about handles WE created; never a provider-contract field.
    // `null` is meaningful: this handle was constructed for an alias-free exact
    // route and therefore uses global tuning. An absent entry is a foreign or
    // hand-built handle for which the boot route remains the compatibility
    // source of configuration scope.
    static #configurationAliasByProvider = new WeakMap<Provider, string | null>();

    // The alias name a provider was built under, or undefined for an exact
    // route, a test Mock, or another hand-built handle.
    static aliasOf(provider: Provider): string | undefined {
        return ProviderInstantiate.#configurationAliasByProvider.get(provider) ?? undefined;
    }

    static configurationAliasOf(
        provider: Provider,
        env: NodeJS.ProcessEnv = process.env,
    ): string | undefined {
        const registered = ProviderInstantiate.#configurationAliasByProvider.get(provider);
        if (registered !== undefined) return registered ?? undefined;
        return resolveActiveRoute(env)?.alias;
    }

    static hasConfigurationScope(
        provider: Provider,
        env: NodeJS.ProcessEnv = process.env,
    ): boolean {
        return ProviderInstantiate.#configurationAliasByProvider.has(provider)
            || resolveActiveRoute(env) !== null;
    }

    static assertGrammarConfigurationScope(
        provider: Provider,
        env: NodeJS.ProcessEnv = process.env,
    ): void {
        if (ProviderInstantiate.hasConfigurationScope(provider, env)) return;
        const scoped = Object.keys(env).some((key) => key.startsWith("PLURNK_PROVIDERS_GBNF_")
            && key !== "PLURNK_PROVIDERS_GBNF_DEBUG");
        if (scoped) {
            throw new Error("GBNF constraint: provider has no registered route and no active model route resolves, while route-scoped PLURNK_PROVIDERS_GBNF_* constraints are configured");
        }
    }

    // {§grammar-configuration-admission} — identify a hand-built provider's
    // configuration scope so direct Engine specimens exercise the same grammar
    // resolution as daemon-constructed handles. null is an exact route using
    // global tuning; a string is an alias-scoped route.
    static registerConfigurationScope(provider: Provider, alias: string | null): void {
        ProviderInstantiate.#configurationAliasByProvider.set(provider, alias);
    }

    // Register a preconstructed handle under the same route+tuning identity as
    // constructed providers. An injected handle must not shadow a later operator
    // tuning projection merely because its wire route is unchanged.
    static registerInstance(
        provider: Provider,
        spec: ProviderSpec,
        env: NodeJS.ProcessEnv = process.env,
        reasoningPolicy?: ReasoningPolicy,
    ): void {
        ProviderInstantiate.#configurationAliasByProvider.set(provider, spec.alias ?? null);
        ProviderInstantiate.#registeredInstances.set(
            ProviderInstantiate.#cacheKey(spec, env, reasoningPolicy),
            provider,
        );
    }

    static async instantiateProvider(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv = process.env,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        if (env === process.env) {
            const registered = ProviderInstantiate.#registeredInstances.get(
                ProviderInstantiate.#cacheKey(route, env, reasoningPolicy),
            );
            if (registered !== undefined) {
                if (reasoningPolicy !== undefined
                    && !registered.supportedReasoningPolicies.includes(reasoningPolicy)) {
                    throw new UnsupportedReasoningPolicyError(
                        `provider:${route.provider}`,
                        reasoningPolicy,
                        registered.supportedReasoningPolicies,
                    );
                }
                return registered;
            }
            const key = ProviderInstantiate.#cacheKey(route, env, reasoningPolicy);
            let cached = ProviderInstantiate.#instances.get(key);
            if (cached === undefined) {
                cached = ProviderInstantiate.#instantiate(route, env, reasoningPolicy);
                ProviderInstantiate.#instances.set(key, cached);
                cached.catch(() => ProviderInstantiate.#instances.delete(key)); // a failed construct never poisons the cache
            }
            return cached;
        }
        return ProviderInstantiate.#instantiate(route, env, reasoningPolicy); // custom env (tests) — never cached
    }

    static #identityKey(route: ProviderSpec): string {
        return `${route.alias ?? ""}|${route.provider}|${route.model}|${route.baseUrl ?? ""}`;
    }

    static #cacheKey(route: ProviderSpec, env: NodeJS.ProcessEnv, reasoningPolicy?: ReasoningPolicy): string {
        const scoped = ProviderInstantiate.#scopedEnv(route, env, reasoningPolicy);
        const tuning = PROVIDERS_KNOBS.map((name) => [name, scoped[name] ?? ""]);
        return `${ProviderInstantiate.#identityKey(route)}|${JSON.stringify(tuning)}`;
    }

    static #scopedEnv(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): NodeJS.ProcessEnv {
        const scoped = route.alias === undefined ? env : scopeEnvToAlias(env, route.alias);
        return reasoningPolicy === undefined
            ? scoped
            : { ...scoped, PLURNK_PROVIDERS_REASONING: reasoningPolicy };
    }

    static configuredReasoningPolicy(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv = process.env,
    ): ReasoningPolicy {
        const value = ProviderInstantiate.#scopedEnv(route, env).PLURNK_PROVIDERS_REASONING;
        const selection = route.alias === undefined
            ? `Model route '${route.provider}/${route.model}'`
            : `Provider alias '${route.alias}'`;
        return parseReasoningPolicy(value, `${selection} reasoning policy`);
    }

    static async #instantiate(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        const provider = await ProviderInstantiate.#construct(route, env, reasoningPolicy);
        ProviderInstantiate.#configurationAliasByProvider.set(provider, route.alias ?? null);
        return provider;
    }

    static async #construct(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        // {§operator-config-precedence} — promote the alias-scoped provider-knob family
        // (PLURNK_PROVIDERS_*_<alias>) to
        // bare BEFORE construction, so per-alias tuning and generation-envelope pins bind. Without this
        // the whole per-alias provider surface was silently dropped at construction.
        env = ProviderInstantiate.#scopedEnv(route, env, reasoningPolicy);
        return ProviderInstantiate.#constructWith(route, env);
    }

    static async #constructWith(route: ProviderSpec, env: NodeJS.ProcessEnv): Promise<Provider> {
        return instantiateFrameworkProvider(
            route.provider,
            env,
            route.model,
            undefined,
            undefined,
            route.baseUrl,
            // #construct already materialized the alias-scoped environment.
            undefined,
        );
    }

    // Convenience: resolve + instantiate in one call. Returns null when no
    // PLURNK_MODEL is set (caller decides what 'no provider' means).
    static async loadActiveProvider(env: NodeJS.ProcessEnv = process.env): Promise<Provider | null> {
        const route = resolveActiveRoute(env); // PLURNK_MODEL resolves one alias or direct route — {§provider-instantiation-alias-resolution}
        if (route === null) return null;
        const provider = await ProviderInstantiate.instantiateProvider(route, env);
        ProviderInstantiate.validateGrammarConfiguration(provider, env);
        return provider;
    }

    // A configured GBNF is an explicit local constrained-sampling contract. Admit
    // only a provider configuration capable of carrying it. Actual enforcement is
    // proven by each user-authorized generation; startup never generates tokens.
    static validateGrammarConfiguration(
        provider: Provider,
        env: NodeJS.ProcessEnv = process.env,
        reasoningPolicy?: ReasoningPolicy,
    ): void {
        // {§grammar-configuration-admission}: resolve through the provider's registered alias,
        // with the active real alias; exact routes remain globally scoped
        // retained only for the boot-global fallback.
        ProviderInstantiate.assertGrammarConfigurationScope(provider, env);
        const alias = ProviderInstantiate.configurationAliasOf(provider, env);
        const scoped = alias === undefined ? env : scopeEnvToAlias(env, alias, [
            "PLURNK_PROVIDERS_GBNF",
            "PLURNK_PROVIDERS_REASONING",
        ]);
        const gbnf = scoped.PLURNK_PROVIDERS_GBNF;
        if (gbnf === undefined || gbnf === "" || gbnf === "0") return; // rails not requested — nothing to verify
        if ((reasoningPolicy ?? scoped.PLURNK_PROVIDERS_REASONING) === "off") {
            throw new Error(
                `PLURNK_PROVIDERS_GBNF=${gbnf} is invalid with reasoning policy off: the PLURNK GBNF requires adaptive or fixed reasoning ({§gbnf-requires-reasoning}).`,
            );
        }
        if (provider.constrainsOutput !== true) {
            throw new Error(
                `PLURNK_PROVIDERS_GBNF=${gbnf} configures local constrained sampling, but '${provider.model}' does not advertise GBNF transport. `
                + `Configure this knob only for a supported local llama-server; endpoint-managed constraints require no service-side GBNF setting. `
                + `If this is a llama-server, set PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1 when automatic detection is unavailable.`,
            );
        }
    }
}
