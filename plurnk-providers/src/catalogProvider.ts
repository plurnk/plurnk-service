import {
    catalogSnapshot,
    lookupProvider,
    resolveModel,
    type ModelInfo,
    type ModelReasoningEffort,
    type ProviderInfo,
} from "@plurnk/plurnk-models";
import {
    costOverrideFromEnv,
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    generationEnvelopeFromEnv,
    parseOptionalFloat,
    samplingFromEnv,
    parseRequiredInt,
    parseTimeoutMs,
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    reasoningFromEnv,
    reasoningResponseStyleFromEnv,
    inferenceAdmissionFromEnv,
} from "./env.ts";
import AiSdkProvider, {
    type AiSdkProviderConfig,
    type GrammarStyle,
    type NativeReasoningEffort,
} from "./AiSdkProvider.ts";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";
import { providerSource } from "./notices.ts";
import type { InputModality, Provider, ProviderCostNormalizer } from "./types.ts";
import { INPUT_MODALITIES } from "./types.ts";
import { REASONING_POLICIES, type ReasoningPolicy } from "@plurnk/plurnk-contracts";
import { estimateProviderCost } from "./cost.ts";
import { emitWarningOnce } from "./warnings.ts";
import RequestFields from "./RequestFields.ts";
import { adaptiveEffortFromEnv } from "./reasoning-effort.ts";
import { withProviderDefaults } from "./defaults.ts";
import type { LanguageModel } from "ai";
import type { AiSdkProviderOptions, CacheAffinity } from "./AiSdkProvider.ts";
import type { PluginAttribution, PluginAttributionContext } from "@plurnk/plurnk-meta";

// {§provider-input-modalities} — the catalog's input modalities, kept to the vocabulary the wire
// can carry; an unknown model declares none.
export const inputModalitiesOf = (input: readonly string[] | undefined): ReadonlySet<InputModality> =>
    new Set((input ?? []).filter((modality): modality is InputModality => (INPUT_MODALITIES as readonly string[]).includes(modality)));

const activationPolicies = Object.freeze(["off", "adaptive"] as const);

