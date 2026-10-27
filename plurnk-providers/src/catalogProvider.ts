import {
    catalogSnapshot,
    lookupProvider,
    resolveModel,
    type ModelInfo,
    type ModelEffort,
    type ProviderInfo,
} from "@plurnk/plurnk-models";
import {
    costOverrideFromEnv,
    contextWindowFromEnv,
    declaredReasoningEfforts,
    effectiveContextWindow,
    dataCaptureFromEnv,
    generationEnvelopeFromEnv,
    parseOptionalFloat,
    samplingFromEnv,
    parseRequiredInt,
    parseTimeoutMs,
    cacheAffinityFromEnv,
    cacheWritePolicyFromEnv,
    effortFromEnv,
    reasoningResponseStyleFromEnv,
    inferenceAdmissionFromEnv,
} from "./env.ts";
import AiSdkProvider, {
    type AiSdkProviderConfig,
    type GrammarStyle,
    type NativeEffort,
    type AiSdkProviderOptions,
    type CacheAffinity,
    type NativeRequestControls,
} from "./AiSdkProvider.ts";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";
import { providerSource } from "./notices.ts";
import type { InputModality, Provider, ProviderCostNormalizer } from "./types.ts";
import { INPUT_MODALITIES } from "./types.ts";
import { EFFORTS, type Effort } from "@plurnk/plurnk-contracts";
import { estimateProviderCost } from "./cost.ts";
import { emitWarningOnce } from "./warnings.ts";
import { adaptiveEffortFromEnv } from "./reasoning-effort.ts";
import { withProviderDefaults } from "./defaults.ts";
import type { LanguageModelSource } from "./aiSdkTransport.ts";
import type { ExtensionAttribution, ExtensionAttributionContext } from "@plurnk/plurnk-meta";

// {§provider-interface} — the catalog's input modalities, kept to the vocabulary the wire
// can carry; an unknown model declares none.
export const inputModalitiesOf = (input: readonly string[] | undefined): ReadonlySet<InputModality> =>
    new Set((input ?? []).filter((modality): modality is InputModality => (INPUT_MODALITIES as readonly string[]).includes(modality)));

const activationPolicies = Object.freeze(["off", "adaptive"] as const);

const nativeEfforts: ReadonlySet<string> = new Set<NativeEffort>([
    "minimal", "low", "medium", "high", "xhigh",
]);

const catalogWireEfforts = (
    info: ModelInfo,
    declared: readonly Exclude<ModelEffort, null>[] = [],
): readonly Exclude<ModelEffort, null>[] => [
    ...new Set([
        ...(info.reasoningOptions
            ?.filter((option) => option.type === "effort")
            .flatMap((option) => option.values.flatMap((value) => value === null ? [] : [value])) ?? []),
        ...declared,
    ]),
];

const catalogSupportsToggle = (info: ModelInfo): boolean =>
    info.reasoningOptions?.some((option) => option.type === "toggle") === true;

const assertCatalogReasoningBudget = (
    name: string,
    info: ModelInfo | undefined,
    budget: number,
): void => {
    for (const option of info?.reasoningOptions ?? []) {
        if (option.type !== "budget_tokens") continue;
        if (option.min !== undefined && budget < option.min) {
            throw new TypeError(`${name} provider: reasoning budget ${budget} is below catalog minimum ${option.min}`);
        }
        if (option.max !== undefined && budget > option.max) {
            throw new TypeError(`${name} provider: reasoning budget ${budget} exceeds catalog maximum ${option.max}`);
        }
    }
};

const usesProviderReasoningProjection = (name: string, native: boolean): boolean =>
    !native || name === "openrouter" || name === "deepinfra" || name === "togetherai";

const supportsReasoningOff = (
    name: string,
    info: ModelInfo | undefined,
    wireEfforts: ReadonlySet<string>,
    declaredEfforts: readonly ModelEffort[],
): boolean => {
    if (info?.reasoning === false) return true;
    if (name === "cloudflare-workers-ai") {
        return info === undefined || wireEfforts.has("none");
    }
    if (
        name === "openrouter"
        || name === "deepinfra"
        || name === "togetherai"
        || name === "deepseek"
        || name === "alibaba"
        || name === "fireworks-ai"
    ) {
        return info === undefined || wireEfforts.has("none") || catalogSupportsToggle(info);
    }
    return info === undefined && declaredEfforts.length === 0
        || wireEfforts.has("none")
        || info !== undefined && catalogSupportsToggle(info);
};

