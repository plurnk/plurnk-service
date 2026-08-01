// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { instantiateProvider as instantiateFrameworkProvider, PROVIDERS_KNOBS, resolveActiveAlias, scopeEnvToAlias } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias } from "@plurnk/plurnk-providers";

export default class ProviderInstantiate {
    // One provider per (provider, model, baseUrl) for the process lifetime: a provider is
    // stateless per the contract, and loop.run instantiating fresh per aliased call re-probed
    // the backend (latency) and re-fired providers' construction warnings on every loop (the
    // owner's boot log: one heuristic warning per loop.run). Cache keyed on the wire identity;
    // env is process-stable for these fields.
    static #instances = new Map<string, Promise<Provider>>();
    static #registeredInstances = new Map<string, Provider>();
    // #352 — provider handle → the alias name that produced it, so the service scopes its own
    // per-alias packet-policy knobs by the provider it's building a packet
    // for. Service-owned metadata about handles WE created; never a provider-contract field.
    static #aliasByProvider = new WeakMap<Provider, string>();

    // The alias name a provider was built under, or undefined (a test Mock, a hand-built handle).
    // PacketBuilder falls back to resolveActiveAlias for the boot-global case.
    static aliasOf(provider: Provider): string | undefined {
        return ProviderInstantiate.#aliasByProvider.get(provider);
    }

    // #488 — register a hand-built provider (a recording Mock) under an alias, so tests can
    // drive the per-alias grammar-rail resolution through the REAL chain instead of the
    // boot-global fallback the silent-severance guard now refuses.
    static registerAlias(provider: Provider, alias: string): void {
        ProviderInstantiate.#aliasByProvider.set(provider, alias);
    }

    // Register a preconstructed handle under its full durable identity. Production
    // providers arrive through instantiateProvider and are already cached; this seam
    // gives injected providers (notably deterministic test providers) the identical
    // lookup behavior when a persisted loop resumes.
    static registerInstance(provider: Provider, spec: ProviderAlias): void {
        ProviderInstantiate.#aliasByProvider.set(provider, spec.alias);
        ProviderInstantiate.#registeredInstances.set(ProviderInstantiate.#identityKey(spec), provider);
    }

    static async instantiateProvider(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
        if (env === process.env) {
            const registered = ProviderInstantiate.#registeredInstances.get(ProviderInstantiate.#identityKey(alias));
            if (registered !== undefined) return registered;
            const key = ProviderInstantiate.#cacheKey(alias, env);
            let cached = ProviderInstantiate.#instances.get(key);
            if (cached === undefined) {
                cached = ProviderInstantiate.#instantiate(alias, env);
                ProviderInstantiate.#instances.set(key, cached);
                cached.catch(() => ProviderInstantiate.#instances.delete(key)); // a failed construct never poisons the cache
            }
            return cached;
        }
        return ProviderInstantiate.#instantiate(alias, env); // custom env (tests) — never cached
    }

    static #identityKey(alias: ProviderAlias): string {
        return `${alias.alias}|${alias.provider}|${alias.model}|${alias.baseUrl ?? ""}`;
    }

