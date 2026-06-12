// Model alias resolution + provider instantiation. Reads
// PLURNK_MODEL_<alias>=<provider>/<model> env vars; PLURNK_MODEL=<alias>
// selects which is active at boot.
//
// Tier-2 instantiation lives HERE since the framework bundles its own
// daughter packages (they are this package's dependencies), so Node's
// caller-relative `import()` resolves them from this module. Consumers pin
// ONE package and call instantiateProvider / loadActiveProvider; they never
// pin or import a daughter directly (SPEC §5).

import type { Provider, ProviderAlias, ProviderFactory } from "./types.ts";
import { isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

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

// The seam is injectable so tests exercise the bespoke path without a real
// package present; production callers never pass it.
type ImportModule = (specifier: string) => Promise<unknown>;
const importModule: ImportModule = (specifier) => import(specifier);

// Two-tier resolution (SPEC §5): standard provider → bundled daughter →
// fail-hard naming both misses. The daughter packages are this framework's
// own dependencies, so the dynamic import resolves wherever the framework is
// installed.
export const instantiateProvider = async (
    name: string,
    env: NodeJS.ProcessEnv,
    model: string,
    importImpl: ImportModule = importModule,
): Promise<Provider> => {
    if (isStandardProvider(name)) {
        const standard = await standardProviderFromEnv(name, env, model);
        if (standard === null) throw new Error(`provider "${name}": standard registry resolution failed`);
        return standard;
    }
    const specifier = `@plurnk/plurnk-providers-${name}`;
    let mod: unknown;
    try {
        mod = await importImpl(specifier);
    } catch (cause) {
        throw new Error(`unknown provider "${name}": not a standard provider and ${specifier} is not installed`, { cause });
    }
    const factory = (mod as { default?: ProviderFactory }).default;
    if (factory === undefined || typeof factory.fromEnv !== "function") {
        throw new Error(`${specifier} default export is not a Provider factory (missing static fromEnv)`);
    }
    return await factory.fromEnv(env, model);
};

// Boot convenience: resolve the active alias cascade and instantiate it.
export const loadActiveProvider = async (
    env: NodeJS.ProcessEnv = process.env,
    importImpl: ImportModule = importModule,
): Promise<Provider> => {
    const alias = resolveActiveAlias(env);
    if (alias === null) {
        throw new Error("no active provider: set PLURNK_MODEL to an alias declared via PLURNK_MODEL_<alias>=<provider>/<model>");
    }
    return instantiateProvider(alias.provider, env, alias.model, importImpl);
};
