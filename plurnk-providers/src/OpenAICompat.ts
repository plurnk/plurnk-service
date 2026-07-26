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
import type { Reasoning, ReserveSpec } from "./env.ts";
import { chatCompletionStream, chatCompletion, OpenAiHttpError, isEdgeStatus, type ProviderFetch, type StreamResponse } from "./openaiStream.ts";
import { normalizeUsage } from "./usage.ts";
import { toProviderError, classifyProviderError, ProviderError, type TelemetryEvent } from "./telemetry.ts";
import { validateGbnf, type Verdict } from "@plurnk/gbnf";
import { emitWarningOnce } from "./warnings.ts";

// How the reasoning intent (PLURNK_PROVIDERS_REASONING: off | adaptive | on, plus
// REASONING_BUDGET iff on — #32/#33) translates to each backend's wire mechanism
// (SPEC §4); the per-style mapping lives in #reasoningBody. Non-obvious ones:
// "template" ALWAYS emits enable_thinking — the explicit false is llama-server's
// only working off-switch (§13); "anthropic" uses the `thinking` object and IGNORES
// reasoning_effort; "effort_explicit" (fireworks) sends the EXPLICIT "none" for OFF
// instead of omitting — reason-by-DEFAULT models (DeepSeek V4 defaults
// 'high') keep reasoning when the field is omitted, fatal under an active grammar
// (#30). Intent maps IDENTICALLY with or without a transported grammar — fireworks
// masks only the content channel, so reasoning and rails coexist in one call
// (canary-verified; the #32 clamp is lifted — it caused the plan-less service#331).
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort" | "effort_explicit" | "template" | "anthropic";

// GBNF transport is a local llama-server capability. "none" means no
// service-managed constrained sampling; endpoint-owned settings are not inferred.
export type GrammarStyle = "none" | "llamacpp";