const supportsFixedEfforts = (
    name: string,
    native: boolean,
    declaredEfforts: readonly ModelEffort[],
): boolean =>
    native
    || name === "deepseek"
    || name === "alibaba"
    || name === "fireworks-ai"
    || name === "cloudflare-workers-ai"
    || declaredEfforts.length > 0;

const reasoningCapabilities = (
    name: string,
    env: NodeJS.ProcessEnv,
    info: ModelInfo | undefined,
    native: boolean,
): {
    readonly declaredEfforts: readonly Exclude<ModelEffort, null>[];
    readonly efforts: readonly [Effort, ...Effort[]];
    readonly outputTokenField?: "max_tokens" | "max_completion_tokens";
    readonly reasoningRequestBody?: (mode: Effort, reasoningBudget: number | null) => Record<string, unknown>;
    readonly reasoningRequestProviderOptions?: (mode: Effort, reasoningBudget: number | null) => AiSdkProviderOptions | undefined;
} => {
    const declaredEfforts = declaredReasoningEfforts(name, env);
    const wireEfforts = info === undefined ? [...declaredEfforts] : catalogWireEfforts(info, declaredEfforts);
    const wireEffortSet = new Set<string>(wireEfforts);
    const needsAdaptiveWireEffort = info?.reasoning !== false && (
        name === "openrouter"
        || name === "deepinfra"
        || name === "togetherai"
        || name === "deepseek"
        || name === "alibaba"
        || name === "cloudflare-workers-ai" && (info !== undefined || declaredEfforts.length > 0)
        || !native && declaredEfforts.length > 0
    );
    const adaptiveWireEffort = needsAdaptiveWireEffort ? adaptiveEffortFromEnv(env, wireEfforts) : undefined;
    const customProjection = usesProviderReasoningProjection(name, native);
    const allowFixed = supportsFixedEfforts(name, native, declaredEfforts);
    const allowOff = supportsReasoningOff(name, info, wireEffortSet, declaredEfforts);

    const supported = info?.reasoning === false || info === undefined && declaredEfforts.length === 0
        ? activationPolicies
        : EFFORTS.filter((policy) => policy === "adaptive"
            || policy === "off" && allowOff
            || allowFixed
                && (policy === "low" || policy === "medium" || policy === "high" || policy === "xhigh"
                    || policy === "max" && customProjection)
                && wireEffortSet.has(policy));
    const [first, ...rest] = supported;
    if (first === undefined) throw new TypeError(`${name} provider: no portable effort is representable`);
    const efforts = [first, ...rest] satisfies [Effort, ...Effort[]];

    if (native) {
        if (name === "openrouter" && info?.reasoning !== false) {
            return {
                declaredEfforts,
                efforts,
                reasoningRequestProviderOptions: (mode, budget) => {
                    if (mode === "off") return { openrouter: { reasoning: { effort: "none" } } };
                    if (budget !== null) {
                        if (mode !== "adaptive") {
                            throw new TypeError(`${name} provider: reasoning effort and budget are exclusive; choose one control`);
                        }
                        assertCatalogReasoningBudget(name, info, budget);
                        return { openrouter: { reasoning: { enabled: true, max_tokens: budget } } };
                    }
                    if (mode !== "adaptive") {
                        return { openrouter: { reasoning: { enabled: true, effort: mode } } };
                    }
                    return {
                        openrouter: {
                            reasoning: adaptiveWireEffort === undefined
                                ? { enabled: true }
                                : { enabled: true, effort: adaptiveWireEffort },
                        },
                    };
                },
            };
        }
        if ((name === "deepinfra" || name === "togetherai") && info?.reasoning !== false) {
            return {
                declaredEfforts,
                efforts,
                reasoningRequestProviderOptions: (mode, budget) => {
                    if (budget !== null) {
                        throw new TypeError(`${name} provider: reasoning budget is unsupported on this route`);
                    }
                    if (mode === "off") return { [name]: { reasoningEffort: "none" } };
                    if (mode !== "adaptive") return { [name]: { reasoningEffort: mode } };
                    return adaptiveWireEffort === undefined ? undefined : { [name]: { reasoningEffort: adaptiveWireEffort } };
                },
            };
        }
        return { declaredEfforts, efforts };
    }

    return {
        declaredEfforts,
        efforts,
        ...(name === "alibaba" ? { outputTokenField: "max_completion_tokens" as const } : {}),
        reasoningRequestBody: (mode, budget) => {
            if (info?.reasoning === false) {
                if (budget !== null) throw new TypeError(`${name} model does not support reasoning`);
                return {};
            }
            switch (name) {
                case "deepseek":
                    if (budget !== null) throw new TypeError(`${name} provider: reasoning budget is unsupported on this route`);
                    if (mode === "off") return { thinking: { type: "disabled" } };
                    if (mode !== "adaptive") return { thinking: { type: "enabled" }, reasoning_effort: mode };
                    return {
                        thinking: { type: "enabled" },
                        ...(adaptiveWireEffort === undefined ? {} : { reasoning_effort: adaptiveWireEffort }),
                    };
                case "alibaba":
                    if (mode === "off") return { enable_thinking: false };
                    if (budget !== null) {
                        if (mode !== "adaptive") {
                            throw new TypeError(`${name} provider: reasoning effort and budget are exclusive; choose one control`);
                        }
                        assertCatalogReasoningBudget(name, info, budget);
                        return { enable_thinking: true, thinking_budget: budget };
                    }
                    if (mode !== "adaptive") return { enable_thinking: true, reasoning_effort: mode };
                    return {
                        enable_thinking: true,
                        ...(adaptiveWireEffort === undefined ? {} : { reasoning_effort: adaptiveWireEffort }),
                    };
                case "fireworks-ai":
                    if (budget !== null) throw new TypeError(`${name} provider: reasoning budget is unsupported on this route`);
                    if (mode === "off") return { reasoning_effort: "none" };
                    if (mode !== "adaptive") return { reasoning_effort: mode };
                    if (adaptiveWireEffort !== undefined) return { reasoning_effort: adaptiveWireEffort };
                    if (info !== undefined && catalogSupportsToggle(info)) return { reasoning_effort: true };
                    return {};
                case "cloudflare-workers-ai":
                    if (budget !== null) throw new TypeError(`${name} provider: reasoning budget is unsupported on this route`);
                    if (info === undefined && declaredEfforts.length === 0) return {};
                    if (mode === "off") return { reasoning_effort: "none" };
                    if (mode !== "adaptive") return { reasoning_effort: mode };
                    return adaptiveWireEffort === undefined ? {} : { reasoning_effort: adaptiveWireEffort };
                default:
                    if (budget !== null) throw new TypeError(`${name} provider: reasoning budget is unsupported on this route`);
                    if (mode === "off") return wireEffortSet.has("none") ? { reasoning_effort: "none" } : {};
                    if (mode !== "adaptive") return { reasoning_effort: mode };
                    return declaredEfforts.length > 0 && adaptiveWireEffort !== undefined
                        ? { reasoning_effort: adaptiveWireEffort }
                        : {};
            }
        },
    };
};

