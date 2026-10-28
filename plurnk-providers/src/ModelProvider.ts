// PLURNK provider over a pi-ai model descriptor or OpenAI-compatible endpoint. Implements
// the universal generate() spine — signal merging, the SSE call, usage mapping,
// finishReason normalization, response assembly.
//
// Composition, not inheritance: a ProviderModel descriptor supplies the vendor
// protocol. The compatible URL path serves PLURNK extensions and local endpoint
// probes.

import {
    normalizeContext,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type ImageContent,
    type Model,
    type TextContent,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamBedrockConverseStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as streamGoogleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { ChatMessage, GrammarEvidence, PromptTokenMeasurement, Provider, ProviderAttempt, ProviderAttemptFinishReason, ProviderChargeEvidence, ProviderCostNormalizer, ProviderGenerateArgs, ProviderModel, ProviderRequestAccounting, ProviderRequestCapacity, ProviderRequestSettlement, ProviderResponse, ProviderUsage, Effort, InputModality, TokenLogprob } from "./types.ts";
import type { ProviderCost } from "@plurnk/plurnk-contracts";
import { EFFORTS, MAX_TIMER_MS, isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import type { EffortSetting, ReasoningResponseStyle } from "./env.ts";
import { UnsupportedEffortError } from "./types.ts";
import { APICallError, RetryError, toProviderError, ProviderError, ProviderTimeoutError } from "./errors.ts";
import type { ProviderNotice } from "./notices.ts";
import { withoutNativeTools } from "./native-tools.ts";
import { assertPromptTokenMeasurement, estimatePromptTokens } from "./promptTokens.ts";
import { emitWarningOnce } from "./warnings.ts";
import { outboundFetch, syncAmbientHttp, type ExtensionAttribution, type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import { resolveProviderCost } from "./cost.ts";
import { validateProviderRequestAccounting } from "./accounting.ts";
import { UsageDetailError, normalizeUsage, validateProviderUsage } from "./usage.ts";
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

export type CacheAffinity = { readonly target: "header" | "body"; readonly name: string };

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
    nativeAdaptiveThinking?: boolean;
    // Native Anthropic and Bedrock transports interpret generic maxOutputTokens as
    // visible output and add an explicit provider reasoning budget. This marker lets the
    // adapter subtract that subset so the resulting wire cap remains PLURNK's
    // one total output budget.
    additiveReasoningProvider?: "anthropic" | "bedrock";
    reasoningStyle?: ReasoningStyle;          // default "none"
    outputTokenField?: "max_tokens" | "max_completion_tokens";
    reasoningRequestBody?: (mode: Effort, reasoningBudget: number | null) => Record<string, unknown>;
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
    systemCacheBreakpoint?: boolean;
    // Optional provider-configured service tier. Unlike caller sampling, this is
    // a fixed deployment choice and therefore wins on every request; a native route
    // carries it only as {§provider-request-authority} allows.
    serviceTier?: string;
    // {§provider-request-authority} — which global request controls a native route's adapter documents,
    // and under which namespace. Absent on a native route means none.
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

const ProviderFailureTransportSymbol = Symbol("plurnk.provider.failureTransport");

interface FailureEvidence {
    readonly status?: number;
    readonly usage?: ProviderUsage;
    readonly chargeEvidence: ProviderChargeEvidence;
    readonly content: string;
    readonly reasoning: string;
    readonly error: { readonly name: string; readonly message: string };
    readonly rawBody?: unknown;
    readonly outputObserved?: boolean;
}

const serializeError = (error: unknown): { readonly name: string; readonly message: string } =>
    error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) };

// {§provider-failure-normalization} (#971) — evidence is keyed by the failure object, so the object
// must be this request's own. A caller's abort reason is shared by every request on that signal (or
// may not be an object), so it is wrapped per request before anything is keyed on it.
const abortFailure = (signal: AbortSignal): Error => {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) {
        const copy = new Error(reason.message, { cause: reason });
        copy.name = reason.name;
        return copy;
    }
    return new DOMException(
        typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
        "AbortError",
    );
};

const attachFailureEvidence = (error: unknown, evidence: FailureEvidence): void => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
        Object.defineProperty(error, ProviderFailureTransportSymbol, {
            value: evidence,
            enumerable: false,
            configurable: true,
        });
    }
};

const readFailureEvidence = (error: unknown): FailureEvidence => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
        const attached = (error as { [ProviderFailureTransportSymbol]?: FailureEvidence })[ProviderFailureTransportSymbol];
        if (attached !== undefined) return attached;
    }
    if (APICallError.isInstance(error)) {
        return {
            status: error.statusCode,
            chargeEvidence: { response: { headers: error.responseHeaders } },
            content: "",
            reasoning: "",
            error: serializeError(error),
            ...(error.responseBody !== undefined ? { rawBody: error.responseBody } : {}),
        };
    }
    if (RetryError.isInstance(error) && error.errors.length > 0) {
        return readFailureEvidence(error.errors.at(-1));
    }
    return {
        chargeEvidence: { response: {} },
        content: "",
        reasoning: "",
        error: serializeError(error),
    };
};

const headersToRecord = (headers: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of headers.entries()) out[key] = value;
    return out;
};

