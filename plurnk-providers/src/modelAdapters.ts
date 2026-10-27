import { isProviderCredentialName, lookupProvider, providerCatalogSnapshot, type ProviderInfo } from "@plurnk/plurnk-models";
import { Validator, type ModelReadiness, type ModelReadinessCause } from "@plurnk/plurnk-contracts";
import { providerCostNormalizer } from "./accounting.ts";
import { providerSetting, providerEnvPrefix as envPrefix } from "./provider-env.ts";
import { withoutNativeToolsFetch } from "./native-tools.ts";
import { createOpenAICompatibleModel } from "./modelTransport.ts";
import {
    createAmazonBedrockModel,
    createAnthropicModel,
    createGoogleModel,
    createXaiModel,
} from "./vendorTransports.ts";
import type {
    ModelProviderOptions,
    CacheAffinity,
    NativeRequestControls,
} from "./ModelProvider.ts";
import type { ModelTransport, ProviderCostNormalizer } from "./types.ts";

export type ProviderModelAdapter = {
    readonly endpoint?: string;
    readonly modelTransport?: (fetch: typeof globalThis.fetch) => ModelTransport;
    readonly normalizeCost?: ProviderCostNormalizer;
    readonly compatible?: {
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    };
    readonly cacheAffinity?: CacheAffinity;
    readonly systemCacheProviderOptions?: ModelProviderOptions;
    readonly reasoningResponseProviderOptions?: ModelProviderOptions;
    readonly additiveReasoningProvider?: "anthropic" | "bedrock";
    // {§provider-request-authority} — the global controls this adapter documents as provider options.
    readonly requestControls?: NativeRequestControls;
    readonly catalog: ProviderInfo | null;
};

// The release generator admits only adapters implemented by this package.
// Derive runtime readiness from that same pinned provider projection instead
// of maintaining a second support list beside the construction switch.
const supportedAdapters = new Set<string>(
    Object.values(providerCatalogSnapshot()).map(({ adapter }) => adapter),
);

// {§provider-request-authority}: an OpenRouter route's application attribution is its provider's declaration,
// handed to the adapter, which owns the headers.
const openRouterAttributionHeaders = (provider: string, env: NodeJS.ProcessEnv): Record<string, string> => {
    const [urlKey, rawUrl] = providerSetting(provider, env, "APP_URL");
    const url = rawUrl?.trim();
    if (url === undefined || url === "") return {};
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (cause) {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`, { cause });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`);
    }
    const name = providerSetting(provider, env, "APP_NAME")[1]?.trim();
    return {
        "HTTP-Referer": parsed.href,
        ...(name === undefined || name === "" ? {} : { "X-OpenRouter-Title": name }),
    };
};

// {§model-fact-resolution} — one credential declaration holds exactly one
// name. An ordered fallback list would paper over an operator/catalog naming
// mismatch; that mismatch belongs at its owning boundary instead.
const singleCredentialName = (provider: string, value: string): string => {
    const name = value.trim();
    if (name.length === 0) throw new Error(`${provider} provider: API_KEY_ENV must name one environment variable.`);
    if (name.includes(",")) {
        throw new Error(
            `${provider} provider: API_KEY_ENV holds one exact name, never an ordered fallback; reconcile the operator environment with the Models.dev contract instead.`,
        );
    }
    return name;
};

export const configuredProviderInfo = (
    provider: string,
    env: NodeJS.ProcessEnv,
): ProviderInfo | null => {
    const prefix = `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}`;
    const adapter = env[`${prefix}_ADAPTER`];
    if (adapter === undefined || adapter.length === 0) return null;
    const declared = env[`${prefix}_API_KEY_ENV`];
    const keyNames = declared === undefined
        ? []
        : [singleCredentialName(provider, declared)];
    const api = env[`${prefix}_BASE_URL`];
    return {
        id: provider,
        name: provider,
        adapter,
        env: keyNames,
        ...(api === undefined || api.length === 0 ? {} : { api }),
    };
};

