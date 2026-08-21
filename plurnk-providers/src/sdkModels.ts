import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
    isProviderCredentialName,
    lookupProvider,
    providerCatalogSnapshot,
    type ProviderInfo,
} from "@plurnk/plurnk-models";
import { Validator, type ModelReadiness, type ModelReadinessCause } from "@plurnk/plurnk-contracts";
import type { LanguageModel } from "ai";
import { providerCostNormalizer } from "./accounting.ts";
import type { AiSdkProviderOptions, CacheAffinity } from "./AiSdkProvider.ts";
import type { ProviderCostNormalizer } from "./types.ts";

export type SdkModel = {
    readonly languageModel?: LanguageModel;
    readonly normalizeCost?: ProviderCostNormalizer;
    readonly compatible?: {
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    };
    readonly cacheAffinity?: CacheAffinity;
    readonly systemCacheProviderOptions?: AiSdkProviderOptions;
    readonly reasoningResponseProviderOptions?: AiSdkProviderOptions;
    readonly additiveReasoningProvider?: "anthropic" | "bedrock";
    readonly catalog: ProviderInfo | null;
};

const cacheControl = { type: "ephemeral" as const };
// The release generator admits only packages implemented by this package.
// Derive runtime readiness from that same pinned provider projection instead
// of maintaining a second support list beside the construction switch.
const supportedSdkPackages = new Set(
    Object.values(providerCatalogSnapshot()).map(({ npm }) => npm),
);

