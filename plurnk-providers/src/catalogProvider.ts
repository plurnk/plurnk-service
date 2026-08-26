import { lookupProvider, resolveModel, type ModelInfo } from "@plurnk/plurnk-models";
import {
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    generationEnvelopeFromEnv,
    parseRequiredFloat,
    parseRequiredInt,
    parseTimeoutMs,
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    reasoningFromEnv,
    reasoningResponseStyleFromEnv,
} from "./env.ts";
import AiSdkProvider, { type AiSdkProviderConfig, type GrammarStyle, type ReasoningStyle } from "./AiSdkProvider.ts";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";
import { providerSource } from "./notices.ts";
import type { Provider, ProviderCostNormalizer } from "./types.ts";
import { REASONING_POLICIES, type ReasoningPolicy } from "@plurnk/plurnk-contracts";
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

const activationPolicies = Object.freeze(["off", "adaptive"] as const);
const deepSeekPolicies = Object.freeze(["off", "adaptive", "high"] as const);
const adaptiveOnly = Object.freeze(["adaptive"] as const);
const reasoningWithoutOff = Object.freeze(["adaptive", "low", "medium", "high"] as const);

const mistralSupportsEffort = (model: string): boolean =>
    model === "mistral-small-latest"
    || model === "mistral-small-2603"
    || model === "mistral-medium-3"
    || model === "mistral-medium-3.5";

const xaiReasoningIsModelFixed = (model: string): boolean =>
    /^grok-4\.20(?:-\d{4})?-(?:non-)?reasoning$/.test(model);

const googleReasoningCannotBeOff = (model: string): boolean =>
    /^gemini-2\.5-pro(?:-|$)/i.test(model)
    || /^gemini-(?:[3-9]|\d{2})[.-]/i.test(model);

const anthropicSupportsAdaptiveThinking = (model: string): boolean =>
    /claude-(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5)/.test(model);

const supportedReasoningPolicies = ({
    info,
    native,
    style,
    sdkPackage,
    model,
}: {
    info?: ModelInfo;
    native: boolean;
    style: ReasoningStyle;
    sdkPackage?: string;
    model: string;
}): readonly ReasoningPolicy[] => {
    if (info !== undefined && info.reasoning !== true) return activationPolicies;
    if (native) {
        if (sdkPackage === "@ai-sdk/mistral") {
            return mistralSupportsEffort(model) ? deepSeekPolicies : adaptiveOnly;
        }
        if (sdkPackage === "@ai-sdk/xai") {
            if (xaiReasoningIsModelFixed(model)) return adaptiveOnly;
            if (model === "grok-4.6") return reasoningWithoutOff;
        }
        if (sdkPackage === "@ai-sdk/google" && googleReasoningCannotBeOff(model)) {
            return reasoningWithoutOff;
        }
        return REASONING_POLICIES;
    }
    if (style === "effort" || style === "effort_explicit") return REASONING_POLICIES;
    if (style === "thinking_effort") return deepSeekPolicies;
    return activationPolicies;
};

