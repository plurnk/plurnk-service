// PLURNK provider over a pi-ai model descriptor or OpenAI-compatible endpoint. Implements
// the universal generate() spine — signal merging, the SSE call, usage mapping,
// finishReason normalization, response assembly.
//
// Composition, not inheritance: a ProviderModel descriptor supplies the vendor
// protocol. The compatible URL path serves PLURNK extensions and local endpoint
// probes.

import type { CallWarning, ChatMessage, GrammarEvidence, JSONValue, PromptTokenMeasurement, Provider, ProviderAttempt, ProviderCostNormalizer, ProviderGenerateArgs, ProviderModel, ProviderRequestAccounting, ProviderRequestCapacity, ProviderRequestSettlement, ProviderResponse, ProviderUsage, Effort, InputModality } from "./types.ts";
import type { ProviderCost } from "@plurnk/plurnk-contracts";
import { EFFORTS, MAX_TIMER_MS, isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import type { EffortSetting, ReasoningResponseStyle } from "./env.ts";
import { UnsupportedEffortError } from "./types.ts";
import { executeProviderModel, executeOpenAICompatible, transportFailureOutputObserved, transportFailureEvidence } from "./modelTransport.ts";
import { APICallError, RetryError, toProviderError, ProviderError, ProviderTimeoutError } from "./errors.ts";
import type { ProviderNotice } from "./notices.ts";
import { assertPromptTokenMeasurement, estimatePromptTokens } from "./promptTokens.ts";
import { emitWarningOnce } from "./warnings.ts";
import { outboundFetch, type ExtensionAttribution, type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import { resolveProviderCost } from "./cost.ts";
import { validateProviderRequestAccounting } from "./accounting.ts";
import { validateProviderUsage } from "./usage.ts";
import { assessRequestCapacity, effectiveInputCapacity, effectiveInputWall, effectiveOutputBudget, effectiveOutputFloor, effectiveReasoningBudget } from "./capacity.ts";
import { nativeFixedEffort } from "./reasoning-effort.ts";
import ModelRequestBody from "./ModelRequestBody.ts";
import LeadingReasoning from "./LeadingReasoning.ts";
import type InferenceAdmission from "./InferenceAdmission.ts";
import RequestCapture from "./RequestCapture.ts";

export type ProviderFetch = typeof globalThis.fetch;

// {§provider-failure-normalization} — an AbortSignal is advisory: a wedged transport that never observes it can
// hang the await past the deadline (#505). Once the signal fires, a well-behaved transport unwinds and settles its
// own attempt (and accounting) within a short grace, and that path wins the race untouched; only a
// transport still wedged after the grace is force-rejected with the signal's own reason, so the existing
// operation/cancellation classification is unchanged. The grace is unwind slack, not a second deadline.
const OPERATION_DEADLINE_UNWIND_GRACE_MS = 1_000;

const headerValue = (headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined => {
    if (headers === undefined) return undefined;
    const target = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
};

const retryDelayMs = (error: APICallError, attempt: number): number => {
    const retryAfterMs = headerValue(error.responseHeaders, "retry-after-ms");
    if (retryAfterMs !== undefined) {
        const timeoutMs = Number.parseFloat(retryAfterMs);
        if (!Number.isNaN(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60_000) return timeoutMs;
    }
    const retryAfter = headerValue(error.responseHeaders, "retry-after");
    if (retryAfter !== undefined) {
        const timeoutSeconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(timeoutSeconds)) return Math.max(0, timeoutSeconds * 1000);
        const parsedDate = Date.parse(retryAfter);
        if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
    }
    return Math.min(1000 * 2 ** (attempt - 1), 10_000);
};

const waitForRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
        reject(signal.reason);
        return;
    }
    const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
    };
    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
});

const raceAgainstDeadline = async <T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = Promise.withResolvers<never>();
    const arm = (): void => { timer = setTimeout(() => backstop.reject(signal.reason), OPERATION_DEADLINE_UNWIND_GRACE_MS); };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
    try {
        return await Promise.race([work, backstop.promise]);
    } finally {
        signal.removeEventListener("abort", arm);
        if (timer !== undefined) clearTimeout(timer);
    }
};

// Local protocol toggles; catalog transports use request-field declarations.
export type ReasoningStyle = "none" | "think" | "template";

export type NativeEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

// GBNF transport is a local llama-server capability. "none" means no
// service-managed constrained sampling; endpoint-owned settings are not inferred.
export type GrammarStyle = "none" | "llamacpp";

export type CacheAffinity =
    | { readonly target: "header" | "body"; readonly name: string }
    | { readonly target: "provider-option"; readonly provider: string; readonly name: string };

export type ModelProviderOptions = Record<string, Record<string, JSONValue | undefined>>;