const toPiContext = (messages: readonly ChatMessage[]): TranscriptContext => {
    const systemParts: string[] = [];
    const contextMessages: Context["messages"] = [];
    let leadingSystem = true;
    for (const message of messages) {
        if (leadingSystem && message.role === "system") {
            systemParts.push(typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "").join(""));
            continue;
        }
        leadingSystem = false;
        if (message.role === "assistant") {
            const text = typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "").join("");
            contextMessages.push({
                role: "assistant",
                content: [{ type: "text", text }],
                api: "openai-completions",
                provider: "openai",
                model: "unknown",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: 0,
            });
            continue;
        }
        const content: string | (TextContent | ImageContent)[] = typeof message.content === "string"
            ? message.content
            : message.content.map((part): TextContent | ImageContent =>
                part.type === "text"
                    ? { type: "text", text: part.text }
                    : { type: "image", data: Buffer.from(part.data).toString("base64"), mimeType: part.mediaType });
        contextMessages.push({
            role: "user",
            content,
            timestamp: 0,
        });
    }
    return normalizeContext({
        ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
        messages: contextMessages,
    });
};

const mapOpenAICompatibleMessages = (
    messages: readonly ChatMessage[],
    systemCacheBreakpoint: boolean,
): readonly Record<string, unknown>[] => {
    let lastLeadingSystemIndex = -1;
    if (systemCacheBreakpoint) {
        for (let i = 0; i < messages.length; i += 1) {
            if (messages[i].role !== "system") break;
            lastLeadingSystemIndex = i;
        }
    }
    return messages.map((message, index) => {
        if (index === lastLeadingSystemIndex && typeof message.content === "string") {
            return {
                role: message.role,
                content: [{
                    type: "text",
                    text: message.content,
                    cache_control: { type: "ephemeral" },
                }],
            };
        }
        if (typeof message.content === "string") {
            return { role: message.role, content: message.content };
        }
        return {
            role: message.role,
            content: message.content.map((part) => {
                if (part.type === "text") return { type: "text", text: part.text };
                const base64 = Buffer.from(part.data).toString("base64");
                if (part.mediaType.startsWith("audio/")) {
                    return {
                        type: "input_audio",
                        input_audio: {
                            data: base64,
                            format: part.mediaType.slice("audio/".length),
                        },
                    };
                }
                return {
                    type: "image_url",
                    image_url: { url: `data:${part.mediaType};base64,${base64}` },
                };
            }),
        };
    });
};

const applyAnthropicPayloadAdjustments = (
    params: Record<string, unknown>,
    messages: readonly ChatMessage[],
    systemCacheBreakpoint: boolean,
    serviceTier: string | undefined,
): void => {
    if (serviceTier !== undefined) {
        params.service_tier = serviceTier;
    }
    if (systemCacheBreakpoint && Array.isArray(params.system) && params.system.length > 0) {
        const last = params.system.at(-1);
        if (isRecord(last)) {
            last.cache_control = { type: "ephemeral" };
        }
    }
    const wireMessages = Array.isArray(params.messages) ? params.messages : undefined;
    if (wireMessages === undefined) return;
    const nonSystem = messages.filter((m) => m.role !== "system");
    for (let i = 0; i < Math.min(wireMessages.length, nonSystem.length); i += 1) {
        const sourceMsg = nonSystem[i];
        const wireMsg = wireMessages[i];
        if (!Array.isArray(sourceMsg.content) || !isRecord(wireMsg) || !Array.isArray(wireMsg.content)) continue;
        for (let j = 0; j < Math.min(sourceMsg.content.length, wireMsg.content.length); j += 1) {
            const sourcePart = sourceMsg.content[j];
            const wireBlock = wireMsg.content[j];
            if (sourcePart.type === "file"
                && sourcePart.mediaType === "application/pdf"
                && isRecord(wireBlock)
                && wireBlock.type === "image") {
                wireBlock.type = "document";
            }
        }
    }
};

const RESOURCE_INTERRUPTED_FINISH_REASONS: ReadonlySet<string> = new Set([
    "preempted",
    "insufficient_system_resource",
    "model_overloaded",
    "server_overloaded",
]);

const normalizeStopReason = (
    stopReason: AssistantMessage["stopReason"] | undefined,
    rawStopReason: string | undefined,
): { finishReason: ProviderAttemptFinishReason; rawFinishReason?: string } => {
    const raw = typeof rawStopReason === "string" && rawStopReason.length > 0 ? rawStopReason : undefined;
    if (raw !== undefined) {
        if (RESOURCE_INTERRUPTED_FINISH_REASONS.has(raw)) {
            return { finishReason: "resource_interrupted", rawFinishReason: raw };
        }
        switch (raw) {
            case "stop":
            case "end_turn":
            case "stop_sequence":
            case "STOP":
            case "completed":
            case "complete":
                return { finishReason: "stop", rawFinishReason: raw };
            case "length":
            case "max_tokens":
            case "MAX_TOKENS":
            case "incomplete":
            case "max_output_tokens":
                return { finishReason: "length", rawFinishReason: raw };
            case "tool_calls":
            case "tool_use":
            case "function_call":
                return { finishReason: "tool_calls", rawFinishReason: raw };
            case "content_filter":
            case "refusal":
            case "safety":
            case "recitation":
            case "SAFETY":
            case "RECITATION":
            case "BLOCKLIST":
            case "PROHIBITED_CONTENT":
            case "SPII":
            case "IMAGE_SAFETY":
            case "content_filtered":
            case "guardrail_intervened":
                return { finishReason: "content_filter", rawFinishReason: raw };
            default:
                return { finishReason: "error", rawFinishReason: raw };
        }
    }
    switch (stopReason) {
        case "stop":
            return { finishReason: "stop" };
        case "length":
            return { finishReason: "length" };
        case "toolUse":
            return { finishReason: "tool_calls" };
        case "error":
        case "aborted":
            return { finishReason: "error" };
        default:
            return { finishReason: null };
    }
};

