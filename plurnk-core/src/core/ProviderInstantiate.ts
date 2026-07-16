// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { resolveActiveAlias, scopeEnvToAlias, isStandardProvider, standardProviderFromEnv } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias, ProviderFactory } from "@plurnk/plurnk-providers";

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
        // Standard providers (openai-compat + groq/deepinfra/...) construct via
        // the framework's factory — it carries probeNctx (auto-detect the
        // endpoint's n_ctx, so a local llama-server isn't a no-window black box
        // that disables the budget grinder + tokensFree) and the shared
        // OpenAICompat transport. `openai` here replaces the former
        // @plurnk/plurnk-providers-openai sibling verbatim.
        if (isStandardProvider(alias.provider)) {
            // alias.baseUrl MUST thread through — it's the per-alias PLURNK_BASEURL_<alias>
            // override. Drop it and every openai-compat alias silently collapses to a shared
            // OPENAI_BASE_URL (or fails hard), so a multi-endpoint setup runs the wrong box.
            const provider = await standardProviderFromEnv(alias.provider, env, alias.model, alias.baseUrl);
            if (provider === null) throw new Error(`standard provider '${alias.provider}' returned null for model '${alias.model}'`);
            return provider;
        }
        // Bespoke siblings (ollama/openrouter/google/xai/cloudflare): dynamic-
        // import the package's own fromEnv factory.
        const packageName = `@plurnk/plurnk-providers-${alias.provider}`;
        let mod: { default: ProviderFactory };
        try {
            mod = await import(packageName);
        } catch (cause) {
            throw new Error(`provider package ${packageName} not installed (alias '${alias.alias}' requires it)`, { cause });
        }
        const factory = mod.default;
        if (typeof factory?.fromEnv !== "function") {
            throw new Error(
                `${packageName}: default export must have a static \`fromEnv(env, model)\` factory`,
            );
        }
        return await factory.fromEnv(env, alias.model, alias.baseUrl !== undefined ? { baseUrl: alias.baseUrl } : undefined);
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

    // §grammar-enforcement-verified-at-boot — the rails are useless if silently OFF. The openai
    // provider only transports the grammar when its boot probe DETECTS llama-server (grammarStyle
    // 'llamacpp'); any probe hiccup silently falls back to 'none' — unconstrained generation, no
    // signal, and the whole grammar contract dark (weeks of "gemma strokes" were unconstrained
    // gemma). The Provider interface exposes no capability to introspect this, so we VERIFY the
    // contract end to end: when the operator requested a grammar, force a trivial one and confirm
    // the backend actually constrained the output. Anything else FAILS HARD at boot — a legible
    // refusal to run beats silent garbage that reads as model failure. No-op when GBNF is off.
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
        // #336 — gate on the provider's own claim: a grammarStyle-'none' provider DROPS the grammar
        // cleanly (never on the wire, constrainsOutput:false), so a global GBNF default must not
        // refuse boot against it — the rails are simply not in play for this backend. The #34 hole
        // stays closed: wherever the provider CLAIMS constrainsOutput, the end-to-end verify below
        // still fails hard; and a llama-server whose /v1/models probe raced to 'none' is cured
        // deterministically by PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1, which the notice names.
        if (provider.constrainsOutput === false) {
            process.stderr.write(
                `plurnk-service: PLURNK_PROVIDERS_GBNF=${gbnf} is configured, but '${provider.model}' does not enforce grammars — running UNCONSTRAINED on this alias. `
                + `If this backend is a llama-server, pin PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1 so detection never races.\n`,
            );
            return;
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
                `grammar enforcement is OFF: PLURNK_PROVIDERS_GBNF=${gbnf} requests constrained sampling, but '${provider.model}' returned UNCONSTRAINED output to a forcing grammar `
                + `(expected ${JSON.stringify(ProviderInstantiate.#VERIFY_TOKEN)}, got ${JSON.stringify(content.slice(0, 40))}). `
                + `The provider likely failed to detect the llama-server backend (grammarStyle 'none') — the grammar was never transported. `
                + `Refusing to boot: unconstrained generation reads as model failure and hides that the rails are dark. `
                + `Check the backend is a live llama-server (/v1/models must carry a per-model 'meta'), or unset PLURNK_PROVIDERS_GBNF to run unconstrained deliberately.`,
            );
        }
    }
}