export type ModelProviderConfig = {
    inferenceAdmission?: InferenceAdmission;
    model: string;
    url?: string;                             // OpenAI-compatible chat-completions URL
    providerModel?: ProviderModel;            // native pi-ai model descriptor
    attributions?: (context: ExtensionAttributionContext) => ExtensionAttribution;
    fetchTimeoutMs: number;                    // discovery/tokenizer HTTP only; zero disables
    operationTimeoutMs: number;                // complete logical call across retries/backoff; zero disables
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    fetch?: ProviderFetch;                    // per-instance request executor; default globalThis.fetch
    contextWindow?: number | null;              // default null; caller resolves-or-fails, narrows to required with the interface
    inputModalities?: ReadonlySet<InputModality>; // {§provider-interface} — native parts the route's model accepts; default none
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
    outputBudget?: number | null;
    outputFloor?: number | null;               // {§provider-capacity-admission} — the least response room any request keeps
    reasoningBudget?: number | null;
    supportedEfforts?: readonly Effort[];
    // Native transport projection for adaptive. Models.dev supplies the route's
    // admissible values; provider-default is reserved for a documented native
    // dynamic option/default or a route with no caller-selectable effort.
    adaptiveEffort?: NativeEffort | "provider-default";
    adaptiveEffortProviderOptions?: ModelProviderOptions;
    // Native Anthropic and Bedrock transports interpret generic maxOutputTokens as
    // visible output and add an explicit provider reasoning budget. This marker lets the
    // adapter subtract that subset so the resulting wire cap remains PLURNK's
    // one total output budget.
    additiveReasoningProvider?: "anthropic" | "bedrock";
    reasoningStyle?: ReasoningStyle;          // default "none"
    outputTokenField?: "max_tokens" | "max_completion_tokens";
    reasoningRequestBody?: (mode: Effort, reasoningBudget: number | null) => Record<string, unknown>;
    reasoningRequestProviderOptions?: (mode: Effort, reasoningBudget: number | null) => ModelProviderOptions | undefined;
    reasoningResponseStyle?: ReasoningResponseStyle; // {§provider-interface}; default "verbatim"
    countPromptTokens?: (messages: readonly ChatMessage[], signal?: AbortSignal) => PromptTokenMeasurement | Promise<PromptTokenMeasurement>;
    estimateCost?: (usage: ProviderUsage | undefined) => ProviderCost;
    normalizeCost?: ProviderCostNormalizer;
    source?: string;                           // notice/problem source, e.g. "provider:openai"; default "provider"
    grammarStyle?: GrammarStyle;               // how a GBNF grammar is carried; default "none" (not sent)
    // {§provider-sdk-boundary} Provider routes own the exact documented
    // projection; the common transport only applies it as managed request state.
    cacheAffinity?: CacheAffinity;
    // {§provider-sdk-boundary} Already policy-gated by provider construction.
    // The transport attaches it to only the final leading system instruction.
    systemCacheProviderOptions?: ModelProviderOptions;
    // {§provider-effort} Route-owned native option needed to expose
    // readable reasoning. Applied only when the effective posture is not off.
    reasoningResponseProviderOptions?: ModelProviderOptions;
    // Optional provider-configured service tier. Unlike caller sampling, this is
    // a fixed deployment choice and therefore wins on every request; a native route
    // carries it only as {§provider-request-authority} allows.
    serviceTier?: string;
    // {§provider-request-authority} — which global request controls a native route's adapter documents as
    // provider options, and under which namespace. Absent on a native route means none.
    requestControls?: NativeRequestControls;
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
    // to the wall) — surfaced as Provider.requiresOutputBudget so consumers can
    // boot-refuse an envelope-less local alias. Default unset (no claim).
    requiresOutputBudget?: boolean;
    // {§provider-effort} Required intent, projected through the transport.
    // The independent budget is never an activation flag.
    effort: EffortSetting;
    // {§provider-configuration} Configured sampling is below caller sampling.
    // Absent optional values and null temperature retain endpoint defaults.
    temperature: number | null;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    seed?: number;
    repeatPenalty: number | null;
    // Zero selects no configured frequency override, as documented on the env panel.
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
    // Data-capture knobs ({§provider-failure-normalization}), off by default — the flag is the isolation, so a
    // serving turn requests nothing and carries nothing. `topLogprobs`: when a
    // non-negative int, request `logprobs:true, top_logprobs:<n>` and surface the
    // per-token confidence on assistant.logprobs (PLURNK_PROVIDERS_TOP_LOGPROBS;
    // null = off); a native route carries it only as {§provider-request-authority}
    // allows. `rawBody` retains raw responses and dispatched request bodies
    // ({§provider-interface}). Both knobs are gated per-alias.
    topLogprobs?: number | null;
    rawBody?: boolean;
    // {§provider-configuration} The generation budgets, env-read via the
    // common envelope parser — a percentage of the detected window or an absolute token
    // count. Optional so an out-of-date sibling keeps constructing (no claim);
    // the standard factory always supplies them. Resolved against contextWindow
    // at read time (getters), so a probe that lands after config assembly still
    // derives correctly.
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

class ProviderReasoningObserverError extends Error {
    constructor(cause: unknown) {
        super("provider reasoning could not be observed", { cause });
        this.name = "ProviderReasoningObserverError";
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

const providerWarningMessage = (warning: CallWarning): string => {
    switch (warning.type) {
        case "unsupported":
        case "compatibility":
            return `${warning.type} ${warning.feature}${warning.details === undefined ? "" : `: ${warning.details}`}`;
        case "deprecated": return `deprecated ${warning.setting}: ${warning.message}`;
        case "other": return warning.message;
    }
};


// {§provider-request-authority} — the global controls a native adapter documents as provider options.
export interface NativeRequestControls {
    readonly namespace: string;
    readonly serviceTier: boolean;
    readonly logprobs: boolean;
}

// {§provider-request-authority} — a native route forwards a configured control only through its
// adapter's documented provider option; a control the adapter does not document is named once and not
// sent, never dropped in silence (#988).
const nativeControlOptions = (
    source: string,
    controls: NativeRequestControls | undefined,
    serviceTier: string | undefined,
    topLogprobs: number | null,
): ModelProviderOptions | undefined => {
    const options: Record<string, string | number | boolean> = {};
    const unsupported = (knob: string): void => emitWarningOnce(
        `${source}: ${knob} is not a provider option this route's SDK${controls === undefined ? "" : ` (${controls.namespace})`} documents, so it is not sent`,
        "PLURNK_REQUEST_CONTROL_UNSUPPORTED",
    );
    if (serviceTier !== undefined) {
        if (controls?.serviceTier === true) options.serviceTier = serviceTier;
        else unsupported("PLURNK_PROVIDERS_SERVICE_TIER");
    }
    if (topLogprobs !== null) {
        if (controls?.logprobs === true) options.logprobs = topLogprobs > 0 ? topLogprobs : true;
        else unsupported("PLURNK_PROVIDERS_TOP_LOGPROBS");
    }
    return controls === undefined || Object.keys(options).length === 0 ? undefined : { [controls.namespace]: options };
};

export default class ModelProvider implements Provider {
    readonly #inferenceAdmission: InferenceAdmission | undefined;
    #model: string;
    #url: string | undefined;
    #providerModel: ProviderModel | undefined;
    #fetchTimeoutMs: number;
    #operationTimeoutMs: number;
    #headers: Record<string, string>;
    #fetch: ProviderFetch;
    #hasApiKey = false;
    #apiKeyRejectedMessage: string | undefined;
    #eosText: string | undefined;
    #contextWindow: number | null;
    #inputModalities: ReadonlySet<InputModality>;
    #maxInputTokens: number | null;
    #maxOutputTokens: number | null;
    #outputBudget: number | null;
    #outputFloor: number | null;
    #reasoningBudget: number | null;
    #additiveReasoningProvider: "anthropic" | "bedrock" | undefined;
    #effort: EffortSetting;
    #supportedEfforts: readonly Effort[];
    #adaptiveEffort: NativeEffort | "provider-default";
    #adaptiveEffortProviderOptions: ModelProviderOptions | undefined;
    readonly #samplingDefaults: Readonly<Record<string, number>>;
    #repeatPenalty: number | null;
    #dryMultiplier: number | undefined;
    #dryBase: number | undefined;
    #dryAllowedLength: number | undefined;
    #repeatLastN: number | undefined;
    #reasoningStyle: ReasoningStyle;
    readonly #outputTokenField: "max_tokens" | "max_completion_tokens";
    readonly #reasoningRequestBody: ((mode: Effort, reasoningBudget: number | null) => Record<string, unknown>) | undefined;
    readonly #reasoningRequestProviderOptions: ((mode: Effort, reasoningBudget: number | null) => ModelProviderOptions | undefined) | undefined;
    #reasoningResponseStyle: ReasoningResponseStyle;
    #countPromptTokens: (messages: readonly ChatMessage[], signal?: AbortSignal) => PromptTokenMeasurement | Promise<PromptTokenMeasurement>;
    #promptTokensUrl: string | undefined;
    #estimateCost: (usage: ProviderUsage | undefined) => ProviderCost;
    #normalizeCost?: ProviderCostNormalizer;
    #source: string;
    #grammarStyle: GrammarStyle;
    #cacheAffinity: CacheAffinity | undefined;
    #systemCacheProviderOptions: ModelProviderOptions | undefined;
    #reasoningResponseProviderOptions: ModelProviderOptions | undefined;
    #serviceTier: string | undefined;
    #controlOptions: ModelProviderOptions | undefined;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #retryAttempts: number;
    #errorDetailLimit: number | undefined;
    #topLogprobs: number | null;
    #rawBody: boolean;
    #servedModel: string | undefined;
    #requiresOutputBudget: boolean | undefined;
    readonly attributions?: (context: ExtensionAttributionContext) => ExtensionAttribution;

    // Optional capability ({§model-fact-resolution}): exact tokenization served by the backend's
    // own vocab. Assigned in the constructor ONLY when the config carries a
    // tokenizeUrl (llama-server), so `provider.tokenize === undefined` remains
    // the honest capability signal for every other backend.
    tokenize?: (text: string) => Promise<number[]>;
    readonly #requestBody: ModelRequestBody;
    constructor(config: ModelProviderConfig) {
        this.#inferenceAdmission = config.inferenceAdmission;
        this.#model = config.model;
        this.#url = config.url;
        this.#providerModel = config.providerModel;
        this.attributions = config.attributions;
        if ((this.#url === undefined) === (this.#providerModel === undefined)) {
            throw new Error(`${config.source ?? "provider"}: configure exactly one model transport or OpenAI-compatible URL`);
        }
        for (const [name, value] of [
            ["fetchTimeoutMs", config.fetchTimeoutMs],
            ["operationTimeoutMs", config.operationTimeoutMs],
        ] as const) {
            if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_MS)) {
                throw new Error(`${config.source ?? "provider"}: ${name} must be an integer from 0 through ${MAX_TIMER_MS} milliseconds`);
            }
        }
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#operationTimeoutMs = config.operationTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#fetch = config.fetch ?? outboundFetch;
        this.#contextWindow = config.contextWindow ?? null;
        this.#inputModalities = config.inputModalities ?? new Set();
        this.#maxInputTokens = config.maxInputTokens ?? null;
        this.#maxOutputTokens = config.maxOutputTokens ?? null;
        this.#outputBudget = config.outputBudget ?? null;
        this.#outputFloor = config.outputFloor ?? null;
        this.#reasoningBudget = config.reasoningBudget ?? null;
        this.#additiveReasoningProvider = config.additiveReasoningProvider;
        this.#effort = config.effort;
        this.#supportedEfforts = Object.freeze([
            ...new Set(config.supportedEfforts ?? EFFORTS),
        ]);
        this.#adaptiveEffort = config.adaptiveEffort ?? "provider-default";
        this.#adaptiveEffortProviderOptions = config.adaptiveEffortProviderOptions;
        if (!this.#supportedEfforts.includes(this.#effort.mode)) {
            throw new UnsupportedEffortError(
                config.source ?? "provider",
                this.#effort.mode,
                this.#supportedEfforts,
            );
        }
        // Loud guard: an out-of-date consumer (stale extension dist) omitting the
        // required tuning fields must fail at construction, not silently send
        // undefined sampling on every grammar request.
        if (config.temperature === undefined || config.repeatPenalty === undefined) {
            throw new Error(`${config.source ?? "provider"}: ModelProviderConfig requires temperature + repeatPenalty declared (PLURNK_PROVIDERS_TEMPERATURE / _REPEAT_PENALTY; null = provider default)`);
        }
        this.#samplingDefaults = Object.fromEntries(Object.entries({
            temperature: config.temperature ?? undefined,
            top_p: config.topP,
            top_k: config.topK,
            presence_penalty: config.presencePenalty,
            frequency_penalty: config.frequencyPenalty === 0 ? undefined : config.frequencyPenalty,
            seed: config.seed,
        }).filter((entry): entry is [string, number] => entry[1] !== undefined));
        this.#repeatPenalty = config.repeatPenalty;
        this.#dryMultiplier = config.dryMultiplier;
        this.#dryBase = config.dryBase;
        this.#dryAllowedLength = config.dryAllowedLength;
        this.#repeatLastN = config.repeatLastN;
        this.#retryAttempts = config.retryAttempts;
        this.#errorDetailLimit = config.errorDetailLimit;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        if (this.#providerModel !== undefined && (config.outputTokenField !== undefined || config.reasoningRequestBody !== undefined)) {
            throw new TypeError(`${config.source ?? "provider"}: compatible request body projections require an OpenAI-compatible URL`);
        }
        if (this.#providerModel === undefined && config.reasoningRequestProviderOptions !== undefined) {
            throw new TypeError(`${config.source ?? "provider"}: native reasoning provider options require a model transport`);
        }
        this.#outputTokenField = config.outputTokenField ?? "max_tokens";
        this.#reasoningRequestBody = config.reasoningRequestBody;
        this.#reasoningRequestProviderOptions = config.reasoningRequestProviderOptions;
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
        this.#reasoningResponseProviderOptions = config.reasoningResponseProviderOptions;
        if (this.#providerModel === undefined && this.#cacheAffinity?.target === "provider-option") {
            throw new Error(`${this.#source}: native provider-option cache affinity requires a model transport`);
        }
        if (this.#providerModel !== undefined && this.#cacheAffinity?.target === "body") {
            throw new Error(`${this.#source}: body cache affinity requires an OpenAI-compatible URL`);
        }
        if (this.#providerModel === undefined && this.#systemCacheProviderOptions !== undefined) {
            throw new Error(`${this.#source}: system cache provider options require a model transport`);
        }
        if (this.#providerModel === undefined && this.#reasoningResponseProviderOptions !== undefined) {
            throw new Error(`${this.#source}: reasoning response provider options require a model transport`);
        }
        if (this.#providerModel === undefined && this.#additiveReasoningProvider !== undefined) {
            throw new Error(`${this.#source}: additive reasoning projection requires a model transport`);
        }
        if (this.#cacheAffinity?.target === "provider-option"
            && Object.hasOwn(
                this.#reasoningResponseProviderOptions?.[this.#cacheAffinity.provider] ?? {},
                this.#cacheAffinity.name,
            )) {
            throw new Error(`${this.#source}: reasoning response options conflict with cache-affinity option ${this.#cacheAffinity.provider}.${this.#cacheAffinity.name}`);
        }
        this.#serviceTier = config.serviceTier;
        this.#apiKeyRejectedMessage = config.apiKeyRejectedMessage;
        this.#eosText = config.eosText;
        this.#hasApiKey = "Authorization" in this.#headers;
        this.#supportsSlotPinning = config.supportsSlotPinning ?? false;
        this.#slotCount = config.slotCount ?? null;
        this.#topLogprobs = config.topLogprobs ?? null;
        if (this.#providerModel === undefined && config.requestControls !== undefined) {
            throw new Error(`${this.#source}: native request controls require a model transport`);
        }
        this.#controlOptions = this.#providerModel === undefined
            ? undefined
            : nativeControlOptions(this.#source, config.requestControls, this.#serviceTier, this.#topLogprobs);
        this.#rawBody = config.rawBody ?? false;
        this.#servedModel = config.servedModel;
        this.#requiresOutputBudget = config.requiresOutputBudget;
        for (const [name, value] of [
            ["contextWindow", this.#contextWindow],
            ["maxInputTokens", this.#maxInputTokens],
            ["maxOutputTokens", this.#maxOutputTokens],
            ["outputBudget", this.#outputBudget],
            ["outputFloor", this.#outputFloor],
            ["reasoningBudget", this.#reasoningBudget],
        ] as const) {
            if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
                throw new Error(`${this.#source}: ${name} must be a positive safe integer or null`);
            }
        }
        // {§provider-capacity-admission}: the floor is never above the output budget.
        this.#outputFloor = effectiveOutputFloor({ configured: this.#outputFloor, outputBudget: this.#outputBudget });
        if (this.#reasoningBudget !== null
            && this.#outputBudget !== null
            && this.#reasoningBudget >= this.#outputBudget) {
            throw new Error(`${this.#source}: reasoningBudget must be smaller than the total outputBudget`);
        }
        if (this.#effort.budget !== this.#reasoningBudget) {
            throw new Error(`${this.#source}: effort and generation envelope disagree on reasoningBudget`);
        }
        this.#reasoningRequestBody?.(this.#effort.mode, this.#reasoningBudget);
        this.#reasoningRequestProviderOptions?.(this.#effort.mode, this.#reasoningBudget);
        if (this.#requiresOutputBudget === true && this.#outputBudget === null) {
            throw new Error(`${this.#source}: this backend requires a resolved PLURNK_PROVIDERS_OUTPUT_BUDGET`);
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
                const body: unknown = await res.json();
                const tokens = isRecord(body) ? body.tokens : undefined;
                if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "number")) {
                    throw new Error(`${this.#source}: tokenize endpoint returned no token array`);
                }
                return tokens;
            };
        }
        this.#requestBody = new ModelRequestBody({ reasoningBudget: this.#reasoningBudget, additiveReasoningProvider: this.#additiveReasoningProvider, effort: this.#effort, adaptiveEffortProviderOptions: this.#adaptiveEffortProviderOptions, repeatPenalty: this.#repeatPenalty, dryMultiplier: this.#dryMultiplier, dryBase: this.#dryBase, dryAllowedLength: this.#dryAllowedLength, repeatLastN: this.#repeatLastN, reasoningStyle: this.#reasoningStyle, source: this.#source, grammarStyle: this.#grammarStyle, cacheAffinity: this.#cacheAffinity, reasoningResponseProviderOptions: this.#reasoningResponseProviderOptions, controlOptions: this.#controlOptions, supportsSlotPinning: this.#supportsSlotPinning, slotCount: this.#slotCount });
    }

    get contextWindow(): number | null { return this.#contextWindow; }
    get inputModalities(): ReadonlySet<InputModality> { return this.#inputModalities; }
    get maxInputTokens(): number | null { return this.#maxInputTokens; }
    get maxOutputTokens(): number | null { return this.#maxOutputTokens; }
    get outputBudget(): number | null { return this.#outputBudget; }
    get outputFloor(): number | null { return this.#outputFloor; }
    get reasoningBudget(): number | null { return this.#reasoningBudget; }
    get supportedEfforts(): readonly Effort[] { return this.#supportedEfforts; }
    get inputCapacity(): number | null {
        return effectiveInputCapacity({
            contextWindow: this.#contextWindow,
            maxInputTokens: this.#maxInputTokens,
            outputBudget: this.#outputBudget,
        });
    }
    // {§provider-capacity-admission}: the physical input wall, the window less the floor.
    get inputWall(): number | null {
        return effectiveInputWall({
            contextWindow: this.#contextWindow,
            maxInputTokens: this.#maxInputTokens,
            outputFloor: this.#outputFloor,
        });
    }
    get model(): string { return this.#model; }
    // Backend's self-reported served id; undefined when unprobed/unknown.
    get servedModel(): string | undefined { return this.#servedModel; }
    // Resolved "decodes unbounded without a cap" fact; undefined = no claim.
    get requiresOutputBudget(): boolean | undefined { return this.#requiresOutputBudget; }
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
                    ...this.#requestBody.reasoningBody(),
                }),
                ...(requestSignal === undefined ? {} : { signal: requestSignal }),
            });
            if (!response.ok) {
                return estimatePromptTokens(
                    messages,
                    `llama-server input-token endpoint returned HTTP ${response.status}`,
                );
            }
            const body: unknown = await response.json();
            const inputTokens = isRecord(body) ? body.input_tokens : undefined;
            if (!isSafeInteger(inputTokens) || inputTokens < 0) {
                return estimatePromptTokens(
                    messages,
                    "llama-server input-token endpoint returned no non-negative integer input_tokens",
                );
            }
            return {
                kind: "exact",
                tokens: inputTokens,
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

    async assessRequestCapacity(
        messages: readonly ChatMessage[],
        maxOutputTokens?: number,
        signal?: AbortSignal,
    ): Promise<ProviderRequestCapacity> {
        const outputBudget = effectiveOutputBudget({
            requested: maxOutputTokens,
            configured: this.#outputBudget,
            maxOutputTokens: this.#maxOutputTokens,
            contextWindow: this.#contextWindow,
        });
        const reasoningBudget = effectiveReasoningBudget({
            configured: this.#reasoningBudget,
            outputBudget,
        });
        return assessRequestCapacity({
            contextWindow: this.#contextWindow,
            maxInputTokens: this.#maxInputTokens,
            maxOutputTokens: this.#maxOutputTokens,
            outputBudget,
            outputFloor: this.#outputFloor,
            reasoningBudget,
            measurement: await this.countPromptTokens(messages, signal),
        });
    }

    // Per-turn metadata bag: pass the backend's non-standard top-level fields
    // through verbatim. Providers do not reinterpret vendor currency or account
    // metadata; a monetary value carries its own amount and currency.
    #buildMeta(chunkMetadata: Record<string, unknown>): Record<string, unknown> | undefined {
        const meta: Record<string, unknown> = { ...chunkMetadata };
        return Object.keys(meta).length > 0 ? meta : undefined;
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

    async generate({ messages, sessionId, signal, grammar, maxOutputTokens, sampling, observeRequest, observeReasoning, callKind }: ProviderGenerateArgs): Promise<ProviderResponse> {
        // {§provider-interface} The session identity is required.
        if (sessionId === undefined || sessionId.length === 0) throw new Error("generate: sessionId is required — the session's stable, opaque identity");
        if (callKind !== undefined && callKind !== "emission" && callKind !== "bare") {
            throw new Error(`generate: unsupported callKind ${JSON.stringify(callKind)}`);
        }
        // Reject before any wire call when already aborted
        // ({§provider-failure-normalization}).
        signal?.throwIfAborted();

        // Grammar transport ({§provider-request-authority}): an operator's grammar rides a
        // llama-style route verbatim and is never sent on any other style.
        const wantGrammar = grammar !== undefined && this.#grammarStyle !== "none";
        const sendGrammar = wantGrammar ? grammar : undefined;
        const preserveGrammarSentence = wantGrammar
            && this.#reasoningStyle === "template";

        const capacity = await this.assessRequestCapacity(messages, maxOutputTokens, signal);
        if (capacity.decision === "reject") {
            if (capacity.prompt.kind !== "exact") {
                throw new TypeError(`${this.#source}: only an exact prompt measurement may reject capacity`);
            }
            throw new ProviderError(
                this.#source,
                "capacity_exceeded",
                `The exact provider request uses ${capacity.prompt.tokens} input tokens, exceeding its ${capacity.inputWall} token input wall.`,
                { capacity, extensions: { capacityStage: "preflight", capacity } },
            );
        }
        // {§provider-capacity-admission}: the wire grants the flexed allowance —
        // the window's remainder, between the floor and the model's limit.
        const effectiveMaxOutputTokens = capacity.responseMax ?? capacity.outputBudget ?? undefined;
        const nativeReasoningBudget = this.#requestBody.nativeReasoningBudget(
            capacity.outputBudget,
            capacity.reasoningBudget,
        );

        // Both transports project the same resolved sampling; managed fields still win.
        const requestSampling = {
            ...this.#samplingDefaults,
            ...this.#requestBody.samplingBody(sampling),
        };
        const body: Record<string, unknown> = {
            ...this.#requestBody.repetitionPenaltyBody(),
            ...requestSampling,
            ...(this.#serviceTier !== undefined ? { service_tier: this.#serviceTier } : {}),
            ...(this.#reasoningRequestBody !== undefined
                ? this.#reasoningRequestBody(this.#effort.mode, capacity.reasoningBudget)
                : this.#requestBody.reasoningBody(preserveGrammarSentence, capacity.reasoningBudget)),
            ...(effectiveMaxOutputTokens === undefined ? {} : { [this.#outputTokenField]: effectiveMaxOutputTokens }),
            ...this.#requestBody.grammarBody(sendGrammar),
            // Request per-token logprobs only when enabled (managed field —
            // reserved from caller sampling; the env flag is the single control).
            ...(this.#topLogprobs !== null ? { logprobs: true, top_logprobs: this.#topLogprobs } : {}),
            ...this.#requestBody.slotBody(sessionId),
            ...(this.#cacheAffinity?.target === "body"
                ? { [this.#cacheAffinity.name]: sessionId }
                : {}),
        };

        // Per-request headers = static auth/routing only.
        const headers = new Headers(this.#headers);
        if (this.#cacheAffinity?.target === "header") {
            headers.set(this.#cacheAffinity.name, sessionId);
        }
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
        const emitReasoning = observeReasoning === undefined
            ? undefined
            : (delta: string): void => {
                if (delta.length === 0) return;
                try {
                    observeReasoning(delta);
                } catch (cause) {
                    throw new ProviderReasoningObserverError(cause);
                }
            };
        let successfulReasoningStream = "";
        let recoveredAfterOutput = false;
        const executeAdmittedRequest = async () => {
            const capture = this.#rawBody ? new RequestCapture() : undefined;
            const fetch = capture?.fetch(this.#fetch ?? outboundFetch) ?? this.#fetch;
            let requestReasoningStream = "";
            let structuredReasoning = false;
            const envelopes = preserveGrammarSentence ? LeadingReasoning.TEMPLATE
                : this.#reasoningResponseStyle === "think-tags" ? LeadingReasoning.THINK : [];
            const observing = emitReasoning !== undefined;
            const liveProjection = observing && envelopes.length > 0 ? new LeadingReasoning(envelopes) : undefined;
            const observeRequestReasoning = !observing
                ? undefined
                : (delta: string): void => {
                    requestReasoningStream += delta;
                    emitReasoning?.(delta);
                };
            const observers = {
                ...(observeRequestReasoning === undefined ? {} : { observeReasoning: (delta: string): void => {
                    structuredReasoning = true;
                    observeRequestReasoning(delta);
                } }),
                ...(liveProjection === undefined ? {} : { observeText: (delta: string): void => {
                    if (!structuredReasoning) {
                        observeRequestReasoning!(liveProjection.push(delta));
                    }
                } }),
            };
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
                forensicEvidence: unknown,
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
                    await settle?.(requestAccounting, forensicEvidence);
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
                response = this.#providerModel === undefined
                    ? await executeOpenAICompatible({
                        url: this.#url!,
                        model: this.#model,
                        headers: requestHeaders,
                        body,
                        messages,
                        signal: operationSignal,
                        fetch,
                        captureRawBody: this.#rawBody,
                        ...observers,
                    })
                    : await executeProviderModel({
                        providerModel: this.#providerModel,
                        fetch,
                        ...(capture === undefined ? {} : { captureRequest: (req) => capture.record(req) }),
                        headers: requestHeaders,
                        providerOptions: this.#requestBody.requestProviderOptions(
                            sessionId,
                            nativeReasoningBudget,
                            this.#reasoningRequestProviderOptions?.(this.#effort.mode, capacity.reasoningBudget),
                        ),
                        systemProviderOptions: this.#systemCacheProviderOptions,
                        messages,
                        signal: operationSignal,
                        captureRawBody: this.#rawBody,
                        ...observers,
                        temperature: typeof requestSampling.temperature === "number" ? requestSampling.temperature : undefined,
                        topP: typeof requestSampling.top_p === "number" ? requestSampling.top_p : undefined,
                        topK: typeof requestSampling.top_k === "number" ? requestSampling.top_k : undefined,
                        presencePenalty: typeof requestSampling.presence_penalty === "number" ? requestSampling.presence_penalty : undefined,
                        frequencyPenalty: typeof requestSampling.frequency_penalty === "number" ? requestSampling.frequency_penalty : undefined,
                        stopSequences: typeof requestSampling.stop === "string"
                            ? [requestSampling.stop]
                            : Array.isArray(requestSampling.stop) && requestSampling.stop.every((value) => typeof value === "string")
                                ? requestSampling.stop
                                : undefined,
                        seed: typeof requestSampling.seed === "number" ? requestSampling.seed : undefined,
                        maxOutputTokens: this.#requestBody.nativeMaxOutputTokens(capacity.outputBudget, nativeReasoningBudget),
                        reasoning: this.#reasoningRequestProviderOptions !== undefined
                            ? "provider-default"
                            : this.#effort.mode === "off"
                                ? "none"
                                : this.#effort.mode === "adaptive"
                                    ? this.#adaptiveEffort
                                    : nativeFixedEffort(this.#effort.mode),
                    });
            } catch (error) {
                if (transportFailureOutputObserved(error)) recoveredAfterOutput = true;
                const failure = transportFailureEvidence(error);
                await settleAccounting(
                    "error",
                    failure.usage,
                    failure.chargeEvidence,
                    { ...failure, ...(capture?.request === undefined ? {} : { request: capture.request }) },
                    failure.status,
                );
                throw error;
            }
            if (!structuredReasoning && liveProjection !== undefined) observeRequestReasoning!(liveProjection.finish());
            successfulReasoningStream = requestReasoningStream;
            await settleAccounting(
                "response",
                response.usage,
                response.chargeEvidence,
                { ...response, ...(capture?.request === undefined ? {} : { request: capture.request }) },
            );
            return response;
        };

        const executeRequest = async () => {
            const release = await this.#inferenceAdmission?.acquire(operationSignal);
            try {
                operationSignal?.throwIfAborted();
                return await executeAdmittedRequest();
            } finally {
                release?.();
            }
        };

        const retry = async (): Promise<Awaited<ReturnType<typeof executeRequest>>> => {
            const errors: unknown[] = [];
            while (true) {
                try {
                    return await executeRequest();
                } catch (error) {
                    if (operationSignal?.aborted) throw error;
                    errors.push(error);
                    if (!APICallError.isInstance(error) || !error.isRetryable || this.#retryAttempts === 0) {
                        if (errors.length === 1) throw error;
                        const message = error instanceof Error ? error.message : String(error);
                        throw new RetryError({
                            message: `Failed after ${errors.length} attempts. Last error: ${message}`,
                            reason: "errorNotRetryable",
                            errors,
                        });
                    }
                    if (errors.length > this.#retryAttempts) {
                        throw new RetryError({
                            message: `Failed after ${errors.length} attempts. Last error: ${error.message}`,
                            reason: "maxRetriesExceeded",
                            errors,
                        });
                    }
                    await waitForRetry(retryDelayMs(error, errors.length), operationSignal);
                }
            }
        };

        let raw;
        try {
            // {§provider-failure-normalization} — the operation deadline and caller cancellation are backstopped by
            // racing, not only by the advisory operationSignal, so a transport that ignores the abort still
            // surfaces the deadline (→ the operationTimeout/caller branches below) rather than hanging the
            // loop (#505). A well-behaved transport settles first and wins the race with its own evidence.
            raw = operationSignal === undefined
                ? await retry()
                : await raceAgainstDeadline(retry(), operationSignal);
        } catch (err) {
            if (err instanceof ProviderRequestObserverError
                || err instanceof ProviderRequestAccountingError
                || err instanceof ProviderReasoningObserverError) throw err.cause;
            if (signal?.aborted) throw signal.reason;
            if (operationTimeout?.aborted) {
                const timeout = new ProviderTimeoutError(this.#operationTimeoutMs, err);
                throw new ProviderError(this.#source, "deadline_exceeded", timeout.message, {
                    status: 504,
                    cause: timeout,
                    extensions: {
                        timeoutPhase: timeout.phase,
                        timeoutMs: timeout.timeoutMs,
                    },
                    accounting,
                    capacity,
                });
            }
            const pe = toProviderError(err, this.#source, this.#errorDetailLimit, capacity);
            if ((pe.status === 401 || pe.status === 403) && this.#hasApiKey && this.#apiKeyRejectedMessage !== undefined) {
                throw new ProviderError(this.#source, "unauthorized", this.#apiKeyRejectedMessage, {
                    status: pe.status,
                    cause: err,
                    accounting,
                    capacity,
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
        const projectedReasoning = LeadingReasoning.project(raw.content, raw.reasoning,
            preserveGrammarSentence && !raw.reasoningProjected ? LeadingReasoning.TEMPLATE
                : this.#reasoningResponseStyle === "think-tags" ? LeadingReasoning.THINK : []);

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
        if (emitReasoning !== undefined
            && raw.reasoning.length > 0
            && successfulReasoningStream !== raw.reasoning) {
            const missing = raw.reasoning.startsWith(successfulReasoningStream)
                ? raw.reasoning.slice(successfulReasoningStream.length)
                : successfulReasoningStream.length === 0
                    ? raw.reasoning
                    : `\n${raw.reasoning}`;
            emitReasoning(missing);
        }

        let notices: ProviderNotice[] | undefined;
        const nativeCalls = raw.finishReason === "tool_calls" || raw.wire.toolCalls.length > 0;
        if (nativeCalls) {
            (notices ??= []).push({
                source: this.#source,
                kind: "provider_warning",
                level: "warn",
                directive: "YOU MUST NOT emit native tool calls.",
                message: "The response included native tool calls, but no tools were declared.",
                position: null,
            });
        }
        if (recoveredAfterOutput && accounting.at(-1)?.outcome === "response") {
            (notices ??= []).push({
                source: this.#source,
                kind: "provider_retry",
                level: "warn",
                message: "A provider stream failed after model output began; this response is a complete retry, not a continuation.",
                position: null,
            });
        }
        for (const warning of raw.warnings) {
            (notices ??= []).push({
                source: this.#source,
                kind: "provider_warning",
                level: "warn",
                message: providerWarningMessage(warning),
                position: null,
            });
        }
        const usage = raw.usage;
        if (sendGrammar !== undefined
            && this.tokenize !== undefined
            && usage?.outputTokens !== undefined) {
            // {§diagnostic-observation} — billed output tokens far beyond every visible channel are reported
            // as the two counts, naming no cause. The count requires the serving vocabulary; an estimate
            // cannot prove absence.
            try {
                const [contentTokens, reasoningTokens] = await Promise.all([
                    this.tokenize(raw.content),
                    this.tokenize(raw.reasoning),
                ]);
                const visible = contentTokens.length + reasoningTokens.length;
                if (usage.outputTokens > visible + 64) {
                    (notices ??= []).push({
                        source: this.#source,
                        kind: "output_unaccounted",
                        level: "warn",
                        message: `${usage.outputTokens} output tokens billed; ${visible} visible across content and reasoning.`,
                        position: Array.from(raw.content).length,
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
            ...(nativeCalls ? { nativeToolCalls: true } : {}),
            content: raw.content,
            reasoning: raw.reasoning.length > 0 ? raw.reasoning : null,
            model: raw.model,
            ...(logprobs !== undefined ? { logprobs, meanLogprob } : {}),
        };
        const evidence = {
            assistantRaw: raw,
            accounting,
            capacity,
            ...(grammarEvidence !== undefined ? { grammarEvidence } : {}),
            ...(raw.rawBody !== undefined ? { rawBody: raw.rawBody } : {}),
            ...(meta !== undefined ? { meta } : {}),
            ...(notices !== undefined ? { notices } : {}),
        };
        // {§provider-capacity-admission} (#482): conformance judges the GRANT the
        // wire actually sent, not the configured reservation — output between
        // the two is overflow tolerance working, never a provider fault.
        const grantedOutput = capacity.responseMax ?? capacity.outputBudget;
        if (grantedOutput !== null
            && usage?.outputTokens !== undefined
            && usage.outputTokens > grantedOutput) {
            const attempt: ProviderAttempt = {
                assistant: { ...assistant, finishReason: raw.finishReason },
                ...evidence,
            };
            throw new ProviderError(
                this.#source,
                "invalid_response",
                `The provider reported ${usage.outputTokens} output tokens after receiving a granted output allowance of ${grantedOutput}.`,
                {
                    attempt,
                    accounting,
                    extensions: {
                        stage: "provider-response",
                        outputBudget: capacity.outputBudget,
                        grantedOutput,
                        reportedOutputTokens: usage.outputTokens,
                    },
                },
            );
        }
        // {§provider-failure-normalization} The transport classified the finish as an error: the attempt failed with
        // its evidence, and nothing here is a completed exchange or a transport outage.
        if (raw.finishReason === "error") {
            const attempt: ProviderResponse<"error"> = {
                assistant: { ...assistant, finishReason: raw.finishReason },
                ...evidence,
            };
            throw new ProviderError(
                this.#source,
                "generation_failed",
                `The provider ended generation with an error${raw.rawFinishReason === undefined ? "" : ` (${raw.rawFinishReason})`}.`,
                {
                    attempt,
                    accounting,
                    extensions: {
                        stage: "provider-response",
                        finishReason: "error",
                        ...(raw.rawFinishReason === undefined ? {} : { rawFinishReason: raw.rawFinishReason }),
                    },
                },
            );
        }
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