const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined => {
    for (const name of names) {
        const value = env[name];
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
};

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.length > 0;
};

const configuredKeyNames = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`];
    return configured === undefined || configured.length === 0
        ? catalog.env
        : [singleCredentialName(provider, configured)];
};

const credentialCandidates = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const names = configuredKeyNames(provider, env, catalog);
    const credentials = names.filter(isProviderCredentialName);
    return credentials.length > 0 ? credentials : names;
};

const configuredBaseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    const prefix = envPrefix(provider);
    return override
        ?? env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`]
        ?? env[`${prefix}_BASE_URL`]
        ?? catalog.api;
};

const templateEnvironmentNames = (value: string | undefined): readonly string[] => value === undefined
    ? []
    : [...new Set([...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]))];

// A list the readiness contract requires to name at least one item: built, never claimed.
const nonEmpty = <T>(items: readonly T[], subject: string): [T, ...T[]] => {
    if (items.length === 0) throw new TypeError(`A model readiness cause names no ${subject}.`);
    const [first, ...rest] = items;
    return [first, ...rest];
};

const missingCause = (
    kind: ModelReadinessCause["kind"],
    alternatives: readonly (readonly string[])[],
): ModelReadinessCause => ({
    kind,
    alternatives: nonEmpty(alternatives.map((alternative) => nonEmpty(alternative, "variable in an alternative")), "alternative"),
});

const bedrockReadinessCauses = (
    env: NodeJS.ProcessEnv,
    hasExplicitBaseUrl: boolean,
): ModelReadinessCause[] => {
    const bearer = isSet(env, "AWS_BEARER_TOKEN_BEDROCK");
    const sigv4 = isSet(env, "AWS_ACCESS_KEY_ID") && isSet(env, "AWS_SECRET_ACCESS_KEY");
    const region = isSet(env, "AWS_REGION") || isSet(env, "AWS_DEFAULT_REGION");
    if (bearer) {
        return hasExplicitBaseUrl || region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    if (sigv4) {
        return region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    return [missingCause("credential", hasExplicitBaseUrl
        ? [
            ["AWS_BEARER_TOKEN_BEDROCK"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ]
        : [
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ])];
};

// Local evidence only: this shares the exact environment and endpoint rules
// used by createProviderModel, but never probes a provider or validates a secret.
export const providerReadiness = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ModelReadiness | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedAdapters.has(catalog.adapter)) return null;
    const rawUrl = configuredBaseUrl(provider, env, catalog, baseUrlOverride);
    const missingCoordinates = templateEnvironmentNames(rawUrl).filter((name) => !isSet(env, name));
    const causes: ModelReadinessCause[] = missingCoordinates.length === 0
        ? []
        : [missingCause("configuration", [missingCoordinates])];

    if (catalog.adapter === "amazon-bedrock") {
        causes.push(...bedrockReadinessCauses(env, rawUrl !== undefined));
    } else {
        const candidates = credentialCandidates(provider, env, catalog);
        const credentialRequired = catalog.adapter !== "openai-compatible" || candidates.length > 0;
        if (credentialRequired && candidates.length === 0) {
            causes.push(missingCause("configuration", [[
                `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`,
            ]]));
        } else if (credentialRequired && firstSet(env, candidates) === undefined) {
            causes.push(missingCause("credential", candidates.map((name) => [name])));
        }
        if (catalog.adapter === "openai-compatible" && rawUrl === undefined) {
            const prefix = envPrefix(provider);
            causes.push(missingCause("configuration", [
                [`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`],
                [`${prefix}_BASE_URL`],
            ]));
        }
    }
    return Validator.assertModelReadiness({ ready: causes.length === 0, causes });
};

const assertProviderReady = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): void => {
    const readiness = providerReadiness(provider, env, baseUrlOverride);
    if (readiness === null || readiness.ready) return;
    const requirements = readiness.causes
        .map(({ alternatives }) => alternatives.map((group) => group.join(" and ")).join(" or "))
        .join("; ");
    throw new Error(`${provider} provider: ${requirements} must be set`);
};

