// PLURNK adapter over an AI SDK language model. Implements the universal generate()
// spine — signal merging, the SSE call, usage mapping, finishReason
// normalization, response assembly — that every sibling had duplicated.
//
// Composition, not inheritance: an official AI SDK language model supplies the
// ordinary vendor protocol. The compatible URL path remains only for PLURNK
// extensions and local endpoint probes the SDK cannot represent.

import type {
    ChatMessage,
    GrammarEvidence,
    PromptTokenMeasurement,
    Provider,
    ProviderCostNormalizer,
    ProviderCallKind,
    ProviderGenerateArgs,
    ProviderRequestAccounting,
    ProviderRequestObserver,
    ProviderRequestSettlement,
    ProviderResponse,
    ProviderUsage,
} from "./types.ts";
import type { ProviderCost } from "@plurnk/plurnk-contracts";
import type { JSONValue } from "ai";
import { MAX_PROVIDER_TIMEOUT_MS } from "./env.ts";
import type { Reasoning, ReasoningResponseStyle, ReserveSpec } from "./env.ts";
import {
    executeAiSdkModel,
    executeOpenAICompatible,
    transportFailureEvidence,
} from "./aiSdkTransport.ts";
import type { LanguageModel } from "ai";
import { prepareRetries } from "ai/internal";
import { toProviderError, ProviderError, ProviderTimeoutError } from "./errors.ts";
import type { ProviderNotice } from "./notices.ts";
import { validateGbnf } from "@plurnk/gbnf";
import { assertPromptTokenMeasurement, estimatePromptTokens } from "./promptTokens.ts";
import { emitWarningOnce } from "./warnings.ts";
import type { PluginAttribution, PluginAttributionContext } from "@plurnk/plurnk-meta";
import { resolveProviderCost } from "./cost.ts";
import { validateProviderRequestAccounting } from "./accounting.ts";
import { validateProviderUsage } from "./usage.ts";

export type ProviderFetch = typeof globalThis.fetch;

// Backend wire spellings for the resolved reasoning intent. The switch beside each
// mapping retains any backend-specific omission/explicit-disable constraint.
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort" | "effort_explicit" | "thinking_effort" | "template" | "anthropic";

// GBNF transport is a local llama-server capability. "none" means no
// service-managed constrained sampling; endpoint-owned settings are not inferred.
export type GrammarStyle = "none" | "llamacpp";

export type CacheAffinity =
    | { readonly target: "header" | "body"; readonly name: string }
    | { readonly target: "provider-option"; readonly provider: string; readonly name: string };

export type AiSdkProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

export type AiSdkProviderConfig = {
    model: string;
    url?: string;                             // OpenAI-compatible chat-completions URL
    languageModel?: LanguageModel;            // native AI SDK provider model
    attributions?: (context: PluginAttributionContext) => PluginAttribution;
    fetchTimeoutMs: number;                    // one physical generation attempt; zero disables
    operationTimeoutMs: number;                // complete logical call across retries/backoff; zero disables
    firstContentTimeoutMs: number;             // first semantic streamed content; zero disables
    streamIdleTimeoutMs?: number;             // semantic streamed-content idle deadline; zero/unset disables
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    fetch?: ProviderFetch;                    // per-instance request executor; default globalThis.fetch
    contextWindow?: number | null;              // default null; caller resolves-or-fails, narrows to required with the interface
    reasoningStyle?: ReasoningStyle;          // default "none"
    reasoningResponseStyle?: ReasoningResponseStyle; // {§provider-tagged-reasoning}; default "verbatim"
    countPromptTokens?: (messages: readonly ChatMessage[], signal?: AbortSignal) => PromptTokenMeasurement | Promise<PromptTokenMeasurement>;
    estimateCost?: (usage: ProviderUsage | undefined) => ProviderCost;
    normalizeCost?: ProviderCostNormalizer;
    source?: string;                           // notice/problem source, e.g. "provider:openai"; default "provider"
    grammarStyle?: GrammarStyle;               // how a GBNF grammar is carried; default "none" (not sent)
    // {§provider-cache-affinity} Provider routes own the exact documented
    // projection; the common transport only applies it as managed request state.
    cacheAffinity?: CacheAffinity;
    // {§provider-cache-write-policy} Already policy-gated by provider construction.
    // The transport attaches it to only the final leading system instruction.
    systemCacheProviderOptions?: AiSdkProviderOptions;
    // Optional provider-configured service tier. Unlike caller sampling, this is
    // a fixed deployment choice and therefore wins on every request.
    serviceTier?: string;
    gbnfDebug?: boolean;                        // PLURNK_PROVIDERS_GBNF_DEBUG: validate the grammar locally + throw on invalid, but DON'T transport it (run unconstrained); default false
    streaming?: boolean;                        // SSE transport (default true); false → one non-streamed JSON
    firstPartyMetadata?: boolean;              // forward per-turn attributions + client as Plurnk-* headers (plurnk only); default false
    apiKeyRejectedMessage?: string;            // friendly hint when a present key is 401/403-rejected (distinct from unset); default undefined
    eosText?: string;                          // server-reported eos_token, stripped from the content tail (--special renders it as text); default undefined
    // Slot affinity wiring is provider-internal, never consumer-facing.
    supportsSlotPinning?: boolean;             // backend accepts an `id_slot` body field (llama-server); default false
    slotCount?: number | null;                 // probed slot count for pinning backends; default null
    // Backend-served exact tokenization (llama-server /tokenize). When set, the
    // provider exposes the optional `tokenize()` capability — the model's OWN
    // vocab, no client-side tokenizer data needed; default unset (capability absent).
    tokenizeUrl?: string;
    // Provider-authoritative count of a complete chat-completions request. This
    // is distinct from /tokenize, which sees content but not the chat template.
    promptTokensUrl?: string;
    // The backend's self-reported served model id (from the /v1/models probe),
    // surfaced as Provider.servedModel. For a local llama-server the wire `model` is
    // the alias; this is the real name (the .gguf) the tokenizer seam maps. Absent
    // when no probe ran or it read no row.
    servedModel?: string;
    // Backend decodes unbounded without a caller cap (llama-server n_predict
    // to the wall) — surfaced as Provider.requiresMaxTokens so consumers can
    // boot-refuse an envelope-less local alias. Default unset (no claim).
    requiresMaxTokens?: boolean;
    // The side-channel reasoning intent — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_REASONING + _BUDGET, read via reasoningFromEnv):
    // { mode: off|adaptive|on, budget: iff on }. The provider maps it to the
    // backend's mechanism via reasoningStyle; budget is only ever a magnitude,
    // never a hidden activation flag.
    reasoning: Reasoning;
    // Decode tuning: no in-code defaults; the canonical measured values (0.2 /
    // 1.15) ship as the floor in .env.defaults (alias-scopable). `temperature` is the
    // DEFAULT for EVERY request, spread UNDER caller sampling.
    // `repeatPenalty` is the FLOOR the provider manages wherever a grammar rides
    // (greedy-under-mask loops without it) — the VALUE is operator config;
    // WHERE it applies stays mechanism.
    temperature: number;
    repeatPenalty: number;
    // Anti-degeneration guard on the cloud path (grammarStyle "none"), where the
    // repeat_penalty multiplier isn't available - the OpenAI-standard frequency_penalty.
    // Optional (default 0 = off) so an out-of-date plugin that omits it just runs unguarded
    // rather than failing construction; the standard factory always supplies it.
    frequencyPenalty?: number;
    // Optional llama.cpp anti-repetition controls. DRY can suppress long
    // repeated sequences, but it can also corrupt exact repetition required by
    // PLURNK operations. The portable default is off; these fields ride only
    // after an explicit operator opt-in. repeatLastN widens the repeat window.
    dryMultiplier?: number;
    dryBase?: number;
    dryAllowedLength?: number;
    repeatLastN?: number;
    // Transient-failure retry budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_RETRY_ATTEMPTS, a non-negative int): 0 = surface the
    // first failure; N = up to N retries on a transient error
    // ({§provider-failure-normalization}).
    retryAttempts: number;
    // Maximum characters retained from an upstream diagnostic in the public
    // ProviderError Problem. Standard factories supply the env-owned value;
    // direct construction may omit it to preserve the complete diagnostic.
    errorDetailLimit?: number;
    // Data-capture knobs ({§provider-evidence}), off by default — the flag is the isolation, so a
    // serving turn requests nothing and carries nothing. `topLogprobs`: when a
    // non-negative int, request `logprobs:true, top_logprobs:<n>` and surface the
    // per-token confidence on assistant.logprobs (PLURNK_PROVIDERS_TOP_LOGPROBS;
    // null = off). `rawBody`: when true, attach the verbatim wire body to
    // response.rawBody (PLURNK_PROVIDERS_RAWBODY). Both universal — any backend,
    // gated per-alias.
    topLogprobs?: number | null;
    rawBody?: boolean;
    // {§provider-generation-envelope} The generation-envelope reserves, env-read via
    // envelopeFromEnv — a percentage of the DETECTED window or an absolute token
    // count. Optional so an out-of-date sibling keeps constructing (no claim);
    // the standard factory always supplies them. Resolved against contextWindow
    // at read time (getters), so a probe that lands after config assembly still
    // derives correctly.
    reasoningReserve?: ReserveSpec;
    completionReserve?: ReserveSpec;
    // The plurnk.ai router owns tuning — false suppresses the
    // client-side temperature/penalty FLOORS on this provider (caller `sampling`
    // still passes through verbatim). Default true (floors ride).
    tuningFloors?: boolean;
};

