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
    ProviderUsage,
    PromptTokenMeasurement,
    TokenLogprob,
    TokenAlternative,
} from "./types.ts";
export { assertPromptTokenMeasurement } from "./promptTokens.ts";

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
export { default as AiSdkProvider, effortFromBudget } from "./AiSdkProvider.ts";
export type { AiSdkProviderConfig, ReasoningStyle, GrammarStyle } from "./AiSdkProvider.ts";
// {§provider-capacity-pool} Front N interchangeable backends as one Provider -
// worker-sticky for KV-cache reuse, overflow to a healthy sibling; the blend
// DECISION stays the consumer's, by choosing which pool to call.
export { default as Pool } from "./Pool.ts";
export type { ProviderFetch } from "./AiSdkProvider.ts";
export { parseRequiredInt, parseOptionalInt, parseRequiredFloat, parseOptionalFloat, requireEnv, reasoningFromEnv, reasoningResponseStyleFromEnv, scopeEnvToAlias, dataCaptureFromEnv, contextWindowFromEnv, effectiveContextWindow, envelopeFromEnv, resolveReserve, PROVIDERS_KNOBS } from "./env.ts";
export type { Reasoning, ReasoningMode, ReasoningResponseStyle, ReserveSpec } from "./env.ts";
export { normalizeUsage, calculateCostUsd } from "./usage.ts";
export type { RawUsage, TokenRates } from "./usage.ts";
export { ProviderError, classifyProviderError, toProviderError } from "./errors.ts";
export { providerSource } from "./notices.ts";
export type { ProviderErrorKind } from "./errors.ts";
export type { ProviderNotice, ProviderNoticeKind } from "./notices.ts";

export { default as Mock } from "./Mock.ts";
export type { MockAssistant, MockResponse, MockReturnedAssistant } from "./Mock.ts";
export { mockDefaultUsage } from "./Mock.ts";