const extractFromAssistantMessage = (message: AssistantMessage | undefined) => {
    if (message === undefined) {
        return {
            content: "",
            reasoning: "",
            reasoningProjected: false,
            toolCalls: [] as { index: number; id: string; type: string; name: string; arguments: string }[],
            finishReason: null as ProviderAttemptFinishReason,
            rawFinishReason: undefined as string | undefined,
        };
    }
    let content = "";
    let reasoning = "";
    const toolCalls: { index: number; id: string; type: string; name: string; arguments: string }[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            content += block.text;
        } else if (block.type === "thinking") {
            if (block.thinking.length > 0) {
                reasoning += block.thinking;
            } else if (typeof block.thinkingSignature === "string" && block.thinkingSignature.startsWith("[")) {
                try {
                    const details: unknown = JSON.parse(block.thinkingSignature);
                    if (Array.isArray(details)) {
                        for (const detail of details) {
                            if (!isRecord(detail)) continue;
                            if (typeof detail.text === "string") reasoning += detail.text;
                            else if (typeof detail.summary === "string") reasoning += detail.summary;
                        }
                    }
                } catch {
                    // signature is opaque
                }
            }
        } else if (block.type === "toolCall") {
            toolCalls.push({
                index: toolCalls.length,
                id: block.id,
                type: "function",
                name: block.name,
                arguments: JSON.stringify(block.arguments),
            });
        }
    }
    const { finishReason, rawFinishReason } = normalizeStopReason(message.stopReason, message.rawStopReason);
    return {
        content,
        reasoning,
        reasoningProjected: reasoning.length > 0,
        toolCalls,
        finishReason,
        rawFinishReason,
    };
};

const STANDARD_CHUNK_KEYS: ReadonlySet<string> = new Set([
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "charge",
    "system_fingerprint",
    "service_tier",
    "type",
    "index",
    "delta",
    "message",
    "content_block",
    "candidates",
    "usageMetadata",
    "modelVersion",
    "responseId",
    "contentBlockStart",
    "contentBlockDelta",
    "contentBlockStop",
    "messageStart",
    "messageStop",
    "metadata",
    "amazon-bedrock-invocationMetrics",
]);

const STANDARD_DELTA_KEYS: ReadonlySet<string> = new Set([
    "role",
    "content",
    "reasoning_content",
    "reasoning",
    "reasoning_text",
    "reasoning_details",
    "tool_calls",
    "function_call",
    "audio",
]);

const extractLogprobs = (choice: Record<string, unknown>): TokenLogprob[] => {
    if (!isRecord(choice.logprobs) || !Array.isArray(choice.logprobs.content)) return [];
    const out: TokenLogprob[] = [];
    for (const item of choice.logprobs.content) {
        if (!isRecord(item) || typeof item.token !== "string" || typeof item.logprob !== "number") continue;
        const top = Array.isArray(item.top_logprobs)
            ? item.top_logprobs.flatMap((alt) =>
                isRecord(alt) && typeof alt.token === "string" && typeof alt.logprob === "number"
                    ? [{ token: alt.token, logprob: alt.logprob }]
                    : [])
            : undefined;
        out.push({
            token: item.token,
            logprob: item.logprob,
            ...(top !== undefined && top.length > 0 ? { top } : {}),
        });
    }
    return out;
};

const collectChunkForensics = (rawChunks: readonly unknown[]) => {
    let id: string | undefined;
    let model: string | undefined;
    let rawUsage: Record<string, unknown> | undefined;
    let charge: unknown;
    let rawFinishReason: string | undefined;
    const logprobs: TokenLogprob[] = [];
    const metadata: Record<string, unknown> = {};
    const channels: Record<string, string> = {};
    for (const chunk of rawChunks) {
        if (!isRecord(chunk)) continue;
        if (typeof chunk.id === "string" && chunk.id.length > 0) id = chunk.id;
        else if (typeof chunk.responseId === "string" && chunk.responseId.length > 0) id = chunk.responseId;
        else if (isRecord(chunk.message) && typeof chunk.message.id === "string") id = chunk.message.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0) model = chunk.model;
        else if (typeof chunk.modelVersion === "string" && chunk.modelVersion.length > 0) model = chunk.modelVersion;
        else if (isRecord(chunk.message) && typeof chunk.message.model === "string") model = chunk.message.model;
        for (const [key, value] of Object.entries(chunk)) {
            if (!STANDARD_CHUNK_KEYS.has(key) && value !== undefined) {
                metadata[key] = value;
            }
        }
        if (chunk.charge !== undefined) {
            charge = chunk.charge;
        }
        if (isRecord(chunk.usage)) {
            rawUsage = Object.assign(rawUsage ?? {}, chunk.usage);
        }
        if (isRecord(chunk.message) && isRecord(chunk.message.usage)) {
            rawUsage = Object.assign(rawUsage ?? {}, chunk.message.usage);
        }
        if (isRecord(chunk.delta) && typeof chunk.delta.stop_reason === "string" && chunk.delta.stop_reason.length > 0) {
            rawFinishReason = chunk.delta.stop_reason;
        }
        if (typeof chunk.stopReason === "string" && chunk.stopReason.length > 0) {
            rawFinishReason = chunk.stopReason;
        }
        if (Array.isArray(chunk.candidates)) {
            for (const candidate of chunk.candidates) {
                if (isRecord(candidate) && typeof candidate.finishReason === "string" && candidate.finishReason.length > 0) {
                    rawFinishReason = candidate.finishReason;
                }
            }
        }
        if (Array.isArray(chunk.choices)) {
            for (const choice of chunk.choices) {
                if (!isRecord(choice)) continue;
                logprobs.push(...extractLogprobs(choice));
                if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
                    rawFinishReason = choice.finish_reason;
                }
                if (isRecord(choice.delta)) {
                    for (const [key, value] of Object.entries(choice.delta)) {
                        if (!STANDARD_DELTA_KEYS.has(key) && typeof value === "string" && value.length > 0) {
                            channels[key] = (channels[key] ?? "") + value;
                        }
                    }
                }
            }
        }
    }
    return { id, model, rawUsage, charge, rawFinishReason, logprobs, metadata, channels };
};