    static #cacheKey(alias: ProviderAlias, env: NodeJS.ProcessEnv): string {
        const scoped = scopeEnvToAlias(env, alias.alias);
        const tuning = PROVIDERS_KNOBS.map((name) => [name, scoped[name] ?? ""]);
        return `${ProviderInstantiate.#identityKey(alias)}|${JSON.stringify(tuning)}`;
    }

    static async #instantiate(alias: ProviderAlias, env: NodeJS.ProcessEnv): Promise<Provider> {
        const provider = await ProviderInstantiate.#construct(alias, env);
        ProviderInstantiate.#aliasByProvider.set(provider, alias.alias);
        return provider;
    }

    static async #construct(alias: ProviderAlias, env: NodeJS.ProcessEnv): Promise<Provider> {
        // #525 — promote the alias-scoped provider-knob family (PLURNK_PROVIDERS_*_<alias>) to
        // bare BEFORE construction, so a per-alias TEMPERATURE/reserve pin binds. Without this
        // the whole per-alias provider surface was silently dropped at construction.
        env = scopeEnvToAlias(env, alias.alias);
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
        const alias = resolveActiveAlias(env); // the active provider alias resolves from PLURNK_MODEL — §provider-instantiation-alias-resolution
        if (alias === null) return null;
        const provider = await ProviderInstantiate.instantiateProvider(alias, env);
        await ProviderInstantiate.verifyGrammarEnforcement(provider, env);
        return provider;
    }

    // A configured GBNF is an explicit local constrained-sampling contract. Verify
    // that the provider both claims the capability and enforces a forcing grammar.
    // Endpoint-owned settings are outside this knob and outside this verification.
    static #VERIFY_TOKEN = "PLURNK-RAILS-LIVE";
    static #VERIFY_REASONING = "verify";
    static #VERIFY_PREFIX = `<|channel>thought\n${ProviderInstantiate.#VERIFY_REASONING}<channel|>`;
    static #VERIFY_INPUT = `${ProviderInstantiate.#VERIFY_PREFIX}${ProviderInstantiate.#VERIFY_TOKEN}`;
    static async verifyGrammarEnforcement(provider: Provider, env: NodeJS.ProcessEnv = process.env): Promise<void> {
        // #353: resolve through the provider's registered alias, with the active alias
        // retained only for the boot-global fallback.
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(env)?.alias ?? "";
        const scoped = scopeEnvToAlias(env, alias, ["PLURNK_PROVIDERS_GBNF", "PLURNK_PROVIDERS_REASONING"]);
        const gbnf = scoped.PLURNK_PROVIDERS_GBNF;
        if (gbnf === undefined || gbnf === "" || gbnf === "0") return; // rails not requested — nothing to verify
        if (scoped.PLURNK_PROVIDERS_REASONING === "off") {
            throw new Error(
                `PLURNK_PROVIDERS_GBNF=${gbnf} is invalid with PLURNK_PROVIDERS_REASONING=off: the PLURNK GBNF requires reasoning to be adaptive or on ({§gbnf-requires-reasoning}).`,
            );
        }
        if (provider.constrainsOutput !== true) {
            throw new Error(
                `PLURNK_PROVIDERS_GBNF=${gbnf} configures local constrained sampling, but '${provider.model}' does not advertise GBNF transport. `
                + `Configure this knob only for a supported local llama-server; endpoint-managed constraints require no service-side GBNF setting. `
                + `If this is a llama-server, set PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1 when automatic detection is unavailable.`,
            );
        }
        const forcing = `root ::= ${JSON.stringify(ProviderInstantiate.#VERIFY_INPUT)}`;
        let response;
        try {
            response = await provider.generate({
                messages: [{ role: "user", content: "ok" }],
                workerId: "gbnf-enforcement-verify", grammar: forcing, maxTokens: 32,
            });
        } catch (cause) {
            // A rejected probe request is distinct from a completed unconstrained response.
            const detail = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
                `grammar enforcement verification could not COMPLETE its probe against '${provider.model}' (PLURNK_PROVIDERS_GBNF=${gbnf}) — the model REJECTED the probe request. `
                + `This is a request/config incompatibility, NOT proof the rails are dark (and it would fail every real turn too). `
                + `The configured rail requires a reasoning-capable model and a compatible adaptive/on reasoning posture. `
                + `Refusing to boot until the request the daemon sends is one the model accepts. Probe error: ${detail}`,
                { cause },
            );
        }
        const evidence = response.grammarEvidence;
        if (evidence === undefined) {
            throw new Error(
                `GBNF enforcement failed: '${provider.model}' did not return grammar evidence for the forcing probe. `
                + `The service cannot verify the pre-projection sentence and refuses to boot.`,
            );
        }
        const input = evidence.input.replace(/(<eos>|<\/s>|<\|eot_id\|>|<\|endoftext\|>|<end_of_turn>)$/, "");
        if (!evidence.transported || input !== ProviderInstantiate.#VERIFY_INPUT) {
            throw new Error(
                `GBNF enforcement failed: PLURNK_PROVIDERS_GBNF=${gbnf} requests constrained sampling, but '${provider.model}' returned unconstrained output to a forcing grammar `
                + `(expected ${JSON.stringify(ProviderInstantiate.#VERIFY_INPUT)}, got ${JSON.stringify(input.slice(0, 80))}; transported=${evidence.transported}). `
                + `Refusing to boot because the configured local constraint was not enforced. `
                + `Check the llama-server capability or remove the PLURNK_PROVIDERS_GBNF setting.`,
            );
        }
    }
}
