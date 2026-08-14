import { lookupProvider, resolveModel, type ModelInfo } from "@plurnk/plurnk-models";
import {
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    envelopeFromEnv,
    parseRequiredFloat,
    parseRequiredInt,
    parseTimeoutMs,
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    reasoningFromEnv,
    reasoningResponseStyleFromEnv,
    resolveReserve,
    type ReserveSpec,
} from "./env.ts";
import AiSdkProvider, { type ReasoningStyle } from "./AiSdkProvider.ts";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";
import { providerSource } from "./notices.ts";
import type { Provider, ProviderCostNormalizer } from "./types.ts";
import { estimateProviderCost } from "./cost.ts";
import { emitWarningOnce } from "./warnings.ts";
import type { LanguageModel } from "ai";
import type { AiSdkProviderOptions, CacheAffinity } from "./AiSdkProvider.ts";
import type { PluginAttribution, PluginAttributionContext } from "@plurnk/plurnk-meta";

const reasoningStyleFromEnv = (
    env: NodeJS.ProcessEnv,
    name: string,
): ReasoningStyle | undefined => {
    const prefix = name.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const value = env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_STYLE`];
    if (value === undefined || value.length === 0) return undefined;
    const styles: readonly ReasoningStyle[] = [
        "none", "think", "include_reasoning", "effort",
        "effort_explicit", "thinking_effort", "template", "anthropic",
    ];
    if (!styles.includes(value as ReasoningStyle)) {
        throw new Error(`${name} provider: PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_STYLE has invalid value "${value}"`);
    }
    return value as ReasoningStyle;
};

export const providerFromSdkModel = ({
    name,
    env,
    model,
    languageModel,
    normalizeCost,
    url,
    headers,
    contextWindow,
    info,
    attributions,
    cacheAffinity,
    systemCacheProviderOptions,
}: {
    name: string;
    env: NodeJS.ProcessEnv;
    model: string;
    languageModel?: LanguageModel;
    normalizeCost?: ProviderCostNormalizer;
    url?: string;
    headers?: Readonly<Record<string, string>>;
    contextWindow: number;
    info?: ModelInfo;
    attributions?: (context: PluginAttributionContext) => PluginAttribution;
    cacheAffinity?: CacheAffinity;
    systemCacheProviderOptions?: AiSdkProviderOptions;
}): Provider => {
    emitWarningOnce(
        `${name} provider: request-level prompt counting is a chars/2 estimate; hard context-envelope admission fails closed without exact or bounded evidence`,
        "PLURNK_PROMPT_COUNT_ESTIMATE",
    );

    const reasoning = reasoningFromEnv(env, name);
    const { reasoningReserve: configuredReasoning, completionReserve: configuredCompletion } = envelopeFromEnv(env, name);
    const completionReserve: ReserveSpec = "tokens" in configuredCompletion
        ? configuredCompletion
        : info?.maxOutput === undefined
            ? configuredCompletion
            : { tokens: Math.min(info.maxOutput, Math.round(configuredCompletion.percent * contextWindow)) };
    const completionTokens = resolveReserve(completionReserve, contextWindow);
    const reasoningReserve: ReserveSpec = "tokens" in configuredReasoning
        ? configuredReasoning
        : reasoning.budget !== null
            ? { tokens: reasoning.budget }
            : completionTokens === null
                ? configuredReasoning
                : { tokens: Math.round(completionTokens / 2) };

    const catalogCost = info?.cost;
    const rates = catalogCost === undefined ? null : {
        input: catalogCost.inputPer1M,
        output: catalogCost.outputPer1M,
        ...(catalogCost.cacheReadPer1M === undefined
            ? {}
            : { cacheRead: catalogCost.cacheReadPer1M }),
        ...(catalogCost.cacheWritePer1M === undefined
            ? {}
            : { cacheWrite: catalogCost.cacheWritePer1M }),
    };
    const estimateCost = (usage: Parameters<typeof estimateProviderCost>[0]) =>
        estimateProviderCost(usage, rates, "Models.dev catalog rates");
    const affinityEnabled = cacheAffinityFromEnv(env, name);
    const cacheWritePolicy = cacheWritePolicyFromEnv(env, name);

    return new AiSdkProvider({
        model,
        ...(attributions === undefined ? {} : { attributions }),
        ...(languageModel === undefined ? {} : { languageModel }),
        ...(normalizeCost === undefined ? {} : { normalizeCost }),
        ...(url === undefined ? {} : { url }),
        ...(headers === undefined ? {} : { headers: { ...headers } }),
        contextWindow,
        fetchTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", name),
        operationTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "PLURNK_PROVIDERS_OPERATION_TIMEOUT", name),
        firstContentTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT, "PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT", name),
        streamIdleTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT, "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT", name),
        reasoning,
        reasoningResponseStyle: reasoningResponseStyleFromEnv(env, name),
        temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", name, 0),
        repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", name, 0),
        frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", name, 0),
        reasoningReserve,
        completionReserve,
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", name),
        reasoningStyle: reasoningStyleFromEnv(env, name),
        ...(affinityEnabled && cacheAffinity !== undefined ? { cacheAffinity } : {}),
        ...(cacheWritePolicy === "stable-system" && systemCacheProviderOptions !== undefined
            ? { systemCacheProviderOptions }
            : {}),
        serviceTier: env.PLURNK_PROVIDERS_SERVICE_TIER,
        estimateCost,
        source: providerSource(name),
        gbnfDebug: env.PLURNK_PROVIDERS_GBNF_DEBUG !== undefined
            && env.PLURNK_PROVIDERS_GBNF_DEBUG !== ""
            && env.PLURNK_PROVIDERS_GBNF_DEBUG !== "0",
        ...dataCaptureFromEnv(env, name),
    });
};

export const catalogProviderFromEnv = (
    name: string,
    env: NodeJS.ProcessEnv,
    model: string,
    baseUrlOverride?: string,
): Provider | null => {
    const resolved = resolveModel(name, model);
    const contextOverride = contextWindowFromEnv(env, name);
    if (lookupProvider(name) === null && configuredProviderInfo(name, env) === null) return null;
    if ((name === "openai" || name === "ollama") && resolved === null) return null;
    if (resolved === null && contextOverride === null) {
        throw new Error(
            `${name} provider: context window unresolved for "${model}" — set PLURNK_PROVIDERS_CONTEXT_WINDOW or update the Models.dev snapshot`,
        );
    }
    const wireModel = resolved?.id ?? model;
    const sdk = createSdkModel(name, wireModel, env, baseUrlOverride);
    if (sdk === null) return null;

    const info = resolved?.info;
    const contextWindow = effectiveContextWindow(contextOverride, info?.contextWindow ?? null);
    if (contextWindow === null) {
        throw new Error(
            `${name} provider: context window unresolved for "${wireModel}" — set PLURNK_PROVIDERS_CONTEXT_WINDOW or update the Models.dev snapshot`,
        );
    }
    return providerFromSdkModel({
        name,
        env,
        model: wireModel,
        languageModel: sdk.languageModel,
        normalizeCost: sdk.normalizeCost,
        url: sdk.compatible?.url,
        headers: sdk.compatible?.headers,
        cacheAffinity: sdk.cacheAffinity,
        systemCacheProviderOptions: sdk.systemCacheProviderOptions,
        contextWindow,
        info,
    });
};
