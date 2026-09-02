// The provider-specific request body and headers one generate call sends: reasoning, grammar, sampling, repetition, slots, metadata. Split out of AiSdkProvider; every knob it reads is injected.
import type { ProviderCallKind, ReasoningPolicy } from "./types.ts";
import type { JSONValue } from "ai";
import { type Reasoning } from "./env.ts";
import { validateGbnf } from "@plurnk/gbnf";
import { fixedEffort } from "./reasoning-effort.ts";
import type { ReasoningStyle, CompatibleReasoningEffort, GrammarStyle, CacheAffinity, AiSdkProviderOptions } from "./AiSdkProvider.ts";

const isJsonObject = (value: JSONValue | undefined): value is Record<string, JSONValue> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const mergeJsonObjects = (
    left: Record<string, JSONValue | undefined>,
    right: Record<string, JSONValue | undefined>,
): Record<string, JSONValue | undefined> => Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
        const leftValue = left[key];
        const rightValue = right[key];
        return [
            key,
            isJsonObject(leftValue) && isJsonObject(rightValue)
                ? mergeJsonObjects(leftValue, rightValue)
                : rightValue ?? leftValue,
        ];
    }),
);

// Anthropic's older manual-reasoning protocol needs an absolute allowance while
// PLURNK's durable contract names an effort. These fractions match the native
// SDK's policy projection, but apply to PLURNK's total envelope rather than the
// model's physical maximum. The minimum is imposed by the provider protocol.
const MANUAL_REASONING_FRACTIONS = Object.freeze({
    adaptive: 0.6,
    low: 0.1,
    medium: 0.3,
    high: 0.6,
    xhigh: 0.75,
    max: 0.85,
} satisfies Record<Exclude<ReasoningPolicy, "off">, number>);

const MANUAL_REASONING_MINIMUM = 1024;

// Body keys the provider owns — a caller's `sampling` passthrough may not set
// these. Two families:
//   transport/managed — grammar transport, the stream/JSON choice, slot pinning,
//     data capture ({§provider-evidence}: backend-specific fields never cross the contract);
//   contract invariants — `n` (atomic single completion: choices[0] is the
//     response; n>1 = paid, dropped output), the tool-calling family (tools-in-
//     body doctrine, §2: native tool_calls return null content = a broken turn),
//     modalities/audio (text-only contract), prediction (decode semantics, not
//     sampling), and the token caps (the envelope is the managed maxOutputTokens —
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

export default class AiSdkRequestBody {
    readonly #reasoningBudget: number | null;
    readonly #additiveReasoningProvider: "anthropic" | "bedrock" | undefined;
    readonly #reasoning: Reasoning;
    readonly #reasoningToggle: boolean;
    readonly #compatibleAdaptiveReasoning: CompatibleReasoningEffort | "provider-default";
    readonly #compatibleOffReasoning: "none" | undefined;
    readonly #adaptiveReasoningProviderOptions: AiSdkProviderOptions | undefined;
    readonly #repeatPenalty: number | null;
    readonly #frequencyPenalty: number;
    readonly #dryMultiplier: number | undefined;
    readonly #dryBase: number | undefined;
    readonly #dryAllowedLength: number | undefined;
    readonly #repeatLastN: number | undefined;
    readonly #reasoningStyle: ReasoningStyle;
    readonly #source: string;
    readonly #grammarStyle: GrammarStyle;
    readonly #cacheAffinity: CacheAffinity | undefined;
    readonly #reasoningResponseProviderOptions: AiSdkProviderOptions | undefined;
    readonly #firstPartyMetadata: boolean;
    readonly #supportsSlotPinning: boolean;
    readonly #slotCount: number | null;
    #runSlots = new Map<string, number>();
    #nextSlot = 0;

