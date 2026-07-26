// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { instantiateProvider as instantiateFrameworkProvider, resolveActiveAlias, scopeEnvToAlias } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias } from "@plurnk/plurnk-providers";

export default class ProviderInstantiate {
    // One provider per (provider, model, baseUrl) for the process lifetime: a provider is
    // stateless per the contract, and loop.run instantiating fresh per aliased call re-probed
    // the backend (latency) and re-fired providers' construction warnings on every loop (the
    // owner's boot log: one heuristic warning per loop.run). Cache keyed on the wire identity;
    // env is process-stable for these fields.
    static #instances = new Map<string, Promise<Provider>>();
    // #352 — provider handle → the alias name that produced it, so the service scopes its OWN
    // per-alias partition knobs (PLURNK_SERVICE_*_<alias>) by the provider it's building a packet
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
        ProviderInstantiate.#instances.set(
            `${spec.provider}|${spec.model}|${spec.baseUrl ?? ""}`,
            Promise.resolve(provider),
        );
    }

    static async instantiateProvider(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
        if (env === process.env) {
            const key = `${alias.provider}|${alias.model}|${alias.baseUrl ?? ""}`;
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
        // #528 — the CONTEXT_WINDOW pin is CORE's log-budget cap, never the provider's window:
        // strip it so the provider reports its NATURAL window (probe/served) and percent reserves
        // resolve off nature. PacketBuilder mins the cap into the prompt budget alone.
        const cap = env.PLURNK_PROVIDERS_CONTEXT_WINDOW;
        delete env.PLURNK_PROVIDERS_CONTEXT_WINDOW; // env is scopeEnvToAlias's copy — the caller's is untouched
        const provider = await ProviderInstantiate.#constructWith(alias, env);
        // #419 — a pinned UNPOLLABLE window: no natural exists, so the pin DECLARES the window
        // (reserves resolve off the declaration — there is no separate nature to protect).
        // Reconstruct once, probe skipped: the pin is the window, deterministically.
        if (provider.contextWindow === null && cap !== undefined) {
            return ProviderInstantiate.#constructWith(alias, { ...env, PLURNK_PROVIDERS_CONTEXT_WINDOW: cap, PLURNK_PROVIDERS_PROBE_NCTX: "0" });
        }
        return provider;
    }

    static async #constructWith(alias: ProviderAlias, env: NodeJS.ProcessEnv): Promise<Provider> {
        return instantiateFrameworkProvider(
            alias.provider,
            env,
            alias.model,
            undefined,
            undefined,
            alias.baseUrl,
            alias.alias,
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
    static async verifyGrammarEnforcement(provider: Provider, env: NodeJS.ProcessEnv = process.env): Promise<void> {
        // #353 — resolve GBNF PER ALIAS, exactly as Engine.#grammarConstraint does. The per-alias
        // move (#352) left this reading the BARE knob (now empty by default), so the boot verify
        // was SILENTLY SKIPPED for every alias whose grammar rides a suffix (turboderp) — the rails
        // ran UNVERIFIED, the #34 hole this method exists to close reopened. The alias is the one
        // that built this provider (the side-table), falling back to the active alias.
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(env)?.alias ?? "";
        const gbnf = scopeEnvToAlias(env, alias, ["PLURNK_PROVIDERS_GBNF"]).PLURNK_PROVIDERS_GBNF;
        if (gbnf === undefined || gbnf === "" || gbnf === "0") return; // rails not requested — nothing to verify
        if (provider.constrainsOutput !== true) {
            throw new Error(
                `PLURNK_PROVIDERS_GBNF=${gbnf} configures local constrained sampling, but '${provider.model}' does not advertise GBNF transport. `
                + `Configure this knob only for a supported local llama-server; endpoint-managed constraints require no service-side GBNF setting. `
                + `If this is a llama-server, set PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1 when automatic detection is unavailable.`,
            );
        }
        const forcing = `root ::= "${ProviderInstantiate.#VERIFY_TOKEN}"`;
        let content: string;
        try {
            const res = await provider.generate({
                messages: [{ role: "user", content: "ok" }],
                workerId: "gbnf-enforcement-verify", grammar: forcing, maxTokens: 16,
            });
            // llama-server sometimes renders the end-of-sequence token as literal text after the
            // forced string ("PLURNK-RAILS-LIVE<eos>") — that IS proof of enforcement (the grammar
            // matched exactly, then the sampler stopped); strip one trailing eos-ish marker.
            content = res.assistant.content.trim().replace(/(<eos>|<\/s>|<\|eot_id\|>|<\|endoftext\|>|<end_of_turn>)\s*$/, "").trim();
        } catch (cause) {
            // The probe REQUEST was rejected (not "rails came back unconstrained"). This is loud, not
            // the silent-off failure the verify guards against — and it will recur on every real turn,
            // so refuse legibly and name the likely cause. The classic one: the provider sends a
            // reasoning parameter the model rejects (a non-reasoning model + PLURNK_PROVIDERS_REASONING
            // defaulting on → OpenAI 400 "does not support parameter reasoningEffort").
            const detail = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
                `grammar enforcement verification could not COMPLETE its probe against '${provider.model}' (PLURNK_PROVIDERS_GBNF=${gbnf}) — the model REJECTED the probe request. `
                + `This is a request/config incompatibility, NOT proof the rails are dark (and it would fail every real turn too). `
                + `Most common cause: the model does not accept a parameter the provider sends — e.g. a reasoning param on a non-reasoning model; set PLURNK_PROVIDERS_REASONING=off (or the model-appropriate posture). `
                + `Refusing to boot until the request the daemon sends is one the model accepts. Probe error: ${detail}`,
                { cause },
            );
        }
        if (content !== ProviderInstantiate.#VERIFY_TOKEN) {
            throw new Error(
                `GBNF enforcement failed: PLURNK_PROVIDERS_GBNF=${gbnf} requests constrained sampling, but '${provider.model}' returned unconstrained output to a forcing grammar `
                + `(expected ${JSON.stringify(ProviderInstantiate.#VERIFY_TOKEN)}, got ${JSON.stringify(content.slice(0, 40))}). `
                + `Refusing to boot because the configured local constraint was not enforced. `
                + `Check the llama-server capability or remove the PLURNK_PROVIDERS_GBNF setting.`,
            );
        }
    }
}
