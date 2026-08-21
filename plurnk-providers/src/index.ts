export type {
    ChatMessage,
    FinishReason,
    GrammarEvidence,
    Provider,
    ProviderAssistant,
    ProviderAttempt,
    ProviderAttemptFinishReason,
    AiSdkProviderPlugin,
    ProviderOptions,
    ProviderResponse,
    ProviderEncryptedReasoningItem,
    ProviderAccounting,
    ProviderCost,
    ProviderCostNormalizer,
    ProviderCallKind,
    ProviderGenerateArgs,
    ProviderRequestAccounting,
    ProviderRequestCapacity,
    ProviderRequestCapacityDecision,
    ProviderRequestIdentity,
    ProviderRequestObserver,
    ProviderRequestSettlement,
    ProviderUsage,
    PromptTokenMeasurement,
    TokenLogprob,
    TokenAlternative,
} from "./types.ts";
export { assertPromptTokenMeasurement } from "./promptTokens.ts";
export { assessRequestCapacity, effectiveInputCapacity, effectiveOutputBudget, requestCapacityDecision } from "./capacity.ts";

// Alias cascade — re-exported from the zero-dep @plurnk/plurnk-aliases, so
// the "." surface is unchanged for existing importers and there's one source of
// truth for the parser (thin clients depend on that package directly).
export type { ProviderAlias } from "@plurnk/plurnk-aliases";
export { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-aliases";

export {
    instantiateProvider,
    loadActiveProvider,
    resetDiscoveryCache,
} from "./ProviderRegistry.ts";

// Scope-agnostic plugin discovery ({§plugin-family-kind}).
export { discover } from "./discover.ts";
export type { DiscoverOptions, Discovery } from "./discover.ts";

// Stable PLURNK adapter over AI SDK language models and compatible local URLs.
export { default as AiSdkProvider } from "./AiSdkProvider.ts";
export type { AiSdkProviderConfig, ReasoningStyle, GrammarStyle } from "./AiSdkProvider.ts";
// {§provider-capacity-pool} Front N interchangeable backends as one Provider -
// worker-sticky for KV-cache reuse, overflow to a healthy sibling; the blend
// DECISION stays the consumer's, by choosing which pool to call.
export { default as Pool } from "./Pool.ts";
export type { ProviderFetch } from "./AiSdkProvider.ts";
export { parseRequiredInt, parseOptionalInt, parseRequiredFloat, parseOptionalFloat, requireEnv, reasoningFromEnv, reasoningResponseStyleFromEnv, parseReasoningPolicy, scopeEnvToAlias, dataCaptureFromEnv, contextWindowFromEnv, effectiveContextWindow, generationEnvelopeFromEnv, resolveGenerationEnvelopeFromEnv, resolveTokenBudget, PROVIDERS_KNOBS } from "./env.ts";
export type { GenerationEnvelope, Reasoning, ReasoningResponseStyle, TokenBudgetSpec } from "./env.ts";
export { REASONING_POLICIES } from "@plurnk/plurnk-contracts";
export type { ReasoningPolicy } from "@plurnk/plurnk-contracts";
export { UnsupportedReasoningPolicyError } from "./types.ts";
export { normalizeUsage, calculateCostUsdDecimal, validateProviderUsage } from "./usage.ts";
export {
    addDecimals,
    estimateProviderCost,
    providerCostUsd,
    resolveProviderCost,
    sumProviderCostsUsd,
    validateChargedCost,
    validateDecimal,
    validateProviderCost,
} from "./cost.ts";
export {
    aggregateProviderAccounting,
    plurnkCostNormalizer,
    providerCostNormalizer,
    validateProviderRequestAccounting,
} from "./accounting.ts";
export type { RawUsage, TokenRates } from "./usage.ts";
export { ProviderError, classifyProviderError, toProviderError } from "./errors.ts";
export { providerSource } from "./notices.ts";
export type { ProviderErrorKind } from "./errors.ts";
export type { ProviderNotice, ProviderNoticeKind } from "./notices.ts";
export type {
    PluginAttributionContext,
    PluginAttributionDeclaration,
    PluginAttributionSource,
} from "@plurnk/plurnk-meta";

export { default as Mock } from "./Mock.ts";
export type { MockAssistant, MockResponse, MockReturnedAssistant } from "./Mock.ts";
export { mockDefaultUsage } from "./Mock.ts";