    constructor({ reasoningBudget, additiveReasoningProvider, reasoning, reasoningToggle, compatibleAdaptiveReasoning, compatibleOffReasoning, adaptiveReasoningProviderOptions, repeatPenalty, frequencyPenalty, dryMultiplier, dryBase, dryAllowedLength, repeatLastN, reasoningStyle, source, grammarStyle, cacheAffinity, reasoningResponseProviderOptions, firstPartyMetadata, supportsSlotPinning, slotCount }: {
        reasoningBudget: number | null;
        additiveReasoningProvider: "anthropic" | "bedrock" | undefined;
        reasoning: Reasoning;
        reasoningToggle: boolean;
        compatibleAdaptiveReasoning: CompatibleReasoningEffort | "provider-default";
        compatibleOffReasoning: "none" | undefined;
        adaptiveReasoningProviderOptions: AiSdkProviderOptions | undefined;
        repeatPenalty: number | null;
        frequencyPenalty: number;
        dryMultiplier: number | undefined;
        dryBase: number | undefined;
        dryAllowedLength: number | undefined;
        repeatLastN: number | undefined;
        reasoningStyle: ReasoningStyle;
        source: string;
        grammarStyle: GrammarStyle;
        cacheAffinity: CacheAffinity | undefined;
        reasoningResponseProviderOptions: AiSdkProviderOptions | undefined;
        firstPartyMetadata: boolean;
        supportsSlotPinning: boolean;
        slotCount: number | null;
    }) {
        this.#reasoningBudget = reasoningBudget;
        this.#additiveReasoningProvider = additiveReasoningProvider;
        this.#reasoning = reasoning;
        this.#reasoningToggle = reasoningToggle;
        this.#compatibleAdaptiveReasoning = compatibleAdaptiveReasoning;
        this.#compatibleOffReasoning = compatibleOffReasoning;
        this.#adaptiveReasoningProviderOptions = adaptiveReasoningProviderOptions;
        this.#repeatPenalty = repeatPenalty;
        this.#frequencyPenalty = frequencyPenalty;
        this.#dryMultiplier = dryMultiplier;
        this.#dryBase = dryBase;
        this.#dryAllowedLength = dryAllowedLength;
        this.#repeatLastN = repeatLastN;
        this.#reasoningStyle = reasoningStyle;
        this.#source = source;
        this.#grammarStyle = grammarStyle;
        this.#cacheAffinity = cacheAffinity;
        this.#reasoningResponseProviderOptions = reasoningResponseProviderOptions;
        this.#firstPartyMetadata = firstPartyMetadata;
        this.#supportsSlotPinning = supportsSlotPinning;
        this.#slotCount = slotCount;
    }