class ProviderRequestObserverError extends Error {
    constructor(cause: unknown) {
        super("provider request accounting could not be durably settled", { cause });
        this.name = "ProviderRequestObserverError";
    }
}

class ProviderRequestAccountingError extends Error {
    constructor(cause: unknown) {
        super("provider request accounting could not be normalized", { cause });
        this.name = "ProviderRequestAccountingError";
    }
}

// Drop trailing occurrences of a server-rendered EOG marker. llama-server
// under --special renders EOS as literal text, so a raw-EOS-ended turn carries a
// trailing <eos> the grammar never sanctioned. Trailing-only + exact-match, so it
// can never eat body content (a body ending in the literal marker isn't producible
// under the grammar, and is vanishingly rare unconstrained).
const stripTrailingSpecial = (content: string, marker: string): string => {
    if (marker.length === 0) return content;
    let out = content;
    while (out.endsWith(marker)) out = out.slice(0, -marker.length);
    return out;
};

type TaggedReasoningProjection = {
    readonly content: string;
    readonly reasoning: string;
    readonly projected: boolean;
    readonly contentStart: number;
};

const projectLeadingReasoning = (
    content: string,
    structuredReasoning: string,
    opening: string,
    closing: string,
): TaggedReasoningProjection => {
    if (structuredReasoning.length > 0 || !content.startsWith(opening)) {
        return { content, reasoning: structuredReasoning, projected: false, contentStart: 0 };
    }
    const closingIndex = content.indexOf(closing, opening.length);
    if (closingIndex === -1) {
        return {
            content: "",
            reasoning: content.slice(opening.length),
            projected: true,
            contentStart: [...content].length,
        };
    }
    const suffixStart = closingIndex + closing.length;
    return {
        content: content.slice(suffixStart),
        reasoning: content.slice(opening.length, closingIndex),
        projected: true,
        contentStart: [...content.slice(0, suffixStart)].length,
    };
};

// {§provider-tagged-reasoning} Only the model-contract position is structural:
// one exact leading envelope. Parsing after stream assembly keeps SSE and JSON
// on one path and leaves later literal tags in the visible suffix untouched.
const projectTaggedReasoning = (
    content: string,
    structuredReasoning: string,
    style: ReasoningResponseStyle,
): TaggedReasoningProjection => style === "think-tags"
    ? projectLeadingReasoning(content, structuredReasoning, "<think>", "</think>")
    : { content, reasoning: structuredReasoning, projected: false, contentStart: 0 };

// llama-server's template reasoning parser can project either supported leading
// reasoning envelope out of the OpenAI-compatible response. Grammar evidence
// needs the sentence before that lossy projection, so constrained template turns
// request it verbatim and split the observed enclosure here.
const projectTemplateReasoning = (content: string): TaggedReasoningProjection => {
    for (const [opening, closing] of [
        ["<|channel>thought\n", "<channel|>"],
        ["<think>\n", "</think>"],
    ] as const) {
        if (content.startsWith(opening)) return projectLeadingReasoning(content, "", opening, closing);
    }
    return { content, reasoning: "", projected: false, contentStart: 0 };
};