const adaptiveReasoningProjection = ({
    sdkPackage,
    model,
    reasoningCapable,
}: {
    sdkPackage?: string;
    model: string;
    reasoningCapable: boolean;
}): Pick<AiSdkProviderConfig, "adaptiveReasoning" | "adaptiveReasoningProviderOptions"> => {
    if (!reasoningCapable) return { adaptiveReasoning: "provider-default" };
    if (sdkPackage === "@ai-sdk/google" && /^gemini-2\.5(?:-|$)/i.test(model)) {
        return {
            adaptiveReasoning: "provider-default",
            adaptiveReasoningProviderOptions: {
                google: { thinkingConfig: { thinkingBudget: -1 } },
            },
        };
    }
    if (sdkPackage === "@ai-sdk/anthropic" && anthropicSupportsAdaptiveThinking(model)) {
        return {
            adaptiveReasoning: "provider-default",
            adaptiveReasoningProviderOptions: {
                anthropic: { thinking: { type: "adaptive", display: "summarized" } },
            },
        };
    }
    if (sdkPackage === "@ai-sdk/amazon-bedrock" && anthropicSupportsAdaptiveThinking(model)) {
        return {
            adaptiveReasoning: "provider-default",
            adaptiveReasoningProviderOptions: {
                bedrock: { reasoningConfig: { type: "adaptive" } },
            },
        };
    }
    if (sdkPackage === "@ai-sdk/mistral" && !mistralSupportsEffort(model)) {
        return { adaptiveReasoning: "provider-default" };
    }
    if (sdkPackage === "@ai-sdk/xai" && xaiReasoningIsModelFixed(model)) {
        return { adaptiveReasoning: "provider-default" };
    }
    return { adaptiveReasoning: "high" };
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
    reasoningResponseProviderOptions,
    additiveReasoningProvider,
    sdkPackage,
    grammarStyle,
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
    // {§provider-grammar-transport} — plugin-declared constrained-decoding
    // capability; "none" keeps the grammar off the wire.
    grammarStyle?: GrammarStyle;
    cacheAffinity?: CacheAffinity;
    systemCacheProviderOptions?: AiSdkProviderOptions;
    reasoningResponseProviderOptions?: AiSdkProviderOptions;
    additiveReasoningProvider?: "anthropic" | "bedrock";
    sdkPackage?: string;
}): Provider => {
    emitWarningOnce(
        `${name} provider: request-level prompt counting is a chars/2 estimate; capacity is deferred to the provider`,
        "PLURNK_PROMPT_COUNT_ESTIMATE",
    );

    const maxInputTokens = info?.maxInputTokens ?? null;
    const maxOutputTokens = info?.maxOutputTokens === undefined
        ? null
        : Math.min(info.maxOutputTokens, contextWindow);
    const envelope = generationEnvelopeFromEnv(
        env,
        name,
        contextWindow,
        maxOutputTokens,
    );
    const reasoning = reasoningFromEnv(env, name, envelope.reasoningBudget);
    const reasoningStyle = reasoningStyleFromEnv(env, name) ?? "none";
    const reasoningCapable = info?.reasoning === true;
    const adaptiveReasoning = adaptiveReasoningProjection({
        sdkPackage,
        model,
        reasoningCapable,
    });

    const catalogCost = info?.cost;
    const rates = catalogCost === undefined ? null : {
        input: catalogCost.inputPer1M,
        output: catalogCost.outputPer1M,
        ...(catalogCost.reasoningPer1M === undefined
            ? {}
            : { reasoning: catalogCost.reasoningPer1M }),
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
        maxInputTokens,
        maxOutputTokens,
        outputBudget: envelope.outputBudget,
        reasoningBudget: reasoning.budget,
        supportedReasoningPolicies: supportedReasoningPolicies({
            info,
            native: languageModel !== undefined,
            style: reasoningStyle,
            sdkPackage,
            model,
        }),
        ...adaptiveReasoning,
        ...(additiveReasoningProvider === undefined || !reasoningCapable
            ? {}
            : { additiveReasoningProvider }),
        fetchTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", name),
        operationTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "PLURNK_PROVIDERS_OPERATION_TIMEOUT", name),
        firstContentTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT, "PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT", name),
        streamIdleTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT, "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT", name),
        reasoning,
        reasoningResponseStyle: reasoningResponseStyleFromEnv(env, name),
        temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", name, 0),
        repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", name, 0),
        frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", name, 0),
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", name),
        reasoningStyle,
        ...(affinityEnabled && cacheAffinity !== undefined ? { cacheAffinity } : {}),
        ...(cacheWritePolicy === "stable-system" && systemCacheProviderOptions !== undefined
            ? { systemCacheProviderOptions }
            : {}),
        ...(reasoningResponseProviderOptions === undefined
            ? {}
            : { reasoningResponseProviderOptions }),
        serviceTier: env.PLURNK_PROVIDERS_SERVICE_TIER,
        estimateCost,
        source: providerSource(name),
        ...(grammarStyle === undefined ? {} : { grammarStyle }),
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
    const sdk = createSdkModel(name, wireModel, env, baseUrlOverride, reasoningFromEnv(env, name).mode);
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
        reasoningResponseProviderOptions: sdk.reasoningResponseProviderOptions,
        additiveReasoningProvider: sdk.additiveReasoningProvider,
        sdkPackage: sdk.catalog?.npm,
        contextWindow,
        info,
    });
};
