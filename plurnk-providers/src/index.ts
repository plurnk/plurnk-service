export type {
    ChatMessage,
    FinishReason,
    Provider,
    ProviderAssistant,
    ProviderFactory,
    ProviderOptions,
    ProviderResponse,
    ProviderUsage,
    TokenLogprob,
    TokenAlternative,
} from "./types.ts";

// Alias cascade — re-exported from the zero-dep @plurnk/plurnk-aliases (#27), so
// the "." surface is unchanged for existing importers and there's one source of
// truth for the parser (thin clients depend on that package directly).
export type { ProviderAlias } from "@plurnk/plurnk-aliases";
export { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-aliases";

export {
    instantiateProvider,
    loadActiveProvider,
    resetDiscoveryCache,
} from "./ProviderRegistry.ts";

// Scope-agnostic tier-2 discovery (SPEC §5) — exported so a consumer can list
// installed providers (first-party + third-party) without instantiating them.
export { discover } from "./discover.ts";
export type { DiscoverOptions, Discovery } from "./discover.ts";

// Shared OpenAI-compatible transport machinery — the spine every sibling
// extends and the basis for ./standardProviders.ts.
export { default as OpenAICompatProvider, effortFromBudget } from "./OpenAICompat.ts";
export type { OpenAICompatConfig, ReasoningStyle, GrammarStyle } from "./OpenAICompat.ts";
export { chatCompletionStream, chatCompletion, OpenAiHttpError } from "./openaiStream.ts";
export type { StreamResponse, EncryptedReasoning } from "./openaiStream.ts";
export { parseRequiredInt, parseOptionalInt, parseRequiredFloat, requireEnv, reasoningFromEnv, scopeEnvToAlias, dataCaptureFromEnv, contextWindowFromEnv, envelopeFromEnv } from "./env.ts";
export type { Reasoning, ReasoningMode, ReserveSpec } from "./env.ts";
export { normalizeUsage, computeCost } from "./usage.ts";
export type { RawUsage, TokenRates } from "./usage.ts";
export { ProviderError, classifyProviderError, toProviderError, providerSource } from "./telemetry.ts";
export type { TelemetryEvent, ProviderTelemetryKind } from "./telemetry.ts";
export { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

export { default as Mock } from "./Mock.ts";
export type { MockAssistant, MockResponse, MockReturnedAssistant } from "./Mock.ts";
export { mockDefaultUsage } from "./Mock.ts";
