import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { lookupProvider, type ProviderInfo } from "@plurnk/plurnk-models";
import type { LanguageModel } from "ai";
import { providerCostNormalizer } from "./accounting.ts";
import type { ProviderCostNormalizer } from "./types.ts";

export type SdkModel = {
    readonly languageModel?: LanguageModel;
    readonly normalizeCost?: ProviderCostNormalizer;
    readonly compatible?: {
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    };
    readonly catalog: ProviderInfo | null;
};

const envPrefix = (provider: string): string =>
    provider.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

export const configuredProviderInfo = (
    provider: string,
    env: NodeJS.ProcessEnv,
): ProviderInfo | null => {
    const prefix = `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}`;
    const npm = env[`${prefix}_NPM`];
    if (npm === undefined || npm.length === 0) return null;
    const keyNames = env[`${prefix}_API_KEY_ENV`]
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? [];
    const api = env[`${prefix}_BASE_URL`];
    return {
        id: provider,
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

const configuredKeyNames = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`];
    return configured === undefined || configured.length === 0
        ? catalog.env
        : configured.split(",").map((name) => name.trim()).filter(Boolean);
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
    const prefix = envPrefix(provider);
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`]
        ?? env[`${prefix}_BASE_URL`]
        ?? catalog.api;
    const value = override ?? configured;
    return value === undefined ? undefined : expandEnv(value, env, provider).replace(/\/+$/, "");
};

const requireApiKey = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): string => {
    const names = configuredKeyNames(provider, env, catalog);
    const key = firstSet(env, names);
    if (key === undefined) throw new Error(`${provider} provider: ${names.join(" or ")} must be set`);
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
    const url = baseUrl(provider, env, catalog, baseUrlOverride);
    const normalizeCost = providerCostNormalizer(catalog.npm);

    switch (catalog.npm) {
        case "@ai-sdk/openai":
            return {
                languageModel: createOpenAI({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).chat(model),
                catalog,
            };
        case "@ai-sdk/groq":
            return {
                languageModel: createGroq({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
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
                catalog,
            };
        case "@ai-sdk/google":
            return {
                languageModel: createGoogle({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
                catalog,
            };
        case "@ai-sdk/xai": {
            const key = requireApiKey(provider, env, catalog);
            const compatibleBase = url ?? "https://api.x.ai/v1";
            return {
                compatible: {
                    url: `${compatibleBase}/chat/completions`,
                    headers: { Authorization: `Bearer ${key}` },
                },
                ...(normalizeCost === undefined ? {} : { normalizeCost }),
                catalog,
            };
        }
        case "@ai-sdk/anthropic":
            return {
                languageModel: createAnthropic({ apiKey: requireApiKey(provider, env, catalog), baseURL: url }).languageModel(model),
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
                catalog,
            };
        case "@openrouter/ai-sdk-provider":
            return {
                languageModel: createOpenRouter({
                    apiKey: requireApiKey(provider, env, catalog),
                    baseURL: url,
                    headers: {
                        ...(env.OPENROUTER_HTTP_REFERER === undefined ? {} : { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER }),
                        ...(env.OPENROUTER_X_TITLE === undefined ? {} : { "X-Title": env.OPENROUTER_X_TITLE }),
                    },
                }).languageModel(model),
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
                catalog,
            };
        default:
            throw new Error(`${provider} provider: Models.dev declares unsupported AI SDK package ${catalog.npm}`);
    }
};