// Shared budget→effort breakpoints (xai and google had identical copies).
export const effortFromBudget = (budget: number): "low" | "medium" | "high" => {
    if (budget <= 1000) return "low";
    if (budget <= 4000) return "medium";
    return "high";
};

// Body keys the provider owns — a caller's `sampling` passthrough may not set
// these. Two families:
//   transport/managed — grammar transport, the stream/JSON choice, slot pinning,
//     data capture ({§provider-evidence}: backend-specific fields never cross the contract);
//   contract invariants — `n` (atomic single completion: choices[0] is the
//     response; n>1 = paid, dropped output), the tool-calling family (tools-in-
//     body doctrine, §2: native tool_calls return null content = a broken turn),
//     modalities/audio (text-only contract), prediction (decode semantics, not
//     sampling), and the token caps (the envelope is the managed maxTokens —
//     sampling must not bypass the consumer's cap).
// Sampling intent (temperature, top_p, penalties, stop, seed, logit_bias) and
// platform knobs (user, service_tier, prompt_cache_*, safety_identifier,
// metadata, store, verbosity) pass through; the managed floors spread UNDER
// sampling stay deliberately caller-overridable.
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
    "model", "messages", "stream", "stream_options", "grammar", "response_format", "id_slot", "logprobs", "top_logprobs",
    "reasoning_format", "reasoning_effort", "thinking", "think", "include_reasoning", "chat_template_kwargs", "thinking_budget_tokens", // lexicon-allow: backend wire fields
    "n", "tools", "tool_choice", "functions", "function_call", "parallel_tool_calls",
    "modalities", "audio", "prediction", "max_tokens", "max_completion_tokens",
    "prompt_cache_key",
]);

export default class AiSdkProvider implements Provider {
    #model: string;
    #url: string | undefined;
    #languageModel: LanguageModel | undefined;
    #fetchTimeoutMs: number;
    #operationTimeoutMs: number;
    #firstContentTimeoutMs: number;
    #streamIdleTimeoutMs: number | undefined;
    #headers: Record<string, string>;
    #fetch: ProviderFetch;
    #hasApiKey = false;
    #apiKeyRejectedMessage: string | undefined;
    #eosText: string | undefined;
    #contextWindow: number | null;
    #reasoning: Reasoning;
    #temperature: number;
    #repeatPenalty: number;
    #frequencyPenalty: number;
    #dryMultiplier: number | undefined;
    #dryBase: number | undefined;
    #dryAllowedLength: number | undefined;
    #repeatLastN: number | undefined;
    #reasoningStyle: ReasoningStyle;
    #reasoningResponseStyle: ReasoningResponseStyle;
    #countPromptTokens: (messages: readonly ChatMessage[], signal?: AbortSignal) => PromptTokenMeasurement | Promise<PromptTokenMeasurement>;
    #promptTokensUrl: string | undefined;
    #estimateCost: (usage: ProviderUsage | undefined) => ProviderCost;
    #normalizeCost?: ProviderCostNormalizer;
    #source: string;
    #grammarStyle: GrammarStyle;
    #cacheAffinity: CacheAffinity | undefined;
    #systemCacheProviderOptions: AiSdkProviderOptions | undefined;
    #serviceTier: string | undefined;
    #gbnfDebug: boolean;
    #streaming: boolean;
    #firstPartyMetadata: boolean;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #retryAttempts: number;
    #errorDetailLimit: number | undefined;
    #topLogprobs: number | null;
    #reasoningReserve: ReserveSpec | undefined;
    #completionReserve: ReserveSpec | undefined;
    #tuningFloors: boolean;
    #rawBody: boolean;
    #servedModel: string | undefined;
    #requiresMaxTokens: boolean | undefined;
    readonly attributions?: (context: PluginAttributionContext) => PluginAttribution;

