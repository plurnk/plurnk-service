// Ollama provider — a thin fromEnv over the shared OpenAICompatProvider.
// Ollama's only bespoke surface is the /api/show probe (context window +
// model family) and the local-only no-auth posture; everything else (the
// generate spine, usage mapping, reasoning translation) is the framework's.

import {
    OpenAICompatProvider,
    parseRequiredInt,
    reasoningFromEnv,
    dataCaptureFromEnv,
    parseRequiredFloat,
    providerSource,
    requireEnv,
    type Provider,
    type ProviderOptions,
    contextWindowFromEnv,
    envelopeFromEnv,
} from "@plurnk/plurnk-providers";

// Tokenizer dispatch. Ollama exposes the model family via /api/show
// `details.family`. Llama-family tokenization is accurate enough for these
// (Llama 1/2/3 share the BPE family with mistral/mixtral); everything else
// (qwen, gemma, phi, deepseek, etc.) falls through to the chars/4 heuristic.
const LLAMA_TOKENIZER_FAMILIES = new Set([
    "llama", "llama2", "llama3",
    "mistral", "mixtral",
]);

export default class Ollama {
    static async fromEnv(env: NodeJS.ProcessEnv, model: string, options?: ProviderOptions): Promise<Provider> {
        // Per-alias override (PLURNK_BASEURL_<alias>) wins — it's how two aliases
        // reach two different ollama boxes; else OLLAMA_BASE_URL, else the official
        // OLLAMA_HOST, which may be a bare host:port with no scheme (normalized
        // below). The chosen base drives BOTH the /api/show probe and the chat URL.
        const rawBase = requireEnv(options?.baseUrl || env.OLLAMA_BASE_URL || env.OLLAMA_HOST, "OLLAMA_BASE_URL or OLLAMA_HOST (or a PLURNK_BASEURL_<alias> override)", "ollama");
        const fetchTimeoutMs = parseRequiredInt(env.PLURNK_PROVIDERS_FETCH_TIMEOUT, "PLURNK_PROVIDERS_FETCH_TIMEOUT", "ollama");
        const streamIdleTimeoutMs = parseRequiredInt(env.PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT, "PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT", "ollama");
        const withScheme = /^https?:\/\//.test(rawBase) ? rawBase : `http://${rawBase}`;
        const normalizedBase = withScheme.replace(/\/$/, "");

        // #507: the operator's window pin wins over the probe (pin-wins-everywhere;
        // previously ollama had NO override path). Probe still runs for `family`.
        const probed = await fetchModelInfo({ base: normalizedBase, model, fetchTimeoutMs });
        const contextWindow = contextWindowFromEnv(env, "ollama") ?? probed.contextWindow;
        const family = probed.family;

        // Local — no auth header; local models are free so calculateCost defaults to 0.
        return new OpenAICompatProvider({
            model,
            url: `${normalizedBase}/v1/chat/completions`,
            fetchTimeoutMs,
            streamIdleTimeoutMs,
            contextWindow,
            temperature: parseRequiredFloat(env.PLURNK_PROVIDERS_TEMPERATURE, "PLURNK_PROVIDERS_TEMPERATURE", "ollama", 0),
            repeatPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_REPEAT_PENALTY, "PLURNK_PROVIDERS_REPEAT_PENALTY", "ollama", 0),
            frequencyPenalty: parseRequiredFloat(env.PLURNK_PROVIDERS_FREQUENCY_PENALTY, "PLURNK_PROVIDERS_FREQUENCY_PENALTY", "ollama", 0),
            // #507: envelope reserves (window-fraction floor, absolute overrides).
            ...envelopeFromEnv(env, "ollama"),
            retryDelayMs: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_DELAY, "PLURNK_PROVIDERS_RETRY_DELAY", "ollama"),
            reasoning: reasoningFromEnv(env, "ollama"),
            retryAttempts: parseRequiredInt(env.PLURNK_PROVIDERS_RETRY_ATTEMPTS, "PLURNK_PROVIDERS_RETRY_ATTEMPTS", "ollama"),
            // Opt-in data capture (#36), off by default, per-alias-scopable.
            ...dataCaptureFromEnv(env, "ollama"),
            reasoningStyle: "think",
            source: providerSource("ollama"),
        });
    }
}

// Ollama's /api/show returns model_info (per-family-prefixed metadata) and
// details (family/quantization/etc.). Two pieces of data we need:
//   - context_length: scan model_info for any "*.context_length" key
//   - family:          details.family (e.g. "llama", "qwen35", "gemma")
type ShowDetails = { family?: string };
type ShowResponse = { model_info?: Record<string, unknown>; details?: ShowDetails };

const fetchModelInfo = async ({
    base, model, fetchTimeoutMs,
}: { base: string; model: string; fetchTimeoutMs: number }): Promise<{ contextWindow: number; family: string | null }> => {
    const res = await fetch(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama /api/show returned ${res.status}: ${body}`);
    }
    const data = (await res.json()) as ShowResponse;
    const info = data.model_info ?? {};
    let contextWindow = 0;
    for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
            contextWindow = value;
            break;
        }
    }
    if (contextWindow === 0) throw new Error(`Ollama /api/show has no *.context_length key for "${model}"`);
    return { contextWindow, family: data.details?.family ?? null };
};