    // Reasoning activation and allowance are independent of grammar transport;
    // only the response representation becomes lossless when evidence is needed.
    // The llama-server template mapping is owned by {§llama-reasoning-request}.
    reasoningBody(
        preserveGrammarSentence = false,
        reasoningBudget = this.#reasoningBudget,
    ): Record<string, unknown> {
        const { mode } = this.#reasoning;
        const budget = reasoningBudget;
        const on = mode !== "off";
        switch (this.#reasoningStyle) {
            case "template": {
                const allowance = mode === "off"
                    ? 0
                    : budget;
                // A fixed effort rides into the template as its own variable; adaptive
                // and off send none and leave the template's default in force.
                const templateEffort = mode === "off" || mode === "adaptive" ? {} : { reasoning_effort: fixedEffort(mode) };
                return {
                    chat_template_kwargs: { enable_thinking: on, ...templateEffort },
                    reasoning_format: preserveGrammarSentence ? "none" : "auto",
                    ...(allowance === null ? {} : { thinking_budget_tokens: allowance }),
                };
            }
            case "think": return on ? { think: true } : {};
            case "include_reasoning": return on ? { include_reasoning: true } : {};
            case "effort": return mode === "off"
                ? this.#compatibleOffReasoning === undefined
                    ? {}
                    : { reasoning_effort: this.#compatibleOffReasoning }
                : mode === "adaptive"
                    ? this.#compatibleAdaptiveReasoning === "provider-default"
                        ? {}
                        : { reasoning_effort: this.#compatibleAdaptiveReasoning }
                    : { reasoning_effort: fixedEffort(mode) };
            // Graded reasoning is mandatory when the route advertises an effort
            // value. Cataloged routes supply the exact strongest legal value;
            // construction rejects an unsupported off or fixed policy.
            case "effort_required": {
                if (mode === "off") {
                    if (this.#compatibleOffReasoning === undefined) {
                        throw new TypeError(`${this.#source}: required reasoning effort has no off projection`);
                    }
                    return { reasoning_effort: this.#compatibleOffReasoning };
                }
                if (mode === "adaptive") {
                    return this.#compatibleAdaptiveReasoning === "provider-default"
                        ? {}
                        : { reasoning_effort: this.#compatibleAdaptiveReasoning };
                }
                return { reasoning_effort: fixedEffort(mode) };
            }
            // Fireworks enum: OFF is sent EXPLICITLY ("none") — omission leaves a
            // reason-by-default model (DeepSeek V4: default 'high') reasoning.
            // ADAPTIVE omits the field UNLESS the catalog declares a toggle control:
            // toggle routes (nemotron-lightning) default reasoning OFF, so adaptive
            // sends the documented Fireworks Boolean enable (#457). The literal
            // "adaptive" is MiniMax-M3-only — Fireworks 400s it for every other
            // model (wire-verified; the 1.0.2 adaptive default refused to boot on
            // it). V4 gotcha: integer efforts 400.
            case "effort_explicit": return mode === "off"
                ? { reasoning_effort: "none" }
                : mode === "adaptive"
                    ? this.#reasoningToggle ? { reasoning_effort: true } : {}
                    : { reasoning_effort: fixedEffort(mode) };
            // {§deepseek-reasoning-request}
            case "thinking_effort": return mode === "off"
                ? { thinking: { type: "disabled" } }
                : mode === "adaptive" ? { thinking: { type: "enabled" } } : {
                    thinking: { type: "enabled" },
                    reasoning_effort: fixedEffort(mode),
                };
            // Anthropic-compatible native dynamic or manual budget mode.
            case "anthropic": return mode === "off"
                ? { thinking: { type: "disabled" } }
                : mode === "adaptive" ? { thinking: { type: "adaptive" } } : {
                    thinking: {
                        type: "enabled",
                        budget_tokens: budget!,
                    },
                };
            case "none": return {};
        }
    }

    // Per-worker slot affinity: the consumer passes which worker this is; the
    // provider owns WHICH slot serves it. Sticky per workerId, round-robin across
    // new runs (distinct runs → distinct slots while slots last), LRU-bounded
    // bookkeeping so a long-lived daemon never grows the map unboundedly —
    // an evicted-and-returning run simply re-pins, worst case one cold prefill.

    // Optional local llama-server GBNF transport ({§gbnf-response-observation}). Unsupported
    // backends receive no grammar-related field.
    grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined) return {};
        switch (this.#grammarStyle) {
            // Grammar-constrained decoding can loop under the mask; a configured
            // per-alias repeat_penalty is the measured remedy ({§provider-sampling-passthrough}).
            case "llamacpp": return { grammar, ...(this.#repeatPenalty !== null ? { repeat_penalty: this.#repeatPenalty } : {}) };
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
    repetitionPenaltyBody(): Record<string, unknown> {
        switch (this.#grammarStyle) {
            // repeat_penalty + optional DRY (repeated-sequence penalty) + a wider
            // repeat_last_n window — the loop-breaking tools a llama.cpp backend serves.
            // Each rides only when its operator knob is set; absent = the box's default.
            case "llamacpp": return {
                ...(this.#repeatPenalty !== null ? { repeat_penalty: this.#repeatPenalty } : {}),
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


    // Caller-supplied OpenAI-compat sampling params (temperature, top_p, top_k,
    // penalties, stop, seed, …) merged UNDER the managed body: model, messages,
    // reasoning, grammar (+ its repeat-penalty floor), max_tokens and slot always
    // win, and reserved transport/protocol keys are stripped so the passthrough
    // can't smuggle a grammar, a stream toggle, or a backend slot
    // ({§provider-request-authority}).
    samplingBody(sampling: Record<string, unknown> | undefined): Record<string, unknown> {
        if (sampling === undefined) return {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(sampling)) if (!RESERVED_BODY_KEYS.has(k)) out[k] = v;
        return out;
    }


    slotBody(workerId: string): Record<string, unknown> {
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


    // First-party telemetry headers ({§provider-request-authority} {§provider-call-kind}): forwarded only when the spec
    // opted in (the plurnk endpoint). The gate is here, not at the call site, so
    // attributions/client/strikes can never reach a third-party backend even if
    // the consumer passes them to the wrong provider. Empty values emit no header
    // — EXCEPT strikes, where 0 is a real value (clean streak) distinct from
    // absent (consumer didn't report); contract {§strikes-first-party-metadata}. Strikes
    // ride HTTP headers only — the packet never carries them (the model must
    // never see strike state; engine accounting is not a metric to game).
    metadataHeaders(attributions: string[] | undefined, client: string | undefined, strikes: number | undefined, workerId: string, primaryWorkerId: string | undefined, workspaceId: string | undefined, loop: number | undefined, turn: number | undefined, callKind: ProviderCallKind | undefined): Record<string, string> {
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


    requestProviderOptions(
        workerId: string,
        nativeReasoningBudget: number | null,
    ): AiSdkProviderOptions | undefined {
        const responseOptions = this.#reasoning.mode === "off"
            ? undefined
            : this.#reasoningResponseProviderOptions;
        const adaptiveOptions = this.#reasoning.mode === "adaptive"
            && nativeReasoningBudget === null
            ? this.#adaptiveReasoningProviderOptions
            : undefined;
        const nativeReasoning = nativeReasoningBudget !== null
            ? this.#additiveReasoningProvider === "anthropic"
                ? { anthropic: { thinking: { type: "enabled", budgetTokens: nativeReasoningBudget } } }
                : this.#additiveReasoningProvider === "bedrock"
                    ? { bedrock: { reasoningConfig: { type: "enabled", budgetTokens: nativeReasoningBudget } } }
                    : undefined
            : undefined;
        const options: AiSdkProviderOptions = {};
        for (const part of [responseOptions, adaptiveOptions, nativeReasoning]) {
            for (const [provider, values] of Object.entries(part ?? {})) {
                options[provider] = mergeJsonObjects(options[provider] ?? {}, values);
            }
        }
        if (this.#cacheAffinity?.target === "provider-option") {
            const { provider, name } = this.#cacheAffinity;
            options[provider] = { ...options[provider], [name]: workerId };
        }
        return Object.keys(options).length === 0 ? undefined : options;
    }


    nativeReasoningBudget(
        outputBudget: number | null,
        configuredReasoningBudget: number | null,
    ): number | null {
        if (this.#additiveReasoningProvider === undefined || this.#reasoning.mode === "off") return null;
        if (configuredReasoningBudget !== null) return configuredReasoningBudget;
        if (this.#adaptiveReasoningProviderOptions !== undefined) return null;
        if (outputBudget === null) {
            throw new TypeError(
                `${this.#source}: manual provider reasoning requires a resolved total output budget`,
            );
        }
        if (outputBudget <= MANUAL_REASONING_MINIMUM) {
            throw new TypeError(
                `${this.#source}: total output budget must exceed the provider's ${MANUAL_REASONING_MINIMUM}-token minimum reasoning allowance`,
            );
        }
        const fraction = MANUAL_REASONING_FRACTIONS[this.#reasoning.mode];
        return Math.min(
            outputBudget - 1,
            Math.max(MANUAL_REASONING_MINIMUM, Math.round(outputBudget * fraction)),
        );
    }


    nativeMaxOutputTokens(
        outputBudget: number | null,
        nativeReasoningBudget: number | null,
    ): number | undefined {
        if (outputBudget === null) return undefined;
        return nativeReasoningBudget !== null
            ? outputBudget - nativeReasoningBudget
            : outputBudget;
    }


    // PLURNK_PROVIDERS_GBNF_DEBUG ({§gbnf-response-observation}): validate the supplied GBNF locally and fail
    // hard if it's malformed, BEFORE any wire call — and the grammar is NOT
    // transported, so the request runs unconstrained. A debug aid to catch invalid
    // grammars (e.g. while editing the plurnk grammar) without a model round-trip;
    // off in production. `validateGbnf(grammar, "")` parses the grammar + resolves
    // its root, throwing iff the grammar itself is invalid (the empty input's
    // verdict is irrelevant — we only care that parsing succeeded).
    assertGrammarValid(grammar: string): void {
        try {
            validateGbnf(grammar, "");
        } catch (cause) {
            throw new Error(`grammar validation (PLURNK_PROVIDERS_GBNF_DEBUG): invalid GBNF — ${(cause as Error).message}`, { cause });
        }
    }

}
