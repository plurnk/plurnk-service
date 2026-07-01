// Provider instantiation + active-alias resolution. Alias PARSING (the
// PLURNK_MODEL_<alias>=<provider>/<model> cascade + PLURNK_BASEURL_<alias>
// overrides) lives in @plurnk/plurnk-aliases — the zero-dep parser shared with
// thin clients (#27); this module resolves the active alias to a Provider.
//
// Two-tier resolution (SPEC §5): tier 1 is the closed standard-provider table;
// tier 2 is a SCOPE-AGNOSTIC node_modules scan (discover()) for packages
// declaring `plurnk.kind:"provider"` — first-party daughters (installed flat
// via @plurnk/plurnk-providers-all) AND third-party providers under any scope.
// The framework is contract-only — it does NOT depend on its daughters; the
// scan is what surfaces them (#12/#14).

import type { Provider, ProviderFactory } from "./types.ts";
import { isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";
import { discover, type DiscoverOptions, type Discovery } from "./discover.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-aliases";

// Two injectable seams, both defaulting to production behavior and never passed
// by real callers: the module importer (tests exercise the bespoke path without
// a real package on disk) and the discovery scan (tests inject a fixed map).
type ImportModule = (specifier: string) => Promise<unknown>;
const importModule: ImportModule = (specifier) => import(specifier);
type DiscoverFn = (options?: DiscoverOptions) => Promise<Discovery>;

// The node_modules scan is filesystem work that never changes within a process,
// so it runs once and the result is memoized. A long-lived daemon pays one scan
// at first bespoke instantiation; every later run reuses it. The trust gate is
// boot config, so the env from the first scan stands for the process.
let discoveredCache: Discovery | null = null;
const providerPackages = async (discoverFn: DiscoverFn, env: NodeJS.ProcessEnv): Promise<Discovery> => {
    discoveredCache ??= await discoverFn({ env });
    return discoveredCache;
};

// Two-tier resolution (SPEC §5): tier 1 standard table → tier 2 discovered
// package (scope-agnostic scan, trust-gated) → fail-hard. The standard table is
// authoritative — a scanned package whose name duplicates a standard one is
// shadowed here (never reached), since tier 1 returns first.
export const instantiateProvider = async (
    name: string,
    env: NodeJS.ProcessEnv,
    model: string,
    importImpl: ImportModule = importModule,
    discoverFn: DiscoverFn = discover,
    baseUrl?: string, // per-alias endpoint override (PLURNK_BASEURL_<alias>); threaded to both tiers
): Promise<Provider> => {
    if (isStandardProvider(name)) {
        const standard = await standardProviderFromEnv(name, env, model, baseUrl);
        if (standard === null) throw new Error(`provider "${name}": standard registry resolution failed`);
        return standard;
    }
    const { registry, skipped } = await providerPackages(discoverFn, env);
    const specifier = registry.get(name);
    if (specifier === undefined) {
        const declined = skipped.get(name);
        if (declined !== undefined) {
            throw new Error(`provider "${name}" resolves to ${declined}, but it is untrusted under PLURNK_PLUGINS_TRUSTED_ONLY — add it to the allowlist (or publish under @plurnk/)`);
        }
        throw new Error(`unknown provider "${name}": not a standard provider, and no installed package declares plurnk.kind:"provider" with name "${name}"`);
    }
    let mod: unknown;
    try {
        mod = await importImpl(specifier);
    } catch (cause) {
        throw new Error(`provider "${name}" resolves to ${specifier}, but importing it failed`, { cause });
    }
    const factory = (mod as { default?: ProviderFactory }).default;
    if (factory === undefined || typeof factory.fromEnv !== "function") {
        throw new Error(`${specifier} default export is not a Provider factory (missing static fromEnv)`);
    }
    return await factory.fromEnv(env, model, baseUrl !== undefined ? { baseUrl } : undefined);
};

// Test-only: drop the memoized discovery so a fresh scan/injection runs next.
export const resetDiscoveryCache = (): void => { discoveredCache = null; };

// Boot convenience: resolve the active alias cascade and instantiate it.
export const loadActiveProvider = async (
    env: NodeJS.ProcessEnv = process.env,
    importImpl: ImportModule = importModule,
    discoverFn: DiscoverFn = discover,
): Promise<Provider> => {
    const alias = resolveActiveAlias(env);
    if (alias === null) {
        throw new Error("no active provider: set PLURNK_MODEL to an alias declared via PLURNK_MODEL_<alias>=<provider>/<model>");
    }
    return instantiateProvider(alias.provider, env, alias.model, importImpl, discoverFn, alias.baseUrl);
};