export type OpenAICompatConfig = {
    model: string;
    url: string;                              // fully-resolved chat-completions URL
    fetchTimeoutMs: number;
    streamIdleTimeoutMs?: number;             // streamed body inter-chunk deadline; zero/unset disables
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    fetch?: ProviderFetch;                    // per-instance request executor; default globalThis.fetch
    contextWindow?: number | null;              // default null; caller resolves-or-fails (#419), narrows to required with the interface
    reasoningStyle?: ReasoningStyle;          // default "none"
    countTokens?: (text: string) => number;   // default chars/2 upper-bound heuristic
    calculateCost?: (usage: ProviderUsage) => number; // default () => 0
    source?: string;                           // telemetry source, e.g. "provider:openai"; default "provider"
    grammarStyle?: GrammarStyle;               // how a GBNF grammar is carried; default "none" (not sent)
    // #518: send the OpenAI-standard `prompt_cache_key` set to workerId, so a
    // serverless backend with REPLICA-LOCAL prompt caching (fireworks, verified)
    // pins a worker's turns to one replica and claims its stable prefix. Default
    // false -- a backend that strict-validates unknown fields 400s, so enable only
    // where the field is accepted. Same identity that already drives slot affinity.
    promptCacheKey?: boolean;
    // Optional provider-configured service tier. Unlike caller sampling, this is
    // a fixed deployment choice and therefore wins on every request.
    serviceTier?: string;
    gbnfDebug?: boolean;                        // PLURNK_PROVIDERS_GBNF_DEBUG: validate the grammar locally + throw on invalid, but DON'T transport it (run unconstrained); default false
    streaming?: boolean;                        // SSE transport (default true); false → one non-streamed JSON
    firstPartyMetadata?: boolean;              // forward per-turn attributions + client as Plurnk-* headers (plurnk only); default false
    apiKeyRejectedMessage?: string;            // #537: friendly hint when a PRESENT key is 401/403-rejected (distinct from unset); default undefined
    eosText?: string;                          // #539: server-reported eos_token, stripped from the content tail (--special renders it as text); default undefined
    // Slot affinity wiring (provider-INTERNAL — never consumer-facing, #11).
    supportsSlotPinning?: boolean;             // backend accepts an `id_slot` body field (llama-server); default false
    slotCount?: number | null;                 // probed slot count for pinning backends; default null
    // Backend-served exact tokenization (llama-server /tokenize). When set, the
    // provider exposes the optional `tokenize()` capability — the model's OWN
    // vocab, no client-side tokenizer data needed; default unset (capability absent).
    tokenizeUrl?: string;
    // #37: the backend's self-reported served model id (from the /v1/models probe),
    // surfaced as Provider.servedModel. For a local llama-server the wire `model` is
    // the alias; this is the real name (the .gguf) the tokenizer seam maps. Absent
    // when no probe ran or it read no row.
    servedModel?: string;
    // #43: backend decodes unbounded without a caller cap (llama-server n_predict
    // to the wall) — surfaced as Provider.requiresMaxTokens so consumers can
    // boot-refuse an envelope-less local alias. Default unset (no claim).
    requiresMaxTokens?: boolean;
    // The side-channel reasoning intent — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_REASONING + _BUDGET, read via reasoningFromEnv):
    // { mode: off|adaptive|on, budget: iff on }. The provider maps it to the
    // backend's mechanism via reasoningStyle; budget is only ever a magnitude,
    // never a hidden activation flag (#33).
    reasoning: Reasoning;
    // Decode tuning: no in-code defaults; the canonical measured values (0.2 /
    // 1.15) ship as the floor in .env.defaults (alias-scopable). `temperature` is the
    // DEFAULT for EVERY request, spread UNDER caller sampling (#30/endpoint#7).
    // `repeatPenalty` is the FLOOR the provider manages wherever a grammar rides
    // (greedy-under-mask loops without it, #9) — the VALUE is operator config;
    // WHERE it applies stays mechanism. `retryDelayMs` is the transient-retry
    // backoff base (attempt N waits retryDelayMs * 2^(N-1); Retry-After wins).
    temperature: number;
    repeatPenalty: number;
    // #426: anti-degeneration guard on the CLOUD path (grammarStyle "none"), where the
    // repeat_penalty multiplier isn't available - the OpenAI-standard frequency_penalty.
    // Optional (default 0 = off) so an out-of-date plugin that omits it just runs unguarded
    // rather than failing construction; the standard factory always supplies it.
    frequencyPenalty?: number;
    // #567: llama.cpp anti-repetition-LOOP controls, sent on the llamacpp path (DRY is a
    // llama.cpp sampler). DRY penalizes repeated SEQUENCES with a penalty escalating in run
    // length — the tool for a plan-restart loop a single-token repeat_penalty over a short
    // window can't see. The GENERIC DRY defaults (0.8/1.75/2) ship as a floor in .env.defaults
    // like repeatPenalty — applied for a detected llama.cpp backend, customer-overridable;
    // absent (a plugin omitting them) = the box's own default. repeatLastN widens the window.
    dryMultiplier?: number;
    dryBase?: number;
    dryAllowedLength?: number;
    repeatLastN?: number;
    retryDelayMs: number;
    // Transient-failure retry budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_RETRY_ATTEMPTS, a non-negative int): 0 = surface the
    // first failure; N = up to N retries on a transient error (§4, #18).
    retryAttempts: number;
    // Data-capture knobs (#36), OFF by default — the flag IS the isolation, so a
    // serving turn requests nothing and carries nothing. `topLogprobs`: when a
    // non-negative int, request `logprobs:true, top_logprobs:<n>` and surface the
    // per-token confidence on assistant.logprobs (PLURNK_PROVIDERS_TOP_LOGPROBS;
    // null = off). `rawBody`: when true, attach the verbatim wire body to
    // response.rawBody (PLURNK_PROVIDERS_RAWBODY). Both universal — any backend,
    // gated per-alias.
    topLogprobs?: number | null;
    rawBody?: boolean;
    // #507 (owner-ruled): the generation-envelope reserves, env-read via
    // envelopeFromEnv — a percentage of the DETECTED window or an absolute token
    // count. Optional so an out-of-date sibling keeps constructing (no claim);
    // the standard factory always supplies them. Resolved against contextWindow
    // at read time (getters), so a probe that lands after config assembly still
    // derives correctly.
    reasoningReserve?: ReserveSpec;
    completionReserve?: ReserveSpec;
    // #507: the plurnk.ai router owns tuning (SPEC §5) — false suppresses the
    // client-side temperature/penalty FLOORS on this provider (caller `sampling`
    // still passes through verbatim). Default true (floors ride).
    tuningFloors?: boolean;
};

// Transient classifications worth retrying: rate_limit (429) and network_failure
// (5xx, timeout, connection reset) are transport; grammar_invalid (a 422 output
// reject a fresh sample may satisfy, #548) rides the same bounded budget.
// unauthorized, quota_exceeded, invalid_response, model_refused are terminal —
// retrying just burns time and budget.
const RETRYABLE: ReadonlySet<string> = new Set(["rate_limit", "network_failure", "grammar_invalid"]);

// #539: drop trailing occurrences of a server-rendered EOG marker. llama-server
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

// Sleep that rejects the moment `signal` aborts (caller cancellation must not
// wait out a backoff). Resolves normally on timeout.
const sleepWithAbort = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });

