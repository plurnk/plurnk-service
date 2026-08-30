import {
    lookupProvider,
    resolveModel,
    type ModelInfo,
    type ModelReasoningEffort,
} from "@plurnk/plurnk-models";
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
import AiSdkProvider, {
    type AiSdkProviderConfig,
    type CompatibleReasoningEffort,
    type GrammarStyle,
    type NativeReasoningEffort,
    type ReasoningStyle,
} from "./AiSdkProvider.ts";
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
        "effort_explicit", "effort_required", "thinking_effort", "template", "anthropic",
    ];
    if (!styles.includes(value as ReasoningStyle)) {
        throw new Error(`${name} provider: PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_STYLE has invalid value "${value}"`);
    }
    return value as ReasoningStyle;
};

// {§provider-reasoning-policy} — the operator's affirmative declaration of efforts a provider's
// reasoning routes accept beyond Models.dev; the daemon adds none on its own (#439).
const DECLARABLE_EFFORTS: ReadonlySet<ModelReasoningEffort> = new Set([
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const declaredEffortsFromEnv = (
    env: NodeJS.ProcessEnv,
    name: string,
): readonly ModelReasoningEffort[] => {
    const prefix = name.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const key = `PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_EFFORTS`;
    const value = env[key];
    if (value === undefined || value.trim().length === 0) return [];
    const efforts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    const invalid = efforts.find((effort) => !DECLARABLE_EFFORTS.has(effort as ModelReasoningEffort));
    if (invalid !== undefined) {
        throw new Error(`${name} provider: ${key} has invalid value "${invalid}"; declarable efforts: ${[...DECLARABLE_EFFORTS].join(", ")}`);
    }
    return [...new Set(efforts as ModelReasoningEffort[])];
};
const activationPolicies = Object.freeze(["off", "adaptive"] as const);
const deepSeekPolicies = Object.freeze(["off", "adaptive", "high"] as const);
const reasoningWithoutOff = Object.freeze(["adaptive", "low", "medium", "high"] as const);

const reasoningEffortOrder = Object.freeze([
    "minimal", "low", "medium", "high", "xhigh", "max",
] as const);
const nativeReasoningEfforts = new Set<NativeReasoningEffort>([
    "minimal", "low", "medium", "high", "xhigh",
]);
const compatibleReasoningEfforts = new Set<CompatibleReasoningEffort>(reasoningEffortOrder);
const compatibleEffortStyles = new Set<ReasoningStyle>([
    "effort", "effort_explicit", "effort_required", "thinking_effort",
]);
const compatibleToggleStyles = new Set<ReasoningStyle>([
    "think", "include_reasoning", "effort_explicit", "thinking_effort", "template", "anthropic",
]);

const catalogEfforts = (
    info: ModelInfo,
    declared: readonly ModelReasoningEffort[] = [],
): readonly ModelReasoningEffort[] => [
    ...new Set([
        ...(info.reasoningOptions
            ?.filter((option) => option.type === "effort")
            .flatMap((option) => option.values) ?? []),
        ...declared,
    ]),
];

const strongestCatalogEffort = <T extends NativeReasoningEffort | CompatibleReasoningEffort>(
    info: ModelInfo,
    supported: ReadonlySet<T>,
    declared: readonly ModelReasoningEffort[] = [],
): T | undefined => {
    const values = new Set(catalogEfforts(info, declared));
    return reasoningEffortOrder.findLast((effort) => supported.has(effort as T) && values.has(effort)) as T | undefined;
};

const catalogSupportsToggle = (info: ModelInfo): boolean =>
    info.reasoningOptions?.some((option) => option.type === "toggle") === true;

const catalogSupportedReasoningPolicies = ({
    info,
    native,
    style,
    declared,
}: {
    info: ModelInfo;
    native: boolean;
    style: ReasoningStyle;
    declared: readonly ModelReasoningEffort[];
}): readonly ReasoningPolicy[] => {
    if (!info.reasoning) return activationPolicies;
    const efforts = new Set(catalogEfforts(info, declared));
    const effortTransport = native || compatibleEffortStyles.has(style);
    const off = native
        ? efforts.has("none") || catalogSupportsToggle(info)
        : (efforts.has("none") && compatibleEffortStyles.has(style))
            || (catalogSupportsToggle(info) && compatibleToggleStyles.has(style));
    return REASONING_POLICIES.filter((policy) => policy === "adaptive"
        || policy === "off" && off
        || (policy === "low" || policy === "medium" || policy === "high")
            && effortTransport
            && efforts.has(policy));
};

const anthropicSupportsAdaptiveThinking = (model: string): boolean =>
    /claude-(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5)/.test(model);

const supportedReasoningPolicies = ({
    info,
    native,
    style,
    declared,
}: {
    info?: ModelInfo;
    native: boolean;
    style: ReasoningStyle;
    declared: readonly ModelReasoningEffort[];
}): readonly ReasoningPolicy[] => {
    if (info !== undefined && info.reasoning !== true) return activationPolicies;
    if (info?.reasoningOptions !== undefined) {
        return catalogSupportedReasoningPolicies({ info, native, style, declared });
    }
    if (native) return activationPolicies;
    if (style === "effort" || style === "effort_explicit") return REASONING_POLICIES;
    if (style === "effort_required") return reasoningWithoutOff;
    if (style === "thinking_effort") return deepSeekPolicies;
    return activationPolicies;
};

const adaptiveReasoningProjection = ({
    sdkPackage,
    model,
    reasoningCapable,
    info,
    declared,
}: {
    sdkPackage?: string;
    model: string;
    reasoningCapable: boolean;
    info?: ModelInfo;
    declared: readonly ModelReasoningEffort[];
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
    if (info?.reasoningOptions !== undefined) {
        return {
            adaptiveReasoning: strongestCatalogEffort(info, nativeReasoningEfforts, declared) ?? "provider-default",
        };
    }
    return { adaptiveReasoning: "provider-default" };
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
    const reasoningCapable = info?.reasoning === true;
    const declaredEfforts = declaredEffortsFromEnv(env, name);
    const declaredReasoningStyle = info?.reasoning === false
        ? "none"
        : reasoningStyleFromEnv(env, name) ?? "none";
    const reasoningStyle = info?.reasoningOptions !== undefined
        && (declaredReasoningStyle === "effort" || declaredReasoningStyle === "effort_required")
        && catalogEfforts(info, declaredEfforts).length === 0
        ? "none"
        : declaredReasoningStyle;
    const adaptiveReasoning = adaptiveReasoningProjection({
        sdkPackage,
        model,
        reasoningCapable,
        info,
        declared: declaredEfforts,
    });
    const compatibleAdaptiveReasoning = languageModel !== undefined || info?.reasoningOptions === undefined
        ? undefined
        : strongestCatalogEffort(info, compatibleReasoningEfforts, declaredEfforts) ?? "provider-default";
    const compatibleOffReasoning = languageModel !== undefined
        || info === undefined
        || !catalogEfforts(info, declaredEfforts).includes("none")
        ? undefined
        : "none" as const;

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
            declared: declaredEfforts,
        }),
        ...adaptiveReasoning,
        ...(compatibleAdaptiveReasoning === undefined ? {} : { compatibleAdaptiveReasoning }),
        ...(compatibleOffReasoning === undefined ? {} : { compatibleOffReasoning }),
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
