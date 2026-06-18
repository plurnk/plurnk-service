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
import { chatCompletionStream, chatCompletion, OpenAiHttpError } from "./openaiStream.ts";
import { normalizeUsage } from "./usage.ts";
import { toProviderError, classifyProviderError } from "./telemetry.ts";

// How the single reasoningBudget (PLURNK_PROVIDERS_REASONING_BUDGET: 0 off,
// -1 adaptive, N capped) translates to each backend's wire mechanism (SPEC §4):
//  - "template":          llama-server (jinja) → `chat_template_kwargs.enable_thinking`,
//                         ALWAYS emitted — the explicit false is the only working
//                         off-switch (llama-server ignores `think` and per-request
//                         budgets; its --reasoning-budget default otherwise keeps
//                         the channel live — fatal under an active grammar, §13).
//  - "think":             Ollama OpenAI-compat → `think: true` when on (budget != 0)
//  - "include_reasoning": OpenRouter relay passthrough toggle when on
//  - "effort":            o-series / Grok / Gemini → reasoning_effort tier from a
//                         capped budget (N>0); adaptive (-1) omits the field (API default)
//  - "anthropic":         Claude OpenAI-compat endpoint → `thinking: { type, budget_tokens }`
//                         (it IGNORES reasoning_effort): 0 off → disabled, N>0 → enabled with
//                         budget_tokens, -1 adaptive → omit (the API's default depth)
//  - "none":              provider has no reasoning toggle (e.g. Cloudflare, Bedrock relay)
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort" | "template" | "anthropic";

// How a caller-supplied GBNF grammar is carried on the wire — backends accept
// different shapes for the SAME GBNF (probed/configured, never guessed; §13):
//  - "llamacpp":         llama.cpp/llama-server → top-level `grammar` field
//                        (+ the repeat-penalty floor); detected via the probe.
//  - "response_format":  Fireworks (and compatible) → `response_format:
//                        { type: "grammar", grammar }`. Verified live: a forcing
//                        grammar constrains the output (plurnk-providers#…).
//  - "none":             backend has no working GBNF path — the grammar is NOT
//                        sent (never silently, so a constrained consumer can't
//                        mistake unconstrained output for enforced).
export type GrammarStyle = "none" | "llamacpp" | "response_format";

export type OpenAICompatConfig = {
    model: string;
    url: string;                              // fully-resolved chat-completions URL
    fetchTimeoutMs: number;
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    contextSize?: number | null;              // default null
    reasoningStyle?: ReasoningStyle;          // default "none"
    countTokens?: (text: string) => number;   // default chars/4 heuristic
    costFor?: (usage: ProviderUsage) => number; // default () => 0
    source?: string;                           // telemetry source, e.g. "provider:openai"; default "provider"
    grammarStyle?: GrammarStyle;               // how a GBNF grammar is carried; default "none" (not sent)
    streaming?: boolean;                        // SSE transport (default true); false → one non-streamed JSON
    // Slot affinity wiring (provider-INTERNAL — never consumer-facing, #11).
    supportsSlotPinning?: boolean;             // backend accepts an `id_slot` body field (llama-server); default false
    slotCount?: number | null;                 // probed slot count for pinning backends; default null
    // The side-channel reasoning budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_REASONING_BUDGET, read via reasoningBudgetFromEnv):
    // 0 off, -1 adaptive, N capped. The provider maps it to the backend's
    // mechanism via reasoningStyle.
    reasoningBudget: number;
    // Transient-failure retry budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDER_RETRY_ATTEMPTS, a non-negative int): 0 = surface the
    // first failure; N = up to N retries on a transient error (§4, #18).
    retryAttempts: number;
};

// Sampling guard under an active grammar (SPEC §13): greedy decoding under
// hard constraint masks degenerates into repetition loops at the server
// default of 1.0, so the floor rides per-request with every attached grammar —
// never rely on server launch flags. Probed on llama.cpp b894 + gemma-4-26B
// (plurnk-providers#9; reference: plurnk-grammar test/llama/gbnf-live.test.ts).
const GRAMMAR_REPEAT_PENALTY_FLOOR = 1.15;

// Exponential-backoff base for transient-failure retries (#18). Attempt N waits
// RETRY_BASE_DELAY_MS * 2^(N-1), unless the server sent a Retry-After (which
// wins). The magnitude is mechanism, not operator intent — the COUNT is the
// knob (PLURNK_PROVIDER_RETRY_ATTEMPTS); the base stays a constant.
const RETRY_BASE_DELAY_MS = 2000;

// Only these two classifications are transient and worth retrying: rate_limit
// (429) and network_failure (5xx, timeout, connection reset). unauthorized,
// quota_exceeded, invalid_response, model_refused are terminal — retrying just
// burns time and budget.
const RETRYABLE: ReadonlySet<string> = new Set(["rate_limit", "network_failure"]);

