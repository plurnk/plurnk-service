// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { resolveActiveAlias, isStandardProvider, standardProviderFromEnv } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias, ProviderFactory } from "@plurnk/plurnk-providers";

export default class ProviderInstantiate {
    static async instantiateProvider(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
        // Standard providers (openai-compat + groq/deepinfra/...) construct via
        // the framework's factory — it carries probeNctx (auto-detect the
        // endpoint's n_ctx, so a local llama-server isn't a no-window black box
        // that disables the budget grinder + tokensFree) and the shared
        // OpenAICompat transport. `openai` here replaces the former
        // @plurnk/plurnk-providers-openai sibling verbatim.
        if (isStandardProvider(alias.provider)) {
            const provider = await standardProviderFromEnv(alias.provider, env, alias.model);
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
        return await factory.fromEnv(env, alias.model);
    }

    // Convenience: resolve + instantiate in one call. Returns null when no
    // PLURNK_MODEL is set (caller decides what 'no provider' means).
    static async loadActiveProvider(env: NodeJS.ProcessEnv = process.env): Promise<Provider | null> {
        const alias = resolveActiveAlias(env); // the active provider alias resolves from PLURNK_MODEL — §provider-instantiation-alias-resolution
        if (alias === null) return null;
        return ProviderInstantiate.instantiateProvider(alias, env);
    }
}
