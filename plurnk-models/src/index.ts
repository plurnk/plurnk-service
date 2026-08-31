// Release-time Models.dev snapshot. This package owns lookup; provider-owned
// field precedence is defined by {§model-fact-resolution}. There is no runtime
// dependency on Models.dev and no parallel PLURNK vendor table.

import catalog from "./catalog.json" with { type: "json" };
import providers from "./providers.json" with { type: "json" };

export type ModelCost = {
    readonly inputPer1M: number;        // USD per 1M input tokens
    readonly outputPer1M: number;       // USD per 1M output tokens
    readonly reasoningPer1M?: number;
    readonly cacheReadPer1M?: number;
    readonly cacheWritePer1M?: number;
};

export type ModelReasoningEffort =
    | null
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "default";

export type ModelReasoningOption =
    | { readonly type: "toggle" }
    | { readonly type: "effort"; readonly values: readonly ModelReasoningEffort[] }
    | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

type ModelInfoBase = {
    readonly name: string;
    readonly contextWindow: number;     // tokens
    readonly maxInputTokens?: number;   // independent input cap; absent when the source had none
    readonly maxOutputTokens?: number;  // independent total-output cap; absent when the source had none
    readonly attachment: boolean;
    readonly toolCall: boolean;
    readonly structuredOutput?: boolean;
    readonly temperature?: boolean;
    readonly modalities: {
        readonly input: readonly string[];
        readonly output: readonly string[];
    };
    readonly cost?: ModelCost;          // absent without complete input and output rates
};

export type ModelInfo = ModelInfoBase & (
    | {
        readonly reasoning: true;
        readonly reasoningOptions: readonly ModelReasoningOption[];
    }
    | {
        readonly reasoning: false;
        readonly reasoningOptions?: never;
    }
);

export type ProviderInfo = {
    readonly id: string;
    readonly name: string;
    readonly npm: string;
    readonly env: readonly string[];
    readonly api?: string;
};

// (#459) The provider segment IS the Models.dev id — configurations align with the
// catalog, one vocabulary end to end. The plurnk-local names these ids once hid
// behind are retired: a retired segment refuses loudly, naming the id, so an old
// declaration can never silently resolve. Custom (_NPM/env-declared) providers
// keep their operator-chosen names — they have no catalog id.
const RETIRED_PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({
    together: "togetherai",
    fireworks: "fireworks-ai",
    cloudflare: "cloudflare-workers-ai",
    // `ollama` is NOT retired: it names the built-in local rail, which has no
    // catalog id — the old alias wrongly conflated it with the ollama-cloud catalog.
    moonshot: "moonshotai",
    dashscope: "alibaba",
    zhipu: "zai",
    hunyuan: "tencent-tokenhub",
    bedrock: "amazon-bedrock",
});

const assertCatalogSegment = (provider: string): string => {
    const id = RETIRED_PROVIDER_NAMES[provider];
    if (id !== undefined) {
        throw new Error(`provider segment '${provider}' was retired; declarations use the Models.dev id '${id}'`);
    }
    return provider;
};

const data = catalog as Record<string, Record<string, ModelInfo>>;
const providerData = providers as Record<string, ProviderInfo>;

// Snapshot lookup only; {§model-fact-resolution} owns field-specific runtime
// precedence. `provider` is the PLURNK alias-cascade segment and `model` is the
// provider-native id (for relays, `publisher/model`).
export const lookup = (provider: string, model: string): ModelInfo | null =>
    data[assertCatalogSegment(provider)]?.[model] ?? null;

export const resolveModel = (
    provider: string,
    model: string,
): { readonly id: string; readonly info: ModelInfo } | null => {
    const models = data[assertCatalogSegment(provider)];
    if (models === undefined) return null;
    const exact = models[model];
    if (exact !== undefined) return { id: model, info: exact };
    const suffix = `/${model}`;
    const matches = Object.entries(models).filter(([candidate]) => candidate.endsWith(suffix));
    return matches.length === 1
        ? { id: matches[0]![0], info: matches[0]![1] }
        : null;
};

export const lookupProvider = (provider: string): ProviderInfo | null =>
    providerData[assertCatalogSegment(provider)] ?? null;

// The raw snapshot, for a consumer that wants to enumerate (e.g. a client's
// model picker). Read-only; do not mutate.
export const catalogSnapshot = (): Readonly<Record<string, Readonly<Record<string, ModelInfo>>>> => data;

// (#459) Retired plurnk-local name → Models.dev id, for surfaces that teach the
// migration (error text, docs); never for resolution.
export const retiredProviderNames = (): Readonly<Record<string, string>> => RETIRED_PROVIDER_NAMES;

// (#459) The route segment IS the Models.dev id; the mapping is identity.
export const providerNameFromCatalogId = (id: string): string => id;

export const providerCatalogSnapshot = (): Readonly<Record<string, ProviderInfo>> => providerData;

// models.dev's `env` mixes credentials with non-secret endpoint coordinates
// such as AWS_REGION and CLOUDFLARE_ACCOUNT_ID. Only conventional credential
// names are credentials; a coordinate is never one.
export const isProviderCredentialName = (name: string): boolean =>
    /(?:API_KEY|TOKEN|SECRET|ACCESS_KEY_ID|PASSWORD|CREDENTIAL)/.test(name);

export const providerCredentialEnvNames = (): readonly string[] =>
    [...new Set(Object.values(providerData)
        .flatMap((provider) => provider.env)
        .filter(isProviderCredentialName))]
        .toSorted();
