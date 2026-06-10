// Ollama provider — a thin fromEnv over the shared OpenAICompatProvider.
// Ollama's only bespoke surface is the /api/show probe (context window +
// model family) and the local-only no-auth posture; everything else (the
// generate spine, usage mapping, reasoning translation) is the framework's.

import {
    OpenAICompatProvider,
    parseRequiredInt,
    providerSource,
    requireEnv,
    tokenizerFor,
    type Provider,
    type TokenizerFamily,
} from "@plurnk/plurnk-providers";

// Tokenizer dispatch. Ollama exposes the model family via /api/show
// `details.family`. Llama-family tokenization is accurate enough for these
// (Llama 1/2/3 share the BPE family with mistral/mixtral); everything else
// (qwen, gemma, phi, deepseek, etc.) falls through to the chars/4 heuristic.
const LLAMA_TOKENIZER_FAMILIES = new Set([
    "llama", "llama2", "llama3",
    "mistral", "mixtral",
]);

const tokenizerFamilyFor = (family: string | null): TokenizerFamily =>
    family !== null && LLAMA_TOKENIZER_FAMILIES.has(family) ? "llama" : "heuristic";

export default class Ollama {
    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Provider> {
        const base = requireEnv(env.OLLAMA_BASE_URL, "OLLAMA_BASE_URL", "ollama");
        const fetchTimeoutMs = parseRequiredInt(env.PLURNK_FETCH_TIMEOUT, "PLURNK_FETCH_TIMEOUT", "ollama");
        const reasonBudget = parseRequiredInt(env.PLURNK_REASON, "PLURNK_REASON", "ollama");
        const normalizedBase = base.replace(/\/$/, "");

        const { contextSize, family } = await fetchModelInfo({ base: normalizedBase, model, fetchTimeoutMs });

        // Local — no auth header; local models are free so costFor defaults to 0.
        return new OpenAICompatProvider({
            model,
            url: `${normalizedBase}/v1/chat/completions`,
            fetchTimeoutMs,
            contextSize,
            reasonBudget,
            reasoningStyle: "think",
            countTokens: tokenizerFor(tokenizerFamilyFor(family)),
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
}: { base: string; model: string; fetchTimeoutMs: number }): Promise<{ contextSize: number; family: string | null }> => {
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
    let contextSize = 0;
    for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
            contextSize = value;
            break;
        }
    }
    if (contextSize === 0) throw new Error(`Ollama /api/show has no *.context_length key for "${model}"`);
    return { contextSize, family: data.details?.family ?? null };
};
