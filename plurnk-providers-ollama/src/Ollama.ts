import { chatCompletionStream, OpenAiHttpError } from "./openaiStream.ts";

// PROVIDERS.md §3.9 default — Ollama serves local models; local can mean
// anything from sub-second to minutes per turn depending on parameter size
// and hardware. 10m default matches the universal knob.
const DEFAULT_FETCH_TIMEOUT_MS = 600000;

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
};

export default class Ollama {
    #baseUrl: string;
    #model: string;
    #contextSize: number;
    #fetchTimeoutMs: number;
    #reasonBudget: number;

    constructor(config: OllamaConfig) {
        this.#baseUrl = config.baseUrl.replace(/\/$/, "");
        this.#model = config.model;
        this.#contextSize = config.contextSize;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#reasonBudget = config.reasonBudget;
    }

    // PROVIDERS.md §3.7 factory contract. Async — resolves contextSize from
    // Ollama's `/api/show` at construction time. The model's family-prefixed
    // context_length (e.g. `qwen35.context_length`, `llama.context_length`)
    // lives in model_info; sibling finds it by suffix match.
    static async fromEnv(env: NodeJS.ProcessEnv, model: string): Promise<Ollama> {
        const baseUrl = env.OLLAMA_BASE_URL;
        if (baseUrl === undefined || baseUrl.length === 0) {
            throw new Error("ollama provider: OLLAMA_BASE_URL must be set");
        }
        const fetchTimeoutMs = env.PLURNK_PROVIDER_FETCH_TIMEOUT !== undefined && env.PLURNK_PROVIDER_FETCH_TIMEOUT.length > 0
            ? Number(env.PLURNK_PROVIDER_FETCH_TIMEOUT)
            : DEFAULT_FETCH_TIMEOUT_MS;
        const normalizedBase = baseUrl.replace(/\/$/, "");
        const contextSize = await fetchContextSize({
            baseUrl: normalizedBase,
            model,
            fetchTimeoutMs,
        });
        return new Ollama({
            baseUrl,
            model,
            contextSize,
            fetchTimeoutMs,
            reasonBudget: Number(env.PLURNK_REASON ?? "0"),
        });
    }

    get contextSize(): number { return this.#contextSize; }
    get model(): string { return this.#model; }
    get baseUrl(): string { return this.#baseUrl; }

    // Heuristic tokenizer. Ollama doesn't expose a /tokenize endpoint; real
    // tokenization would require loading the GGUF model's embedded tokenizer
    // client-side (pass-2 work — possibly via wasm port of llama-tokenizer
    // or the model-specific HuggingFace tokenizer.json when available).
    countTokens(text: string): number {
        return text.length === 0 ? 0 : Math.ceil(text.length / 4);
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

// Ollama's /api/show returns model_info as an object whose keys are
// family-prefixed (`qwen35.context_length`, `llama.context_length`,
// `gemma.context_length`, etc.). We scan for any key ending in
// `.context_length`. Returns the first match; throws on miss.
type ShowResponse = { model_info?: Record<string, unknown> };

const fetchContextSize = async ({
    baseUrl, model, fetchTimeoutMs,
}: { baseUrl: string; model: string; fetchTimeoutMs: number }): Promise<number> => {
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
    for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
            return value;
        }
    }
    throw new Error(`Ollama /api/show has no *.context_length key for "${model}"`);
};

export { OpenAiHttpError };
