// Model alias resolution. Reads PLURNK_MODEL_<alias>=<provider>/<model>
// env vars; PLURNK_MODEL=<alias> selects which is active at boot.
//
// `instantiateProvider` and `loadActiveProvider` (the dynamic-import path)
// live in the consumer (plurnk-service) because Node's `import()` resolves
// package specifiers relative to the calling module's location; the
// consumer is the package that actually has the `@plurnk/plurnk-providers-*`
// sibling installed in its node_modules. This module ships only the pure
// env-parsing helpers.

import type { ProviderAlias } from "./types.ts";

export const parseAliasesFromEnv = (env: NodeJS.ProcessEnv = process.env): ProviderAlias[] => {
    const out: ProviderAlias[] = [];
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        if (!key.startsWith("PLURNK_MODEL_")) continue;
        const aliasRaw = key.slice("PLURNK_MODEL_".length);
        if (aliasRaw.length === 0) continue;
        const slash = value.indexOf("/");
        if (slash <= 0) continue;
        const alias = aliasRaw.toLowerCase();
        // Aliases are case-folded, so PLURNK_MODEL_opus and PLURNK_MODEL_OPUS
        // collide. Surface the ambiguity rather than silently picking one.
        if (seen.has(alias)) throw new Error(`Duplicate provider alias "${alias}": multiple PLURNK_MODEL_* keys case-fold to the same alias. Rename one.`);
        seen.add(alias);
        out.push({ alias, provider: value.slice(0, slash), model: value.slice(slash + 1) });
    }
    return out;
};

export const resolveActiveAlias = (env: NodeJS.ProcessEnv = process.env): ProviderAlias | null => {
    const selected = env.PLURNK_MODEL;
    if (selected === undefined || selected.length === 0) return null;
    const aliases = parseAliasesFromEnv(env);
    return aliases.find((a) => a.alias === selected.toLowerCase()) ?? null;
};
