// Dynamic provider instantiation. Lives in plurnk-service (the consumer)
// because Node's `import()` resolves package specifiers relative to the
// calling module's location; this is the package that actually has the
// `@plurnk/plurnk-providers-*` siblings installed in its node_modules.
//
// The pure helpers (parseAliasesFromEnv, resolveActiveAlias) live in
// @plurnk/plurnk-providers as framework-grade env parsing.

import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { Provider, ProviderAlias, ProviderFactory } from "@plurnk/plurnk-providers";

export const instantiateProvider = async (alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): Promise<Provider> => {
    const packageName = `@plurnk/plurnk-providers-${alias.provider}`;
    let mod: { default: ProviderFactory };
    try {
        mod = await import(packageName);
    } catch (cause) {
        throw new Error(
            `provider package ${packageName} not installed (alias '${alias.alias}' requires it): ` +
            (cause instanceof Error ? cause.message : String(cause)),
        );
    }
    const factory = mod.default;
    if (typeof factory?.fromEnv !== "function") {
        throw new Error(
            `${packageName}: default export must have a static \`fromEnv(env, model)\` factory`,
        );
    }
    return await factory.fromEnv(env, alias.model);
};

// Convenience: resolve + instantiate in one call. Returns null when no
// PLURNK_MODEL is set (caller decides what 'no provider' means).
export const loadActiveProvider = async (env: NodeJS.ProcessEnv = process.env): Promise<Provider | null> => {
    const alias = resolveActiveAlias(env);
    if (alias === null) return null;
    return instantiateProvider(alias, env);
};
