// Shared OpenAI-compatible provider. Implements the universal generate()
// spine — signal merging, the SSE call, usage mapping, finishReason
// normalization, response assembly — that every sibling had duplicated.
//
// Composition, not inheritance: the per-provider deltas (resolved URL, auth
// headers, reasoning translation style, tokenizer, cost) arrive as config.
// A sibling's fromEnv probes whatever it needs (catalog, pricing, context
// window), builds the config, and returns `new OpenAICompatProvider(config)`.
// Pure-config providers come from ./standardProviders.ts with no sibling at all.

import type { ChatMessage, FinishReason, Provider, ProviderResponse, ProviderUsage } from "./types.ts";
import { chatCompletionStream } from "./openaiStream.ts";
import { normalizeUsage } from "./usage.ts";
import { toProviderError } from "./telemetry.ts";

// How a numeric PLURNK_REASON budget translates to the wire (SPEC §4).
//  - "think":             llama-server / Ollama OpenAI-compat → `think: true`
//  - "include_reasoning": OpenRouter relay passthrough toggle
//  - "effort":            o-series / Grok / Gemini → reasoning_effort tier
//  - "none":              provider has no reasoning toggle (e.g. Cloudflare)
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort";

export type OpenAICompatConfig = {
    model: string;
    url: string;                              // fully-resolved chat-completions URL
    fetchTimeoutMs: number;
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    contextSize?: number | null;              // default null
    reasonBudget?: number;                    // PLURNK_REASON; default 0 (disabled)
    reasoningStyle?: ReasoningStyle;          // default "none"
    countTokens?: (text: string) => number;   // default chars/4 heuristic
    costFor?: (usage: ProviderUsage) => number; // default () => 0
    source?: string;                           // telemetry source, e.g. "provider:openai"; default "provider"
};

// SPEC §2 closed set. Wire values outside it (provider-specific or absent)
// collapse to null — the consumer treats null as "no signal".
const FINISH_REASONS: ReadonlySet<string> = new Set(["stop", "length", "tool_calls", "content_filter"]);
const normalizeFinishReason = (raw: string | null): FinishReason =>
    raw !== null && FINISH_REASONS.has(raw) ? (raw as FinishReason) : null;

// Shared budget→effort breakpoints (xai and google had identical copies).
export const effortFromBudget = (budget: number): "low" | "medium" | "high" => {
    if (budget <= 1000) return "low";
    if (budget <= 4000) return "medium";
    return "high";
};

const heuristicTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 4));

export default class OpenAICompatProvider implements Provider {
    #model: string;
    #url: string;
    #fetchTimeoutMs: number;
    #headers: Record<string, string>;
    #contextSize: number | null;
    #reasonBudget: number;
    #reasoningStyle: ReasoningStyle;
    #countTokens: (text: string) => number;
    #costFor: (usage: ProviderUsage) => number;
    #source: string;

    constructor(config: OpenAICompatConfig) {
        this.#model = config.model;
        this.#url = config.url;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#contextSize = config.contextSize ?? null;
        this.#reasonBudget = config.reasonBudget ?? 0;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        this.#countTokens = config.countTokens ?? heuristicTokens;
        this.#costFor = config.costFor ?? (() => 0);
        this.#source = config.source ?? "provider";
    }

    get contextSize(): number | null { return this.#contextSize; }
    get model(): string { return this.#model; }

    countTokens(text: string): number { return this.#countTokens(text); }
    costFor(usage: ProviderUsage): number { return this.#costFor(usage); }

    #reasoningBody(): Record<string, unknown> {
        if (this.#reasonBudget <= 0) return {};
        switch (this.#reasoningStyle) {
            case "think": return { think: true };
            case "include_reasoning": return { include_reasoning: true };
            case "effort": return { reasoning_effort: effortFromBudget(this.#reasonBudget) };
            case "none": return {};
        }
    }

    async generate({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<ProviderResponse> {
        // Reject before any wire call when already aborted (SPEC §10.8).
        signal?.throwIfAborted();
        const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
        const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        const body: Record<string, unknown> = { model: this.#model, messages, ...this.#reasoningBody() };

        let raw;
        try {
            raw = await chatCompletionStream({ url: this.#url, headers: this.#headers, body, signal: effectiveSignal });
        } catch (err) {
            // Caller-initiated abort is cancellation, not a telemetry-worthy
            // provider failure — rethrow as-is. Everything else (HTTP error,
            // timeout, network) becomes a classified ProviderError.
            if (signal?.aborted) throw err;
            throw toProviderError(err, this.#source);
        }

        return {
            assistant: {
                content: raw.content,
                reasoning: raw.reasoning_content.length > 0 ? raw.reasoning_content : null,
                usage: normalizeUsage(raw.usage),
                finishReason: normalizeFinishReason(raw.finish_reason),
                model: raw.model ?? this.#model,
            },
            assistantRaw: raw,
        };
    }
}