const expandEnv = (value: string, env: NodeJS.ProcessEnv, provider: string): string =>
    value.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
        const replacement = env[name];
        if (replacement === undefined || replacement.length === 0) {
            throw new Error(`${provider} provider: ${name} must be set to resolve the Models.dev API URL`);
        }
        return replacement;
    });

const baseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    // {§model-fact-resolution} — distinct sources, one precedence: the PLURNK
    // knob, then the provider-native convention (OPENAI_BASE_URL etc.), then
    // the catalog. This is not an alias fallback: each source is a different
    // owner, and the catalog remains the last authority.
    const value = configuredBaseUrl(provider, env, catalog, override);
    return value === undefined ? undefined : expandEnv(value, env, provider).replace(/\/+$/, "");
};

const requireApiKey = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): string => {
    // {§model-fact-resolution} — a catalog `env` list mixes credentials with
    // non-secret coordinates; the credential is the credential-named one.
    const candidates = credentialCandidates(provider, env, catalog);
    const key = firstSet(env, candidates);
    if (key === undefined) throw new Error(`${provider} provider: ${candidates.join(" or ")} must be set`);
    return key;
};

const resolveAdapterProvider = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): { catalog: ProviderInfo; url: string | undefined } | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedAdapters.has(catalog.adapter)) {
        throw new Error(`${provider} provider: unsupported provider adapter ${catalog.adapter}`);
    }
    assertProviderReady(provider, env, baseUrlOverride);
    return { catalog, url: baseUrl(provider, env, catalog, baseUrlOverride) };
};

const providerCacheAffinity = (provider: string): CacheAffinity | undefined => {
    switch (provider) {
        case "openai":
            return { target: "provider-option", provider: "openai", name: "promptCacheKey" };
        case "deepinfra":
            return { target: "provider-option", provider: "deepinfra", name: "prompt_cache_key" };
        case "openrouter":
            return { target: "header", name: "x-session-id" };
        case "cloudflare-workers-ai":
        case "fireworks-ai":
            return { target: "header", name: "x-session-affinity" };
        default:
            return undefined;
    }
};

const providerSystemCacheOptions = (provider: string, model: string): ModelProviderOptions | undefined => {
    if (provider === "anthropic") {
        return { anthropic: { cacheControl: { type: "ephemeral" } } };
    }
    if (provider === "openrouter" && (model.startsWith("anthropic/") || model.startsWith("~anthropic/"))) {
        return { openrouter: { cacheControl: { type: "ephemeral" } } };
    }
    return undefined;
};

export const createProviderModel = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ProviderModelAdapter | null => {
    const resolved = resolveAdapterProvider(provider, env, baseUrlOverride);
    if (resolved === null) return null;
    const { catalog, url } = resolved;
    const cacheAffinity = providerCacheAffinity(provider);
    const systemCacheProviderOptions = providerSystemCacheOptions(provider, model);
    return {
        ...modelFromAdapter(provider, model, { ...env }, catalog, url),
        ...(systemCacheProviderOptions === undefined ? {} : { systemCacheProviderOptions }),
        ...(cacheAffinity === undefined ? {} : { cacheAffinity }),
        endpoint: url,
    };
};

