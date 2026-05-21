import llamaTokenizer from "llama-tokenizer-js";
import { chatCompletionStream, OpenAiHttpError } from "./openaiStream.ts";

// PROVIDERS.md §3.9 default — Ollama serves local models; local can mean
// anything from sub-second to minutes per turn depending on parameter size
// and hardware. 10m default matches the universal knob.
const DEFAULT_FETCH_TIMEOUT_MS = 600000;

// Tokenizer dispatch. Ollama exposes the model family via /api/show
// `details.family`. Llama-family tokenization is accurate enough for these;
// everything else falls back to the chars/4 heuristic until handler-specific
// tokenizers land (pass-3 work).
const LLAMA_TOKENIZER_FAMILIES = new Set([
    "llama", "llama2", "llama3",
    "mistral", "mixtral",
]);
type TokenizerKind = "llama" | "heuristic";

const tokenizerForFamily = (family: string | null): TokenizerKind =>
    family !== null && LLAMA_TOKENIZER_FAMILIES.has(family) ? "llama" : "heuristic";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderUsage = {
    prompt: number;
    completion: number;
    cached: number;
    total: number;
};

export type ProviderAssistant = {
    content: string;
    reasoning: string | null;
    usage: ProviderUsage;
    finishReason: string | null;
    model: string;
};

export type ProviderResponse = {
    assistant: ProviderAssistant;
    assistantRaw: unknown;
};

export type OllamaConfig = {
    baseUrl: string;
    model: string;
    contextSize: number;
    fetchTimeoutMs: number;
    // PROVIDERS.md §3.8 universal reasoning budget. Ollama's OpenAI-compat
    // endpoint accepts a non-standard `think: bool` body flag — any positive
    // budget toggles it on.
    reasonBudget: number;
    // Resolved at fromEnv from /api/show details.family. Frozen on the
    // instance for the lifetime of the provider.
    tokenizer: TokenizerKind;
};

export default class Ollama {
    #baseUrl: string;
    #model: string;
    #contextSize: number;
    #fetchTimeoutMs: number;
    #reasonBudget: number;
    #tokenizer: TokenizerKind;

    constructor(config: OllamaConfig) {
        this.#baseUrl = config.baseUrl.replace(/\/$/, "");
        this.#model = config.model;
        this.#contextSize = config.contextSize;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#reasonBudget = config.reasonBudget;
        this.#tokenizer = config.tokenizer;
    }

    // PROVIDERS.md §3.7 factory contract. Async — resolves contextSize and
    // tokenizer-family from Ollama's `/api/show` at construction time in a
    // single round-trip.
    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Ollama> {
        const baseUrl = env.OLLAMA_BASE_URL;
        if (baseUrl === undefined || baseUrl.length === 0) {
            throw new Error("ollama provider: OLLAMA_BASE_URL must be set");
        }
        const fetchTimeoutMs = env.PLURNK_PROVIDER_FETCH_TIMEOUT !== undefined && env.PLURNK_PROVIDER_FETCH_TIMEOUT.length > 0
            ? Number(env.PLURNK_PROVIDER_FETCH_TIMEOUT)
            : DEFAULT_FETCH_TIMEOUT_MS;
        const normalizedBase = baseUrl.replace(/\/$/, "");
        const info = await fetchModelInfo({
            baseUrl: normalizedBase,
            model,
            fetchTimeoutMs,
        });
        return new Ollama({
            baseUrl,
            model,
            contextSize: info.contextSize,
            fetchTimeoutMs,
            reasonBudget: Number(env.PLURNK_REASON ?? "0"),
            tokenizer: tokenizerForFamily(info.family),
        });
    }

    get contextSize(): number { return this.#contextSize; }
    get model(): string { return this.#model; }
    get baseUrl(): string { return this.#baseUrl; }
    get tokenizer(): TokenizerKind { return this.#tokenizer; }

    // Family-dispatched tokenizer resolved at fromEnv. Llama family uses
    // llama-tokenizer-js (Llama 1/2/3, also reasonably accurate for
    // mistral/mixtral which share the BPE family). Everything else
    // (qwen, gemma, phi, deepseek, etc.) falls through to the chars/4
    // heuristic — per-family tokenizers for those are pass-3 work.
    countTokens(text: string): number {
        if (text.length === 0) return 0;
        return this.#tokenizer === "llama"
            ? llamaTokenizer.encode(text).length
            : Math.ceil(text.length / 4);
    }

    // Local models are free.
    costFor(_usage: ProviderUsage): number { return 0; }

    async generate({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse> {
        const body: Record<string, unknown> = { model: this.#model, messages };
        // PROVIDERS.md §3.8 translation: non-zero PLURNK_REASON → think: true.
        // Ollama's OpenAI-compat endpoint accepts this non-standard flag and
        // routes reasoning back via the standard `reasoning_content` delta.
        if (this.#reasonBudget > 0) body.think = true;

        const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
        const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        const raw = await chatCompletionStream({
            url: `${this.#baseUrl}/v1/chat/completions`,
            headers: {},
            body,
            signal: effectiveSignal,
        });

        const usage: ProviderUsage = {
            prompt: raw.usage?.prompt_tokens ?? 0,
            completion: raw.usage?.completion_tokens ?? 0,
            cached: raw.usage?.cached_tokens ?? 0,
            total: raw.usage?.total_tokens ?? 0,
        };

        return {
            assistant: {
                content: raw.content,
                reasoning: raw.reasoning_content.length > 0 ? raw.reasoning_content : null,
                usage,
                finishReason: raw.finish_reason,
                model: raw.model ?? this.#model,
            },
            assistantRaw: raw,
        };
    }
}

// Ollama's /api/show returns model_info (per-family-prefixed metadata) and
// details (family/quantization/etc.). Two pieces of data we need:
//   - context_length: scan model_info for any "*.context_length" key
//   - family:          details.family (e.g. "llama", "qwen35", "gemma")
type ShowDetails = { family?: string };
type ShowResponse = { model_info?: Record<string, unknown>; details?: ShowDetails };

const fetchModelInfo = async ({
    baseUrl, model, fetchTimeoutMs,
}: { baseUrl: string; model: string; fetchTimeoutMs: number }): Promise<{ contextSize: number; family: string | null }> => {
    const res = await fetch(`${baseUrl}/api/show`, {
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
    if (contextSize === 0) {
        throw new Error(`Ollama /api/show has no *.context_length key for "${model}"`);
    }
    const family = data.details?.family ?? null;
    return { contextSize, family };
};

export { OpenAiHttpError };
