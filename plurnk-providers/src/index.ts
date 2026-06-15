export type {
    ChatMessage,
    FinishReason,
    Provider,
    ProviderAlias,
    ProviderAssistant,
    ProviderFactory,
    ProviderResponse,
    ProviderUsage,
} from "./types.ts";

export {
    parseAliasesFromEnv,
    resolveActiveAlias,
    instantiateProvider,
    loadActiveProvider,
    resetDiscoveryCache,
} from "./ProviderRegistry.ts";

// Scope-agnostic tier-2 discovery (SPEC §5) — exported so a consumer can list
// installed providers (first-party + third-party) without instantiating them.
export { discover } from "./discover.ts";
export type { DiscoverOptions } from "./discover.ts";

// Shared OpenAI-compatible transport machinery — the spine every sibling
// extends and the basis for ./standardProviders.ts.
export { default as OpenAICompatProvider, effortFromBudget } from "./OpenAICompat.ts";
export type { OpenAICompatConfig, ReasoningStyle } from "./OpenAICompat.ts";
export { chatCompletionStream, OpenAiHttpError } from "./openaiStream.ts";
export type { StreamResponse } from "./openaiStream.ts";
export { parseRequiredInt, parseOptionalInt, requireEnv, reasoningBudgetFromEnv, planFromEnv } from "./env.ts";
export { tokenizerFor, tokenizerByPublisher, parseTokenizerFamily } from "./tokenizers.ts";
export type { TokenizerFamily, CountTokens } from "./tokenizers.ts";
export { normalizeUsage, computeCost } from "./usage.ts";
export type { RawUsage, TokenRates } from "./usage.ts";
export { ProviderError, classifyProviderError, toProviderError, providerSource } from "./telemetry.ts";
export type { TelemetryEvent, ProviderTelemetryKind } from "./telemetry.ts";
export { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

export { default as Mock } from "./Mock.ts";
export type { MockAssistant, MockResponse, MockReturnedAssistant } from "./Mock.ts";
export { mockDefaultUsage } from "./Mock.ts";