const modelFromAdapter = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    url: string | undefined,
): ProviderModelAdapter => {
    const normalizeCost = providerCostNormalizer(catalog.adapter);
    const attributionHeaders = catalog.adapter === "openrouter"
        ? openRouterAttributionHeaders(provider, env)
        : undefined;

    switch (catalog.adapter) {
        case "openai":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "openai",
                    namespace: "openai",
                    baseURL: url ?? "https://api.openai.com/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                }),
                requestControls: { namespace: "openai", serviceTier: true, logprobs: true },
                catalog,
            };
        case "groq":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "groq",
                    namespace: "groq",
                    baseURL: url ?? "https://api.groq.com/openai/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                }),
                requestControls: { namespace: "groq", serviceTier: true, logprobs: false },
                catalog,
            };
        case "cerebras":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "cerebras",
                    namespace: "cerebras",
                    baseURL: url ?? "https://api.cerebras.ai/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                }),
                requestControls: { namespace: "cerebras", serviceTier: true, logprobs: false },
                catalog,
            };
        case "mistral":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "mistral",
                    namespace: "mistral",
                    baseURL: url ?? "https://api.mistral.ai/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                    includeUsage: false,
                }),
                requestControls: { namespace: "mistral", serviceTier: false, logprobs: false },
                catalog,
            };
        case "togetherai":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "togetherai",
                    namespace: "togetherai",
                    baseURL: url ?? "https://api.together.xyz/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                }),
                requestControls: { namespace: "togetherai", serviceTier: false, logprobs: false },
                catalog,
            };
        case "xai":
            return {
                modelTransport: (fetch) => createXaiModel(model, {
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    fetch: withoutNativeToolsFetch("openai", fetch),
                }),
                requestControls: { namespace: "xai", serviceTier: true, logprobs: false },
                catalog,
            };
        case "deepinfra":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "deepinfra",
                    namespace: "deepinfra",
                    baseURL: url ?? "https://api.deepinfra.com/v1/openai",
                    apiKey: requireApiKey(provider, env, catalog),
                    fetch: withoutNativeToolsFetch("openai", fetch),
                    includeTopK: false,
                }),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                requestControls: { namespace: "deepinfra", serviceTier: false, logprobs: false },
                catalog,
            };
        case "google":
            return {
                modelTransport: (fetch) => createGoogleModel(model, {
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    fetch: withoutNativeToolsFetch("generate-content", fetch),
                }),
                reasoningResponseProviderOptions: {
                    google: { thinkingConfig: { includeThoughts: true } },
                },
                requestControls: { namespace: "google", serviceTier: true, logprobs: false },
                catalog,
            };
        case "anthropic":
            return {
                modelTransport: (fetch) => createAnthropicModel(model, {
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    fetch: withoutNativeToolsFetch("messages", fetch),
                }),
                additiveReasoningProvider: "anthropic",
                requestControls: { namespace: "anthropic", serviceTier: true, logprobs: false },
                catalog,
            };
        case "amazon-bedrock":
            return {
                modelTransport: (fetch) => createAmazonBedrockModel(model, {
                    fetch,
                    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
                    accessKeyId: env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                    sessionToken: env.AWS_SESSION_TOKEN,
                    apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
                    baseURL: url,
                }),
                ...(model.includes("anthropic")
                    ? { additiveReasoningProvider: "bedrock" as const }
                    : {}),
                requestControls: { namespace: "bedrock", serviceTier: true, logprobs: false },
                catalog,
            };
        case "openrouter":
            return {
                modelTransport: (fetch) => createOpenAICompatibleModel(model, {
                    name: "openrouter",
                    namespace: "openrouter",
                    baseURL: url ?? "https://openrouter.ai/api/v1",
                    apiKey: requireApiKey(provider, env, catalog),
                    headers: attributionHeaders,
                    fetch: withoutNativeToolsFetch("openai", fetch),
                }),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                requestControls: { namespace: "openrouter", serviceTier: false, logprobs: false },
                catalog,
            };
        case "openai-compatible": {
            if (url === undefined) throw new Error(`${provider} provider: Models.dev supplies no API URL and no base URL was configured`);
            const keyNames = configuredKeyNames(provider, env, catalog);
            const key = keyNames.length === 0 ? undefined : requireApiKey(provider, env, catalog);
            return {
                compatible: {
                    url: `${url}/chat/completions`,
                    headers: key === undefined
                        ? {}
                        : { Authorization: `Bearer ${key}` },
                },
                catalog,
            };
        }
        default:
            throw new Error(`${provider} provider: unsupported provider adapter ${catalog.adapter}`);
    }
};
