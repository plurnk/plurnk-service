// @plurnk/plurnk-models — a build-time-vendored snapshot of model metadata
// (context window + pricing) sourced from models.dev.
//
// FALLBACK ONLY. Live provider data always wins: a backend's probed context
// window and a provider's fetched per-token pricing are ground truth and may
// change; this snapshot is the last resort when no live source is available
// (e.g. a cloud model the endpoint doesn't self-report). Consumers resolve in
// this order — env override → live probe/fetch → THIS catalog → null. Never let
// a stale snapshot shadow a live value, especially cost.

import catalog from "./catalog.json" with { type: "json" };

export type ModelCost = {
    readonly inputPer1M: number;        // USD per 1M input tokens
    readonly outputPer1M: number;       // USD per 1M output tokens
    readonly cacheReadPer1M?: number;
    readonly cacheWritePer1M?: number;
};

export type ModelInfo = {
    readonly contextWindow: number;     // tokens
    readonly maxOutput?: number;        // completion cap (tokens); absent when the source had none
    readonly cost?: ModelCost;          // absent when models.dev had no pricing
};

// plurnk provider name → models.dev provider id. Identity for most; these
// diverge (verified against api.json). Keep in sync with KEEP in generate.mjs.
// The Chinese hosts map to the INTERNATIONAL id (USD pricing), matching the
// standard provider's default intl base; minimax/stepfun/siliconflow/modelscope
// are identity. volcengine/baichuan/qianfan have no models.dev entry at all.
const PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
    together: "togetherai",
    fireworks: "fireworks-ai",
    cloudflare: "cloudflare-workers-ai",
    ollama: "ollama-cloud",
    moonshot: "moonshotai",
    dashscope: "alibaba",
    zhipu: "zai",
    hunyuan: "tencent-tokenhub",
});

const data = catalog as Record<string, Record<string, ModelInfo>>;

// Snapshot metadata for the FALLBACK lookup. Returns null on a miss — the
// caller MUST already have preferred any live value; a null here means "no
// fallback either", i.e. leave the field unknown. `provider` is the plurnk
// provider name (the alias-cascade segment); `model` is the provider-native id
// (for relays, `publisher/model`, matching models.dev's keys).
export const lookup = (provider: string, model: string): ModelInfo | null => {
    const id = PROVIDER_IDS[provider] ?? provider;
    return data[id]?.[model] ?? null;
};

// The raw snapshot, for a consumer that wants to enumerate (e.g. a client's
// model picker). Read-only; do not mutate.
export const catalogSnapshot = (): Readonly<Record<string, Readonly<Record<string, ModelInfo>>>> => data;