// Sleep that rejects the moment `signal` aborts (caller cancellation must not
// wait out a backoff). Resolves normally on timeout.
const sleepWithAbort = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });

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
    #reasoningBudget: number;
    #reasoningStyle: ReasoningStyle;
    #countTokens: (text: string) => number;
    #costFor: (usage: ProviderUsage) => number;
    #source: string;
    #grammarStyle: GrammarStyle;
    #streaming: boolean;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #retryAttempts: number;

    constructor(config: OpenAICompatConfig) {
        this.#model = config.model;
        this.#url = config.url;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#contextSize = config.contextSize ?? null;
        this.#reasoningBudget = config.reasoningBudget;
        this.#retryAttempts = config.retryAttempts;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        this.#countTokens = config.countTokens ?? heuristicTokens;
        this.#costFor = config.costFor ?? (() => 0);
        this.#source = config.source ?? "provider";
        this.#grammarStyle = config.grammarStyle ?? "none";
        this.#streaming = config.streaming ?? true;
        this.#supportsSlotPinning = config.supportsSlotPinning ?? false;
        this.#slotCount = config.slotCount ?? null;
    }

    get contextSize(): number | null { return this.#contextSize; }
    get model(): string { return this.#model; }

    countTokens(text: string): number { return this.#countTokens(text); }
    costFor(usage: ProviderUsage): number { return this.#costFor(usage); }

    #reasoningBody(): Record<string, unknown> {
        const b = this.#reasoningBudget;   // 0 off, -1 adaptive, N>0 capped
        const on = b !== 0;
        switch (this.#reasoningStyle) {
            // Native-channel styles. "template" ALWAYS emits — the explicit
            // enable_thinking:false is the only working off-switch on
            // llama-server (§13). The magnitude is irrelevant for native (on/off only).
            case "template": return { chat_template_kwargs: { enable_thinking: on } };
            case "think": return on ? { think: true } : {};
            case "include_reasoning": return on ? { include_reasoning: true } : {};
            // effort tiers from a capped budget; adaptive (-1) omits the field
            // (lets the API pick its default depth); off (0) omits.
            case "effort": return b > 0 ? { reasoning_effort: effortFromBudget(b) } : {};
            // Anthropic compat: explicit thinking object. 0 → disabled; N>0 →
            // enabled with budget_tokens; -1 adaptive → omit (the API default).
            case "anthropic": return b === 0
                ? { thinking: { type: "disabled" } }
                : b > 0 ? { thinking: { type: "enabled", budget_tokens: b } } : {};
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

    // Grammar transport (SPEC §13): carry the caller-supplied GBNF in the shape
    // the backend accepts. Same grammar, different wire field per backend; an
    // unsupported/unknown backend sends NO field at all (cloud APIs 400 on
    // unknowns, and a silent send would let a constrained consumer mistake
    // unconstrained output for enforced).
    #grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined) return {};
        switch (this.#grammarStyle) {
            // llama.cpp greedy-decodes under hard constraint and loops without
            // the repeat-penalty floor (#9) — it rides with the grammar here.
            case "llamacpp": return { grammar, repeat_penalty: GRAMMAR_REPEAT_PENALTY_FLOOR };
            case "response_format": return { response_format: { type: "grammar", grammar } };
            case "none": return {};
        }
    }

    async generate({ messages, runId, signal, grammar, maxTokens }: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number }): Promise<ProviderResponse> {
        // Boundary validation (SPEC §2): the run identity is required.
        if (runId === undefined || runId.length === 0) throw new Error("generate: runId is required — the run's stable, opaque identity");
        // Reject before any wire call when already aborted (SPEC §10.8).
        signal?.throwIfAborted();

        const body: Record<string, unknown> = {
            model: this.#model,
            messages,
            ...this.#reasoningBody(),
            ...this.#grammarBody(grammar),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            ...this.#slotBody(runId),
        };

        // Transient-failure retry (#18). Each attempt gets a FRESH fetch timeout
        // (the budget is per-request, not shared across retries); the caller's
        // signal spans them all. Retry only the transient classifications, prefer
        // a server Retry-After over the backoff, and let the caller's abort cut
        // through both the in-flight request and the backoff sleep.
        const transport = this.#streaming ? chatCompletionStream : chatCompletion;
        let raw;
        for (let attempt = 0; ; attempt++) {
            const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
            const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
            try {
                raw = await transport({ url: this.#url, headers: this.#headers, body, signal: effectiveSignal });
                break;
            } catch (err) {
                // Caller-initiated abort is cancellation — never retried or wrapped.
                if (signal?.aborted) throw err;
                const { kind } = classifyProviderError(err);
                // Terminal kind, or budget spent → surface the classified failure.
                if (!RETRYABLE.has(kind) || attempt >= this.#retryAttempts) throw toProviderError(err, this.#source);
                const retryAfter = err instanceof OpenAiHttpError ? err.retryAfter : null;
                await sleepWithAbort(retryAfter ?? RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
            }
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
