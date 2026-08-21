// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { instantiateProvider as instantiateFrameworkProvider, parseReasoningPolicy, PROVIDERS_KNOBS, resolveActiveAlias, scopeEnvToAlias, UnsupportedReasoningPolicyError } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias, ReasoningPolicy } from "@plurnk/plurnk-providers";

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
    static #aliasByProvider = new WeakMap<Provider, string>();

    // The alias name a provider was built under, or undefined (a test Mock, a hand-built handle).
    // PacketBuilder falls back to resolveActiveAlias for the boot-global case.
    static aliasOf(provider: Provider): string | undefined {
        return ProviderInstantiate.#aliasByProvider.get(provider);
    }

    // {§grammar-configuration-admission} — register a hand-built provider (a recording Mock)
    // under an alias, so tests can
    // drive the per-alias grammar-rail resolution through the REAL chain instead of the
    // boot-global fallback the silent-severance guard now refuses.
    static registerAlias(provider: Provider, alias: string): void {
        ProviderInstantiate.#aliasByProvider.set(provider, alias);
    }

    // Register a preconstructed handle under the same route+tuning identity as
    // constructed providers. An injected handle must not shadow a later operator
    // tuning projection merely because its wire route is unchanged.
    static registerInstance(
        provider: Provider,
        spec: ProviderAlias,
        env: NodeJS.ProcessEnv = process.env,
        reasoningPolicy?: ReasoningPolicy,
    ): void {
        ProviderInstantiate.#aliasByProvider.set(provider, spec.alias);
        ProviderInstantiate.#registeredInstances.set(
            ProviderInstantiate.#cacheKey(spec, env, reasoningPolicy),
            provider,
        );
    }

    static async instantiateProvider(
        alias: ProviderAlias,
        env: NodeJS.ProcessEnv = process.env,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        if (env === process.env) {
            const registered = ProviderInstantiate.#registeredInstances.get(
                ProviderInstantiate.#cacheKey(alias, env, reasoningPolicy),
            );
            if (registered !== undefined) {
                if (reasoningPolicy !== undefined
                    && !registered.supportedReasoningPolicies.includes(reasoningPolicy)) {
                    throw new UnsupportedReasoningPolicyError(
                        `provider:${alias.provider}`,
                        reasoningPolicy,
                        registered.supportedReasoningPolicies,
                    );
                }
                return registered;
            }
            const key = ProviderInstantiate.#cacheKey(alias, env, reasoningPolicy);
            let cached = ProviderInstantiate.#instances.get(key);
            if (cached === undefined) {
                cached = ProviderInstantiate.#instantiate(alias, env, reasoningPolicy);
                ProviderInstantiate.#instances.set(key, cached);
                cached.catch(() => ProviderInstantiate.#instances.delete(key)); // a failed construct never poisons the cache
            }
            return cached;
        }
        return ProviderInstantiate.#instantiate(alias, env, reasoningPolicy); // custom env (tests) — never cached
    }

    static #identityKey(alias: ProviderAlias): string {
        return `${alias.alias}|${alias.provider}|${alias.model}|${alias.baseUrl ?? ""}`;
    }

    static #cacheKey(alias: ProviderAlias, env: NodeJS.ProcessEnv, reasoningPolicy?: ReasoningPolicy): string {
        const scoped = ProviderInstantiate.#scopedEnv(alias, env, reasoningPolicy);
        const tuning = PROVIDERS_KNOBS.map((name) => [name, scoped[name] ?? ""]);
        return `${ProviderInstantiate.#identityKey(alias)}|${JSON.stringify(tuning)}`;
    }

    static #scopedEnv(
        alias: ProviderAlias,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): NodeJS.ProcessEnv {
        const scoped = scopeEnvToAlias(env, alias.alias);
        return reasoningPolicy === undefined
            ? scoped
            : { ...scoped, PLURNK_PROVIDERS_REASONING: reasoningPolicy };
    }

    static configuredReasoningPolicy(
        alias: ProviderAlias,
        env: NodeJS.ProcessEnv = process.env,
    ): ReasoningPolicy {
        const value = ProviderInstantiate.#scopedEnv(alias, env).PLURNK_PROVIDERS_REASONING;
        return parseReasoningPolicy(value, `Provider alias '${alias.alias}' reasoning policy`);
    }

    static async #instantiate(
        alias: ProviderAlias,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        const provider = await ProviderInstantiate.#construct(alias, env, reasoningPolicy);
        ProviderInstantiate.#aliasByProvider.set(provider, alias.alias);
        return provider;
    }

    static async #construct(
        alias: ProviderAlias,
        env: NodeJS.ProcessEnv,
        reasoningPolicy?: ReasoningPolicy,
    ): Promise<Provider> {
        // {§operator-config-precedence} — promote the alias-scoped provider-knob family
        // (PLURNK_PROVIDERS_*_<alias>) to
        // bare BEFORE construction, so per-alias tuning and generation-envelope pins bind. Without this
        // the whole per-alias provider surface was silently dropped at construction.
        env = ProviderInstantiate.#scopedEnv(alias, env, reasoningPolicy);
        return ProviderInstantiate.#constructWith(alias, env);
    }

    static async #constructWith(alias: ProviderAlias, env: NodeJS.ProcessEnv): Promise<Provider> {
        return instantiateFrameworkProvider(
            alias.provider,
            env,
            alias.model,
            undefined,
            undefined,
            alias.baseUrl,
            // #construct already materialized the alias-scoped environment.
            undefined,
        );
    }

    // Convenience: resolve + instantiate in one call. Returns null when no
    // PLURNK_MODEL is set (caller decides what 'no provider' means).
    static async loadActiveProvider(env: NodeJS.ProcessEnv = process.env): Promise<Provider | null> {
        const alias = resolveActiveAlias(env); // the active provider alias resolves from PLURNK_MODEL — {§provider-instantiation-alias-resolution}
        if (alias === null) return null;
        const provider = await ProviderInstantiate.instantiateProvider(alias, env);
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
        // with the active alias
        // retained only for the boot-global fallback.
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(env)?.alias ?? "";
        const scoped = scopeEnvToAlias(env, alias, [
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
