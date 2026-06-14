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

// How the single reasoning gate (`reasoningEnabled`, PLURNK_PROVIDERS_REASONING)
// translates to each backend's wire mechanism (SPEC §4). One consumer intent —
// "side-channel reasoning on/off" — many backend dialects:
//  - "template":          llama-server (jinja) → `chat_template_kwargs.enable_thinking`,
//                         ALWAYS emitted — the explicit false is the only working
//                         off-switch (llama-server ignores `think` and per-request
//                         budgets; its --reasoning-budget default otherwise keeps
//                         the channel live — fatal under an active grammar, §13).
//  - "think":             Ollama OpenAI-compat → `think: true` when enabled
//  - "include_reasoning": OpenRouter relay passthrough toggle (gated by PLURNK_PROVIDERS_REASON_LEVEL > 0)
//  - "effort":            o-series / Grok / Gemini → reasoning_effort tier (gated by PLURNK_PROVIDERS_REASON_LEVEL > 0)
//  - "none":              provider has no reasoning toggle (e.g. Cloudflare)
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort" | "template";

export type OpenAICompatConfig = {
    model: string;
    url: string;                              // fully-resolved chat-completions URL
    fetchTimeoutMs: number;
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    contextSize?: number | null;              // default null
    reasonBudget?: number;                    // PLURNK_PROVIDERS_REASON_LEVEL; default 0 (disabled)
    reasoningStyle?: ReasoningStyle;          // default "none"
    countTokens?: (text: string) => number;   // default chars/4 heuristic
    costFor?: (usage: ProviderUsage) => number; // default () => 0
    source?: string;                           // telemetry source, e.g. "provider:openai"; default "provider"
    supportsGrammar?: boolean;                 // backend accepts a `grammar` body field (llama-server); default false
    // Slot affinity wiring (provider-INTERNAL — never consumer-facing, #11).
    supportsSlotPinning?: boolean;             // backend accepts an `id_slot` body field (llama-server); default false
    slotCount?: number | null;                 // probed slot count for pinning backends; default null
    // The side-channel reasoning gate — REQUIRED, no in-code default:
    // configuration lives in the operator's env (SPEC §4), read via
    // reasoningKnobsFromEnv. The provider maps it to the backend's mechanism
    // via reasoningStyle.
    reasoningEnabled: boolean;                 // PLURNK_PROVIDERS_REASONING
};

// Sampling guard under an active grammar (SPEC §13): greedy decoding under
// hard constraint masks degenerates into repetition loops at the server
// default of 1.0, so the floor rides per-request with every attached grammar —
// never rely on server launch flags. Probed on llama.cpp b894 + gemma-4-26B
// (plurnk-providers#9; reference: plurnk-grammar test/llama/gbnf-live.test.ts).
const GRAMMAR_REPEAT_PENALTY_FLOOR = 1.15;

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
    #supportsGrammar: boolean;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #reasoningEnabled: boolean;

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
        this.#supportsGrammar = config.supportsGrammar ?? false;
        this.#supportsSlotPinning = config.supportsSlotPinning ?? false;
        this.#slotCount = config.slotCount ?? null;
        this.#reasoningEnabled = config.reasoningEnabled;
    }

    get contextSize(): number | null { return this.#contextSize; }
    get model(): string { return this.#model; }

    countTokens(text: string): number { return this.#countTokens(text); }
    costFor(usage: ProviderUsage): number { return this.#costFor(usage); }

    #reasoningBody(): Record<string, unknown> {
        switch (this.#reasoningStyle) {
            // Native-channel styles. "template" ALWAYS emits — the explicit
            // enable_thinking:false is the only working off-switch on
            // llama-server (§13).
            case "template": return { chat_template_kwargs: { enable_thinking: this.#reasoningEnabled } };
            case "think": return this.#reasoningEnabled ? { think: true } : {};
            // Cloud/relay styles also gate on the budget magnitude (PLURNK_PROVIDERS_REASON_LEVEL).
            case "include_reasoning": return this.#reasoningEnabled && this.#reasonBudget > 0 ? { include_reasoning: true } : {};
            case "effort": return this.#reasoningEnabled && this.#reasonBudget > 0 ? { reasoning_effort: effortFromBudget(this.#reasonBudget) } : {};
            case "none": return {};
        }
    }

    // Per-run slot affinity (#11): the consumer passes WHICH run this is; the
    // provider owns WHICH slot serves it. Sticky per runId, round-robin across
    // new runs (distinct runs → distinct slots while slots last), LRU-bounded
    // bookkeeping so a long-lived daemon never grows the map unboundedly —
    // an evicted-and-returning run simply re-pins, worst case one cold prefill.
    #runSlots = new Map<string, number>();
    #nextSlot = 0;

    #slotBody(runId: string): Record<string, unknown> {
        if (!this.#supportsSlotPinning || this.#slotCount === null || this.#slotCount < 1) return {};
        let slot = this.#runSlots.get(runId);
        if (slot === undefined) {
            slot = this.#nextSlot++ % this.#slotCount;
            if (this.#runSlots.size >= this.#slotCount * 8) {
                this.#runSlots.delete(this.#runSlots.keys().next().value as string);
            }
        } else {
            this.#runSlots.delete(runId); // re-insert to refresh LRU recency
        }
        this.#runSlots.set(runId, slot);
        return { id_slot: slot };
    }

    // Grammar transport (SPEC §13): attach the caller-supplied GBNF verbatim
    // when the backend supports it, with the repeat-penalty floor it requires.
    // Unsupported backend → no wire field at all (cloud APIs 400 on unknowns).
    #grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined || !this.#supportsGrammar) return {};
        return { grammar, repeat_penalty: GRAMMAR_REPEAT_PENALTY_FLOOR };
    }

    async generate({ messages, runId, signal, grammar, maxTokens }: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number }): Promise<ProviderResponse> {
        // Boundary validation (SPEC §2): the run identity is required.
        if (runId === undefined || runId.length === 0) throw new Error("generate: runId is required — the run's stable, opaque identity");
        // Reject before any wire call when already aborted (SPEC §10.8).
        signal?.throwIfAborted();
        const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
        const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        const body: Record<string, unknown> = {
            model: this.#model,
            messages,
            ...this.#reasoningBody(),
            ...this.#grammarBody(grammar),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            ...this.#slotBody(runId),
        };

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