    // Optional capability ({§provider-local-capabilities}): exact tokenization served by the backend's
    // own vocab. Assigned in the constructor ONLY when the config carries a
    // tokenizeUrl (llama-server), so `provider.tokenize === undefined` remains
    // the honest capability signal for every other backend.
    tokenize?: (text: string) => Promise<number[]>;
    constructor(config: AiSdkProviderConfig) {
        this.#model = config.model;
        this.#url = config.url;
        this.#languageModel = config.languageModel;
        this.attributions = config.attributions;
        if ((this.#url === undefined) === (this.#languageModel === undefined)) {
            throw new Error(`${config.source ?? "provider"}: configure exactly one AI SDK model or OpenAI-compatible URL`);
        }
        for (const [name, value] of [
            ["fetchTimeoutMs", config.fetchTimeoutMs],
            ["operationTimeoutMs", config.operationTimeoutMs],
            ["firstContentTimeoutMs", config.firstContentTimeoutMs],
            ["streamIdleTimeoutMs", config.streamIdleTimeoutMs],
        ] as const) {
            if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > MAX_PROVIDER_TIMEOUT_MS)) {
                throw new Error(`${config.source ?? "provider"}: ${name} must be an integer from 0 through ${MAX_PROVIDER_TIMEOUT_MS} milliseconds`);
            }
        }
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#operationTimeoutMs = config.operationTimeoutMs;
        this.#firstContentTimeoutMs = config.firstContentTimeoutMs;
        this.#streamIdleTimeoutMs = config.streamIdleTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.#contextWindow = config.contextWindow ?? null;
        this.#reasoning = config.reasoning;
        // Loud guard: an out-of-date consumer (stale plugin dist) omitting the
        // required tuning fields must fail at construction, not silently send
        // undefined sampling on every grammar request.
        if (typeof config.temperature !== "number" || typeof config.repeatPenalty !== "number") {
            throw new Error(`${config.source ?? "provider"}: AiSdkProviderConfig requires temperature + repeatPenalty (PLURNK_PROVIDERS_TEMPERATURE / _REPEAT_PENALTY)`);
        }
        this.#temperature = config.temperature;
        this.#repeatPenalty = config.repeatPenalty;
        this.#frequencyPenalty = typeof config.frequencyPenalty === "number" ? config.frequencyPenalty : 0;
        this.#dryMultiplier = config.dryMultiplier;
        this.#dryBase = config.dryBase;
        this.#dryAllowedLength = config.dryAllowedLength;
        this.#repeatLastN = config.repeatLastN;
        this.#retryAttempts = config.retryAttempts;
        this.#errorDetailLimit = config.errorDetailLimit;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        this.#reasoningResponseStyle = config.reasoningResponseStyle ?? "verbatim";
        if (config.countPromptTokens !== undefined && config.promptTokensUrl !== undefined) {
            throw new Error(`${config.source ?? "provider"}: configure countPromptTokens or promptTokensUrl, not both`);
        }
        this.#countPromptTokens = config.countPromptTokens ?? ((messages) => estimatePromptTokens(messages));
        this.#promptTokensUrl = config.promptTokensUrl;
        this.#estimateCost = config.estimateCost
            ?? (() => ({
                kind: "unknown",
                reason: "the request reported no direct cost and no model rate is configured",
            }));
        this.#normalizeCost = config.normalizeCost;
        this.#source = config.source ?? "provider";
        this.#grammarStyle = config.grammarStyle ?? "none";
        this.#cacheAffinity = config.cacheAffinity;
        this.#systemCacheProviderOptions = config.systemCacheProviderOptions;
        if (this.#languageModel === undefined && this.#cacheAffinity?.target === "provider-option") {
            throw new Error(`${this.#source}: native provider-option cache affinity requires an AI SDK model`);
        }
        if (this.#languageModel !== undefined && this.#cacheAffinity?.target === "body") {
            throw new Error(`${this.#source}: body cache affinity requires an OpenAI-compatible URL`);
        }
        if (this.#languageModel === undefined && this.#systemCacheProviderOptions !== undefined) {
            throw new Error(`${this.#source}: system cache provider options require an AI SDK model`);
        }
        this.#serviceTier = config.serviceTier;
        this.#gbnfDebug = config.gbnfDebug ?? false;
        this.#streaming = config.streaming ?? true;
        this.#firstPartyMetadata = config.firstPartyMetadata ?? false;
        this.#apiKeyRejectedMessage = config.apiKeyRejectedMessage;
        this.#eosText = config.eosText;
        this.#hasApiKey = "Authorization" in this.#headers;
        this.#supportsSlotPinning = config.supportsSlotPinning ?? false;
        this.#slotCount = config.slotCount ?? null;
        this.#topLogprobs = config.topLogprobs ?? null;
        this.#reasoningReserve = config.reasoningReserve;
        this.#completionReserve = config.completionReserve;
        this.#tuningFloors = config.tuningFloors ?? true;
        this.#rawBody = config.rawBody ?? false;
        this.#servedModel = config.servedModel;
        this.#requiresMaxTokens = config.requiresMaxTokens;
        const reasoningReserve = this.reasoningReserve;
        if (this.#reasoningStyle === "template"
            && this.#reasoning.mode === "on"
            && reasoningReserve !== null
            && this.#reasoning.budget! > reasoningReserve) {
            throw new Error(`${this.#source}: PLURNK_PROVIDERS_REASONING_BUDGET (${this.#reasoning.budget}) exceeds the resolved PLURNK_PROVIDERS_REASONING_RESERVE (${reasoningReserve})`);
        }
        const { tokenizeUrl } = config;
        if (tokenizeUrl !== undefined) {
            this.tokenize = async (text: string): Promise<number[]> => {
                const res = await this.#fetch(tokenizeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...this.#headers },
                    body: JSON.stringify({ content: text }),
                    ...(this.#fetchTimeoutMs > 0
                        ? { signal: AbortSignal.timeout(this.#fetchTimeoutMs) }
                        : {}),
                });
                if (!res.ok) throw new Error(`${this.#source}: tokenize endpoint returned ${res.status}`);
                const { tokens } = (await res.json()) as { tokens?: unknown };
                if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "number")) {
                    throw new Error(`${this.#source}: tokenize endpoint returned no token array`);
                }
                return tokens;
            };
        }
    }

    get contextWindow(): number | null { return this.#contextWindow; }
    // {§provider-generation-envelope} Envelope reserves — absolute pins stand alone; percentages need the
    // detected window; null = underivable (no claim for core's no-cap path).
    #resolveReserve(spec: ReserveSpec | undefined): number | null {
        if (spec === undefined) return null;
        if ("tokens" in spec) return spec.tokens;
        return this.#contextWindow === null ? null : Math.round(spec.percent * this.#contextWindow);
    }
    get reasoningReserve(): number | null { return this.#resolveReserve(this.#reasoningReserve); }
    get completionReserve(): number | null { return this.#resolveReserve(this.#completionReserve); }
    get model(): string { return this.#model; }
    // Backend's self-reported served id; undefined when unprobed/unknown.
    get servedModel(): string | undefined { return this.#servedModel; }
    // Resolved "decodes unbounded without a cap" fact; undefined = no claim.
    get requiresMaxTokens(): boolean | undefined { return this.#requiresMaxTokens; }
    // Resolved capability: will a transported grammar actually constrain
    // this backend's decode? Introspectable so a consumer can verify the rails
    // are LIVE without spending a generation on a forcing-grammar probe.
    get constrainsOutput(): boolean { return this.#grammarStyle !== "none"; }

    async countPromptTokens(
        messages: readonly ChatMessage[],
        signal?: AbortSignal,
    ): Promise<PromptTokenMeasurement> {
        if (this.#promptTokensUrl === undefined) {
            return assertPromptTokenMeasurement(
                await this.#countPromptTokens(messages, signal),
                this.#source,
            );
        }

        signal?.throwIfAborted();
        try {
            const timeout = this.#fetchTimeoutMs > 0
                ? AbortSignal.timeout(this.#fetchTimeoutMs)
                : undefined;
            const requestSignal = signal === undefined
                ? timeout
                : timeout === undefined
                    ? signal
                    : AbortSignal.any([signal, timeout]);
            const response = await this.#fetch(this.#promptTokensUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...this.#headers },
                body: JSON.stringify({
                    model: this.#model,
                    messages,
                    ...this.#reasoningBody(),
                }),
                ...(requestSignal === undefined ? {} : { signal: requestSignal }),
            });
            if (!response.ok) {
                return estimatePromptTokens(
                    messages,
                    `llama-server input-token endpoint returned HTTP ${response.status}`,
                );
            }
            const body = await response.json() as { input_tokens?: unknown };
            if (!Number.isInteger(body.input_tokens) || (body.input_tokens as number) < 0) {
                return estimatePromptTokens(
                    messages,
                    "llama-server input-token endpoint returned no non-negative integer input_tokens",
                );
            }
            return {
                kind: "exact",
                tokens: body.input_tokens as number,
                source: "llama-server:/v1/chat/completions/input_tokens",
            };
        } catch (cause) {
            signal?.throwIfAborted();
            return estimatePromptTokens(
                messages,
                `llama-server input-token measurement failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }
    // Reasoning activation and allowance are independent of grammar transport;
    // only the response representation becomes lossless when evidence is needed.
    // The llama-server template mapping is owned by {§llama-reasoning-request}.
    #reasoningBody(preserveGrammarSentence = false): Record<string, unknown> {
        const { mode, budget } = this.#reasoning;
        const on = mode !== "off";
        switch (this.#reasoningStyle) {
            case "template": {
                const allowance = mode === "off"
                    ? 0
                    : mode === "on" ? budget : this.reasoningReserve;
                return {
                    chat_template_kwargs: { enable_thinking: on },
                    reasoning_format: preserveGrammarSentence ? "none" : "auto",
                    ...(allowance === null ? {} : { thinking_budget_tokens: allowance }),
                };
            }
            case "think": return on ? { think: true } : {};
            case "include_reasoning": return on ? { include_reasoning: true } : {};
            // effort tiers from the budget; off/adaptive omit the field (the
            // API's default depth is its adaptive).
            case "effort": return mode === "on" ? { reasoning_effort: effortFromBudget(budget!) } : {};
            // Fireworks enum: OFF is sent EXPLICITLY ("none") — omission leaves a
            // reason-by-default model (DeepSeek V4: default 'high') reasoning.
            // ADAPTIVE omits the field: the backend's own default posture IS the
            // adaptive semantics, and the literal "adaptive" is MiniMax-M3-only —
            // Fireworks 400s it for every other model (wire-verified; the
            // 1.0.2 adaptive default refused to boot on it). V4 gotcha: integer
            // efforts 400.
            case "effort_explicit": return mode === "off"
                ? { reasoning_effort: "none" }
                : mode === "on" ? { reasoning_effort: effortFromBudget(budget!) } : {};
            // {§deepseek-reasoning-request}
            case "thinking_effort": return mode === "off"
                ? { thinking: { type: "disabled" } }
                : mode === "on" ? {
                    thinking: { type: "enabled" },
                    reasoning_effort: effortFromBudget(budget!),
                } : {};
            // Anthropic compat: explicit thinking object. off → disabled; on →
            // enabled with budget_tokens; adaptive → omit (the API default).
            case "anthropic": return mode === "off"
                ? { thinking: { type: "disabled" } }
                : mode === "on" ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
            case "none": return {};
        }
    }

    // Per-worker slot affinity: the consumer passes which worker this is; the
    // provider owns WHICH slot serves it. Sticky per workerId, round-robin across
    // new runs (distinct runs → distinct slots while slots last), LRU-bounded
    // bookkeeping so a long-lived daemon never grows the map unboundedly —
    // an evicted-and-returning run simply re-pins, worst case one cold prefill.
    #runSlots = new Map<string, number>();
    #nextSlot = 0;

    #slotBody(workerId: string): Record<string, unknown> {
        if (!this.#supportsSlotPinning || this.#slotCount === null || this.#slotCount < 1) return {};
        let slot = this.#runSlots.get(workerId);
        if (slot === undefined) {
            slot = this.#nextSlot++ % this.#slotCount;
            if (this.#runSlots.size >= this.#slotCount * 8) {
                this.#runSlots.delete(this.#runSlots.keys().next().value as string);
            }
        } else {
            this.#runSlots.delete(workerId); // re-insert to refresh LRU recency
        }
        this.#runSlots.set(workerId, slot);
        return { id_slot: slot };
    }

    // Optional local llama-server GBNF transport ({§gbnf-response-observation}). Unsupported
    // backends receive no grammar-related field.
    #grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined) return {};
        switch (this.#grammarStyle) {
            // Greedy decoding under hard constraint loops without a repeat-penalty
            // floor — llama.cpp spells it `repeat_penalty`.
            case "llamacpp": return { grammar, repeat_penalty: this.#repeatPenalty };
            case "none": return {};
        }
    }

    // Anti-degeneration default on every request, keyed to the backend's wire
    // convention - NOT grammar-bound. GBNF is a local constraint, so a cloud
    // alias runs the sampler bare: firefast (deepseek/fireworks) ran 4/86 bench turns
    // straight to the token cap on pure looped repetition (run52). Ships next to
    // temperature so caller `sampling` can tune it; the grammar path re-asserts it as a
    // managed FLOOR in #grammarBody. llama.cpp takes the repeat_penalty
    // MULTIPLIER; the plain cloud path ("none") can't, so it gets
    // frequency_penalty - OpenAI-standard, accepted by every OpenAI-compat backend (verified
    // live: together/deepinfra/fireworks; it is OpenAI's own param, so real OpenAI takes it too).
    #repetitionPenaltyBody(): Record<string, unknown> {
        switch (this.#grammarStyle) {
            // repeat_penalty + optional DRY (repeated-sequence penalty) + a wider
            // repeat_last_n window — the loop-breaking tools a llama.cpp backend serves.
            // Each rides only when its operator knob is set; absent = the box's default.
            case "llamacpp": return {
                repeat_penalty: this.#repeatPenalty,
                ...(this.#repeatLastN !== undefined ? { repeat_last_n: this.#repeatLastN } : {}),
                ...(this.#dryMultiplier !== undefined && this.#dryMultiplier > 0 ? {
                    dry_multiplier: this.#dryMultiplier,
                    ...(this.#dryBase !== undefined ? { dry_base: this.#dryBase } : {}),
                    ...(this.#dryAllowedLength !== undefined ? { dry_allowed_length: this.#dryAllowedLength } : {}),
                } : {}),
            };
            case "none": return this.#frequencyPenalty > 0 ? { frequency_penalty: this.#frequencyPenalty } : {};
        }
    }

    // First-party telemetry headers ({§provider-request-authority} {§provider-call-kind}): forwarded only when the spec
    // opted in (the plurnk endpoint). The gate is here, not at the call site, so
    // attributions/client/strikes can never reach a third-party backend even if
    // the consumer passes them to the wrong provider. Empty values emit no header
    // — EXCEPT strikes, where 0 is a real value (clean streak) distinct from
    // absent (consumer didn't report); contract {§strikes-first-party-metadata}. Strikes
    // ride HTTP headers only — the packet never carries them (the model must
    // never see strike state; engine accounting is not a metric to game).
    #metadataHeaders(attributions: string[] | undefined, client: string | undefined, strikes: number | undefined, workerId: string, primaryWorkerId: string | undefined, workspaceId: string | undefined, loop: number | undefined, turn: number | undefined, callKind: ProviderCallKind | undefined): Record<string, string> {
        if (!this.#firstPartyMetadata) return {};
        const h: Record<string, string> = {};
        if (attributions !== undefined && attributions.length > 0) h["Plurnk-Attribution"] = JSON.stringify(attributions);
        if (client !== undefined && client.length > 0) h["Plurnk-Client"] = client;
        if (strikes !== undefined && Number.isInteger(strikes) && strikes >= 0) h["Plurnk-Strikes"] = String(strikes);
        // Worker identity: the opaque workerId
        // the consumer already supplies, forwarded so the endpoint can key
        // per-worker affinity/telemetry — same gate as every first-party signal.
        h["Plurnk-Worker-Id"] = workerId;
        // Root worker of the lineage ({§worker-primary}): the no-parent ancestor of this turn's
        // worker tree. The consumer classifies primary-vs-spawned by equality
        // (primaryWorkerId == workerId ⇒ the primary/root worker). The provider
        // EMITS what the consumer supplies and never invents a primary; the
        // consumer's contract is to stamp it EVERY turn (including the primary's
        // own, where it equals workerId). Absence is the consumer's violation for
        // the endpoint to surface, not a provider default.
        if (primaryWorkerId !== undefined && primaryWorkerId.length > 0) h["Plurnk-Worker-Primary"] = primaryWorkerId;
        // Turn coordinate ({§lifecycle-terms}): workspace/loop/turn, the
        // daemon-side sequence the endpoint can never scrape from the wire.
        // Coordinates are 1-based — 0 is not a real value, so no strikes-style
        // zero exception; absent/empty/0 emits no header.
        if (workspaceId !== undefined && workspaceId.length > 0) h["Plurnk-Workspace-Id"] = workspaceId;
        if (loop !== undefined && Number.isInteger(loop) && loop >= 1) h["Plurnk-Loop"] = String(loop);
        if (turn !== undefined && Number.isInteger(turn) && turn >= 1) h["Plurnk-Turn"] = String(turn);
        if (callKind !== undefined) h["Plurnk-Call-Kind"] = callKind;
        return h;
    }

    // PLURNK_PROVIDERS_GBNF_DEBUG ({§gbnf-response-observation}): validate the supplied GBNF locally and fail
    // hard if it's malformed, BEFORE any wire call — and the grammar is NOT
    // transported, so the request runs unconstrained. A debug aid to catch invalid
    // grammars (e.g. while editing the plurnk grammar) without a model round-trip;
    // off in production. `validateGbnf(grammar, "")` parses the grammar + resolves
    // its root, throwing iff the grammar itself is invalid (the empty input's
    // verdict is irrelevant — we only care that parsing succeeded).
    #assertGrammarValid(grammar: string): void {
        try {
            validateGbnf(grammar, "");
        } catch (cause) {
            throw new Error(`grammar validation (PLURNK_PROVIDERS_GBNF_DEBUG): invalid GBNF — ${(cause as Error).message}`, { cause });
        }
    }

    // Per-turn metadata bag: pass the backend's non-standard top-level fields
    // through verbatim. Providers do not reinterpret vendor currency or account
    // metadata; a monetary value carries its own amount and currency.
    #buildMeta(chunkMetadata: Record<string, unknown>): Record<string, unknown> | undefined {
        const meta: Record<string, unknown> = { ...chunkMetadata };
        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    // Caller-supplied OpenAI-compat sampling params (temperature, top_p, top_k,
    // penalties, stop, seed, …) merged UNDER the managed body: model, messages,
    // reasoning, grammar (+ its repeat-penalty floor), max_tokens and slot always
    // win, and reserved transport/protocol keys are stripped so the passthrough
    // can't smuggle a grammar, a stream toggle, or a backend slot
    // ({§provider-request-authority}).
    #samplingBody(sampling: Record<string, unknown> | undefined): Record<string, unknown> {
        if (sampling === undefined) return {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(sampling)) if (!RESERVED_BODY_KEYS.has(k)) out[k] = v;
        return out;
    }

    #accounting(
        outcome: ProviderRequestAccounting["outcome"],
        usage: ProviderUsage | undefined,
        evidence: Parameters<ProviderCostNormalizer>[0],
        status?: number,
    ): ProviderRequestAccounting {
        const knownUsage = usage === undefined ? undefined : validateProviderUsage(usage);
        const direct = this.#normalizeCost?.(evidence);
        return validateProviderRequestAccounting({
            provider: this.#source,
            model: this.#model,
            outcome,
            ...(status === undefined ? {} : { status }),
            ...(knownUsage === undefined ? {} : { usage: knownUsage }),
            cost: resolveProviderCost(direct, this.#estimateCost(knownUsage)),
        });
    }

    async generate({ messages, workerId, primaryWorkerId, signal, grammar, maxTokens, attributions, client, strikes, workspaceId, loop, turn, sampling, observeRequest, callKind }: ProviderGenerateArgs): Promise<ProviderResponse> {
        // {§provider-interface} The worker identity is required.
        if (workerId === undefined || workerId.length === 0) throw new Error("generate: workerId is required — the worker's stable, opaque identity");
        if (callKind !== undefined && callKind !== "emission" && callKind !== "bare") {
            throw new Error(`generate: unsupported callKind ${JSON.stringify(callKind)}`);
        }
        // Reject before any wire call when already aborted
        // ({§provider-failure-normalization}).
        signal?.throwIfAborted();

        // Grammar handling ({§gbnf-response-observation}). Debug validates the
        // supplied grammar before the call but withholds it from the backend.
        const wantGrammar = grammar !== undefined && this.#grammarStyle !== "none";
        if (wantGrammar && this.#gbnfDebug) this.#assertGrammarValid(grammar!);
        const sendGrammar = wantGrammar && !this.#gbnfDebug ? grammar : undefined;
        const preserveGrammarSentence = wantGrammar
            && this.#reasoningStyle === "template";

        // Assembly order = precedence: the family's sampling DEFAULTS
        // (PLURNK_PROVIDERS_TEMPERATURE — universal, measured on grammar
        // paths and the name promises every request) < the caller's `sampling`
        // < the managed fields, which always win.
        const body: Record<string, unknown> = {
            // Floors are suppressed on router-owned-tuning providers (plurnk) —
            // the router's per-model tuning must not be overridden by client floors.
            ...(this.#tuningFloors ? { temperature: this.#temperature, ...this.#repetitionPenaltyBody() } : {}),
            ...this.#samplingBody(sampling),
            ...(this.#serviceTier !== undefined ? { service_tier: this.#serviceTier } : {}),
            model: this.#model,
            messages,
            ...this.#reasoningBody(preserveGrammarSentence),
            ...this.#grammarBody(sendGrammar),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            // Request per-token logprobs only when enabled (managed field —
            // reserved from caller sampling; the env flag is the single control).
            ...(this.#topLogprobs !== null ? { logprobs: true, top_logprobs: this.#topLogprobs } : {}),
            ...this.#slotBody(workerId),
            ...(this.#cacheAffinity?.target === "body"
                ? { [this.#cacheAffinity.name]: workerId }
                : {}),
        };

        // Per-request headers = static auth/routing + any first-party telemetry.
        const metaHeaders = this.#metadataHeaders(attributions, client, strikes, workerId, primaryWorkerId, workspaceId, loop, turn, callKind);
        const headers = new Headers(this.#headers);
        if (this.#cacheAffinity?.target === "header") {
            headers.set(this.#cacheAffinity.name, workerId);
        }
        for (const [name, value] of Object.entries(metaHeaders)) headers.set(name, value);
        const requestHeaders = Object.fromEntries(headers.entries());
        const accounting: ProviderRequestAccounting[] = [];
        const operationTimeout = this.#operationTimeoutMs > 0
            ? AbortSignal.timeout(this.#operationTimeoutMs)
            : undefined;
        const operationSignal = signal === undefined
            ? operationTimeout
            : operationTimeout === undefined
                ? signal
                : AbortSignal.any([signal, operationTimeout]);
        const executeRequest = async () => {
            let settle: ProviderRequestSettlement | undefined;
            try {
                settle = await observeRequest?.({
                    provider: this.#source,
                    model: this.#model,
                });
            } catch (cause) {
                throw new ProviderRequestObserverError(cause);
            }
            const settleAccounting = async (
                outcome: ProviderRequestAccounting["outcome"],
                usage: ProviderUsage | undefined,
                evidence: Parameters<ProviderCostNormalizer>[0],
                status?: number,
            ): Promise<ProviderRequestAccounting> => {
                let requestAccounting: ProviderRequestAccounting;
                let normalizationFailure: { cause: unknown } | undefined;
                try {
                    requestAccounting = this.#accounting(outcome, usage, evidence, status);
                } catch (cause) {
                    normalizationFailure = { cause };
                    let knownUsage: ProviderUsage | undefined;
                    try {
                        knownUsage = usage === undefined ? undefined : validateProviderUsage(usage);
                    } catch {
                        knownUsage = undefined;
                    }
                    requestAccounting = validateProviderRequestAccounting({
                        provider: this.#source,
                        model: this.#model,
                        outcome,
                        ...(status === undefined ? {} : { status }),
                        ...(knownUsage === undefined ? {} : { usage: knownUsage }),
                        cost: {
                            kind: "unknown",
                            reason: "provider request accounting could not be normalized after physical I/O",
                        },
                    });
                }
                accounting.push(requestAccounting);
                try {
                    await settle?.(requestAccounting);
                } catch (cause) {
                    throw new ProviderRequestObserverError(cause);
                }
                if (normalizationFailure !== undefined) {
                    throw new ProviderRequestAccountingError(normalizationFailure.cause);
                }
                return requestAccounting;
            };
            let response;
            try {
                response = this.#languageModel === undefined
                    ? await executeOpenAICompatible({
                        url: this.#url!,
                        model: this.#model,
                        headers: requestHeaders,
                        body,
                        messages,
                        signal: operationSignal,
                        fetch: this.#fetch,
                        fetchTimeoutMs: this.#fetchTimeoutMs,
                        firstContentTimeoutMs: this.#firstContentTimeoutMs,
                        streamIdleTimeoutMs: this.#streamIdleTimeoutMs,
                        streaming: this.#streaming,
                        captureRawBody: this.#rawBody,
                    })
                    : await executeAiSdkModel({
                        languageModel: this.#languageModel,
                        headers: requestHeaders,
                        providerOptions: this.#cacheAffinity?.target === "provider-option"
                            ? {
                                [this.#cacheAffinity.provider]: {
                                    [this.#cacheAffinity.name]: workerId,
                                },
                            }
                            : undefined,
                        systemProviderOptions: this.#systemCacheProviderOptions,
                        messages,
                        signal: operationSignal,
                        fetchTimeoutMs: this.#fetchTimeoutMs,
                        firstContentTimeoutMs: this.#firstContentTimeoutMs,
                        streamIdleTimeoutMs: this.#streamIdleTimeoutMs,
                        streaming: this.#streaming,
                        captureRawBody: this.#rawBody,
                        temperature: this.#tuningFloors
                            ? (typeof sampling?.temperature === "number" ? sampling.temperature : this.#temperature)
                            : typeof sampling?.temperature === "number" ? sampling.temperature : undefined,
                        topP: typeof sampling?.top_p === "number" ? sampling.top_p : undefined,
                        topK: typeof sampling?.top_k === "number" ? sampling.top_k : undefined,
                        presencePenalty: typeof sampling?.presence_penalty === "number" ? sampling.presence_penalty : undefined,
                        frequencyPenalty: typeof sampling?.frequency_penalty === "number"
                            ? sampling.frequency_penalty
                            : this.#tuningFloors && this.#frequencyPenalty > 0 ? this.#frequencyPenalty : undefined,
                        stopSequences: typeof sampling?.stop === "string"
                            ? [sampling.stop]
                            : Array.isArray(sampling?.stop) && sampling.stop.every((value) => typeof value === "string")
                                ? sampling.stop
                                : undefined,
                        seed: typeof sampling?.seed === "number" ? sampling.seed : undefined,
                        maxOutputTokens: maxTokens,
                        reasoning: this.#reasoning.mode === "off"
                            ? "none"
                            : this.#reasoning.mode === "adaptive"
                                ? "provider-default"
                                : effortFromBudget(this.#reasoning.budget!),
                    });
            } catch (error) {
                const failure = transportFailureEvidence(error);
                await settleAccounting(
                    "error",
                    failure.usage,
                    failure.chargeEvidence,
                    failure.status,
                );
                throw error;
            }
            await settleAccounting(
                "response",
                response.usage,
                response.chargeEvidence,
            );
            return response;
        };

        let raw;
        try {
            const { retry } = prepareRetries({
                maxRetries: this.#retryAttempts,
                abortSignal: operationSignal,
            });
            raw = await retry(executeRequest);
        } catch (err) {
            if (err instanceof ProviderRequestObserverError
                || err instanceof ProviderRequestAccountingError) throw err.cause;
            if (signal?.aborted) throw err;
            if (operationTimeout?.aborted) {
                const timeout = new ProviderTimeoutError("operation", this.#operationTimeoutMs, err);
                throw new ProviderError(this.#source, "deadline_exceeded", timeout.message, {
                    status: 504,
                    cause: timeout,
                    retryable: false,
                    extensions: {
                        timeoutPhase: timeout.phase,
                        timeoutMs: timeout.timeoutMs,
                    },
                    accounting,
                });
            }
            const pe = toProviderError(err, this.#source, this.#errorDetailLimit);
            if ((pe.status === 401 || pe.status === 403) && this.#hasApiKey && this.#apiKeyRejectedMessage !== undefined) {
                throw new ProviderError(this.#source, "unauthorized", this.#apiKeyRejectedMessage, {
                    status: pe.status,
                    cause: err,
                    accounting,
                });
            }
            pe.prependAccounting(accounting);
            throw pe;
        }

        // llama-server --special renders EOG tokens as text, so a turn ending
        // via raw EOS carries a trailing <eos> the grammar never sanctioned - it both
        // false-rejects the rail verdict and leaks a control token into the packet.
        // Strip the server-reported eos_token from the tail ONCE, before the verdict
        // grades it and before it reaches assistant/packet. rawBody keeps the verbatim
        // wire text for forensics.
        if (this.#eosText !== undefined) raw.content = stripTrailingSpecial(raw.content, this.#eosText);

        const grammarInput = raw.content;
        const projectedReasoning = preserveGrammarSentence && !raw.reasoningProjected
            ? projectTemplateReasoning(raw.content)
            : projectTaggedReasoning(
                raw.content,
                raw.reasoning,
                this.#reasoningResponseStyle,
            );

        // Preserve the exact pre-projection response. Constrained template turns
        // request `reasoning_format: "none"`, so even an empty channel and any
        // template-provided opener remain observable. An unexpectedly projected
        // response cannot supply independent evidence.
        let grammarEvidence: GrammarEvidence | undefined;
        if (wantGrammar) {
            if (preserveGrammarSentence) {
                if (!raw.reasoningProjected) {
                    grammarEvidence = {
                        input: grammarInput,
                        contentStart: projectedReasoning.projected ? projectedReasoning.contentStart : 0,
                        transported: sendGrammar !== undefined,
                    };
                }
            } else if (projectedReasoning.projected) {
                grammarEvidence = {
                    input: grammarInput,
                    contentStart: projectedReasoning.contentStart,
                    transported: sendGrammar !== undefined,
                };
            } else {
                grammarEvidence = {
                    input: grammarInput,
                    contentStart: 0,
                    transported: sendGrammar !== undefined,
                };
            }
        }

        if (projectedReasoning.projected) {
            raw.content = projectedReasoning.content;
            raw.reasoning = projectedReasoning.reasoning;
        }

        let notices: ProviderNotice[] | undefined;
        const usage = raw.usage;
        if (sendGrammar !== undefined
            && this.tokenize !== undefined
            && usage?.outputTokens !== undefined) {
            // Channel-escape detector: completion tokens
            // billed far beyond every visible channel mean the decode ESCAPED into
            // a server-discarded reasoning block mid-emission. This diagnostic
            // requires the serving vocabulary; an estimate cannot prove absence.
            try {
                const [contentTokens, reasoningTokens] = await Promise.all([
                    this.tokenize(raw.content),
                    this.tokenize(raw.reasoning),
                ]);
                const visible = contentTokens.length + reasoningTokens.length;
                if (usage.outputTokens > visible + 64) {
                    (notices ??= []).push({
                        source: this.#source,
                        kind: "grammar_unenforced",
                        level: "warn",
                        message: `decode escaped the grammar: ${usage.outputTokens} output tokens billed but only ${visible} visible across content+reasoning — the balance ran unconstrained in a discarded reasoning channel`,
                        position: [...raw.content].length,
                    });
                }
            } catch (cause) {
                emitWarningOnce(
                    `${this.#source}: exact visible-token diagnostic unavailable (${cause instanceof Error ? cause.message : String(cause)})`,
                    "PLURNK_VISIBLE_TOKEN_COUNT_UNAVAILABLE",
                );
            }
        }

        const meta = this.#buildMeta(raw.metadata);
        const logprobs = raw.logprobs.length > 0 ? raw.logprobs : undefined;
        const meanLogprob = logprobs !== undefined
            ? logprobs.reduce((sum, token) => sum + token.logprob, 0) / logprobs.length
            : undefined;

        const assistant = {
            content: raw.content,
            reasoning: raw.reasoning.length > 0 ? raw.reasoning : null,
            ...(raw.reasoningEncrypted.length > 0
                ? { reasoningEncrypted: raw.reasoningEncrypted }
                : {}),
            model: raw.model,
            ...(logprobs !== undefined ? { logprobs, meanLogprob } : {}),
        };
        const evidence = {
            assistantRaw: raw,
            accounting,
            ...(grammarEvidence !== undefined ? { grammarEvidence } : {}),
            ...(raw.rawBody !== undefined ? { rawBody: raw.rawBody } : {}),
            ...(meta !== undefined ? { meta } : {}),
            ...(notices !== undefined ? { notices } : {}),
        };
        if (raw.finishReason === "resource_interrupted") {
            const attempt: ProviderResponse<"resource_interrupted"> = {
                assistant: { ...assistant, finishReason: raw.finishReason },
                ...evidence,
            };
            throw new ProviderError(
                this.#source,
                "resource_interrupted",
                "The provider interrupted generation because inference resources were unavailable.",
                {
                    attempt,
                    accounting,
                    extensions: {
                        stage: "provider-response",
                        finishReason: "resource_interrupted",
                        ...(raw.rawFinishReason === undefined
                            ? {}
                            : { rawFinishReason: raw.rawFinishReason }),
                    },
                },
            );
        }
        return {
            assistant: { ...assistant, finishReason: raw.finishReason },
            ...evidence,
        };
    }

}