// SPEC §2 closed set. The four canonical values pass through; known per-backend
// synonyms translate INTO them (anthropic max_tokens/end_turn, gemini MAX_TOKENS/
// SAFETY/RECITATION) so a token-cap hit canonicalizes to "length" whatever the
// backend names it -- core's `finishReason === "length"` truncation check (#425)
// is then an invariant by construction, not a convention each backend must
// independently honor. A non-empty value outside both the set and the table
// collapses to null AND warns once, so a new backend's unmapped cap string
// surfaces instead of silently becoming "no signal" (which would make core miss
// the truncation entirely). Case-folded: gemini shouts its reasons.
const FINISH_SYNONYMS = new Map<string, Exclude<FinishReason, null>>([
    ["stop", "stop"], ["length", "length"], ["tool_calls", "tool_calls"], ["content_filter", "content_filter"],
    ["max_tokens", "length"], ["model_length", "length"], ["max_completion_tokens", "length"],
    ["end_turn", "stop"], ["stop_sequence", "stop"], ["eos_token", "stop"],
    ["tool_use", "tool_calls"],
    ["safety", "content_filter"], ["recitation", "content_filter"],
]);
const normalizeFinishReason = (raw: string | null): FinishReason => {
    if (raw === null || raw.length === 0) return null;
    const hit = FINISH_SYNONYMS.get(raw.toLowerCase());
    if (hit !== undefined) return hit;
    emitWarningOnce(
        `unrecognized finish_reason "${raw}"; treated as no-signal (finishReason=null). If it denotes a token-cap hit, core's length-cap detection will miss it -- add it to FINISH_SYNONYMS.`,
        "PLURNK_FINISH_REASON_UNKNOWN",
    );
    return null;
};

// Shared budget→effort breakpoints (xai and google had identical copies).
export const effortFromBudget = (budget: number): "low" | "medium" | "high" => {
    if (budget <= 1000) return "low";
    if (budget <= 4000) return "medium";
    return "high";
};

// chars/2 upper bound (see ./tokenizers.ts) — overcounts safely, never under.
const heuristicTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 2));

// Body keys the provider owns — a caller's `sampling` passthrough may not set
// these. Two families (#477 audit):
//   transport/managed — grammar transport, the stream/JSON choice, slot pinning,
//     data capture (SPEC §8: backend-specific fields never cross the contract);
//   contract invariants — `n` (atomic single completion: choices[0] is the
//     response; n>1 = paid, dropped output), the tool-calling family (tools-in-
//     body doctrine, §2: native tool_calls return null content = a broken turn),
//     modalities/audio (text-only contract), prediction (decode semantics, not
//     sampling), and the token caps (the envelope is the managed maxTokens —
//     sampling must not bypass the consumer's #425 cap).
// Sampling intent (temperature, top_p, penalties, stop, seed, logit_bias) and
// platform knobs (user, service_tier, prompt_cache_*, safety_identifier,
// metadata, store, verbosity) pass through; the managed floors spread UNDER
// sampling stay deliberately caller-overridable.
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
    "model", "messages", "stream", "stream_options", "grammar", "response_format", "id_slot", "logprobs", "top_logprobs",
    "n", "tools", "tool_choice", "functions", "function_call", "parallel_tool_calls",
    "modalities", "audio", "prediction", "max_tokens", "max_completion_tokens",
    "prompt_cache_key",
]);

// Render a non-accept verdict into a terse, factual grammar_unenforced message
// (SPEC §12 message policy: no guidance prose). `reject` names the diverging code
// point + what the grammar would have accepted; `incomplete` names the valid-prefix
// length that never reached a terminal state.
const describeUnenforced = (v: Exclude<Verdict, { status: "accept" }>): string => {
    if (v.status === "reject") {
        const expected = v.expected.length > 0
            ? v.expected.map((e) => `${e.rule} accepts ${e.accepts}`).join(", ")
            : "end of input";
        return `grammar not enforced: output rejected by the transported grammar at code point ${v.pos} (${JSON.stringify(v.char)}); expected ${expected}`;
    }
    return `grammar not enforced: output is an incomplete match of the transported grammar — a valid prefix of ${v.pos} code points that never terminated`;
};

