// Model alias resolution. Reads PLURNK_MODEL_<alias>=<provider>/<model>
// env vars; PLURNK_MODEL=<alias> selects which is active at boot. Each
// alias maps to a provider plugin (@plurnk/plurnk-providers-<provider>);
// the registry dynamic-imports the package and calls its `fromEnv` factory.
//
// The first path segment of the value names the provider plugin; the rest
// is the provider's own identifier (may contain "/" for tri-level providers
// like openrouter's publisher/model).

import type { Provider, ProviderAlias, ProviderFactory } from "./types.ts";

export const parseAliasesFromEnv = (env: NodeJS.ProcessEnv = process.env): ProviderAlias[] => {
    const out: ProviderAlias[] = [];
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        if (!key.startsWith("PLURNK_MODEL_")) continue;
        const aliasRaw = key.slice("PLURNK_MODEL_".length);
        if (aliasRaw.length === 0) continue;
        const slash = value.indexOf("/");
        if (slash <= 0) continue;
        out.push({
            alias: aliasRaw.toLowerCase(),
            provider: value.slice(0, slash),
            model: value.slice(slash + 1),
        });
    }
    return out;
};

export const resolveActiveAlias = (env: NodeJS.ProcessEnv = process.env): ProviderAlias | null => {
    const selected = env.PLURNK_MODEL;
    if (selected === undefined || selected.length === 0) return null;
    const aliases = parseAliasesFromEnv(env);
    return aliases.find((a) => a.alias === selected.toLowerCase()) ?? null;
};

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