const nativeReasoningEfforts = new Set<NativeReasoningEffort>([
    "minimal", "low", "medium", "high", "xhigh",
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

const catalogSupportsToggle = (info: ModelInfo): boolean =>
    info.reasoningOptions?.some((option) => option.type === "toggle") === true;

const catalogSupportedReasoningPolicies = ({
    info,
    declared,
}: {
    info: ModelInfo;
    declared: readonly ModelReasoningEffort[];
}): readonly ReasoningPolicy[] => {
    if (!info.reasoning) return activationPolicies;
    const efforts = new Set(catalogEfforts(info, declared));
    const off = efforts.has("none") || catalogSupportsToggle(info);
    return REASONING_POLICIES.filter((policy) => policy === "adaptive"
        || policy === "off" && off
        || (policy === "low" || policy === "medium" || policy === "high"
                || policy === "xhigh" || policy === "max")
            && efforts.has(policy));
};

const anthropicSupportsAdaptiveThinking = (model: string): boolean =>
    /claude-(?:opus-(?:4-[678]|5)|sonnet-(?:4-6|5)|fable-5)/.test(model);

const reasoningCapabilities = (
    name: string,
    env: NodeJS.ProcessEnv,
    info: ModelInfo | undefined,
    native: boolean,
) => {
    const declaredEfforts = RequestFields.declaredEfforts(name, env);
    if (!native || RequestFields.namespace(name, env) !== undefined) {
        const requestFields = new RequestFields(name, env, info);
        return { declaredEfforts, policies: requestFields.policies, requestFields };
    }
    RequestFields.assertNative(name, env);
    const supported = info === undefined ? activationPolicies : catalogSupportedReasoningPolicies({ info, declared: declaredEfforts });
    const [first, ...rest] = supported.filter((policy) => policy !== "max");
    if (first === undefined) throw new TypeError(`${name} provider: no portable reasoning policy is representable`);
    return {
        declaredEfforts,
        policies: [first, ...rest] satisfies [ReasoningPolicy, ...ReasoningPolicy[]],
    };
};

// {§provider-reasoning-policy} Read-only discovery and construction share admission;
// the compatible SDK package is the only catalog transport without a native model.
export const catalogReasoningPolicies = (
    provider: ProviderInfo,
    info: ModelInfo,
    env: NodeJS.ProcessEnv,
): readonly [ReasoningPolicy, ...ReasoningPolicy[]] => reasoningCapabilities(
    provider.id, withProviderDefaults(env), info, provider.npm !== "@ai-sdk/openai-compatible",
).policies;

const adaptiveReasoningProjection = ({
    env,
    sdkPackage,
    model,
    reasoningCapable,
    info,
    declared,
}: {
    env: NodeJS.ProcessEnv;
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
    if (info !== undefined) {
        return {
            adaptiveReasoning: adaptiveEffortFromEnv(env, catalogEfforts(info, declared)
                .filter((effort): effort is NativeReasoningEffort => nativeReasoningEfforts.has(effort as NativeReasoningEffort))) ?? "provider-default",
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
    endpoint,
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
    endpoint?: string;
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
    const { declaredEfforts, policies, requestFields } = reasoningCapabilities(
        name, env, info, languageModel !== undefined,
    );
    const adaptiveReasoning = adaptiveReasoningProjection({
        env,
        sdkPackage,
        model,
        reasoningCapable,
        info,
        declared: declaredEfforts,
    });

    const catalogCost = info?.cost;
    const catalogRates = catalogCost === undefined ? null : {
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
    // {§operator-cost-override} (#461): the catalog is the starting point; a declared
    // override merges over it, and the estimate's source names the overlay.
    const costOverride = costOverrideFromEnv(env, name);
    if (costOverride !== null && catalogRates === null
        && (costOverride.input === undefined || costOverride.output === undefined)) {
        throw new Error(
            `${name} provider: PLURNK_PROVIDERS_COST without catalog rates must declare input and output`,
        );
    }
    const rates = costOverride === null
        ? catalogRates
        : { ...(catalogRates ?? {}), ...costOverride } as NonNullable<typeof catalogRates>;
    const rateSource = costOverride === null
        ? "Models.dev catalog rates"
        : "operator PLURNK_PROVIDERS_COST override over Models.dev catalog rates";
    const estimateCost = (usage: Parameters<typeof estimateProviderCost>[0]) =>
        estimateProviderCost(usage, rates, rateSource);
    const affinityEnabled = cacheAffinityFromEnv(env, name);
    const cacheWritePolicy = cacheWritePolicyFromEnv(env, name);

    return new AiSdkProvider({
        inferenceAdmission: inferenceAdmissionFromEnv(env, endpoint ?? url?.replace(/\/chat\/completions$/, "") ?? `sdk:${name}`),
        model,
        ...(attributions === undefined ? {} : { attributions }),
        ...(languageModel === undefined ? {} : { languageModel }),
        ...(normalizeCost === undefined ? {} : { normalizeCost }),
        ...(url === undefined ? {} : { url }),
        ...(headers === undefined ? {} : { headers: { ...headers } }),
        contextWindow,
        // {§provider-input-modalities} — the catalog's input modalities decide which native parts ride.
        inputModalities: inputModalitiesOf(info?.modalities.input),
        maxInputTokens,
        maxOutputTokens,
        outputBudget: envelope.outputBudget,
        reasoningBudget: reasoning.budget,
        supportedReasoningPolicies: policies,
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
        ...samplingFromEnv(env, name),
        repeatPenalty: parseOptionalFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", name, 0),
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", name),
        ...(requestFields === undefined ? {} : { requestFields }),
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
        ...dataCaptureFromEnv(env, name),
    });
};

// A model the snapshot does not resolve is named as such, with the ids it may have meant: those that share its
// final path segment ambiguously, or whose final segment begins with it.
const uncatalogedModel = (name: string, model: string): string => {
    const ids = Object.keys(catalogSnapshot()[name] ?? {});
    const ambiguous = ids.filter((id) => id.endsWith(`/${model}`));
    const near = ambiguous.length > 0 ? ambiguous : ids.filter((id) => (id.split("/").at(-1) ?? id).startsWith(model));
    const reason = ambiguous.length > 1 ? `matches ${ambiguous.length} Models.dev ids by path suffix` : "is not a Models.dev id or a unique path suffix of one";
    const hint = near.length === 0 ? "" : `; candidates: ${near.slice(0, 3).join(", ")}`;
    return `${name} provider: model "${model}" ${reason}${hint} — correct the model id, or set PLURNK_PROVIDERS_CONTEXT_WINDOW to route an uncataloged model`;
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
    if (resolved === null && contextOverride === null) throw new Error(uncatalogedModel(name, model));
    const wireModel = resolved?.id ?? model;
    const info = resolved?.info;
    const contextWindow = effectiveContextWindow(contextOverride, info?.contextWindow ?? null);
    if (contextWindow === null) {
        throw new Error(
            `${name} provider: context window unresolved for "${wireModel}" — set PLURNK_PROVIDERS_CONTEXT_WINDOW or update the Models.dev snapshot`,
        );
    }
    const sdk = createSdkModel(name, wireModel, env, baseUrlOverride);
    if (sdk === null) return null;

    return providerFromSdkModel({
        name,
        env,
        model: wireModel,
        languageModel: sdk.languageModel,
        normalizeCost: sdk.normalizeCost,
        url: sdk.compatible?.url,
        endpoint: sdk.endpoint,
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