export default class OpenAICompatProvider implements Provider {
    #model: string;
    #url: string;
    #fetchTimeoutMs: number;
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
    #retryDelayMs: number;
    #reasoningStyle: ReasoningStyle;
    #countTokens: (text: string) => number;
    #calculateCost: (usage: ProviderUsage) => number;
    #source: string;
    #grammarStyle: GrammarStyle;
    #promptCacheKey: boolean;
    #serviceTier: string | undefined;
    #gbnfDebug: boolean;
    #streaming: boolean;
    #firstPartyMetadata: boolean;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #retryAttempts: number;
    #topLogprobs: number | null;
    #reasoningReserve: ReserveSpec | undefined;
    #completionReserve: ReserveSpec | undefined;
    #tuningFloors: boolean;
    #rawBody: boolean;
    #servedModel: string | undefined;
    #requiresMaxTokens: boolean | undefined;

    // Optional capability (SPEC §2): exact tokenization served by the backend's
    // own vocab. Assigned in the constructor ONLY when the config carries a
    // tokenizeUrl (llama-server), so `provider.tokenize === undefined` remains
    // the honest capability signal for every other backend.
    tokenize?: (text: string) => Promise<number[]>;

    constructor(config: OpenAICompatConfig) {
        this.#model = config.model;
        this.#url = config.url;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#streamIdleTimeoutMs = config.streamIdleTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.#contextWindow = config.contextWindow ?? null;
        this.#reasoning = config.reasoning;
        // Loud guard: an out-of-date consumer (stale plugin dist) omitting the
        // required tuning fields must fail at construction, not silently send
        // undefined sampling on every grammar request.
        if (typeof config.temperature !== "number" || typeof config.repeatPenalty !== "number" || typeof config.retryDelayMs !== "number") {
            throw new Error(`${config.source ?? "provider"}: OpenAICompatConfig requires temperature + repeatPenalty + retryDelayMs (PLURNK_PROVIDERS_TEMPERATURE / _REPEAT_PENALTY / _RETRY_DELAY) — rebuild against providers >= 0.33.0`);
        }
        this.#temperature = config.temperature;
        this.#repeatPenalty = config.repeatPenalty;
        this.#frequencyPenalty = typeof config.frequencyPenalty === "number" ? config.frequencyPenalty : 0;
        this.#dryMultiplier = config.dryMultiplier;
        this.#dryBase = config.dryBase;
        this.#dryAllowedLength = config.dryAllowedLength;
        this.#repeatLastN = config.repeatLastN;
        this.#retryDelayMs = config.retryDelayMs;
        this.#retryAttempts = config.retryAttempts;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        this.#countTokens = config.countTokens ?? heuristicTokens;
        this.#calculateCost = config.calculateCost ?? (() => 0);
        this.#source = config.source ?? "provider";
        this.#grammarStyle = config.grammarStyle ?? "none";
        this.#promptCacheKey = config.promptCacheKey ?? false;
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
        const { tokenizeUrl } = config;
        if (tokenizeUrl !== undefined) {
            this.tokenize = async (text: string): Promise<number[]> => {
                const res = await this.#fetch(tokenizeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...this.#headers },
                    body: JSON.stringify({ content: text }),
                    signal: AbortSignal.timeout(this.#fetchTimeoutMs),
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
    // #507: envelope reserves — absolute pins stand alone; percentages need the
    // detected window; null = underivable (no claim for core's no-cap path).
    #resolveReserve(spec: ReserveSpec | undefined): number | null {
        if (spec === undefined) return null;
        if ("tokens" in spec) return spec.tokens;
        return this.#contextWindow === null ? null : Math.round(spec.percent * this.#contextWindow);
    }
    get reasoningReserve(): number | null { return this.#resolveReserve(this.#reasoningReserve); }
    get completionReserve(): number | null { return this.#resolveReserve(this.#completionReserve); }
    get model(): string { return this.#model; }
    // #37: backend's self-reported served id; undefined when unprobed/unknown.
    get servedModel(): string | undefined { return this.#servedModel; }
    // #43: resolved "decodes unbounded without a cap" fact; undefined = no claim.
    get requiresMaxTokens(): boolean | undefined { return this.#requiresMaxTokens; }
    // Resolved capability (#34): will a transported grammar actually constrain
    // this backend's decode? Introspectable so a consumer can verify the rails
    // are LIVE without spending a generation on a forcing-grammar probe.
    get constrainsOutput(): boolean { return this.#grammarStyle !== "none"; }

    countTokens(text: string): number { return this.#countTokens(text); }
    calculateCost(usage: ProviderUsage): number { return this.#calculateCost(usage); }

    // Maps the reasoning INTENT (off | adaptive | on+budget, #33) to the
    // backend's wire mechanism — including under a transported grammar. The #32
    // clamp (force reasoning_effort "none" under response_format) is LIFTED:
    // canary-verified live that fireworks masks ONLY the content channel — the
    // reasoning channel rides beside it unmasked, and the plurnk grammar's
    // reasoning?/preplan regions absorb any in-band spillover. The old measured
    // failures (low→cycles, high→spirals) were pre-max_tokens-cap; with a bounded
        // cap the matrix ACCEPTs across efforts (reasoning-rails matrix
    // F9). Clamping was the root of the plan-less regression (service#331).
    #reasoningBody(): Record<string, unknown> {
        const { mode, budget } = this.#reasoning;
        const on = mode !== "off";
        switch (this.#reasoningStyle) {
            // Native-channel styles. "template" ALWAYS emits — the explicit
            // enable_thinking:false is the only working off-switch on llama-server
            // (§13). Activation only; budget is enforced by the box's
            // --reasoning-budget launch flag (per-request numerics ignored, F7).
            //
            // #488 postmortem: intent maps IDENTICALLY under a transported
            // grammar. The brief rails-win-the-channel clamp (enable_thinking
            // forced false under a grammar) is REVERTED — specimens proved the
            // SANCTIONED think block is the protection, not the hazard: the
            // server auto-gates the grammar around it and content decodes
            // constrained (26-run baseline green; zero grammar rejects across
            // the #488 "railless" specimens). Closing the channel starved a
            // reasoning-tuned model into ESCAPING mid-content into the raw
            // thought channel — discarded server-side, decode unconstrained,
            // 12,288 tokens billed for 1,033 visible chars. The escape is
            // surfaced instead (vanished-token telemetry + meta rail state).
            case "template": return { chat_template_kwargs: { enable_thinking: on } };
            case "think": return on ? { think: true } : {};
            case "include_reasoning": return on ? { include_reasoning: true } : {};
            // effort tiers from the budget; off/adaptive omit the field (the
            // API's default depth is its adaptive).
            case "effort": return mode === "on" ? { reasoning_effort: effortFromBudget(budget!) } : {};
            // Fireworks enum: OFF is sent EXPLICITLY ("none") — omission leaves a
            // reason-by-default model (DeepSeek V4: default 'high') reasoning (#30).
            // ADAPTIVE omits the field: the backend's own default posture IS the
            // adaptive semantics, and the literal "adaptive" is MiniMax-M3-only —
            // fireworks 400s it for every other model (wire-verified, #403; the
            // 1.0.2 adaptive default refused to boot on it). V4 gotcha: integer
            // efforts 400.
            case "effort_explicit": return mode === "off"
                ? { reasoning_effort: "none" }
                : mode === "on" ? { reasoning_effort: effortFromBudget(budget!) } : {};
            // Anthropic compat: explicit thinking object. off → disabled; on →
            // enabled with budget_tokens; adaptive → omit (the API default).
            case "anthropic": return mode === "off"
                ? { thinking: { type: "disabled" } }
                : mode === "on" ? { thinking: { type: "enabled", budget_tokens: budget } } : {};
            case "none": return {};
        }
    }

    // Per-run slot affinity (#11): the consumer passes WHICH run this is; the
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

    // Optional local llama-server GBNF transport (SPEC §13). Unsupported
    // backends receive no grammar-related field.
    #grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined) return {};
        switch (this.#grammarStyle) {
            // Greedy decoding under hard constraint loops without a repeat-penalty
            // floor (#9, SPEC §13) — llama.cpp spells it `repeat_penalty`.
            case "llamacpp": return { grammar, repeat_penalty: this.#repeatPenalty };
            case "none": return {};
        }
    }

    // Anti-degeneration DEFAULT on EVERY request (#426), keyed to the backend's wire
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
            // #567: repeat_penalty + optional DRY (repeated-SEQUENCE penalty) + a wider
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

    // First-party telemetry headers (SPEC §5): forwarded ONLY when the spec
    // opted in (the plurnk endpoint). The gate is here, not at the call site, so
    // attributions/client/strikes can never reach a third-party backend even if
    // the consumer passes them to the wrong provider. Empty values emit no header
    // — EXCEPT strikes, where 0 is a real value (clean streak) distinct from
    // absent (consumer didn't report); contract per plurnk-service#313. Strikes
    // ride HTTP headers only — the packet never carries them (the model must
    // never see strike state; engine accounting is not a metric to game).
    #metadataHeaders(attributions: string[] | undefined, client: string | undefined, strikes: number | undefined, workerId: string, primaryWorkerId: string | undefined, workspaceId: string | undefined, loop: number | undefined, turn: number | undefined): Record<string, string> {
        if (!this.#firstPartyMetadata) return {};
        const h: Record<string, string> = {};
        if (attributions !== undefined && attributions.length > 0) h["Plurnk-Attribution"] = JSON.stringify(attributions);
        if (client !== undefined && client.length > 0) h["Plurnk-Client"] = client;
        if (strikes !== undefined && Number.isInteger(strikes) && strikes >= 0) h["Plurnk-Strikes"] = String(strikes);
        // Worker identity (#26, wire-name completed #486/#511): the opaque workerId
        // the consumer already supplies, forwarded so the endpoint can key
        // per-worker affinity/telemetry — same gate as every first-party signal.
        h["Plurnk-Worker-Id"] = workerId;
        // Root worker of the lineage (#522): the no-parent ancestor of this turn's
        // worker tree. The consumer classifies primary-vs-spawned by equality
        // (primaryWorkerId == workerId ⇒ the primary/root worker). The provider
        // EMITS what the consumer supplies and never invents a primary; the
        // consumer's contract is to stamp it EVERY turn (including the primary's
        // own, where it equals workerId). Absence is the consumer's violation for
        // the endpoint to surface, not a provider default.
        if (primaryWorkerId !== undefined && primaryWorkerId.length > 0) h["Plurnk-Worker-Primary"] = primaryWorkerId;
        // Turn coordinate (#404, extends #26 per #391): workspace/loop/turn, the
        // daemon-side sequence the endpoint can never scrape from the wire.
        // Coordinates are 1-based — 0 is not a real value, so no strikes-style
        // zero exception; absent/empty/0 emits no header.
        if (workspaceId !== undefined && workspaceId.length > 0) h["Plurnk-Workspace-Id"] = workspaceId;
        if (loop !== undefined && Number.isInteger(loop) && loop >= 1) h["Plurnk-Loop"] = String(loop);
        if (turn !== undefined && Number.isInteger(turn) && turn >= 1) h["Plurnk-Turn"] = String(turn);
        return h;
    }

    // Enforcement verification (SPEC §13). When a grammar was actually transported
    // (grammarStyle !== "none"), the backend MUST have constrained the output;
    // some silently drop the grammar field or mislabel the channel, and without
    // this check we would return unconstrained output as if enforced. STRICT: any
    // non-accept verdict (reject, or an incomplete/never-terminated match) is a
    // grammar_unenforced failure. A grammar our own validator can't parse — even
    // though the backend accepted it (a port-vs-llama.cpp gap) — is a non-fatal
    // verify gap: warn, don't fail a transport that may have worked. This is a
    // conformance check against the grammar we already hold, NOT a plurnk-DSL
    // parse (§8) — it stays grammar-generic and backend-agnostic.
    // Validate output against the grammar. Returns the verdict, or null on the
    // verify GAP — a grammar our own validator can't parse (a port-vs-llama.cpp
    // gap): warn, don't manufacture a conflict from a check that didn't run.
    #grammarVerdict(grammar: string, content: string): Verdict | null {
        try {
            return validateGbnf(grammar, content);
        } catch (cause) {
            // Once per (code, message) — #40: this fires PER TURN otherwise.
            emitWarningOnce(
                `${this.#source}: could not verify grammar enforcement — the transported grammar did not parse in @plurnk/gbnf (${(cause as Error).message})`,
                "PLURNK_GRAMMAR_UNVERIFIABLE",
            );
            return null;
        }
    }

    // PLURNK_PROVIDERS_GBNF_DEBUG (SPEC §13): validate the supplied GBNF locally and fail
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

    // Per-turn metadata bag (#23): pass the backend's non-standard top-level fields
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
    // can't smuggle a grammar, a stream toggle, or a backend slot (SPEC §8).
    #samplingBody(sampling: Record<string, unknown> | undefined): Record<string, unknown> {
        if (sampling === undefined) return {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(sampling)) if (!RESERVED_BODY_KEYS.has(k)) out[k] = v;
        return out;
    }

    async generate({ messages, workerId, primaryWorkerId, signal, grammar, maxTokens, attributions, client, strikes, workspaceId, loop, turn, sampling }: { messages: ChatMessage[]; workerId: string; primaryWorkerId?: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; workspaceId?: string; loop?: number; turn?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse> {
        // Boundary validation (SPEC §2): the worker identity is required.
        if (workerId === undefined || workerId.length === 0) throw new Error("generate: workerId is required — the worker's stable, opaque identity");
        // Reject before any wire call when already aborted (SPEC §10.8).
        signal?.throwIfAborted();

        // Grammar handling (SPEC §13). PLURNK_PROVIDERS_GBNF_DEBUG validates the supplied
        // grammar locally and throws on a malformed one, then WITHHOLDS it so the
        // model generates UNCONSTRAINED — and the free output is still verified
        // against the grammar (below), surfacing exactly where the model's natural
        // output and the grammar conflict. Otherwise the grammar is sent when the
        // backend supports it (grammarStyle !== "none").
        const wantGrammar = grammar !== undefined && this.#grammarStyle !== "none";
        if (wantGrammar && this.#gbnfDebug) this.#assertGrammarValid(grammar!);
        const sendGrammar = wantGrammar && !this.#gbnfDebug ? grammar : undefined;

        // Assembly order = precedence: the family's sampling DEFAULTS
        // (PLURNK_PROVIDERS_TEMPERATURE — universal, #30 measured it on grammar
        // paths and the name promises every request) < the caller's `sampling`
        // < the managed fields, which always win.
        const body: Record<string, unknown> = {
            // #507: floors suppressed on router-owned-tuning providers (plurnk) —
            // the router's per-model tuning must not be overridden by client floors.
            ...(this.#tuningFloors ? { temperature: this.#temperature, ...this.#repetitionPenaltyBody() } : {}),
            ...this.#samplingBody(sampling),
            ...(this.#serviceTier !== undefined ? { service_tier: this.#serviceTier } : {}),
            model: this.#model,
            messages,
            ...this.#reasoningBody(),
            ...this.#grammarBody(sendGrammar),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            // #36: request per-token logprobs only when enabled (managed field —
            // reserved from caller sampling; the env flag is the single control).
            ...(this.#topLogprobs !== null ? { logprobs: true, top_logprobs: this.#topLogprobs } : {}),
            ...this.#slotBody(workerId),
            // #518: prompt-cache affinity -- workerId as the OpenAI-standard
            // prompt_cache_key routes a worker's turns to one serverless replica so
            // its stable prefix caches (managed; reserved from caller sampling).
            ...(this.#promptCacheKey ? { prompt_cache_key: workerId } : {}),
        };

        // Transient-failure retry (#18). Each attempt gets a FRESH fetch timeout
        // (the budget is per-request, not shared across retries); the caller's
        // signal spans them all. Retry only the transient classifications, prefer
        // a server Retry-After over the backoff, and let the caller's abort cut
        // through both the in-flight request and the backoff sleep.
        const transport = this.#streaming ? chatCompletionStream : chatCompletion;

        // Per-request headers = static auth/routing + any first-party telemetry.
        const metaHeaders = this.#metadataHeaders(attributions, client, strikes, workerId, primaryWorkerId, workspaceId, loop, turn);
        const headers = Object.keys(metaHeaders).length > 0 ? { ...this.#headers, ...metaHeaders } : this.#headers;
        const transportRetries: Array<{ attempt: number; kind: string; elapsedMs: number; message: string }> = [];
        let raw;
        for (let attempt = 0; ; attempt++) {
            const attemptStarted = performance.now();
            const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
            const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
            try {
                raw = await transport({
                    url: this.#url,
                    headers,
                    body,
                    signal: effectiveSignal,
                    fetch: this.#fetch,
                    captureRawBody: this.#rawBody,
                    streamIdleTimeoutMs: this.#streamIdleTimeoutMs,
                });
                break;
            } catch (err) {
                // Caller-initiated abort is cancellation — never retried or wrapped.
                if (signal?.aborted) throw err;
                const { kind } = classifyProviderError(err);
                // #543: Cloudflare/CDN edge codes (520-527) classify as network_failure
                // but fail-fast - a retry just re-incurs the same origin/edge timeout.
                const edgeTimeout = err instanceof OpenAiHttpError && isEdgeStatus(err.status);
                // Terminal kind, edge failure, or budget spent -> surface the failure.
                if (!RETRYABLE.has(kind) || edgeTimeout || attempt >= this.#retryAttempts) {
                    const pe = toProviderError(err, this.#source);
                    // #537 case 2: a 401/403 with a key PRESENT is a rejected key, not a
                    // transport failure — surface the distinct, actionable hint (kind stays
                    // "unauthorized", so core's routing is unchanged) rather than the raw
                    // upstream JSON. Distinct from the unset-key throw at construction.
                    if ((pe.status === 401 || pe.status === 403) && this.#hasApiKey && this.#apiKeyRejectedMessage !== undefined) {
                        throw new ProviderError(this.#source, "unauthorized", this.#apiKeyRejectedMessage, { status: pe.status, cause: err });
                    }
                    throw pe;
                }
                transportRetries.push({
                    attempt: attempt + 1,
                    kind,
                    elapsedMs: Math.round(performance.now() - attemptStarted),
                    message: err instanceof Error ? err.message : String(err),
                });
                const retryAfter = err instanceof OpenAiHttpError ? err.retryAfter : null;
                await sleepWithAbort(retryAfter ?? this.#retryDelayMs * 2 ** attempt, signal);
            }
        }

        // #539: llama-server --special renders EOG tokens as text, so a turn ending
        // via raw EOS carries a trailing <eos> the grammar never sanctioned - it both
        // false-rejects the rail verdict and leaks a control token into the packet.
        // Strip the server-reported eos_token from the tail ONCE, before the verdict
        // grades it and before it reaches assistant/packet. rawBody keeps the verbatim
        // wire text for forensics.
        if (this.#eosText !== undefined) raw.content = stripTrailingSpecial(raw.content, this.#eosText);

        // Grammar conformance (§13): bytes always flow; the verdict is an
        // observation. Same check whether the grammar was transported
        // (sendGrammar) or withheld (PLURNK_PROVIDERS_GBNF_DEBUG filter mode) — a
        // non-accept verdict attaches a grammar_unenforced telemetry event
        // (message + divergence position) and the response returns normally.
        // Discard/retry/escalate/self-correct is the consumer's policy.
        let telemetry: TelemetryEvent[] | undefined;
        let railsMeta: Record<string, unknown> | undefined;
        const usage = normalizeUsage(raw.usage, raw.reasoning_content, raw.content);
        const observedGrammar = sendGrammar ?? (wantGrammar && this.#gbnfDebug ? grammar : undefined);
        if (observedGrammar !== undefined) {
            const verdict = this.#grammarVerdict(observedGrammar, raw.content);
            if (verdict !== null && verdict.status !== "accept") {
                telemetry = [{ source: this.#source, kind: "grammar_unenforced", message: describeUnenforced(verdict), position: verdict.pos }];
            }
            // #488 per-request loud state: rail attachment + conformance verdict
            // ride `meta` into the consumer's turn row, so a drill reads rail
            // presence PER TURN from the run db instead of inferring it from
            // output shape (the #488 misdiagnosis, twice).
            railsMeta = { railsAttached: sendGrammar !== undefined, railsVerdict: verdict?.status ?? "unverifiable" };
            // #488 channel-escape detector (the run105 class): completion tokens
            // billed far beyond every visible channel mean the decode ESCAPED into
            // a server-discarded reasoning block mid-emission — unconstrained,
            // invisible, billed (12,288 billed vs 1,033 chars visible, live).
            // countTokens OVERCOUNTS text (chars/2 upper bound), so billed
            // exceeding visible-plus-slack is real vanishing, not estimator noise.
            const visible = this.#countTokens(raw.content) + this.#countTokens(raw.reasoning_content);
            if (sendGrammar !== undefined && usage.completion > visible + 64) {
                (telemetry ??= []).push({
                    source: this.#source,
                    kind: "grammar_unenforced",
                    message: `decode escaped the grammar: ${usage.completion} completion tokens billed but only ~${visible} visible across content+reasoning — the balance ran unconstrained in a discarded reasoning channel`,
                    position: [...raw.content].length,
                });
            }
        }

        const builtMeta = this.#buildMeta(raw.chunkMetadata);
        const retryMeta = transportRetries.length > 0 ? { transportRetries } : undefined;
        const meta = railsMeta !== undefined || retryMeta !== undefined
            ? { ...builtMeta, ...railsMeta, ...retryMeta }
            : builtMeta;

        // #36: surface per-token logprobs + their mean when the backend returned
        // them (only possible when the flag requested them). Absent otherwise —
        // never synthesized.
        const logprobs = raw.logprobs !== null && raw.logprobs.length > 0 ? raw.logprobs : undefined;
        const meanLogprob = logprobs !== undefined
            ? logprobs.reduce((sum, t) => sum + t.logprob, 0) / logprobs.length
            : undefined;

        return {
            assistant: {
                content: raw.content,
                reasoning: raw.reasoning_content.length > 0 ? raw.reasoning_content : null,
                // #482: sealed relay blobs ride only when present — same absence
                // discipline as logprobs (never synthesized, never empty-array).
                ...(raw.reasoning_encrypted.length > 0 ? { reasoningEncrypted: raw.reasoning_encrypted } : {}),
                usage,
                finishReason: normalizeFinishReason(raw.finish_reason),
                model: raw.model ?? this.#model,
                ...(logprobs !== undefined ? { logprobs, meanLogprob } : {}),
            },
            assistantRaw: raw,
            ...(raw.rawBody !== undefined ? { rawBody: raw.rawBody } : {}),
            ...(meta !== undefined ? { meta } : {}),
            ...(telemetry !== undefined ? { telemetry } : {}),
        };
    }
}