// {§provider-effort} Read-only discovery and construction share admission;
// the compatible SDK package is the only catalog transport without a native model.
export const catalogEfforts = (
    provider: ProviderInfo,
    info: ModelInfo,
    env: NodeJS.ProcessEnv,
): readonly [Effort, ...Effort[]] => reasoningCapabilities(
    provider.id, withProviderDefaults(env), info, provider.npm !== "@ai-sdk/openai-compatible",
).efforts;

const adaptiveEffortProjection = ({
    name,
    env,
    model,
    reasoningCapable,
    info,
    declared,
}: {
    name: string;
    env: NodeJS.ProcessEnv;
    model: string;
    reasoningCapable: boolean;
    info?: ModelInfo;
    declared: readonly Exclude<ModelEffort, null>[];
}): Pick<AiSdkProviderConfig, "adaptiveEffort" | "adaptiveEffortProviderOptions"> => {
    if (!reasoningCapable) return { adaptiveEffort: "provider-default" };
    if (name === "anthropic" && model.includes("claude-")) {
        return {
            adaptiveEffort: "provider-default",
            adaptiveEffortProviderOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" } } },
        };
    }
    if (name === "amazon-bedrock" && model.includes("claude-")) {
        return {
            adaptiveEffort: "provider-default",
            adaptiveEffortProviderOptions: { bedrock: { reasoningConfig: { type: "adaptive" } } },
        };
    }
    if (info !== undefined) {
        return {
            adaptiveEffort: adaptiveEffortFromEnv(env, catalogWireEfforts(info, declared)
                .filter((effort): effort is NativeEffort => effort !== null && nativeEfforts.has(effort))) ?? "provider-default",
        };
    }
    return { adaptiveEffort: "provider-default" };
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
    requestControls,
    grammarStyle,
    endpoint,
}: {
    name: string;
    env: NodeJS.ProcessEnv;
    model: string;
    languageModel?: LanguageModelSource;
    normalizeCost?: ProviderCostNormalizer;
    url?: string;
    headers?: Readonly<Record<string, string>>;
    contextWindow: number;
    info?: ModelInfo;
    attributions?: (context: ExtensionAttributionContext) => ExtensionAttribution;
    // {§provider-request-authority} — extension-declared constrained-decoding
    // capability; "none" keeps the grammar off the wire.
    grammarStyle?: GrammarStyle;
    cacheAffinity?: CacheAffinity;
    systemCacheProviderOptions?: AiSdkProviderOptions;
    reasoningResponseProviderOptions?: AiSdkProviderOptions;
    additiveReasoningProvider?: "anthropic" | "bedrock";
    requestControls?: NativeRequestControls;
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
    const effort = effortFromEnv(env, name, envelope.reasoningBudget);
    const reasoningCapable = info?.reasoning === true;
    const {
        declaredEfforts,
        efforts,
        outputTokenField,
        reasoningRequestBody,
        reasoningRequestProviderOptions,
    } = reasoningCapabilities(
        name, env, info, languageModel !== undefined,
    );
    const adaptiveEffort = adaptiveEffortProjection({
        name,
        env,
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
    // {§provider-monetary-evidence} (#461): the catalog is the starting point; a declared
    // override merges over it, and the estimate's source names the overlay.
    const costOverride = costOverrideFromEnv(env, name);
    let rates = catalogRates;
    if (costOverride !== null) {
        const merged = { ...catalogRates, ...costOverride };
        if (merged.input === undefined || merged.output === undefined) {
            throw new Error(
                `${name} provider: PLURNK_PROVIDERS_COST without catalog rates must declare input and output`,
            );
        }
        rates = { ...merged, input: merged.input, output: merged.output };
    }
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
        // {§provider-interface} — the catalog's input modalities decide which native parts ride.
        inputModalities: inputModalitiesOf(info?.modalities.input),
        maxInputTokens,
        maxOutputTokens,
        outputBudget: envelope.outputBudget,
        outputFloor: envelope.outputFloor,
        reasoningBudget: effort.budget,
        supportedEfforts: efforts,
        ...adaptiveEffort,
        ...(additiveReasoningProvider === undefined || !reasoningCapable
            ? {}
            : { additiveReasoningProvider }),
        fetchTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", name),
        operationTimeoutMs: parseTimeoutMs(env.PLURNK_PROVIDERS_OPERATION_TIMEOUT, "PLURNK_PROVIDERS_OPERATION_TIMEOUT", name),
        effort,
        reasoningResponseStyle: reasoningResponseStyleFromEnv(env, name),
        ...samplingFromEnv(env, name),
        repeatPenalty: parseOptionalFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", name, 0),
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        errorDetailLimit: parseRequiredInt(env.PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT, "PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT", name),
        ...(outputTokenField === undefined ? {} : { outputTokenField }),
        ...(reasoningRequestBody === undefined ? {} : { reasoningRequestBody }),
        ...(reasoningRequestProviderOptions === undefined ? {} : { reasoningRequestProviderOptions }),
        ...(affinityEnabled && cacheAffinity !== undefined ? { cacheAffinity } : {}),
        ...(cacheWritePolicy === "stable-system" && systemCacheProviderOptions !== undefined
            ? { systemCacheProviderOptions }
            : {}),
        ...(reasoningResponseProviderOptions === undefined
            ? {}
            : { reasoningResponseProviderOptions }),
        serviceTier: env.PLURNK_PROVIDERS_SERVICE_TIER,
        ...(requestControls === undefined ? {} : { requestControls }),
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
        ...(sdk.requestControls === undefined ? {} : { requestControls: sdk.requestControls }),
        sdkPackage: sdk.catalog?.npm,
        contextWindow,
        info,
    });
};