const toUsageFromPiMessage = (
    message: AssistantMessage | undefined,
    rawUsage: Record<string, unknown> | undefined,
): ProviderUsage | undefined => {
    const sdkUsage = (() => {
        if (message === undefined) return undefined;
        const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
        const reasoning = (message.usage as { reasoning?: number }).reasoning;
        if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0) {
            return undefined;
        }
        const totalInput = input + cacheRead + cacheWrite;
        return {
            inputTokens: totalInput,
            outputTokens: output,
            totalTokens: totalTokens || totalInput + output,
            inputTokenDetails: {
                noCacheTokens: input,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
            },
            ...(typeof reasoning === "number" && reasoning > 0
                ? {
                    outputTokenDetails: {
                        textTokens: Math.max(0, output - reasoning),
                        reasoningTokens: reasoning,
                    },
                }
                : {}),
        };
    })();
    if (rawUsage !== undefined) {
        try {
            const normalized = normalizeUsage(rawUsage, sdkUsage);
            if (normalized !== undefined) return normalized;
        } catch (error) {
            if (error instanceof UsageDetailError) return error.usage;
            throw error;
        }
    }
    return sdkUsage;
};

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

// {§provider-request-authority} — the global controls a native adapter documents.
export interface NativeRequestControls {
    readonly namespace: string;
    readonly serviceTier: boolean;
    readonly logprobs: boolean;
}

