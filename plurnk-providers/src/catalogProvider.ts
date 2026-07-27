import { lookupProvider, resolveModel, type ModelInfo } from "@plurnk/plurnk-models";
import {
    contextWindowFromEnv,
    effectiveContextWindow,
    dataCaptureFromEnv,
    envelopeFromEnv,
    parseRequiredFloat,
    parseRequiredInt,
    promptCacheKeyFromEnv,
    reasoningFromEnv,
    resolveReserve,
    tokenRatesFromEnv,
    type ReserveSpec,
} from "./env.ts";
import AiSdkProvider, { type ReasoningStyle } from "./AiSdkProvider.ts";
import { configuredProviderInfo, createSdkModel } from "./sdkModels.ts";
import { providerSource } from "./telemetry.ts";
import type { Provider, ProviderUsage } from "./types.ts";
import { calculateCostUsd } from "./usage.ts";
import { emitWarningOnce } from "./warnings.ts";
import type { LanguageModel } from "ai";

const reasoningStyleFromEnv = (
    env: NodeJS.ProcessEnv,
    name: string,
): ReasoningStyle | undefined => {
    const prefix = name.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const value = env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_STYLE`];
    if (value === undefined || value.length === 0) return undefined;
    const styles: readonly ReasoningStyle[] = [
        "none", "think", "include_reasoning", "effort",
        "effort_explicit", "template", "anthropic",
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
    url,
    headers,
    contextWindow,
    info,
}: {
    name: string;
    env: NodeJS.ProcessEnv;
    model: string;
    languageModel?: LanguageModel;
    url?: string;
    headers?: Readonly<Record<string, string>>;
    contextWindow: number;
    info?: ModelInfo;
}): Provider => {
    emitWarningOnce(
        `${name} provider: countTokens is a chars/2 upper bound — exact counts come from the mimetypes tokenizer seam or tokenize()`,
        "PLURNK_TOKENIZER_HEURISTIC",
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

    const configuredRates = tokenRatesFromEnv(env, name);
    const catalogCost = info?.cost;
    const rates = configuredRates ?? (catalogCost === undefined ? null : {
        input: catalogCost.inputPer1M,
        output: catalogCost.outputPer1M,
        cached: catalogCost.cacheReadPer1M ?? catalogCost.inputPer1M,
    });
    const calculateCost = rates === null
        ? undefined
        : (usage: ProviderUsage): number => calculateCostUsd(usage, rates);

    return new AiSdkProvider({
        model,
        ...(languageModel === undefined ? {} : { languageModel }),
        ...(url === undefined ? {} : { url }),
        ...(headers === undefined ? {} : { headers: { ...headers } }),
        contextWindow,
        fetchTimeoutMs: parseRequiredInt(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", name),
        streamIdleTimeoutMs: parseRequiredInt(env.PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT, "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT", name),
        reasoning,
        temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", name, 0),
        repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", name, 0),
        frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", name, 0),
        reasoningReserve,
        completionReserve,
        retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", name),
        reasoningStyle: reasoningStyleFromEnv(env, name),
        promptCacheKey: url === undefined ? false : promptCacheKeyFromEnv(env, name),
        serviceTier: env.PLURNK_PROVIDERS_SERVICE_TIER,
        calculateCost,
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

    emitWarningOnce(
        `${name} provider: countTokens is a chars/2 upper bound — exact counts come from the mimetypes tokenizer seam or tokenize()`,
        "PLURNK_TOKENIZER_HEURISTIC",
    );

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
        url: sdk.compatible?.url,
        headers: sdk.compatible?.headers,
        contextWindow,
        info,
    });
};