const openRouterHeaders = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): Readonly<Record<string, string>> => {
    if (catalog.id !== "openrouter") return {};
    if (env.OPENROUTER_X_TITLE !== undefined) {
        throw new Error(`${provider} provider: OPENROUTER_X_TITLE was renamed to OPENROUTER_APP_TITLE.`);
    }
    const referer = env.OPENROUTER_HTTP_REFERER?.trim();
    if (referer === undefined || referer === "") return {};
    let parsed: URL;
    try {
        parsed = new URL(referer);
    } catch (cause) {
        throw new Error(`${provider} provider: OPENROUTER_HTTP_REFERER must be an absolute HTTP(S) URL.`, { cause });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${provider} provider: OPENROUTER_HTTP_REFERER must be an absolute HTTP(S) URL.`);
    }
    const title = env.OPENROUTER_APP_TITLE?.trim();
    return {
        "HTTP-Referer": parsed.href,
        ...(title === undefined || title === "" ? {} : { "X-OpenRouter-Title": title }),
    };
};

const envPrefix = (provider: string): string =>
    provider.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

// {§provider-fact-authority} — one credential declaration holds exactly one
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
    const npm = env[`${prefix}_NPM`];
    if (npm === undefined || npm.length === 0) return null;
    const declared = env[`${prefix}_API_KEY_ENV`];
    const keyNames = declared === undefined
        ? []
        : [singleCredentialName(provider, declared)];
    const api = env[`${prefix}_BASE_URL`];
    return {
        id: provider,
        name: provider,
        npm,
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
    : [...new Set([...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]!))];

const missingCause = (
    kind: ModelReadinessCause["kind"],
    alternatives: readonly (readonly string[])[],
): ModelReadinessCause => ({
    kind,
    alternatives: alternatives.map((alternative) => [...alternative]) as ModelReadinessCause["alternatives"],
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
// used by createSdkModel, but never probes a provider or validates a secret.
export const providerReadiness = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ModelReadiness | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedSdkPackages.has(catalog.npm)) return null;
    const rawUrl = configuredBaseUrl(provider, env, catalog, baseUrlOverride);
    const missingCoordinates = templateEnvironmentNames(rawUrl).filter((name) => !isSet(env, name));
    const causes: ModelReadinessCause[] = missingCoordinates.length === 0
        ? []
        : [missingCause("configuration", [missingCoordinates])];

    if (catalog.npm === "@ai-sdk/amazon-bedrock") {
        causes.push(...bedrockReadinessCauses(env, rawUrl !== undefined));
    } else {
        const candidates = credentialCandidates(provider, env, catalog);
        const credentialRequired = catalog.npm !== "@ai-sdk/openai-compatible" || candidates.length > 0;
        if (credentialRequired && candidates.length === 0) {
            causes.push(missingCause("configuration", [[
                `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`,
            ]]));
        } else if (credentialRequired && firstSet(env, candidates) === undefined) {
            causes.push(missingCause("credential", candidates.map((name) => [name])));
        }
        if (catalog.npm === "@ai-sdk/openai-compatible" && rawUrl === undefined) {
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
    // {§provider-fact-authority} — distinct sources, one precedence: the PLURNK
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
    // {§provider-fact-authority} — a catalog `env` list mixes credentials with
    // non-secret coordinates; the credential is the credential-named one.
    const candidates = credentialCandidates(provider, env, catalog);
    const key = firstSet(env, candidates);
    if (key === undefined) throw new Error(`${provider} provider: ${candidates.join(" or ")} must be set`);
    return key;
};

export const createSdkModel = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): SdkModel | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedSdkPackages.has(catalog.npm)) {
        throw new Error(`${provider} provider: Models.dev declares unsupported AI SDK package ${catalog.npm}`);
    }
    assertProviderReady(provider, env, baseUrlOverride);
    const url = baseUrl(provider, env, catalog, baseUrlOverride);
    const normalizeCost = providerCostNormalizer(catalog.npm);

    switch (catalog.npm) {
        case "@ai-sdk/openai":
            return {
                languageModel: createOpenAI({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).chat(model),
                ...(catalog.id === "openai"
                    ? { cacheAffinity: { target: "provider-option" as const, provider: "openai", name: "promptCacheKey" } }
                    : {}),
                catalog,
            };
        case "@ai-sdk/groq":
            return {
                languageModel: createGroq({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                catalog,
            };
        case "@ai-sdk/cerebras":
            return {
                languageModel: createCerebras({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                catalog,
            };
        case "@ai-sdk/mistral":
            return {
                languageModel: createMistral({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                catalog,
            };
        case "@ai-sdk/togetherai":
            return {
                languageModel: createTogetherAI({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                catalog,
            };
        case "@ai-sdk/deepinfra":
            return {
                languageModel: createDeepInfra({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                ...(catalog.id === "deepinfra"
                    ? { cacheAffinity: { target: "provider-option" as const, provider: "deepinfra", name: "prompt_cache_key" } }
                    : {}),
                catalog,
            };
        case "@ai-sdk/google":
            return {
                languageModel: createGoogle({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                reasoningResponseProviderOptions: {
                    google: { thinkingConfig: { includeThoughts: true } },
                },
                catalog,
            };
        case "@ai-sdk/xai":
            return {
                languageModel: createXai({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).chat(model),
                ...(catalog.id === "xai"
                    ? { cacheAffinity: { target: "header" as const, name: "x-grok-conv-id" } }
                    : {}),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                catalog,
            };
        case "@ai-sdk/anthropic":
            return {
                languageModel: createAnthropic({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                additiveReasoningProvider: "anthropic",
                ...(catalog.id === "anthropic"
                    ? { systemCacheProviderOptions: { anthropic: { cacheControl } } }
                    : {}),
                catalog,
            };
        case "@ai-sdk/amazon-bedrock":
            return {
                languageModel: createAmazonBedrock({
                    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
                    accessKeyId: env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                    sessionToken: env.AWS_SESSION_TOKEN,
                    apiKey: env.AWS_BEARER_TOKEN_BEDROCK,
                    baseURL: url,
                }).languageModel(model),
                ...(model.includes("anthropic")
                    ? { additiveReasoningProvider: "bedrock" as const }
                    : {}),
                catalog,
            };
        case "@openrouter/ai-sdk-provider":
            return {
                languageModel: createOpenRouter({
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    headers: openRouterHeaders(provider, env, catalog),
                }).languageModel(model),
                ...(catalog.id === "openrouter"
                    ? { cacheAffinity: { target: "header" as const, name: "x-session-id" } }
                    : {}),
                ...(catalog.id === "openrouter" && model.replace(/^~/, "").startsWith("anthropic/")
                    ? { systemCacheProviderOptions: { openrouter: { cacheControl } } }
                    : {}),
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                catalog,
            };
        case "@ai-sdk/openai-compatible":
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
                ...(catalog.id === "cloudflare-workers-ai"
                    ? { cacheAffinity: { target: "header" as const, name: "x-session-affinity" } }
                    : catalog.id === "fireworks-ai"
                        ? { cacheAffinity: { target: "body" as const, name: "prompt_cache_key" } }
                        : {}),
                catalog,
            };
        default:
            throw new Error(`${provider} provider: Models.dev declares unsupported AI SDK package ${catalog.npm}`);
    }
};
