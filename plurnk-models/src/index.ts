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

export type ModelInfo = {
    readonly name: string;
    readonly contextWindow: number;     // tokens
    readonly maxInputTokens?: number;   // independent input cap; absent when the source had none
    readonly maxOutputTokens?: number;  // independent total-output cap; absent when the source had none
    readonly reasoning: boolean;        // Models.dev's asserted capability fact
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

export type ProviderInfo = {
    readonly id: string;
    readonly name: string;
    readonly npm: string;
    readonly env: readonly string[];
    readonly api?: string;
};

// plurnk provider name → models.dev provider id. Identity for most; these
// diverge from the operator-friendly PLURNK alias (verified against api.json).
// The Chinese hosts map to the international catalog id (USD pricing).
// volcengine/baichuan/qianfan have no models.dev entry.
const PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
    together: "togetherai",
    fireworks: "fireworks-ai",
    cloudflare: "cloudflare-workers-ai",
    ollama: "ollama-cloud",
    moonshot: "moonshotai",
    dashscope: "alibaba",
    zhipu: "zai",
    hunyuan: "tencent-tokenhub",
    bedrock: "amazon-bedrock",
});

const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(Object.entries(PROVIDER_IDS).map(([name, id]) => [id, name])),
);

const data = catalog as Record<string, Record<string, ModelInfo>>;
const providerData = providers as Record<string, ProviderInfo>;

// Snapshot lookup only; {§model-fact-resolution} owns field-specific runtime
// precedence. `provider` is the PLURNK alias-cascade segment and `model` is the
// provider-native id (for relays, `publisher/model`).
export const lookup = (provider: string, model: string): ModelInfo | null => {
    const id = PROVIDER_IDS[provider] ?? provider;
    return data[id]?.[model] ?? null;
};

export const resolveModel = (
    provider: string,
    model: string,
): { readonly id: string; readonly info: ModelInfo } | null => {
    const id = PROVIDER_IDS[provider] ?? provider;
    const models = data[id];
    if (models === undefined) return null;
    const exact = models[model];
    if (exact !== undefined) return { id: model, info: exact };
    const suffix = `/${model}`;
    const matches = Object.entries(models).filter(([candidate]) => candidate.endsWith(suffix));
    return matches.length === 1
        ? { id: matches[0]![0], info: matches[0]![1] }
        : null;
};

export const lookupProvider = (provider: string): ProviderInfo | null => {
    const id = PROVIDER_IDS[provider] ?? provider;
    return providerData[id] ?? null;
};

// The raw snapshot, for a consumer that wants to enumerate (e.g. a client's
// model picker). Read-only; do not mutate.
export const catalogSnapshot = (): Readonly<Record<string, Readonly<Record<string, ModelInfo>>>> => data;

// PLURNK provider name → Models.dev provider id, for consumers that must
// reconcile a declaration or default against the authoritative catalog.
export const providerIdMap = (): Readonly<Record<string, string>> => PROVIDER_IDS;

// Models.dev provider id -> the exact provider segment accepted by a PLURNK
// model route. Identity names remain unchanged; the explicit map reverses the
// handful whose operator-facing route name deliberately differs.
export const providerNameFromCatalogId = (id: string): string => PROVIDER_NAMES[id] ?? id;

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
