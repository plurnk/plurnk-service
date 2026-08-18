// Provider instantiation + active-alias resolution. Alias PARSING (the
// PLURNK_MODEL_<alias>=<provider>/<model> cascade + PLURNK_BASEURL_<alias>
// overrides) lives in @plurnk/plurnk-aliases — the zero-dep parser shared with
// thin clients; this module resolves the active alias to a Provider.
//
// {§provider-resolution} Models.dev catalog → PLURNK provider declaration
// → local protocol adapter → scope-agnostic AI SDK plugin discovery. Generic
// provider facts belong to models.dev or operator config; PLURNK owns only the
// stable Provider contract and product-specific local behavior.

import type { AiSdkProviderPlugin, Provider } from "./types.ts";
import { catalogProviderFromEnv, providerFromSdkModel } from "./catalogProvider.ts";
import { discover, type DiscoverOptions, type Discovery } from "./discover.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-aliases";
import { scopeEnvToAlias } from "./env.ts";
import { ollamaProviderFromEnv } from "./ollama.ts";
import { compatibleProviderFromEnv } from "./compatibleProvider.ts";
import { contextWindowFromEnv } from "./env.ts";
import { withProviderDefaults } from "./defaults.ts";
import Meta, {
    type PluginAttribution,
    type PluginAttributionContext,
} from "@plurnk/plurnk-meta";

// Two injectable seams, both defaulting to production behavior and never passed
// by real callers: the module importer (tests exercise the bespoke path without
// a real package on disk) and the discovery scan (tests inject a fixed map).
type ImportModule = (specifier: string) => Promise<unknown>;
const importModule: ImportModule = (specifier) => import(specifier);
type DiscoveryInput = Omit<Discovery, "packageAttributions"> & {
    packageAttributions?: Discovery["packageAttributions"];
};
type DiscoverFn = (options?: DiscoverOptions) => Promise<DiscoveryInput>;

// The node_modules scan is filesystem work that never changes within a process,
// so it runs once and the result is memoized. A long-lived daemon pays one scan
// at first bespoke instantiation; every later run reuses it. The trust gate is
// boot config, so the env from the first scan stands for the process.
let discoveredCache: DiscoveryInput | null = null;
const providerPackages = async (discoverFn: DiscoverFn, env: NodeJS.ProcessEnv): Promise<DiscoveryInput> => {
    discoveredCache ??= await discoverFn({ env });
    return discoveredCache;
};

// Catalog and explicit declarations are authoritative. Discovery is the
// extensibility seam for an AI SDK provider that neither source describes.
export const instantiateProvider = async (
    name: string,
    env: NodeJS.ProcessEnv,
    model: string,
    importImpl: ImportModule = importModule,
    discoverFn: DiscoverFn = discover,
    baseUrl?: string, // per-alias endpoint override (PLURNK_BASEURL_<alias>); threaded to both tiers
    alias?: string, // the alias this instantiation serves — scopes PLURNK_PROVIDERS_<KNOB>_<alias> overrides
): Promise<Provider> => {
    env = withProviderDefaults(env);
    // Per-alias knob scoping overlays _<alias>-suffixed knobs onto their bare
    // names before any resolver reads them.
    if (alias !== undefined) env = scopeEnvToAlias(env, alias);
    const catalog = catalogProviderFromEnv(name, env, model, baseUrl);
    if (catalog !== null) return catalog;
    if (name === "ollama") return ollamaProviderFromEnv(env, model, baseUrl === undefined ? undefined : { baseUrl });
    if (name === "openai" || name === "plurnk") return compatibleProviderFromEnv(name, env, model, baseUrl);
    const { registry, skipped, packageAttributions = new Map(), grammarStyles = new Map() } = await providerPackages(discoverFn, env);
    const specifier = registry.get(name);
    if (specifier === undefined) {
        const declined = skipped.get(name);
        if (declined !== undefined) {
            throw new Error(`provider "${name}" resolves to ${declined}, but it is untrusted under PLURNK_PLUGINS_TRUSTED_ONLY — add it to the allowlist (or publish under @plurnk/)`);
        }
        throw new Error(`unknown provider "${name}": absent from models.dev, operator declarations, local adapters, and installed AI SDK provider plugins`);
    }
    let mod: unknown;
    try {
        mod = await importImpl(specifier);
    } catch (cause) {
        throw new Error(`provider "${name}" resolves to ${specifier}, but importing it failed`, { cause });
    }
    const sdkProvider = (mod as { default?: AiSdkProviderPlugin }).default;
    if (sdkProvider === undefined || typeof sdkProvider.languageModel !== "function") {
        throw new Error(`${specifier} default export is not an AI SDK provider (missing languageModel)`);
    }
    if (baseUrl !== undefined) {
        throw new Error(`${specifier}: PLURNK_BASEURL_${alias ?? "<alias>"} cannot reconfigure an installed AI SDK provider; declare the provider through PLURNK_PROVIDERS_PROVIDER_* instead`);
    }
    const contextWindow = contextWindowFromEnv(env, name);
    if (contextWindow === null) {
        throw new Error(`${specifier}: PLURNK_PROVIDERS_CONTEXT_WINDOW must be set because Models.dev has no metadata for provider "${name}"`);
    }
    const declared = packageAttributions.get(specifier) ?? [];
    const attributions = (context: PluginAttributionContext): PluginAttribution => Meta.composeAttributions(
        declared,
        Meta.runtimeAttribution(sdkProvider, context, specifier),
    );
    return providerFromSdkModel({
        name,
        env,
        model,
        languageModel: sdkProvider.languageModel(model),
        contextWindow,
        attributions,
        ...(grammarStyles.get(name) === undefined ? {} : { grammarStyle: grammarStyles.get(name) }),
    });
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
    return instantiateProvider(alias.provider, env, alias.model, importImpl, discoverFn, alias.baseUrl, alias.alias);
};