// {§provider-request-authority} — a native route forwards a configured control only when its
// adapter documents it; a control the adapter does not document is named once and not
// sent, never dropped in silence (#988).
const resolveRequestControls = (
    source: string,
    controls: NativeRequestControls | undefined,
    serviceTier: string | undefined,
    topLogprobs: number | null,
): { readonly serviceTier?: string; readonly topLogprobs?: number } => {
    const unsupported = (knob: string): void => emitWarningOnce(
        `${source}: ${knob} is not a provider option this route's SDK${controls === undefined ? "" : ` (${controls.namespace})`} documents, so it is not sent`,
        "PLURNK_REQUEST_CONTROL_UNSUPPORTED",
    );
    let resolvedServiceTier: string | undefined;
    if (serviceTier !== undefined) {
        if (controls?.serviceTier === true) resolvedServiceTier = serviceTier;
        else unsupported("PLURNK_PROVIDERS_SERVICE_TIER");
    }
    let resolvedTopLogprobs: number | undefined;
    if (topLogprobs !== null) {
        if (controls?.logprobs === true) resolvedTopLogprobs = topLogprobs;
        else unsupported("PLURNK_PROVIDERS_TOP_LOGPROBS");
    }
    return {
        ...(resolvedServiceTier === undefined ? {} : { serviceTier: resolvedServiceTier }),
        ...(resolvedTopLogprobs === undefined ? {} : { topLogprobs: resolvedTopLogprobs }),
    };
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
    #nativeAdaptiveThinking: boolean;
    readonly #samplingDefaults: Readonly<Record<string, number>>;
    #repeatPenalty: number | null;
    #dryMultiplier: number | undefined;
    #dryBase: number | undefined;
    #dryAllowedLength: number | undefined;
    #repeatLastN: number | undefined;
    #reasoningStyle: ReasoningStyle;
    readonly #outputTokenField: "max_tokens" | "max_completion_tokens";
    readonly #reasoningRequestBody: ((mode: Effort, reasoningBudget: number | null) => Record<string, unknown>) | undefined;
    #reasoningResponseStyle: ReasoningResponseStyle;
    #countPromptTokens: (messages: readonly ChatMessage[], signal?: AbortSignal) => PromptTokenMeasurement | Promise<PromptTokenMeasurement>;
    #promptTokensUrl: string | undefined;
    #estimateCost: (usage: ProviderUsage | undefined) => ProviderCost;
    #normalizeCost?: ProviderCostNormalizer;
    #source: string;
    #grammarStyle: GrammarStyle;
    #cacheAffinity: CacheAffinity | undefined;
    #systemCacheBreakpoint: boolean;
    #serviceTier: string | undefined;
    #resolvedControls: { readonly serviceTier?: string; readonly topLogprobs?: number };
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
        this.#nativeAdaptiveThinking = config.nativeAdaptiveThinking === true;
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
        if (this.#providerModel !== undefined && config.outputTokenField !== undefined) {
            throw new TypeError(`${config.source ?? "provider"}: compatible request body projections require an OpenAI-compatible URL`);
        }
        this.#outputTokenField = config.outputTokenField ?? "max_tokens";
        this.#reasoningRequestBody = config.reasoningRequestBody;
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
        this.#systemCacheBreakpoint = config.systemCacheBreakpoint === true;
        if (this.#providerModel === undefined && this.#systemCacheBreakpoint) {
            throw new Error(`${this.#source}: system cache breakpoints require a model transport`);
        }
        if (this.#providerModel === undefined && this.#additiveReasoningProvider !== undefined) {
            throw new Error(`${this.#source}: additive reasoning projection requires a model transport`);
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
        this.#resolvedControls = this.#providerModel === undefined
            ? {
                ...(this.#serviceTier === undefined ? {} : { serviceTier: this.#serviceTier }),
                ...(this.#topLogprobs === null ? {} : { topLogprobs: this.#topLogprobs }),
            }
            : resolveRequestControls(this.#source, config.requestControls, this.#serviceTier, this.#topLogprobs);
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
        this.#requestBody = new ModelRequestBody({ reasoningBudget: this.#reasoningBudget, additiveReasoningProvider: this.#additiveReasoningProvider, effort: this.#effort, nativeAdaptiveThinking: this.#nativeAdaptiveThinking, repeatPenalty: this.#repeatPenalty, dryMultiplier: this.#dryMultiplier, dryBase: this.#dryBase, dryAllowedLength: this.#dryAllowedLength, repeatLastN: this.#repeatLastN, reasoningStyle: this.#reasoningStyle, source: this.#source, grammarStyle: this.#grammarStyle, supportsSlotPinning: this.#supportsSlotPinning, slotCount: this.#slotCount });
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
        for (const field of ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"]) {
            if (field in body) {
                throw new TypeError("PLURNK provider requests cannot declare native tools");
            }
        }

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
                const effectiveModel: ProviderModel = this.#providerModel ?? {
                    id: this.#model,
                    api: "openai-completions",
                    provider: this.#source,
                    baseUrl: this.#url!.replace(/\/chat\/completions\/?$/, ""),
                    compat: {
                        supportsStore: false,
                        supportsDeveloperRole: false,
                        supportsUsageInStreaming: false,
                        supportsFinishReason: true,
                    },
                };
                const buildPiModel = <TApi extends ProviderModel["api"]>(api: TApi): Model<TApi> => ({
                    id: effectiveModel.id,
                    name: effectiveModel.name ?? effectiveModel.id,
                    api,
                    provider: effectiveModel.provider,
                    baseUrl: effectiveModel.baseUrl,
                    reasoning: effectiveModel.reasoning ?? true,
                    input: [...(effectiveModel.input ?? ["text", "image"])],
                    cost: effectiveModel.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: effectiveModel.contextWindow ?? 128_000,
                    maxTokens: effectiveModel.maxTokens ?? 32_768,
                    ...(effectiveModel.headers === undefined ? {} : { headers: { ...effectiveModel.headers } }),
                });
                const context = toPiContext(messages);
                const rawChunks: unknown[] = [];
                let httpResponse: { status: number; headers: Record<string, string>; ok: boolean } | undefined;
                let httpErrorBody: string | undefined;
                let capturedTransportError: unknown;
                let requestUrl = this.#url ?? effectiveModel.baseUrl;
                let requestBodyValues: unknown;

                const baseFetch = capture?.fetch(this.#fetch ?? outboundFetch) ?? this.#fetch ?? outboundFetch;
                const customFetch: ProviderFetch = async (input, init) => {
                    const effectiveInput = this.#providerModel === undefined && this.#url !== undefined
                        ? this.#url
                        : input;
                    requestUrl = typeof effectiveInput === "string"
                        ? effectiveInput
                        : effectiveInput instanceof URL
                            ? effectiveInput.toString()
                            : effectiveInput.url;
                    if (typeof init?.body === "string") {
                        try {
                            requestBodyValues = JSON.parse(init.body);
                        } catch {
                            requestBodyValues = init.body;
                        }
                    }
                    try {
                        const res = await baseFetch(effectiveInput, init);
                        httpResponse = {
                            status: res.status,
                            headers: headersToRecord(res.headers),
                            ok: res.ok,
                        };
                        if (!res.ok) {
                            try {
                                httpErrorBody = await res.clone().text();
                            } catch {
                                // ignore clone read error
                            }
                        }
                        return res;
                    } catch (err) {
                        capturedTransportError = err;
                        throw err;
                    }
                };

                const temperature = typeof requestSampling.temperature === "number" ? requestSampling.temperature : undefined;
                const topP = typeof requestSampling.top_p === "number" ? requestSampling.top_p : undefined;
                const topK = typeof requestSampling.top_k === "number" ? requestSampling.top_k : undefined;
                const presencePenalty = typeof requestSampling.presence_penalty === "number" ? requestSampling.presence_penalty : undefined;
                const frequencyPenalty = typeof requestSampling.frequency_penalty === "number" ? requestSampling.frequency_penalty : undefined;
                const stopSequences = typeof requestSampling.stop === "string"
                    ? [requestSampling.stop]
                    : Array.isArray(requestSampling.stop) && requestSampling.stop.every((value): value is string => typeof value === "string")
                        ? requestSampling.stop
                        : undefined;
                const seed = typeof requestSampling.seed === "number" ? requestSampling.seed : undefined;
                const maxTokens = this.#providerModel === undefined
                    ? effectiveMaxOutputTokens
                    : this.#requestBody.nativeMaxOutputTokens(capacity.outputBudget, nativeReasoningBudget);
                const reasoning = this.#providerModel === undefined || this.#reasoningRequestBody !== undefined
                    ? "provider-default"
                    : this.#effort.mode === "off"
                        ? "none"
                        : this.#effort.mode === "adaptive"
                            ? this.#adaptiveEffort
                            : nativeFixedEffort(this.#effort.mode);

                const commonOptions = {
                    signal: operationSignal,
                    headers: requestHeaders,
                    ...(temperature === undefined ? {} : { temperature }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    onProviderStreamEvent: (rawEvent: unknown) => {
                        rawChunks.push(rawEvent);
                    },
                };

                const onPayload = async (payload: unknown) => {
                    const transformed = effectiveModel.onPayload !== undefined
                        ? await effectiveModel.onPayload(payload, effectiveModel)
                        : payload;
                    const params = isRecord(transformed) ? { ...transformed } : {};
                    if (effectiveModel.api === "openai-completions") {
                        if (topP !== undefined) params.top_p = topP;
                        if (topK !== undefined && effectiveModel.includeTopK === true) params.top_k = topK;
                        if (presencePenalty !== undefined) params.presence_penalty = presencePenalty;
                        if (frequencyPenalty !== undefined) params.frequency_penalty = frequencyPenalty;
                        if (stopSequences !== undefined) params.stop = stopSequences;
                        if (seed !== undefined) params.seed = seed;
                        if (this.#systemCacheBreakpoint
                            || messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file" && !p.mediaType.startsWith("image/")))) {
                            params.messages = mapOpenAICompatibleMessages(messages, this.#systemCacheBreakpoint);
                        } else if (messages[0]?.role === "system" && Array.isArray(params.messages)) {
                            const first: unknown = params.messages[0];
                            if (!isRecord(first) || (first.role !== "system" && first.role !== "developer")) {
                                params.messages.unshift({ role: "system", content: "" });
                            }
                        }
                        if (this.#providerModel === undefined) {
                            for (const [key, value] of Object.entries(body)) {
                                if (value === undefined) delete params[key];
                                else params[key] = value;
                            }
                        } else {
                            if (this.#reasoningRequestBody !== undefined) {
                                Object.assign(params, this.#reasoningRequestBody(this.#effort.mode, capacity.reasoningBudget));
                            }
                            if (this.#cacheAffinity?.target === "body") {
                                params[this.#cacheAffinity.name] = sessionId;
                            }
                            if (this.#resolvedControls.topLogprobs !== undefined) {
                                params.logprobs = true;
                                params.top_logprobs = this.#resolvedControls.topLogprobs;
                            }
                            if (this.#resolvedControls.serviceTier !== undefined) {
                                params.service_tier = this.#resolvedControls.serviceTier;
                            }
                        }
                    } else if (effectiveModel.api === "openai-responses") {
                        if (topP !== undefined) params.top_p = topP;
                        if (this.#cacheAffinity?.target === "body") {
                            params[this.#cacheAffinity.name] = sessionId;
                        }
                        if (this.#resolvedControls.serviceTier !== undefined) {
                            params.service_tier = this.#resolvedControls.serviceTier;
                        }
                        if (this.#resolvedControls.topLogprobs !== undefined) {
                            const existingInclude = Array.isArray(params.include)
                                ? params.include.filter((item): item is string => typeof item === "string")
                                : [];
                            if (!existingInclude.includes("message.output_text.logprobs")) {
                                params.include = [...existingInclude, "message.output_text.logprobs"];
                            }
                            params.top_logprobs = this.#resolvedControls.topLogprobs;
                        }
                    } else if (effectiveModel.api === "anthropic-messages") {
                        if (topP !== undefined) params.top_p = topP;
                        if (topK !== undefined) params.top_k = topK;
                        if (stopSequences !== undefined) params.stop_sequences = stopSequences;
                        applyAnthropicPayloadAdjustments(params, messages, this.#systemCacheBreakpoint, this.#resolvedControls.serviceTier);
                    } else if (effectiveModel.api === "google-generative-ai") {
                        const config: Record<string, unknown> = isRecord(params.config) ? { ...params.config } : {};
                        if (topP !== undefined) config.topP = topP;
                        if (topK !== undefined) config.topK = topK;
                        if (presencePenalty !== undefined) config.presencePenalty = presencePenalty;
                        if (frequencyPenalty !== undefined) config.frequencyPenalty = frequencyPenalty;
                        if (stopSequences !== undefined) config.stopSequences = stopSequences;
                        if (seed !== undefined) config.seed = seed;
                        if (this.#resolvedControls.serviceTier !== undefined) {
                            config.serviceTier = this.#resolvedControls.serviceTier;
                        }
                        params.config = withoutNativeTools(config, "generate-content");
                        try {
                            capture?.record({
                                method: "POST",
                                origin: new URL(effectiveModel.baseUrl).origin,
                                body: JSON.stringify(params),
                            });
                        } catch {
                            // ignore invalid URL
                        }
                        requestBodyValues = params;
                        return params;
                    } else if (effectiveModel.api === "bedrock-converse-stream") {
                        const inferenceConfig: Record<string, unknown> = isRecord(params.inferenceConfig)
                            ? { ...params.inferenceConfig }
                            : {};
                        if (topP !== undefined) inferenceConfig.topP = topP;
                        if (stopSequences !== undefined) inferenceConfig.stopSequences = stopSequences;
                        if (Object.keys(inferenceConfig).length > 0) params.inferenceConfig = inferenceConfig;
                        if (this.#resolvedControls.serviceTier !== undefined) {
                            params.serviceTier = { type: this.#resolvedControls.serviceTier };
                        }
                    }
                    const toolProtocol = effectiveModel.api === "bedrock-converse-stream"
                        ? "amazon-bedrock"
                        : effectiveModel.api === "anthropic-messages"
                            ? "messages"
                            : "openai";
                    const nextParams = withoutNativeTools(params, toolProtocol);
                    if (effectiveModel.api === "bedrock-converse-stream") {
                        try {
                            capture?.record({
                                method: "POST",
                                origin: new URL(effectiveModel.baseUrl).origin,
                                body: JSON.stringify(nextParams),
                            });
                        } catch {
                            // ignore invalid URL
                        }
                    }
                    requestBodyValues = nextParams;
                    return nextParams;
                };

                const startStream = (): AssistantMessageEventStream => {
                    switch (effectiveModel.api) {
                        case "openai-completions": {
                            const reasoningEffort = this.#providerModel === undefined || reasoning === "none" || reasoning === "provider-default"
                                ? undefined
                                : reasoning;
                            return streamOpenAICompletions(
                                {
                                    ...buildPiModel("openai-completions"),
                                    ...(effectiveModel.compat === undefined ? {} : { compat: { ...effectiveModel.compat } }),
                                },
                                context,
                                {
                                    ...commonOptions,
                                    fetch: customFetch,
                                    apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                                    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                                    onPayload,
                                },
                            );
                        }
                        case "openai-responses": {
                            const reasoningEffort = reasoning === "none" || reasoning === "provider-default" ? undefined : reasoning;
                            return streamOpenAIResponses(buildPiModel("openai-responses"), context, {
                                ...commonOptions,
                                fetch: customFetch,
                                apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                                onPayload,
                            });
                        }
                        case "anthropic-messages": {
                            const effortOption = reasoning !== "none" && reasoning !== "provider-default"
                                ? (reasoning === "minimal" ? "low" : reasoning === "xhigh" ? "max" : reasoning)
                                : undefined;
                            return streamAnthropic(
                                {
                                    ...buildPiModel("anthropic-messages"),
                                    ...(this.#nativeAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
                                },
                                context,
                                {
                                    ...commonOptions,
                                    fetch: customFetch,
                                    apiKey: effectiveModel.apiKey ?? "plurnk-unset",
                                    cacheRetention: "none",
                                    ...(reasoning === "none"
                                        ? { thinkingEnabled: false }
                                        : this.#nativeAdaptiveThinking
                                            ? {
                                                thinkingEnabled: true,
                                                ...(effortOption === undefined ? {} : { effort: effortOption }),
                                            }
                                            : nativeReasoningBudget !== null
                                                ? { thinkingEnabled: true, thinkingBudgetTokens: nativeReasoningBudget }
                                                : {}),
                                    onPayload,
                                },
                            );
                        }
                        case "google-generative-ai": {
                            syncAmbientHttp();
                            const googleLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" = reasoning === "minimal"
                                ? "MINIMAL"
                                : reasoning === "low"
                                    ? "LOW"
                                    : reasoning === "medium"
                                        ? "MEDIUM"
                                        : "HIGH";
                            const googleThinking = reasoning === "none"
                                ? { enabled: false }
                                : nativeReasoningBudget !== null
                                    ? { enabled: true, budgetTokens: nativeReasoningBudget }
                                    : reasoning !== "provider-default"
                                        ? {
                                            enabled: true,
                                            level: googleLevel,
                                        }
                                        : undefined;
                            return streamGoogleGenerativeAi(buildPiModel("google-generative-ai"), context, {
                                ...commonOptions,
                                ...(effectiveModel.apiKey === undefined ? {} : { apiKey: effectiveModel.apiKey }),
                                ...(googleThinking === undefined ? {} : { thinking: googleThinking }),
                                onPayload,
                            });
                        }
                        case "bedrock-converse-stream": {
                            syncAmbientHttp();
                            const bedrockReasoning = reasoning === "none" || reasoning === "provider-default"
                                ? undefined
                                : (reasoning === "xhigh" ? "max" : reasoning);
                            return streamBedrockConverseStream(buildPiModel("bedrock-converse-stream"), context, {
                                ...commonOptions,
                                ...(bedrockReasoning === undefined ? {} : { reasoning: bedrockReasoning }),
                                ...(nativeReasoningBudget !== null && bedrockReasoning !== undefined
                                    ? {
                                        thinkingBudgets: {
                                            minimal: nativeReasoningBudget,
                                            low: nativeReasoningBudget,
                                            medium: nativeReasoningBudget,
                                            high: nativeReasoningBudget,
                                        },
                                    }
                                    : {}),
                                onPayload,
                            });
                        }
                    }
                };

                let outputObserved = false;
                let finalMessage: AssistantMessage | undefined;
                let lastErrorMessage: AssistantMessage | undefined;
                let streamError: string | undefined;

                const stream = startStream();
                for await (const event of stream) {
                    if (event.type === "text_delta" && event.delta.length > 0) {
                        outputObserved = true;
                        observers.observeText?.(event.delta);
                    } else if (event.type === "thinking_delta" && event.delta.length > 0) {
                        outputObserved = true;
                        observers.observeReasoning?.(event.delta);
                    } else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
                        outputObserved = true;
                    } else if (event.type === "done") {
                        finalMessage = event.message;
                    } else if (event.type === "error") {
                        lastErrorMessage = event.error;
                        if (event.error.rawStopReason !== undefined
                            && !operationSignal?.aborted
                            && capturedTransportError === undefined
                            && httpResponse?.ok !== false) {
                            finalMessage = event.error;
                        } else {
                            streamError = event.error.errorMessage ?? "Provider stream failed";
                        }
                    }
                }

                const forensics = collectChunkForensics(rawChunks);
                const messageInfo = extractFromAssistantMessage(finalMessage ?? lastErrorMessage);
                const responseHeaders = httpResponse?.headers;
                const responseId = finalMessage?.responseId ?? lastErrorMessage?.responseId ?? forensics.id;

                if (finalMessage === undefined) {
                    const failureRawBody = rawChunks.length > 0
                        ? rawChunks
                        : httpErrorBody !== undefined && httpErrorBody.length > 0
                            ? httpErrorBody
                            : undefined;
                    if (operationSignal?.aborted) {
                        const abortError = abortFailure(operationSignal);
                        const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
                        attachFailureEvidence(abortError, {
                            status: httpResponse?.status,
                            usage,
                            chargeEvidence: {
                                ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
                                ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                                response: {
                                    ...(responseId === undefined ? {} : { id: responseId }),
                                    ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                                },
                            },
                            content: messageInfo.content,
                            reasoning: messageInfo.reasoning,
                            error: serializeError(abortError),
                            ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
                            outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
                        });
                        throw abortError;
                    }
                    const statusCode = httpResponse !== undefined && !httpResponse.ok ? httpResponse.status : undefined;
                    if (capturedTransportError !== undefined && statusCode === undefined) {
                        const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
                        attachFailureEvidence(capturedTransportError, {
                            status: httpResponse?.status,
                            usage,
                            chargeEvidence: {
                                ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
                                ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                                response: {
                                    ...(responseId === undefined ? {} : { id: responseId }),
                                    ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                                },
                            },
                            content: messageInfo.content,
                            reasoning: messageInfo.reasoning,
                            error: serializeError(capturedTransportError),
                            ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
                            outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
                        });
                        throw capturedTransportError;
                    }
                    let parsedErrorData: unknown;
                    let errorMessage = streamError ?? `HTTP ${statusCode ?? "error"}`;
                    if (httpErrorBody !== undefined && httpErrorBody.length > 0) {
                        try {
                            parsedErrorData = JSON.parse(httpErrorBody);
                            if (isRecord(parsedErrorData)) {
                                const errField = parsedErrorData.error;
                                if (isRecord(errField) && typeof errField.message === "string" && errField.message.length > 0) {
                                    errorMessage = errField.message;
                                } else if (typeof errField === "string" && errField.length > 0) {
                                    errorMessage = errField;
                                } else if (typeof parsedErrorData.message === "string" && parsedErrorData.message.length > 0) {
                                    errorMessage = parsedErrorData.message;
                                } else {
                                    errorMessage = httpErrorBody;
                                }
                            }
                        } catch {
                            errorMessage = httpErrorBody;
                        }
                    }
                    const apiError = new APICallError({
                        message: errorMessage,
                        url: requestUrl,
                        requestBodyValues,
                        statusCode,
                        responseHeaders,
                        responseBody: httpErrorBody,
                        data: parsedErrorData,
                    });
                    const usage = toUsageFromPiMessage(lastErrorMessage, forensics.rawUsage);
                    let charge: unknown = forensics.charge;
                    if (parsedErrorData !== undefined && isRecord(parsedErrorData) && isRecord(parsedErrorData.usage)) {
                        charge = parsedErrorData.usage.cost ?? charge;
                    }
                    attachFailureEvidence(apiError, {
                        status: statusCode,
                        usage,
                        chargeEvidence: {
                            ...(charge === undefined ? {} : { charge }),
                            ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                            response: {
                                ...(responseId === undefined ? {} : { id: responseId }),
                                ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                            },
                        },
                        content: messageInfo.content,
                        reasoning: messageInfo.reasoning,
                        error: serializeError(apiError),
                        ...(failureRawBody === undefined ? {} : { rawBody: failureRawBody }),
                        outputObserved: outputObserved || messageInfo.content.length > 0 || messageInfo.reasoning.length > 0,
                    });
                    throw apiError;
                }

                const usage = toUsageFromPiMessage(finalMessage, forensics.rawUsage);
                const chargeEvidence: ProviderChargeEvidence = {
                    ...(forensics.charge === undefined ? {} : { charge: forensics.charge }),
                    ...(forensics.rawUsage === undefined ? {} : { usage: forensics.rawUsage }),
                    response: {
                        ...(responseId === undefined ? {} : { id: responseId }),
                        ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
                    },
                };
                response = {
                    id: responseId,
                    model: forensics.model ?? finalMessage.model ?? effectiveModel.id,
                    content: messageInfo.content,
                    reasoning: messageInfo.reasoning,
                    reasoningProjected: messageInfo.reasoningProjected,
                    finishReason: messageInfo.finishReason,
                    ...(messageInfo.rawFinishReason === undefined ? {} : { rawFinishReason: messageInfo.rawFinishReason }),
                    usage,
                    chargeEvidence,
                    logprobs: forensics.logprobs,
                    metadata: forensics.metadata,
                    wire: {
                        chunks: rawChunks.length,
                        emptyChunks: 0,
                        fields: {},
                        channels: forensics.channels,
                        toolCalls: messageInfo.toolCalls,
                        unmappedChunks: [],
                    },
                    ...(this.#rawBody ? { rawBody: rawChunks } : {}),
                };
            } catch (error) {
                const failure = readFailureEvidence(error);
                if (failure.outputObserved) recoveredAfterOutput = true;
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
